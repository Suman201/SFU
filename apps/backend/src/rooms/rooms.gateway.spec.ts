import { ForbiddenException } from '@nestjs/common';
import type {
  ChatMessage,
  ChatReadState,
  ConsumerLayerEvent,
  ClassSessionLifecycleEvent,
  ProducerDynacastEvent,
  RoomFailureEvent,
  RoomIncidentState,
  RoomIncidentTimelineEvent,
  RoomQualityState,
  RoomSnapshotBundleSummary,
  StudentMediaModerationEvent,
  TransportQualityState
} from '@native-sfu/contracts';
import { RoomOwnerRedirectException } from '../cluster/node-registry.service';
import { RoomsGateway } from './rooms.gateway';

describe('RoomsGateway', () => {
  it('disconnects unauthorized sockets', async () => {
    const { gateway } = createGatewayHarness();
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

    it('re-emits cross-node targeted room signals only to matching local sockets', () => {
      const { emitSignal, emissions, socketRegistry } = createGatewayHarness();
      const message: ChatMessage = {
        id: 'chat-remote-1',
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        channelId: 'classroom:session-1:chat',
        chatChannelId: 'classroom:session-1:chat',
        senderId: 'student-participant',
        senderName: 'Student One',
        senderRole: 'student',
        recipientId: 'teacher-participant',
        scope: 'private',
        message: 'Can you review this?',
        shadowMuted: false,
        createdAt: '2026-06-22T10:05:00.000Z'
      };
      socketRegistry.set('student-socket-a', socketStub({ roomId: 'room-1', participantId: 'student-participant', userId: 'student-1' }));
      socketRegistry.set('teacher-socket', socketStub({ roomId: 'room-1', participantId: 'teacher-participant', userId: 'teacher-1' }));
      socketRegistry.set('student-two-socket', socketStub({ roomId: 'room-1', participantId: 'student-two-participant', userId: 'student-2' }));

      emitSignal({
        sourceNodeId: 'node-b',
        roomId: 'room-1',
        event: 'chat:message',
        payload: [message],
        target: {
          socketIds: ['student-socket-a', 'teacher-socket'],
          participantIds: ['student-participant', 'teacher-participant'],
          userIds: ['student-1', 'teacher-1']
        }
      });

      expect(emissions).toEqual([
        { target: 'student-socket-a', event: 'chat:message', payload: message },
        { target: 'teacher-socket', event: 'chat:message', payload: message }
      ]);
      expect(emissions.some((emission) => emission.target === 'student-two-socket')).toBe(false);
    });

    it('emits room closed when the room service closes a room outside a socket action', async () => {
      const { emitRoomClosed, emissions, signals } = createGatewayHarness();

      emitRoomClosed('room-1');
      await flushPromises();

      expect(emissions).toEqual([{ target: 'room-1', event: 'room:closed', payload: 'room-1' }]);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:closed', 'room-1');
    });

    it('lets sockets watch a class-session lifecycle channel', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const socket = {
        data: { user: { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] } },
        join: jest.fn(async (_roomId: string) => undefined)
      };
      const ack = jest.fn();

      await gateway.watchSession(socket as never, { sessionId: 'session-1' }, ack);

      expect(rooms.assertCanWatchClassSession).toHaveBeenCalledWith('session-1', {
        id: 'student-1',
        email: 'student@example.test',
        roles: ['STUDENT']
      });
      expect(socket.join).toHaveBeenCalledWith('class-session:session-1:lifecycle');
      expect(ack).toHaveBeenCalledWith({ ok: true, data: undefined });
    });

    it('rejects lifecycle watchers who cannot access the class session', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const socket = {
        data: { user: { id: 'student-2', email: 'student.two@example.test', roles: ['STUDENT'] } },
        join: jest.fn(async (_roomId: string) => undefined)
      };
      rooms.assertCanWatchClassSession.mockRejectedValueOnce(new ForbiddenException('You are not allowed to open this class session.'));
      const ack = jest.fn();

      await gateway.watchSession(socket as never, { sessionId: 'session-1' }, ack);

      expect(socket.join).not.toHaveBeenCalled();
      expect(ack.mock.calls[0]?.[0]).toEqual({
        ok: false,
        error: {
          code: 'ForbiddenException',
          message: 'You are not allowed to open this class session.'
        }
      });
    });

    it('rejects malformed lifecycle watch session ids before joining a room', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const socket = {
        data: { user: { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] } },
        join: jest.fn(async (_roomId: string) => undefined)
      };
      const ack = jest.fn();

      await gateway.watchSession(socket as never, { sessionId: 'session 1' }, ack);

      expect(rooms.assertCanWatchClassSession).not.toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
      expect(ack.mock.calls[0]?.[0]).toEqual({
        ok: false,
        error: {
          code: 'BadRequestException',
          message: 'Invalid class session id.'
        }
      });
    });

    it('leaves lifecycle watcher rooms idempotently without reauthorizing', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const socket = {
        data: { user: { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] } },
        leave: jest.fn(async (_roomId: string) => undefined)
      };
      const ack = jest.fn();

      await gateway.unwatchSession(socket as never, { sessionId: 'session-1' }, ack);

      expect(rooms.assertCanWatchClassSession).not.toHaveBeenCalled();
      expect(socket.leave).toHaveBeenCalledWith('class-session:session-1:lifecycle');
      expect(ack).toHaveBeenCalledWith({ ok: true, data: undefined });
    });

    it('rejects malformed lifecycle unwatch session ids without leaving arbitrary rooms', async () => {
      const { gateway } = createGatewayHarness();
      const socket = {
        data: { user: { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] } },
        leave: jest.fn(async (_roomId: string) => undefined)
      };
      const ack = jest.fn();

      await gateway.unwatchSession(socket as never, { sessionId: 'session 1' }, ack);

      expect(socket.leave).not.toHaveBeenCalled();
      expect(ack.mock.calls[0]?.[0]).toEqual({
        ok: false,
        error: {
          code: 'BadRequestException',
          message: 'Invalid class session id.'
        }
      });
    });

    it('broadcasts class-session lifecycle events to watchers', async () => {
      const { emitClassSessionLifecycle, emissions, signals } = createGatewayHarness();
      const payload: ClassSessionLifecycleEvent = {
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        status: 'live',
        startedAt: '2026-06-22T10:00:00.000Z'
      };

      emitClassSessionLifecycle('session:started', payload);
      await flushPromises();

      expect(emissions).toEqual([{ target: 'class-session:session-1:lifecycle', event: 'session:started', payload }]);
      expect(signals.publish).toHaveBeenCalledWith('class-session:session-1:lifecycle', 'session:started', payload);
    });

    it('targets private chat messages after chat send ack succeeds', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const message: ChatMessage = {
        id: 'chat-1',
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        channelId: 'classroom:session-1:chat',
        chatChannelId: 'classroom:session-1:chat',
        senderId: 'student-participant',
        senderName: 'Student One',
        senderRole: 'student',
        recipientId: 'teacher-participant',
        scope: 'private',
        message: 'Hello class',
        shadowMuted: false,
        createdAt: '2026-06-22T10:05:00.000Z'
      };
      rooms.sendChat.mockResolvedValue({
        message,
        targets: [
          { roomId: 'room-1', participantId: 'student-participant', socketId: 'student-socket-a', userId: 'student-1', nodeId: 'node-a' },
          { roomId: 'room-1', participantId: 'student-participant', socketId: 'student-socket-b', userId: 'student-1', nodeId: 'node-b' },
          { roomId: 'room-1', participantId: 'teacher-participant', socketId: 'teacher-socket', userId: 'teacher-1', nodeId: 'node-a' }
        ]
      });
      const ack = jest.fn();

      await gateway.sendChat(
        { data: { participantId: 'student-participant' } } as never,
        { roomId: 'room-1', message: 'Hello class', scope: 'private' },
        ack
      );

      expect(rooms.sendChat).toHaveBeenCalledWith({ roomId: 'room-1', message: 'Hello class', scope: 'private' }, 'student-participant');
      expect(emissions).toEqual([
        { target: 'student-socket-a', event: 'chat:message', payload: message },
        { target: 'student-socket-b', event: 'chat:message', payload: message },
        { target: 'teacher-socket', event: 'chat:message', payload: message }
      ]);
      expect(signals.publish).not.toHaveBeenCalledWith('room-1', 'chat:message', message);
      expect(signals.publishTargeted).toHaveBeenCalledWith(
        'room-1',
        {
          socketIds: ['student-socket-a', 'student-socket-b', 'teacher-socket'],
          participantIds: ['student-participant', 'teacher-participant'],
          userIds: ['student-1', 'teacher-1'],
          nodeIds: ['node-a', 'node-b']
        },
        'chat:message',
        message
      );
      expect(ack).toHaveBeenCalledWith({ ok: true, data: message });
    });

    it('broadcasts explicit teacher chat announcements to the room', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const message: ChatMessage = {
        id: 'chat-2',
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        channelId: 'classroom:session-1:chat',
        chatChannelId: 'classroom:session-1:chat',
        senderId: 'teacher-participant',
        senderName: 'Teacher One',
        senderRole: 'teacher',
        scope: 'broadcast',
        message: 'Wrap up in five minutes',
        shadowMuted: false,
        createdAt: '2026-06-22T10:07:00.000Z'
      };
      rooms.sendChat.mockResolvedValue({ message, broadcastRoomId: 'room-1' });
      const ack = jest.fn();

      await gateway.sendChat(
        { data: { participantId: 'teacher-participant' } } as never,
        { roomId: 'room-1', message: 'Wrap up in five minutes', scope: 'broadcast' },
        ack
      );

      expect(emissions).toEqual([{ target: 'room-1', event: 'chat:message', payload: message }]);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'chat:message', message);
      expect(ack).toHaveBeenCalledWith({ ok: true, data: message });
    });

    it('acks chat read state updates without broadcasting them to the room', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const readState: ChatReadState = {
        id: 'read-1',
        sessionId: 'session-1',
        roomId: 'room-1',
        userId: 'student-1',
        participantId: 'student-participant',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-1:student:student-1',
        lastReadAt: '2026-06-22T10:12:00.000Z',
        updatedAt: '2026-06-22T10:12:00.000Z'
      };
      rooms.markChatRead.mockResolvedValue(readState);
      const ack = jest.fn();

      await gateway.markChatRead(
        {
          id: 'student-socket',
          data: {
            user: { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] },
            participantId: 'student-participant'
          }
        } as never,
        { sessionId: 'session-1', roomId: 'room-1', scope: 'private' },
        ack
      );

      expect(rooms.markChatRead).toHaveBeenCalledWith(
        { sessionId: 'session-1', roomId: 'room-1', scope: 'private' },
        { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] },
        'student-participant'
      );
      expect(emissions).toEqual([{ target: 'student-socket', event: 'chat:read', payload: readState }]);
      expect(signals.publish).not.toHaveBeenCalledWith('room-1', 'chat:read', readState);
      expect(ack).toHaveBeenCalledWith({ ok: true, data: readState });
    });

    it('targets class-session student media moderation and broadcasts state updates', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const event: StudentMediaModerationEvent = {
        roomId: 'room-1',
        participantId: 'student-participant',
        producerId: 'producer-audio',
        kind: 'audio',
        action: 'mute-mic',
        moderatedByParticipantId: 'teacher-participant'
      };
      const producer = {
        id: 'producer-audio',
        roomId: 'room-1',
        participantId: 'student-participant',
        kind: 'audio',
        status: 'paused'
      };
      const permissions = {
        canPublishAudio: false,
        canPublishVideo: true,
        canShareScreen: false,
        canChat: true
      };
      rooms.moderateStudentMedia.mockResolvedValue({
        event,
        permissions,
        producer,
        targets: [
          { roomId: 'room-1', participantId: 'student-participant', socketId: 'student-socket-a', userId: 'student-1', nodeId: 'node-a' },
          { roomId: 'room-1', participantId: 'student-participant', socketId: 'student-socket-b', userId: 'student-1', nodeId: 'node-b' }
        ]
      });
      const ack = jest.fn();

      await gateway.muteStudentMicrophone(
        { data: { participantId: 'teacher-participant' } } as never,
        { roomId: 'room-1', participantId: 'student-participant' },
        ack
      );

      expect(rooms.moderateStudentMedia).toHaveBeenCalledWith(
        'room-1',
        'teacher-participant',
        'student-participant',
        'mute-mic'
      );
      expect(emissions).toEqual([
        { target: 'room-1', event: 'producer:updated', payload: producer },
        { target: 'room-1', event: 'participant:updated', payload: ['student-participant', { audioEnabled: false }] },
        { target: 'room-1', event: 'permissions:updated', payload: ['student-participant', permissions] },
        { target: 'student-socket-a', event: 'student:media-moderated', payload: event },
        { target: 'student-socket-b', event: 'student:media-moderated', payload: event }
      ]);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'producer:updated', producer);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'participant:updated', 'student-participant', { audioEnabled: false });
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'permissions:updated', 'student-participant', permissions);
      expect(signals.publish).not.toHaveBeenCalledWith('room-1', 'student:media-moderated', event);
      expect(signals.publishTargeted).toHaveBeenCalledWith(
        'room-1',
        {
          socketIds: ['student-socket-a', 'student-socket-b'],
          participantIds: ['student-participant'],
          userIds: ['student-1'],
          nodeIds: ['node-a', 'node-b']
        },
        'student:media-moderated',
        event
      );
      expect(ack).toHaveBeenCalledWith({ ok: true, data: event });
    });

    it('targets class-session student media restore without broadcasting participant media on', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const permissions = {
        canPublishAudio: true,
        canPublishVideo: true,
        canShareScreen: false,
        canChat: true
      };
      const event: StudentMediaModerationEvent = {
        roomId: 'room-1',
        participantId: 'student-participant',
        kind: 'audio',
        action: 'unmute-mic',
        moderatedByParticipantId: 'teacher-participant',
        permissions,
        message: 'Teacher allowed your microphone. You can turn it on when ready.'
      };
      rooms.moderateStudentMedia.mockResolvedValue({
        event,
        permissions,
        targets: [
          { roomId: 'room-1', participantId: 'student-participant', socketId: 'student-socket-a', userId: 'student-1', nodeId: 'node-a' },
          { roomId: 'room-1', participantId: 'student-participant', socketId: 'student-socket-b', userId: 'student-1', nodeId: 'node-b' }
        ]
      });
      const ack = jest.fn();

      await gateway.unmuteStudentMicrophone(
        { data: { participantId: 'teacher-participant' } } as never,
        { roomId: 'room-1', participantId: 'student-participant' },
        ack
      );

      expect(rooms.moderateStudentMedia).toHaveBeenCalledWith(
        'room-1',
        'teacher-participant',
        'student-participant',
        'unmute-mic'
      );
      expect(emissions).toEqual([
        { target: 'room-1', event: 'permissions:updated', payload: ['student-participant', permissions] },
        { target: 'student-socket-a', event: 'student:media-moderated', payload: event },
        { target: 'student-socket-b', event: 'student:media-moderated', payload: event }
      ]);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'permissions:updated', 'student-participant', permissions);
      expect(signals.publish).not.toHaveBeenCalledWith('room-1', 'participant:updated', 'student-participant', { audioEnabled: true });
      expect(signals.publishTargeted).toHaveBeenCalledWith(
        'room-1',
        {
          socketIds: ['student-socket-a', 'student-socket-b'],
          participantIds: ['student-participant'],
          userIds: ['student-1'],
          nodeIds: ['node-a', 'node-b']
        },
        'student:media-moderated',
        event
      );
      expect(ack).toHaveBeenCalledWith({ ok: true, data: event });
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

    it('emits teacher reconnecting state instead of participant left during class-session grace', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const room = { id: 'room-1', participants: [], producers: [], consumers: [] };
      rooms.leaveRoomForSocket.mockResolvedValueOnce({
        closed: false,
        left: true,
        reconnecting: true,
        participantPatch: { connected: false, screenSharing: false },
        room
      });
      const socket = {
        id: 'teacher-socket',
        data: { roomId: 'room-1', participantId: 'teacher-participant' }
      };

      await gateway.handleDisconnect(socket as never);

      expect(emissions).toEqual([
        {
          target: 'room-1',
          event: 'participant:updated',
          payload: ['teacher-participant', { connected: false, screenSharing: false }]
        },
        { target: 'room-1', event: 'room:updated', payload: room }
      ]);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'participant:updated', 'teacher-participant', {
        connected: false,
        screenSharing: false
      });
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:updated', room);
      expect(emissions.some((emission) => emission.event === 'participant:left')).toBe(false);
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

    it('publishes transport quality updates through the cross-node room signal path', async () => {
      const { emitTransportQuality, emissions, signals } = createGatewayHarness();
      const state: TransportQualityState = {
        roomId: 'room-1',
        participantId: 'subscriber',
        transportId: 'transport-1',
        score: {
          score: 84,
          level: 'good',
          reasons: ['stable'],
          breakdown: {
            packetLossScore: 90,
            rttScore: 88,
            jitterScore: 86,
            congestionScore: 80,
            retransmissionScore: 84,
            allocationScore: 92
          },
          updatedAt: '2026-06-17T00:00:00.000Z'
        },
        consumers: [],
        producers: [],
        targetBitrate: 900000,
        allocatedBitrate: 820000,
        actualBitrate: 780000,
        pacingQueueDepth: 0,
        updatedAt: '2026-06-17T00:00:00.000Z'
      };

      emitTransportQuality(state);
      await flushPromises();

      expect(
        emissions.some(
          (emission) =>
            emission.target === 'room-1' &&
            emission.event === 'transport:quality-updated' &&
            emission.payload === state
        )
      ).toBe(true);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'transport:quality-updated', state);
    });

    it('publishes room quality updates through the cross-node room signal path', async () => {
      const { emitRoomQuality, emissions, signals } = createGatewayHarness();
      const state: RoomQualityState = {
        roomId: 'room-1',
        score: {
          score: 76,
          level: 'good',
          reasons: ['stable'],
          breakdown: {
            packetLossScore: 82,
            rttScore: 80,
            jitterScore: 78,
            congestionScore: 74,
            retransmissionScore: 72,
            allocationScore: 84
          },
          updatedAt: '2026-06-17T00:00:00.000Z'
        },
        consumers: [],
        producers: [],
        transports: [],
        targetBitrate: 1_500_000,
        allocatedBitrate: 1_300_000,
        actualBitrate: 1_100_000,
        congestionState: 'normal',
        updatedAt: '2026-06-17T00:00:00.000Z'
      };

      emitRoomQuality(state);
      await flushPromises();

      expect(
        emissions.some(
          (emission) => emission.target === 'room-1' && emission.event === 'room:quality-updated' && emission.payload === state
        )
      ).toBe(true);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:quality-updated', state);
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

    it('publishes incident state, timeline, and snapshot updates onto the room signal path', async () => {
      const { emitRoomIncidentState, emitRoomIncidentEvent, emitSnapshotGenerated, emissions, signals } = createGatewayHarness();
      const state: RoomIncidentState = {
        roomId: 'room-1',
        status: 'recovering',
        health: 'critical',
        protected: true,
        admissionsState: 'protected',
        publishingState: 'paused',
        underRecovery: true,
        activeAlerts: [],
        snapshotCount: 1,
        updatedAt: '2026-06-19T00:00:00.000Z'
      };
      const event: RoomIncidentTimelineEvent = {
        id: 'incident-1',
        roomId: 'room-1',
        type: 'manual_action',
        severity: 'warn',
        summary: 'Operator protected the room',
        createdAt: '2026-06-19T00:00:01.000Z'
      };
      const snapshot: RoomSnapshotBundleSummary = {
        bundleId: 'bundle-1',
        roomId: 'room-1',
        generatedAt: '2026-06-19T00:00:02.000Z',
        triggerReason: 'manual_operator',
        automatic: false,
        health: 'critical',
        status: 'recovering',
        protected: true,
        underRecovery: true,
        degradedEntityCount: 3,
        warningCount: 2
      };

      emitRoomIncidentState(state);
      emitRoomIncidentEvent(event);
      emitSnapshotGenerated(snapshot);
      await flushPromises();

      expect(
        emissions.some((emission) => emission.target === 'room-1' && emission.event === 'room:incident-updated' && emission.payload === state)
      ).toBe(true);
      expect(
        emissions.some((emission) => emission.target === 'room-1' && emission.event === 'room:incident-event' && emission.payload === event)
      ).toBe(true);
      expect(
        emissions.some((emission) => emission.target === 'room-1' && emission.event === 'room:snapshot-generated' && emission.payload === snapshot)
      ).toBe(true);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:incident-updated', state);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:incident-event', event);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:snapshot-generated', snapshot);
    });

    it('returns incident state over Socket.IO', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const ack = jest.fn();

      await gateway.getRoomIncidentState({ data: { participantId: 'host-1' } } as never, { roomId: 'room-1' }, ack);

      expect(rooms.getRoomIncidentState).toHaveBeenCalledWith('room-1', 'host-1');
      expect((ack.mock.calls[0]![0] as any).ok).toBe(true);
      expect((ack.mock.calls[0]![0] as any).data.roomId).toBe('room-1');
    });

    it('runs a recovery action and broadcasts the updated room', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const ack = jest.fn();

      await gateway.runRoomRecoveryAction(
        { data: { participantId: 'host-1' } } as never,
        { roomId: 'room-1', action: 'protect_room', reason: 'Protect while congestion clears' },
        ack
      );

      expect(rooms.runRoomRecoveryAction).toHaveBeenCalledWith(
        { roomId: 'room-1', action: 'protect_room', reason: 'Protect while congestion clears' },
        'host-1'
      );
      expect(
        emissions.some((emission) => emission.target === 'room-1' && emission.event === 'room:updated' && (emission.payload as any).id === 'room-1')
      ).toBe(true);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'room:updated', { id: 'room-1' });
      expect((ack.mock.calls[0]![0] as any).ok).toBe(true);
      expect((ack.mock.calls[0]![0] as any).data.action).toBe('protect_room');
    });

    it('returns transport quality over Socket.IO', async () => {
      const { gateway, rooms } = createGatewayHarness();
      const ack = jest.fn();

      await gateway.getTransportQuality(
        {
          data: {
            participantId: 'participant-1'
          }
        } as never,
        { transportId: 'transport-1' },
        ack
      );

      expect(rooms.getTransportQualityState).toHaveBeenCalledWith('transport-1', 'participant-1');
      const response = ack.mock.calls[0]![0] as any;
      expect(response.ok).toBe(true);
      expect(response.data.transportId).toBe('transport-1');
    });

    it('keeps pending joiners out of the Socket.IO room until they are admitted', async () => {
      const { gateway, rooms, emissions, signals } = createGatewayHarness();
      const pendingParticipant = {
        id: 'participant-2',
        socketId: 'pending-socket',
        admitted: false
      };
      rooms.joinRoom.mockResolvedValue({
        room: {
          id: 'room-1',
          participants: [pendingParticipant]
        },
        participantId: 'participant-2',
        admitted: false,
        admissionDecision: {
          scope: 'join',
          health: 'degraded',
          action: 'soft-throttle',
          code: 'profile_policy',
          message: 'New room joins should be slowed or manually admitted until the room stabilizes.',
          triggeredBy: ['profile'],
          updatedAt: '2026-06-19T00:00:00.000Z'
        }
      });
      const socket: {
        id: string;
        data: {
          user: { id: string; email: string; roles: string[] };
          roomId?: string;
          participantId?: string;
        };
        join: jest.Mock;
      } = {
        id: 'pending-socket',
        data: { user: { id: 'user-2', email: 'viewer@example.test', roles: ['participant'] } },
        join: jest.fn()
      };
      const ack = jest.fn();

      await gateway.joinRoom(socket as never, { roomId: 'room-1', displayName: 'Viewer' }, ack);

      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.data.roomId).toBe('room-1');
      expect(socket.data.participantId).toBe('participant-2');
      expect(emissions).toEqual([{ target: 'room-1', event: 'waiting-room:pending', payload: pendingParticipant }]);
      expect(signals.publish).toHaveBeenCalledWith('room-1', 'waiting-room:pending', pendingParticipant);
      expect(ack.mock.calls[0]![0]?.ok).toBe(true);
      expect(ack.mock.calls[0]![0]?.data?.participantId).toBe('participant-2');
      expect(ack.mock.calls[0]![0]?.data?.admitted).toBe(false);
    });

    it('joins the admitted participant socket before broadcasting room admission events', async () => {
      const { gateway, rooms, emissions, signals, socketRegistry } = createGatewayHarness();
      const pendingSocket: { join: jest.Mock<Promise<void>, [string]> } = {
        join: jest.fn(async (_roomId: string) => undefined)
      };
      const admittedParticipant = {
        id: 'participant-2',
        socketId: 'pending-socket',
        admitted: true
      };
      const room = {
        id: 'room-1',
        participants: [admittedParticipant]
      };
      socketRegistry.set('pending-socket', pendingSocket as never);
      rooms.admit.mockResolvedValue(room);
      const socket = {
        data: { participantId: 'host-1' }
      };
      const ack = jest.fn();

      await gateway.admit(socket as never, { roomId: 'room-1', participantId: 'participant-2' }, ack);

      expect(pendingSocket.join).toHaveBeenCalledWith('room-1');
      expect(emissions).toEqual([
        { target: 'room-1', event: 'participant:joined', payload: admittedParticipant },
        { target: 'room-1', event: 'room:updated', payload: room }
      ]);
      expect(signals.publish.mock.calls).toEqual([
        ['room-1', 'participant:joined', admittedParticipant],
        ['room-1', 'room:updated', room]
      ]);
      expect(ack.mock.calls[0]![0]).toEqual({ ok: true, data: undefined });
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
  onRoomQualitySummaryUpdated: jest.Mock;
  onRoomIncidentStateUpdated: jest.Mock;
  onRoomIncidentTimelineEvent: jest.Mock;
  onRoomSnapshotGenerated: jest.Mock;
  onRoomFailed: jest.Mock;
  onRoomClosed: jest.Mock;
  onClassSessionLifecycleEvent: jest.Mock;
  assertCanWatchClassSession: jest.Mock;
  lookupRoomOwner: jest.Mock;
  getTransportQualityState: jest.Mock;
  getRoomIncidentState: jest.Mock;
  getRoomIncidentTimeline: jest.Mock;
  getRoomSnapshotHistory: jest.Mock;
  runRoomRecoveryAction: jest.Mock;
  joinRoom: jest.Mock;
  admit: jest.Mock;
  sendChat: jest.Mock;
  markChatRead: jest.Mock;
  moderateStudentMedia: jest.Mock;
  producerDynacastSignalTarget: jest.Mock;
  recordDynacastSignalDelivery: jest.Mock;
  recordDynacastSignalFailure: jest.Mock;
  leaveRoomForSocket: jest.Mock;
}

function createGatewayHarness(options: { targetMissing?: boolean } = {}): {
  gateway: RoomsGateway;
  rooms: GatewayRoomsHarness;
  signals: { publish: jest.Mock; publishTargeted: jest.Mock };
  emitSignal: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[]; target?: Record<string, string[]> }) => void;
  emitProducerDynacast: (event: ProducerDynacastEvent) => void;
  emitConsumerLayer: (event: ConsumerLayerEvent) => void;
  emitTransportQuality: (state: TransportQualityState) => void;
  emitRoomQuality: (state: RoomQualityState) => void;
  emitRoomQualitySummary: (state: unknown) => void;
  emitRoomIncidentState: (state: RoomIncidentState) => void;
  emitRoomIncidentEvent: (event: RoomIncidentTimelineEvent) => void;
  emitSnapshotGenerated: (summary: RoomSnapshotBundleSummary) => void;
  emitRoomFailure: (event: RoomFailureEvent) => void;
  emitRoomClosed: (roomId: string) => void;
  emitClassSessionLifecycle: (event: 'session:started' | 'session:ended', payload: ClassSessionLifecycleEvent) => void;
  emissions: Array<{ target: string; event: string; payload: unknown }>;
  socketRegistry: Map<string, ReturnType<typeof socketStub>>;
} {
  let consumerLayerListener: ((event: ConsumerLayerEvent) => void) | undefined;
  let producerDynacastListener: ((event: ProducerDynacastEvent) => void) | undefined;
  let transportQualityListener: ((state: TransportQualityState) => void) | undefined;
  let roomQualityListener: ((state: RoomQualityState) => void) | undefined;
  let roomQualitySummaryListener: ((state: unknown) => void) | undefined;
  let roomIncidentStateListener: ((state: RoomIncidentState) => void) | undefined;
  let roomIncidentEventListener: ((event: RoomIncidentTimelineEvent) => void) | undefined;
  let snapshotGeneratedListener: ((summary: RoomSnapshotBundleSummary) => void) | undefined;
  let roomFailureListener: ((event: RoomFailureEvent) => void) | undefined;
  let roomClosedListener: ((roomId: string) => void) | undefined;
  let classSessionLifecycleListener:
    | ((event: 'session:started' | 'session:ended', payload: ClassSessionLifecycleEvent) => void)
    | undefined;
  let signalListener:
    | ((signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[]; target?: Record<string, string[]> }) => void)
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
    onTransportQualityUpdated: jest.fn((listener: (state: TransportQualityState) => void) => {
      transportQualityListener = listener;
      return jest.fn();
    }),
    onRoomQualityUpdated: jest.fn((listener: (state: RoomQualityState) => void) => {
      roomQualityListener = listener;
      return jest.fn();
    }),
    onRoomQualitySummaryUpdated: jest.fn((listener: (state: unknown) => void) => {
      roomQualitySummaryListener = listener;
      return jest.fn();
    }),
    onRoomIncidentStateUpdated: jest.fn((listener: (state: RoomIncidentState) => void) => {
      roomIncidentStateListener = listener;
      return jest.fn();
    }),
    onRoomIncidentTimelineEvent: jest.fn((listener: (event: RoomIncidentTimelineEvent) => void) => {
      roomIncidentEventListener = listener;
      return jest.fn();
    }),
    onRoomSnapshotGenerated: jest.fn((listener: (summary: RoomSnapshotBundleSummary) => void) => {
      snapshotGeneratedListener = listener;
      return jest.fn();
    }),
    onRoomFailed: jest.fn((listener: (event: RoomFailureEvent) => void) => {
      roomFailureListener = listener;
      return jest.fn();
    }),
    onRoomClosed: jest.fn((listener: (roomId: string) => void) => {
      roomClosedListener = listener;
      return jest.fn();
    }),
    onClassSessionLifecycleEvent: jest.fn((listener: (event: 'session:started' | 'session:ended', payload: ClassSessionLifecycleEvent) => void) => {
      classSessionLifecycleListener = listener;
      return jest.fn();
    }),
    assertCanWatchClassSession: jest.fn(async () => undefined),
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
    getTransportQualityState: jest.fn(async (transportId: string) => ({
      roomId: 'room-1',
      participantId: 'participant-1',
      transportId,
      score: {
        score: 84,
        level: 'good',
        reasons: ['stable'],
        breakdown: {
          packetLossScore: 90,
          rttScore: 88,
          jitterScore: 86,
          congestionScore: 80,
          retransmissionScore: 84,
          allocationScore: 92
        },
        updatedAt: '2026-06-17T00:00:00.000Z'
      },
      consumers: [],
      producers: [],
      targetBitrate: 900000,
      allocatedBitrate: 820000,
      actualBitrate: 780000,
      pacingQueueDepth: 0,
      updatedAt: '2026-06-17T00:00:00.000Z'
    })),
    getRoomIncidentState: jest.fn(async (roomId: string) => ({
      roomId,
      status: 'stable',
      health: 'stable',
      protected: false,
      admissionsState: 'default',
      publishingState: 'default',
      underRecovery: false,
      activeAlerts: [],
      snapshotCount: 0,
      updatedAt: '2026-06-19T00:00:00.000Z'
    })),
    getRoomIncidentTimeline: jest.fn(async (request: { roomId: string; limit?: number }) => ({
      roomId: request.roomId,
      events: [],
      updatedAt: '2026-06-19T00:00:00.000Z'
    })),
    getRoomSnapshotHistory: jest.fn(async (request: { roomId: string; limit?: number }) => ({
      roomId: request.roomId,
      bundles: [],
      updatedAt: '2026-06-19T00:00:00.000Z'
    })),
    runRoomRecoveryAction: jest.fn(async (request: { roomId: string; action: string }) => ({
      roomId: request.roomId,
      action: request.action,
      executed: true,
      room: { id: request.roomId },
      incidentState: {
        roomId: request.roomId,
        status: 'recovering',
        health: 'critical',
        protected: true,
        admissionsState: 'protected',
        publishingState: 'protected',
        underRecovery: true,
        activeAlerts: [],
        snapshotCount: 1,
        updatedAt: '2026-06-19T00:00:00.000Z'
      }
    })),
    joinRoom: jest.fn(),
    admit: jest.fn(),
    sendChat: jest.fn(),
    markChatRead: jest.fn(),
    moderateStudentMedia: jest.fn(),
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
    onSignal: jest.fn((listener: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[]; target?: Record<string, string[]> }) => void) => {
      signalListener = listener;
      return jest.fn();
    }),
    publish: jest.fn(async () => undefined),
    publishTargeted: jest.fn(async () => undefined)
  };
  const gateway = new RoomsGateway(rooms as never, {} as never, signals as never);
  const emissions: Array<{ target: string; event: string; payload: unknown }> = [];
  const socketRegistry = new Map<string, ReturnType<typeof socketStub>>();
  gateway.server = {
    to: (target: string) => ({
      emit: (event: string, ...payload: unknown[]) => emissions.push({ target, event, payload: payload.length <= 1 ? payload[0] : payload })
    }),
    in: () => ({
      fetchSockets: async () => [{ id: 'publisher-socket' }, { id: 'subscriber-a' }, { id: 'subscriber-b' }]
    }),
    sockets: {
      sockets: socketRegistry
    }
  } as never;

  return {
    gateway,
    rooms,
    signals,
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
    emitTransportQuality: (state: TransportQualityState) => {
      if (!transportQualityListener) {
        throw new Error('Transport quality listener was not registered');
      }
      transportQualityListener(state);
    },
    emitRoomQuality: (state: RoomQualityState) => {
      if (!roomQualityListener) {
        throw new Error('Room quality listener was not registered');
      }
      roomQualityListener(state);
    },
    emitRoomQualitySummary: (state: unknown) => {
      if (!roomQualitySummaryListener) {
        throw new Error('Room quality summary listener was not registered');
      }
      roomQualitySummaryListener(state);
    },
    emitRoomIncidentState: (state: RoomIncidentState) => {
      if (!roomIncidentStateListener) {
        throw new Error('Room incident state listener was not registered');
      }
      roomIncidentStateListener(state);
    },
    emitRoomIncidentEvent: (event: RoomIncidentTimelineEvent) => {
      if (!roomIncidentEventListener) {
        throw new Error('Room incident timeline listener was not registered');
      }
      roomIncidentEventListener(event);
    },
    emitSnapshotGenerated: (summary: RoomSnapshotBundleSummary) => {
      if (!snapshotGeneratedListener) {
        throw new Error('Room snapshot listener was not registered');
      }
      snapshotGeneratedListener(summary);
    },
    emitRoomFailure: (event: RoomFailureEvent) => {
      if (!roomFailureListener) {
        throw new Error('Room failure listener was not registered');
      }
      roomFailureListener(event);
    },
    emitRoomClosed: (roomId: string) => {
      if (!roomClosedListener) {
        throw new Error('Room closed listener was not registered');
      }
      roomClosedListener(roomId);
    },
    emitClassSessionLifecycle: (event, payload) => {
      if (!classSessionLifecycleListener) {
        throw new Error('Class session lifecycle listener was not registered');
      }
      classSessionLifecycleListener(event, payload);
    },
    emissions,
    socketRegistry
  };
}

function socketStub(data: { roomId?: string; participantId?: string; userId?: string } = {}) {
  return {
    data: {
      ...(data.roomId ? { roomId: data.roomId } : {}),
      ...(data.participantId ? { participantId: data.participantId } : {}),
      ...(data.userId ? { user: { id: data.userId, email: `${data.userId}@example.test`, roles: ['STUDENT'] } } : {})
    },
    join: jest.fn(async (_roomId: string) => undefined)
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
