import type { ConsumerLayerEvent, ProducerDynacastEvent, RoomFailureEvent } from '@native-sfu/contracts';
import { RoomOwnerRedirectException } from '../cluster/node-registry.service';
import { RoomsGateway } from './rooms.gateway';

describe('RoomsGateway', () => {
  it('disconnects unauthorized sockets', async () => {
    const gateway = new RoomsGateway({} as never, {} as never, {} as never);
    const socket: { data: { requestId?: string }; handshake: { auth: Record<string, unknown>; headers: Record<string, unknown>; address: string }; disconnect: jest.Mock } = {
      data: {},
      handshake: { auth: {}, headers: {}, address: '127.0.0.1' },
      disconnect: jest.fn()
    };

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data.requestId).toBeDefined();
  });

  describe('Dynacast signaling', () => {
    it('re-emits cross-node room signals onto the local Socket.IO room', () => {
      const { emitSignal, emissions } = createGatewayHarness();

      emitSignal({
        sourceNodeId: 'node-b',
        roomId: 'room-1',
        event: 'participant:joined',
        payload: [{ participantId: 'viewer-1' }]
      });

      expect(emissions).toEqual([{ target: 'room-1', event: 'participant:joined', payload: { participantId: 'viewer-1' } }]);
    });

    it('targets producer Dynacast events only to the publisher socket', async () => {
      const { rooms, emitProducerDynacast, emissions } = createGatewayHarness();
      const event = dynacastEvent('layers-needed');

      emitProducerDynacast(event);
      await flushPromises();

      expect(rooms.producerDynacastSignalTarget).toHaveBeenCalledWith(event, 3);
      expect(emissions).toEqual([{ target: 'publisher-socket', event: 'producer:layers-needed', payload: event }]);
      expect(rooms.recordDynacastSignalDelivery).toHaveBeenCalledWith(event, 2);
      expect(rooms.recordDynacastSignalFailure).not.toHaveBeenCalled();
      expect(emissions.some((emission) => emission.target === event.roomId)).toBe(false);
    });

    it('records a control failure when the publisher socket cannot be resolved', async () => {
      const { rooms, emitProducerDynacast, emissions } = createGatewayHarness({ targetMissing: true });
      const event = dynacastEvent('updated');

      emitProducerDynacast(event);
      await flushPromises();

      expect(emissions).toEqual([]);
      expect(rooms.recordDynacastSignalFailure).toHaveBeenCalledWith(event, 'publisher_socket_missing');
      expect(rooms.recordDynacastSignalDelivery).not.toHaveBeenCalled();
    });

    it('ignores stale disconnects after publisher socket replacement', async () => {
      const { gateway, rooms, emissions } = createGatewayHarness();
      rooms.leaveRoomForSocket.mockResolvedValueOnce({ closed: false, left: false });
      const socket = {
        id: 'old-publisher-socket',
        data: { roomId: 'room-1', participantId: 'publisher' },
        to: jest.fn(() => ({ emit: jest.fn() }))
      };

      await gateway.handleDisconnect(socket as never);

      expect(rooms.leaveRoomForSocket).toHaveBeenCalledWith('room-1', 'publisher', 'old-publisher-socket');
      expect(socket.to).not.toHaveBeenCalled();
      expect(emissions).toEqual([]);
    });

    it('emits SVC layer events on SVC-specific socket channels', () => {
      const { emitConsumerLayer, emissions } = createGatewayHarness();
      const event: ConsumerLayerEvent = {
        type: 'changed',
        roomId: 'room-1',
        participantId: 'viewer',
        consumerId: 'consumer-svc',
        producerId: 'producer-svc',
        currentSvcLayers: { spatialLayerId: 2, temporalLayerId: 1 },
        targetSvcLayers: { spatialLayerId: 2, temporalLayerId: 1 },
        preferredSvcLayers: { spatialLayerId: 2, temporalLayerId: 1 },
        reason: 'preferred',
        timestamp: '2026-06-16T00:00:00.000Z'
      };

      emitConsumerLayer(event);

      expect(emissions).toEqual([{ target: 'room-1', event: 'consumer:svc-layers-changed', payload: event }]);
    });

    it('emits room media failure events to the affected room', () => {
      const { emitRoomFailure, emissions } = createGatewayHarness();
      const event: RoomFailureEvent = {
        roomId: 'room-1',
        workerId: 'media-worker-1',
        reason: 'worker_crashed',
        message: 'Media worker media-worker-1 crashed',
        failedAt: '2026-06-16T00:00:00.000Z',
        recoverable: false,
        affectedParticipants: ['publisher', 'viewer'],
        affectedTransports: ['transport-1'],
        affectedProducers: ['producer-1'],
        affectedConsumers: ['consumer-1']
      };

      emitRoomFailure(event);

      expect(emissions).toEqual([{ target: 'room-1', event: 'room:failed', payload: event }]);
    });

    it('returns room owner lookup over Socket.IO', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const ack = jest.fn();

      await gateway.getRoomOwner({ roomId: 'room-1' }, ack);

      expect(rooms.lookupRoomOwner).toHaveBeenCalledWith('room-1');
      const response = ack.mock.calls[0]![0];
      expect(response.ok).toBe(true);
      expect(response.data.roomId).toBe('room-1');
      expect(response.data.local).toBe(true);
      expect(response.data.available).toBe(true);
    });

    it('returns redirect details and does not join socket room on remote-owned join', async () => {
      const { gateway, rooms } = createGatewayHarness();
      rooms.joinRoom.mockRejectedValueOnce(
        new RoomOwnerRedirectException({
          roomId: 'room-1',
          ownerNodeId: 'node-a',
          ownerUrl: 'https://node-a.example.test',
          reason: 'room_owned_by_remote_node'
        })
      );
      const socket = {
        id: 'viewer-socket',
        data: { user: { id: 'user-1', email: 'viewer@example.test', roles: ['participant'] } },
        join: jest.fn(),
        to: jest.fn(() => ({ emit: jest.fn() }))
      };
      const ack = jest.fn();

      await gateway.joinRoom(socket as never, { roomId: 'room-1', displayName: 'Viewer' }, ack);

      expect(socket.join).not.toHaveBeenCalled();
      const response = ack.mock.calls[0]![0];
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('ROOM_REDIRECT');
      expect(response.error.message).toBe('Room is owned by node node-a');
      expect(response.error.details.ownerNodeId).toBe('node-a');
      expect(response.error.details.ownerUrl).toBe('https://node-a.example.test');
    });
  });
});

interface GatewayRoomsHarness {
  onConsumerLayerEvent: jest.Mock;
  onProducerDynacastEvent: jest.Mock;
  onConsumerScoreUpdated: jest.Mock;
  onProducerScoreUpdated: jest.Mock;
  onTransportQualityUpdated: jest.Mock;
  onRoomQualityUpdated: jest.Mock;
  onRoomFailed: jest.Mock;
  lookupRoomOwner: jest.Mock;
  joinRoom: jest.Mock;
  producerDynacastSignalTarget: jest.Mock;
  recordDynacastSignalDelivery: jest.Mock;
  recordDynacastSignalFailure: jest.Mock;
  leaveRoomForSocket: jest.Mock;
}

function createGatewayHarness(options: { targetMissing?: boolean } = {}): {
  gateway: RoomsGateway;
  rooms: GatewayRoomsHarness;
  emitSignal: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void;
  emitProducerDynacast: (event: ProducerDynacastEvent) => void;
  emitConsumerLayer: (event: ConsumerLayerEvent) => void;
  emitRoomFailure: (event: RoomFailureEvent) => void;
  emissions: Array<{ target: string; event: string; payload: unknown }>;
} {
  let consumerLayerListener: ((event: ConsumerLayerEvent) => void) | undefined;
  let producerDynacastListener: ((event: ProducerDynacastEvent) => void) | undefined;
  let roomFailureListener: ((event: RoomFailureEvent) => void) | undefined;
  let signalListener:
    | ((signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void)
    | undefined;
  const rooms = {
    onConsumerLayerEvent: jest.fn((listener: (event: ConsumerLayerEvent) => void) => {
      consumerLayerListener = listener;
      return jest.fn();
    }),
    onProducerDynacastEvent: jest.fn((listener: (event: ProducerDynacastEvent) => void) => {
      producerDynacastListener = listener;
      return jest.fn();
    }),
    onConsumerScoreUpdated: jest.fn(() => jest.fn()),
    onProducerScoreUpdated: jest.fn(() => jest.fn()),
    onTransportQualityUpdated: jest.fn(() => jest.fn()),
    onRoomQualityUpdated: jest.fn(() => jest.fn()),
    onRoomFailed: jest.fn((listener: (event: RoomFailureEvent) => void) => {
      roomFailureListener = listener;
      return jest.fn();
    }),
    lookupRoomOwner: jest.fn(async (roomId: string) => ({
      roomId,
      local: true,
      available: true,
      owner: {
        roomId,
        nodeId: 'node-a',
        publicUrl: 'https://node-a.example.test',
        claimedAt: '2026-06-16T00:00:00.000Z',
        lastHeartbeatAt: '2026-06-16T00:00:00.000Z',
        expiresAt: '2026-06-16T00:00:30.000Z'
      }
    })),
    joinRoom: jest.fn(),
    producerDynacastSignalTarget: jest.fn(async (_event: ProducerDynacastEvent, roomSocketCount: number) =>
      options.targetMissing
        ? undefined
        : {
            socketId: 'publisher-socket',
            roomSocketCount,
            suppressedSubscribers: roomSocketCount - 1
          }
    ),
    recordDynacastSignalDelivery: jest.fn(),
    recordDynacastSignalFailure: jest.fn(),
    leaveRoomForSocket: jest.fn(async () => ({ closed: false, left: true }))
  };
  const signals = {
    onSignal: jest.fn((listener: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void) => {
      signalListener = listener;
      return jest.fn();
    }),
    publish: jest.fn(async () => undefined)
  };
  const gateway = new RoomsGateway(rooms as never, {} as never, signals as never);
  const emissions: Array<{ target: string; event: string; payload: unknown }> = [];
  gateway.server = {
    to: (target: string) => ({
      emit: (event: string, ...payload: unknown[]) => emissions.push({ target, event, payload: payload.length <= 1 ? payload[0] : payload })
    }),
    in: () => ({
      fetchSockets: async () => [{ id: 'publisher-socket' }, { id: 'subscriber-a' }, { id: 'subscriber-b' }]
    })
  } as never;

  return {
    gateway,
    rooms,
    emitSignal: (signal) => {
      if (!signalListener) {
        throw new Error('Room signal listener was not registered');
      }
      signalListener(signal);
    },
    emitProducerDynacast: (event) => {
      if (!producerDynacastListener) {
        throw new Error('Producer Dynacast listener was not registered');
      }
      producerDynacastListener(event);
    },
    emitConsumerLayer: (event: ConsumerLayerEvent) => {
      if (!consumerLayerListener) {
        throw new Error('Consumer layer listener was not registered');
      }
      consumerLayerListener(event);
    },
    emitRoomFailure: (event: RoomFailureEvent) => {
      if (!roomFailureListener) {
        throw new Error('Room failure listener was not registered');
      }
      roomFailureListener(event);
    },
    emissions
  };
}

function dynacastEvent(type: ProducerDynacastEvent['type']): ProducerDynacastEvent {
  const state = {
    producerId: 'producer-1',
    roomId: 'room-1',
    participantId: 'publisher',
    enabled: true,
    activeLayers: [{ spatialLayer: 0 }, { spatialLayer: 1 }, { spatialLayer: 2 }],
    desiredLayers: [{ spatialLayer: 0 }],
    suspendedLayers: [{ spatialLayer: 1 }, { spatialLayer: 2 }],
    highestRequiredSpatialLayer: 0,
    layers: [],
    layerDemandChanges: 1,
    layerResumeCount: 1,
    layerSuspendCount: 2,
    estimatedBandwidthSavedBps: 3_400_000,
    estimatedIngressBandwidthSavedBps: 3_400_000,
    activeLayerDurationMs: 100,
    suspendedLayerDurationMs: 200,
    reason: 'consumer_joined' as const,
    updatedAt: '2026-06-16T00:00:00.000Z'
  };
  return {
    type,
    producerId: 'producer-1',
    roomId: 'room-1',
    participantId: 'publisher',
    enabled: true,
    activeLayers: state.activeLayers,
    desiredLayers: state.desiredLayers,
    suspendedLayers: state.suspendedLayers,
    neededLayers: type === 'layers-needed' ? [{ spatialLayer: 0 }] : [],
    unneededLayers: type === 'layers-unneeded' ? [{ spatialLayer: 2 }] : [],
    reason: state.reason,
    estimatedBandwidthSavedBps: state.estimatedBandwidthSavedBps,
    state,
    timestamp: state.updatedAt
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
