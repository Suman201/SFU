import type { DurableStreamMessageMeta } from '../redis/redis.service';
import { RoomSignalService, type RoomSignalEnvelope } from './room-signal.service';

describe('RoomSignalService', () => {
  it('publishes room events onto the durable control-plane stream', async () => {
    const harness = createHarness('node-a');

    await harness.service.publish('room-1', 'participant:joined', { participantId: 'viewer-1' });

    expect(harness.redis.publishDurable).toHaveBeenCalledTimes(1);
    const [stream, payload] = harness.redis.publishDurable.mock.calls[0]!;
    expect(stream).toBe('sfu:room-signals');
    expect(payload.roomId).toBe('room-1');
    expect(payload.sourceNodeId).toBe('node-a');
    expect(payload.event).toBe('participant:joined');
    expect(payload.payload).toEqual([{ participantId: 'viewer-1' }]);
    expect(typeof payload.eventId).toBe('string');
  });

  it('publishes targeted room events with target metadata intact', async () => {
    const harness = createHarness('node-a');
    const target = {
      socketIds: ['student-socket-a', 'teacher-socket'],
      participantIds: ['student-participant', 'teacher-participant'],
      userIds: ['student-1', 'teacher-1']
    };

    await harness.service.publishTargeted('room-1', target, 'chat:message', { id: 'chat-1' });

    expect(harness.redis.publishDurable).toHaveBeenCalledTimes(1);
    const [, payload] = harness.redis.publishDurable.mock.calls[0]!;
    expect(payload.roomId).toBe('room-1');
    expect(payload.event).toBe('chat:message');
    expect(payload.payload).toEqual([{ id: 'chat-1' }]);
    expect(payload.target).toEqual(target);
  });

  it('suppresses local echo events from the same node', async () => {
    const harness = createHarness('node-a');
    const listener = jest.fn();
    harness.service.onSignal(listener);
    await harness.service.onModuleInit();

    await harness.deliver({
      eventId: 'event-1',
      sourceNodeId: 'node-a',
      roomId: 'room-1',
      event: 'participant:joined',
      payload: [{ participantId: 'viewer-1' }]
    });

    expect(listener).not.toHaveBeenCalled();
    expect(harness.redis.setIfAbsent).not.toHaveBeenCalled();
  });

  it('suppresses duplicate replayed room events by event id', async () => {
    const harness = createHarness('node-b', { dedupeAccepted: false });
    const listener = jest.fn();
    harness.service.onSignal(listener);
    await harness.service.onModuleInit();

    await harness.deliver({
      eventId: 'event-2',
      sourceNodeId: 'node-a',
      roomId: 'room-1',
      event: 'participant:left',
      payload: [{ participantId: 'viewer-1' }]
    });

    expect(listener).not.toHaveBeenCalled();
    expect(harness.metrics.controlPlaneDuplicateSuppressions.labels).toHaveBeenCalledWith('room_signals', 'event_id');
  });

  it('delivers replayed remote events to listeners exactly once', async () => {
    const harness = createHarness('node-b');
    const listener = jest.fn();
    harness.service.onSignal(listener);
    await harness.service.onModuleInit();

    await harness.deliver(
      {
        eventId: 'event-3',
        sourceNodeId: 'node-a',
        roomId: 'room-1',
        event: 'producer:created',
        payload: [{ producerId: 'producer-1' }]
      },
      { stream: 'sfu:room-signals', id: '12-0', consumerKey: 'room-signals:node-b', replayed: true }
    );

    expect(listener).toHaveBeenCalledWith({
      eventId: 'event-3',
      sourceNodeId: 'node-a',
      roomId: 'room-1',
      event: 'producer:created',
      payload: [{ producerId: 'producer-1' }]
    });
    expect(harness.metrics.controlPlaneReplayMessages.labels).toHaveBeenCalledWith('room_signals');
    expect(harness.metrics.controlPlaneMessagesDelivered.labels).toHaveBeenCalledWith('room_signals');
  });
});

function createHarness(nodeId: string, options: { dedupeAccepted?: boolean } = {}) {
  let handler:
    | ((payload: RoomSignalEnvelope, meta: DurableStreamMessageMeta) => Promise<void> | void)
    | undefined;
  const redis = {
    publishDurable: jest.fn(async (_stream: string, _payload: RoomSignalEnvelope) => '1-0'),
    consumeDurable: jest.fn(
      async (
        _stream: string,
        _consumerKey: string,
        registeredHandler: (payload: RoomSignalEnvelope, meta: DurableStreamMessageMeta) => Promise<void> | void
      ) => {
        handler = registeredHandler;
      }
    ),
    setIfAbsent: jest.fn(async () => options.dedupeAccepted ?? true)
  };
  const metrics = {
    controlPlaneMessagesPublished: metricStub(),
    controlPlanePublishFailures: metricStub(),
    controlPlaneMessagesDelivered: metricStub(),
    controlPlaneConsumeFailures: metricStub(),
    controlPlaneReplayMessages: metricStub(),
    controlPlaneDuplicateSuppressions: metricStub()
  };
  const registry = {
    localNodeId: jest.fn(() => nodeId)
  };
  const service = new RoomSignalService(redis as never, registry as never, metrics as never);

  return {
    service,
    redis,
    metrics,
    async deliver(
      payload: RoomSignalEnvelope,
      meta: DurableStreamMessageMeta = { stream: 'sfu:room-signals', id: '1-0', consumerKey: `room-signals:${nodeId}`, replayed: false }
    ) {
      if (!handler) {
        throw new Error('Durable consumer handler not registered');
      }
      await handler(payload, meta);
    }
  };
}

function metricStub() {
  const metric = {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
    labels: jest.fn()
  };
  metric.labels.mockReturnValue(metric);
  return metric;
}
