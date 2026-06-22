import { BadRequestException } from '@nestjs/common';
import { PlatformEventsService } from './platform-events.service';
import { RedisStreamDeliveryAdapter } from './adapters/redis-stream-delivery.adapter';
import { WebhookDeliveryAdapter } from './adapters/webhook-delivery.adapter';

describe('PlatformEventsService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('persists platform events and queues deliveries with immutable endpoint snapshots', async () => {
    const harness = createHarness();
    const webhookEndpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      subscribedEventTypes: ['room.created'],
      roomFilterIds: []
    });
    const redisEndpoint = createRedisStreamEndpointDoc({
      id: 'redis-endpoint-1',
      subscribedEventTypes: ['room.created'],
      roomFilterIds: []
    });
    harness.webhookEndpoints.find.mockReturnValue(selectQuery([webhookEndpoint]));
    harness.redisStreamEndpoints.find.mockResolvedValue([redisEndpoint]);
    harness.platformEvents.create.mockImplementation(async (document: Record<string, unknown>) => ({
      id: 'event-1',
      createdAt: new Date('2026-06-19T10:00:00.000Z'),
      ...document
    }));

    await harness.service.appendEvent({
      type: 'room.created',
      roomId: 'room-1',
      payload: {
        room: { roomId: 'room-1' },
        host: { participantId: 'host-1', admitted: true }
      }
    });

    webhookEndpoint.url = 'https://hooks.example.test/edited-after-queue';
    const queuedDeliveries = ((harness.webhookDeliveries.insertMany.mock.calls as unknown as any[][])[0]?.[0] ?? []) as Array<Record<string, any>>;
    expect(queuedDeliveries.length).toBe(2);
    const webhookDelivery = queuedDeliveries.find((entry) => entry.adapterKind === 'webhook');
    const redisDelivery = queuedDeliveries.find((entry) => entry.adapterKind === 'redis-stream');
    expect(webhookDelivery?.endpointId).toBe('endpoint-1');
    expect(webhookDelivery?.eventId).toBe('event-1');
    expect(webhookDelivery?.status).toBe('queued');
    expect(webhookDelivery?.endpointSnapshot?.url).toBe('https://hooks.example.test/events');
    expect(webhookDelivery?.endpointSnapshot?.secretFingerprint).toBe(webhookEndpoint.secretFingerprint);
    expect(redisDelivery?.endpointId).toBe('redis-endpoint-1');
    expect(redisDelivery?.eventId).toBe('event-1');
    expect(redisDelivery?.status).toBe('queued');
    expect(redisDelivery?.endpointSnapshot?.streamKey).toBe('ops:events');
    const snapshotMetricCalls = harness.metrics.eventDeliverySnapshotSourceUsage.labels.mock.calls as unknown[][];
    expect(snapshotMetricCalls.some((call) => call[0] === 'webhook' && call[1] === 'queued_endpoint_state')).toBe(true);
    expect(snapshotMetricCalls.some((call) => call[0] === 'redis-stream' && call[1] === 'queued_endpoint_state')).toBe(true);
  });

  it('delivers redis stream payloads and records delivery references without touching webhook-only metrics', async () => {
    const harness = createHarness();
    const endpoint = createRedisStreamEndpointDoc({
      id: 'redis-endpoint-1',
      streamKey: 'ops:room-events',
      maxLen: 250
    });
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-redis-1',
      adapterKind: 'redis-stream',
      endpointId: endpoint.id,
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1'
    });
    const persistedDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      attempts: []
    });
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.redisStreamEndpoints.findById.mockResolvedValue(endpoint);
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);

    await (harness.service as any).dispatchDelivery(delivery);

    const publishCall = (harness.redisService.publishDurable.mock.calls as unknown as any[][])[0] ?? [];
    expect(publishCall[0]).toBe('ops:room-events');
    expect((publishCall[1] as Record<string, unknown>).deliveryId).toBe('delivery-redis-1');
    expect((publishCall[1] as Record<string, unknown>).eventId).toBe('event-1');
    expect((publishCall[1] as Record<string, unknown>).attemptNumber).toBe(1);
    expect(publishCall[2]).toEqual({ maxLen: 250 });
    expect(persistedDelivery.status).toBe('delivered');
    expect(persistedDelivery.lastDeliveryReference).toBe('1742-0');
    expect(persistedDelivery.attempts[0]?.deliveryReference).toBe('1742-0');
    expect(endpoint.health.lastDeliveryReference).toBe('1742-0');
    expect((harness.metrics.eventDeliveriesSucceeded.labels.mock.calls as unknown[][])[0]).toEqual(['redis-stream', 'room.created']);
    expect((harness.metrics.webhookDeliveriesSucceeded.labels.mock.calls as unknown[]).length).toBe(0);
  });

  it('retries redis stream deliveries on retryable network failures', async () => {
    const harness = createHarness();
    const endpoint = createRedisStreamEndpointDoc({
      id: 'redis-endpoint-1',
      maxAttempts: 3
    });
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-redis-1',
      adapterKind: 'redis-stream',
      endpointId: endpoint.id,
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1'
    });
    const persistedDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      attempts: []
    });
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.redisStreamEndpoints.findById.mockResolvedValue(endpoint);
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    harness.redisService.publishDurable.mockRejectedValueOnce(new Error('ECONNRESET socket closed'));

    await (harness.service as any).dispatchDelivery(delivery);

    expect(persistedDelivery.status).toBe('retrying');
    expect(persistedDelivery.attemptCount).toBe(1);
    expect(persistedDelivery.lastFailureCategory).toBe('network');
    expect(endpoint.health.status).toBe('degraded');
    expect((harness.metrics.eventRetriesScheduled.labels.mock.calls as unknown[][])[0]).toEqual(['redis-stream', 'room.created']);
    expect((harness.metrics.eventDeliveriesFailed.labels.mock.calls as unknown[][])[0]).toEqual(['redis-stream', 'room.created']);
    expect((harness.metrics.webhookRetriesScheduled.labels.mock.calls as unknown[]).length).toBe(0);
  });

  it('exhausts redis stream deliveries immediately on non-retryable auth failures', async () => {
    const harness = createHarness();
    const endpoint = createRedisStreamEndpointDoc({
      id: 'redis-endpoint-1',
      maxAttempts: 5
    });
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-redis-1',
      adapterKind: 'redis-stream',
      endpointId: endpoint.id,
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1'
    });
    const persistedDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      attempts: []
    });
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.redisStreamEndpoints.findById.mockResolvedValue(endpoint);
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    harness.redisService.publishDurable.mockRejectedValueOnce(new Error('NOAUTH Authentication required'));

    await (harness.service as any).dispatchDelivery(delivery);

    expect(persistedDelivery.status).toBe('exhausted');
    expect(persistedDelivery.attemptCount).toBe(1);
    expect(persistedDelivery.lastFailureCategory).toBe('auth');
    expect(endpoint.health.status).toBe('failing');
    expect((harness.metrics.eventDeliveriesExhausted.labels.mock.calls as unknown[][])[0]).toEqual(['redis-stream', 'room.created']);
    expect((harness.metrics.webhookDeliveriesExhausted.labels.mock.calls as unknown[]).length).toBe(0);
  });

  it('delivers webhook payloads with HMAC headers and records successful attempts', async () => {
    const harness = createHarness();
    const endpoint = createEndpoint(harness.service, {
      id: 'endpoint-1'
    });
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-1',
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1'
    });
    const persistedDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      attempts: []
    });
    const eventDoc = createEventDoc();
    harness.platformEvents.findById.mockResolvedValue(eventDoc);
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(endpoint));
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 204
    }));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await (harness.service as any).dispatchDelivery(delivery);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = ((fetchMock.mock.calls as unknown as any[][])[0]?.[1] ?? undefined) as
      | { headers?: Record<string, string> }
      | undefined;
    expect(request?.headers?.['x-native-sfu-delivery-id']).toBe('delivery-1');
    expect(request?.headers?.['x-native-sfu-event-id']).toBe('event-1');
    expect(request?.headers?.['x-native-sfu-event-type']).toBe('room.created');
    expect(String(request?.headers?.['x-native-sfu-signature'])).toMatch(/^sha256=/);
    expect(persistedDelivery.status).toBe('delivered');
    expect(persistedDelivery.attemptCount).toBe(1);
    expect(endpoint.health.status).toBe('healthy');
    const successLabels = (harness.metrics.webhookDeliveriesSucceeded.labels.mock.calls as unknown as any[][])[0] ?? [];
    expect(successLabels[0]).toBe('room.created');
    const adapterLabels = (harness.metrics.eventDeliveryAdapterExecutions.labels.mock.calls as unknown as any[][])[0] ?? [];
    expect(adapterLabels).toEqual(['webhook', 'succeeded']);
  });

  it('marks deliveries exhausted after the final failed attempt', async () => {
    const harness = createHarness();
    const endpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      maxAttempts: 1
    });
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-1',
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1'
    });
    const persistedDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      attempts: []
    });
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(endpoint));
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503
    })) as unknown as typeof fetch;

    await (harness.service as any).dispatchDelivery(delivery);

    expect(persistedDelivery.status).toBe('exhausted');
    expect(persistedDelivery.lastFailureCategory).toBe('http');
    expect(endpoint.health.status).toBe('failing');
    expect(endpoint.health.lastFailureCategory).toBe('http');
    expect((harness.metrics.webhookDeliveryFailuresByCategory.labels.mock.calls as unknown[][])[0]).toEqual([
      'room.created',
      'http'
    ]);
    const exhaustedLabels = (harness.metrics.webhookDeliveriesExhausted.labels.mock.calls as unknown as any[][])[0] ?? [];
    expect(exhaustedLabels[0]).toBe('room.created');
  });

  it('exhausts non-retryable failures immediately even when maxAttempts remains', async () => {
    const harness = createHarness();
    const endpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      maxAttempts: 5
    });
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-1',
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1'
    });
    const persistedDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      attempts: []
    });
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(endpoint));
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => ({
      ok: false,
      status: 401
    })) as unknown as typeof fetch;

    await (harness.service as any).dispatchDelivery(delivery);

    expect(persistedDelivery.status).toBe('exhausted');
    expect(persistedDelivery.attemptCount).toBe(1);
    expect(persistedDelivery.lastFailureCategory).toBe('auth');
    expect(endpoint.health.status).toBe('failing');
    expect((harness.metrics.eventDeliveriesExhausted.labels.mock.calls as unknown[][])[0]).toEqual(['webhook', 'room.created']);
  });

  it('rejects disabled endpoints during manual replay even when the original snapshot exists', async () => {
    const harness = createHarness();
    const currentEndpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      enabled: false
    });
    const exhaustedDelivery = createDelivery(harness.service, currentEndpoint, {
      id: 'delivery-1',
      status: 'exhausted'
    });
    harness.webhookDeliveries.findById.mockReturnValue(selectQuery(exhaustedDelivery));
    harness.webhookDeliveries.findOne.mockResolvedValue(null);
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(currentEndpoint));
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());

    const error = await captureError(() =>
      harness.service.replayWebhookDelivery('delivery-1', {
        type: 'operator',
        label: 'operations-token'
      })
    );
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('rejects replay for deliveries that are already delivered', async () => {
    const harness = createHarness();
    const delivered = createDelivery(harness.service, createEndpoint(harness.service), {
      id: 'delivery-1',
      status: 'delivered'
    });
    harness.webhookDeliveries.findById.mockReturnValue(selectQuery(delivered));

    const error = await captureError(() =>
      harness.service.replayWebhookDelivery('delivery-1', {
        type: 'operator',
        label: 'operations-token'
      })
    );
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate active replays for the same source delivery', async () => {
    const harness = createHarness();
    const exhausted = createDelivery(harness.service, createEndpoint(harness.service), {
      id: 'delivery-1',
      status: 'exhausted'
    });
    harness.webhookDeliveries.findById.mockReturnValue(selectQuery(exhausted));
    harness.webhookDeliveries.findOne.mockResolvedValue({
      id: 'delivery-replay-1',
      replayOfDeliveryId: 'delivery-1',
      status: 'queued'
    });

    const error = await captureError(() =>
      harness.service.replayWebhookDelivery('delivery-1', {
        type: 'operator',
        label: 'operations-token'
      })
    );
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('replays a delivery with its original endpoint snapshot after endpoint edits', async () => {
    const harness = createHarness();
    const originalEndpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      url: 'https://hooks.example.test/original',
      timeoutMs: 1800,
      maxAttempts: 4,
      initialBackoffMs: 900
    });
    const currentEndpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      url: 'https://hooks.example.test/current',
      timeoutMs: 6000,
      maxAttempts: 2,
      initialBackoffMs: 300
    });
    const exhausted = createDelivery(harness.service, originalEndpoint, {
      id: 'delivery-1',
      status: 'exhausted'
    });
    const replayDocFactory = jest.fn(async (document: Record<string, unknown>) => ({
      id: 'delivery-replay-1',
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
      updatedAt: new Date('2026-06-20T10:00:00.000Z'),
      ...document
    }));
    harness.webhookDeliveries.findById.mockReturnValue(selectQuery(exhausted));
    harness.webhookDeliveries.findOne.mockResolvedValue(null);
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(currentEndpoint));
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.webhookDeliveries.create.mockImplementation(replayDocFactory);

    const response = await harness.service.replayWebhookDelivery('delivery-1', {
      type: 'operator',
      label: 'operations-token'
    });

    const createInput = ((replayDocFactory.mock.calls as unknown as any[][])[0]?.[0] ?? {}) as Record<string, any>;
    expect(createInput.snapshotSource).toBe('original_delivery_snapshot');
    expect(createInput.endpointSnapshot.url).toBe('https://hooks.example.test/original');
    expect(createInput.endpointSnapshot.timeoutMs).toBe(1800);
    expect(createInput.endpointSnapshot.maxAttempts).toBe(4);
    expect((response.delivery.endpointSnapshot as any).url).toBe('https://hooks.example.test/original');
  });

  it('replays an event to an endpoint with the current endpoint snapshot', async () => {
    const harness = createHarness();
    const currentEndpoint = createEndpoint(harness.service, {
      id: 'endpoint-1',
      url: 'https://hooks.example.test/current',
      timeoutMs: 4200,
      maxAttempts: 6,
      initialBackoffMs: 1200
    });
    const replayDocFactory = jest.fn(async (document: Record<string, unknown>) => ({
      id: 'delivery-replay-1',
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
      updatedAt: new Date('2026-06-20T10:00:00.000Z'),
      ...document
    }));
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(currentEndpoint));
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.webhookDeliveries.create.mockImplementation(replayDocFactory);

    const response = await harness.service.replayEventToEndpoint('event-1', 'endpoint-1', {
      type: 'operator',
      label: 'operations-token'
    });

    const createInput = ((replayDocFactory.mock.calls as unknown as any[][])[0]?.[0] ?? {}) as Record<string, any>;
    expect(createInput.snapshotSource).toBe('current_endpoint_state');
    expect(createInput.endpointSnapshot.url).toBe('https://hooks.example.test/current');
    expect(createInput.endpointSnapshot.timeoutMs).toBe(4200);
    expect((response.delivery.endpointSnapshot as any).url).toBe('https://hooks.example.test/current');
  });

  it('converts duplicate active replay creation races into a bad request', async () => {
    const harness = createHarness();
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(createEndpoint(harness.service, { id: 'endpoint-1' })));
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.webhookDeliveries.create.mockRejectedValue({ code: 11000 });

    const error = await captureError(() =>
      harness.service.replayEventToEndpoint('event-1', 'endpoint-1', {
        type: 'operator',
        label: 'operations-token'
      })
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('A queued or in-flight delivery already exists for this endpoint and event');
  });

  it('does not resurrect a delivery cancelled while dispatch is in flight', async () => {
    const harness = createHarness();
    const endpoint = createEndpoint(harness.service);
    const delivery = createDelivery(harness.service, endpoint, {
      id: 'delivery-1'
    });
    const cancelledDelivery = createDelivery(harness.service, endpoint, {
      ...delivery,
      status: 'cancelled'
    });
    harness.platformEvents.findById.mockResolvedValue(createEventDoc());
    harness.webhookEndpoints.findById.mockReturnValue(selectQuery(endpoint));
    harness.webhookDeliveries.findById.mockResolvedValue(cancelledDelivery);
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => ({
      ok: true,
      status: 204
    })) as unknown as typeof fetch;

    await (harness.service as any).dispatchDelivery(delivery);

    expect(cancelledDelivery.status).toBe('cancelled');
    expect((harness.metrics.webhookDeliveriesSucceeded.labels.mock.calls as unknown[]).length).toBe(0);
  });

  it('returns diagnostics with snapshot counts, backlog concentration, and dispatch settings', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    const harness = createHarness({
      deliveryConcurrency: 6,
      deliveryMaxBatchPerPump: 18,
      deliveryMaxConcurrentPerEndpoint: 2
    });
    harness.webhookEndpoints.countDocuments.mockImplementation(async (filter?: Record<string, unknown>) => {
      if (!filter || Object.keys(filter).length === 0) return 4;
      if (filter.enabled === true) return 3;
      if (filter.enabled === false) return 1;
      if ((filter as Record<string, unknown>)['health.status']) return 1;
      return 0;
    });
    harness.redisStreamEndpoints.countDocuments.mockImplementation(async (filter?: Record<string, unknown>) => {
      if (!filter || Object.keys(filter).length === 0) return 2;
      if (filter.enabled === true) return 1;
      if (filter.enabled === false) return 1;
      if ((filter as Record<string, unknown>)['health.status']) return 1;
      return 0;
    });
    harness.webhookDeliveries.countDocuments.mockImplementation(async (filter?: Record<string, any>) => {
      if (filter?.status === 'dispatching' && filter?.lockedUntil?.$gt) return 1;
      if (filter?.status === 'dispatching' && filter?.lockedUntil?.$lte) return 1;
      return 0;
    });
    (harness.webhookDeliveries.aggregate as jest.Mock).mockImplementation(async (pipeline: Array<Record<string, any>>) => {
      const group = pipeline.at(-1)?.$group ?? pipeline[0]?.$group;
      const match = pipeline[0]?.$match;
      if (group?._id?.adapterKind === '$adapterKind' && group?._id?.status === '$status') {
        return [
          { _id: { adapterKind: 'webhook', status: 'queued' }, count: 2 },
          { _id: { adapterKind: 'webhook', status: 'retrying' }, count: 1 },
          { _id: { adapterKind: 'webhook', status: 'dispatching' }, count: 1 },
          { _id: { adapterKind: 'webhook', status: 'delivered' }, count: 8 },
          { _id: { adapterKind: 'webhook', status: 'exhausted' }, count: 3 },
          { _id: { adapterKind: 'webhook', status: 'cancelled' }, count: 4 },
          { _id: { adapterKind: 'redis-stream', status: 'queued' }, count: 1 }
        ];
      }
      if (group?._id === '$lastFailureCategory') {
        return [
          { _id: 'http', count: 2 },
          { _id: 'timeout', count: 1 },
          { _id: 'endpoint_disabled', count: 4 }
        ];
      }
      if (group?._id === '$snapshotSource') {
        return [
          { _id: 'queued_endpoint_state', count: 5 },
          { _id: 'original_delivery_snapshot', count: 2 },
          { _id: 'current_endpoint_state', count: 1 }
        ];
      }
      if (match?.status?.$in) {
        return [
          {
            _id: { adapterKind: 'webhook', endpointId: 'endpoint-1' },
            total: 7,
            queued: 4,
            retrying: 2,
            dispatching: 1,
            oldestQueuedAt: new Date('2026-06-20T09:58:00.000Z'),
            oldestRetryingAt: new Date('2026-06-20T09:59:00.000Z'),
            oldestDispatchingAt: new Date('2026-06-20T09:59:30.000Z')
          },
          {
            _id: { adapterKind: 'redis-stream', endpointId: 'endpoint-2' },
            total: 3,
            queued: 1,
            retrying: 1,
            dispatching: 1,
            oldestQueuedAt: new Date('2026-06-20T09:59:15.000Z'),
            oldestRetryingAt: new Date('2026-06-20T09:59:20.000Z'),
            oldestDispatchingAt: new Date('2026-06-20T09:59:40.000Z')
          }
        ];
      }
      return [];
    });
    harness.platformEvents.countDocuments.mockResolvedValue(12);
    harness.platformEvents.findOne.mockReturnValue(sortQuery({
      occurredAt: new Date('2026-06-20T10:00:00.000Z')
    }));
    await (harness.service as any).cleanupExpiredHistory();

    const summary = await harness.service.diagnosticsSummary();

    expect(summary.snapshotSourceCounts).toEqual({
      queued_endpoint_state: 5,
      original_delivery_snapshot: 2,
      current_endpoint_state: 1
    });
    expect(summary.endpointCountsByAdapter).toEqual({
      webhook: 4,
      'redis-stream': 2
    });
    expect(summary.adapterCounts).toEqual({
      webhook: 4,
      'redis-stream': 1
    });
    expect(summary.deliveryCountsByAdapter.webhook).toEqual({
      queued: 2,
      retrying: 1,
      dispatching: 1,
      delivered: 8,
      exhausted: 3,
      cancelled: 4
    });
    expect(summary.deliveryCountsByAdapter['redis-stream']).toEqual({
      queued: 1,
      retrying: 0,
      dispatching: 0,
      delivered: 0,
      exhausted: 0,
      cancelled: 0
    });
    expect(summary.activeDispatchesByAdapter).toEqual({
      webhook: 0,
      'redis-stream': 0
    });
    expect(summary.leaseCounts).toEqual({ active: 1, expired: 1 });
    expect(summary.backlogAging).toEqual({
      queued: 120000,
      retrying: 60000,
      dispatching: 30000
    });
    expect(summary.backlogAgingByAdapter).toEqual({
      webhook: {
        queued: 120000,
        retrying: 60000,
        dispatching: 30000
      },
      'redis-stream': {
        queued: 45000,
        retrying: 40000,
        dispatching: 20000
      }
    });
    expect(summary.fairness).toEqual({
      activeLaneCount: 2,
      queuedLaneCount: 2,
      retryingLaneCount: 2,
      dispatchingLaneCount: 2,
      largestBacklogEndpointShare: 0.7,
      largestBacklogEndpointShareByAdapter: {
        webhook: 1,
        'redis-stream': 1
      }
    });
    expect(summary.dispatch).toEqual({
      concurrency: 6,
      maxBatchPerPump: 18,
      maxConcurrentPerEndpoint: 2,
      activeDispatches: 0,
      nextClaimPrefers: 'queued'
    });
    expect(summary.topBacklogEndpoints).toEqual([
      {
        adapterKind: 'webhook',
        endpointId: 'endpoint-1',
        total: 7,
        queued: 4,
        retrying: 2,
        dispatching: 1
      },
      {
        adapterKind: 'redis-stream',
        endpointId: 'endpoint-2',
        total: 3,
        queued: 1,
        retrying: 1,
        dispatching: 1
      }
    ]);
    expect(summary.retention.lastSweepDeletedCounts).toEqual({ events: 0, deliveries: 0 });
  });

  it('keeps source events while any delivery record still references them', async () => {
    const harness = createHarness();
    (harness.webhookDeliveries.distinct as jest.Mock).mockResolvedValue(['event-pending', 'event-exhausted']);
    harness.webhookDeliveries.deleteMany
      .mockResolvedValueOnce({ deletedCount: 2 })
      .mockResolvedValueOnce({ deletedCount: 1 });
    harness.platformEvents.deleteMany.mockResolvedValue({ deletedCount: 5 });

    await (harness.service as any).cleanupExpiredHistory();

    const distinctCalls = (harness.webhookDeliveries.distinct as jest.Mock).mock.calls as any[][];
    expect(distinctCalls[0]?.[0]).toBe('eventId');
    const deleteFilter = ((harness.platformEvents.deleteMany as jest.Mock).mock.calls as any[][])[0]?.[0] as Record<string, any>;
    expect(deleteFilter._id).toEqual({ $nin: ['event-pending', 'event-exhausted'] });
  });

  it('alternates fresh and retry claims while enforcing per-endpoint dispatch caps', async () => {
    const harness = createHarness({
      deliveryConcurrency: 3,
      deliveryMaxBatchPerPump: 3,
      deliveryMaxConcurrentPerEndpoint: 1
    });
    const claimSpy = jest
      .spyOn(harness.service as any, 'claimNextDueDelivery')
      .mockResolvedValueOnce({ id: 'delivery-1', adapterKind: 'webhook', endpointId: 'endpoint-1' })
      .mockResolvedValueOnce({ id: 'delivery-2', adapterKind: 'redis-stream', endpointId: 'endpoint-2' })
      .mockResolvedValueOnce(null);
    const dispatchSpy = jest.spyOn(harness.service as any, 'dispatchWithAccounting').mockResolvedValue(undefined);

    await (harness.service as any).pumpDueDeliveries();

    const claimCalls = claimSpy.mock.calls as any[][];
    expect(claimCalls[0]?.[0]).toEqual({
      preferRetry: false,
      excludedLaneKeys: []
    });
    expect(claimCalls[1]?.[0]).toEqual({
      preferRetry: true,
      excludedLaneKeys: ['webhook:endpoint-1']
    });
    expect(claimCalls[2]?.[0]).toEqual({
      preferRetry: false,
      excludedLaneKeys: ['webhook:endpoint-1', 'redis-stream:endpoint-2']
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('validates webhook endpoint URL and retry bounds before persistence', async () => {
    const harness = createHarness({ nodeEnv: 'production' });

    const requests: Array<Record<string, unknown>> = [
      {
        name: 'Ops',
        url: 'http://hooks.example.test/events',
        subscribedEventTypes: ['room.created'],
        signingSecret: 'this-is-a-long-enough-secret'
      },
      {
        name: 'Ops',
        url: 'https://hooks.example.test/events',
        subscribedEventTypes: ['room.created'],
        timeoutMs: 400,
        signingSecret: 'this-is-a-long-enough-secret'
      },
      {
        name: 'Ops',
        url: 'https://hooks.example.test/events',
        subscribedEventTypes: ['room.created'],
        maxAttempts: 15,
        signingSecret: 'this-is-a-long-enough-secret'
      },
      {
        name: 'Ops',
        url: 'https://hooks.example.test/events',
        subscribedEventTypes: ['room.created'],
        initialBackoffMs: 150,
        signingSecret: 'this-is-a-long-enough-secret'
      }
    ];

    for (const request of requests) {
      const error = await captureError(() => harness.service.createWebhookEndpoint(request as never));
      expect(error).toBeInstanceOf(BadRequestException);
    }

    expect(harness.webhookEndpoints.create).not.toHaveBeenCalled();
  });
});

function createHarness(
  options: {
    nodeEnv?: 'development' | 'production';
    deliveryConcurrency?: number;
    deliveryMaxBatchPerPump?: number;
    deliveryMaxConcurrentPerEndpoint?: number;
  } = {}
) {
  const platformEvents = createModel();
  const webhookEndpoints = createModel();
  const redisStreamEndpoints = createModel();
  const webhookDeliveries = createModel();
  webhookEndpoints.find.mockReturnValue(selectQuery([]));
  webhookEndpoints.findById.mockReturnValue(selectQuery(null));
  redisStreamEndpoints.find.mockResolvedValue([]);
  redisStreamEndpoints.findById.mockResolvedValue(null);
  webhookDeliveries.findById.mockResolvedValue(null);
  platformEvents.create.mockImplementation(async (document: Record<string, any>) => ({
    id: document.id ?? 'platform-event-log-1',
    createdAt: document.createdAt ?? new Date('2026-06-19T10:00:00.000Z'),
    occurredAt: document.occurredAt ?? new Date('2026-06-19T10:00:00.000Z'),
    ...document
  }));
  const adapter = new WebhookDeliveryAdapter();
  const redisService = {
    publishDurable: jest.fn(async () => '1742-0')
  };
  const redisAdapter = new RedisStreamDeliveryAdapter(redisService as never);
  const adapterRegistry = {
    get: jest.fn((kind: string) => (kind === 'redis-stream' ? redisAdapter : adapter)),
    registeredKinds: jest.fn(() => ['webhook', 'redis-stream'])
  };
  const metrics = {
    platformEventsEmitted: metricWithLabels(),
    platformEventQueries: metricWithLabels(),
    eventDeliveryAttempts: metricWithLabels(),
    eventDeliveriesSucceeded: metricWithLabels(),
    eventDeliveriesFailed: metricWithLabels(),
    eventDeliveryFailuresByCategory: metricWithLabels(),
    eventDeliveriesExhausted: metricWithLabels(),
    eventDeliveriesCancelled: metricWithLabels(),
    eventRetriesScheduled: metricWithLabels(),
    eventDeliveryReplays: metricWithLabels(),
    eventDeliveryActiveDispatchesByAdapter: metricWithLabelsAndSet(),
    eventDeliveryEndpointCountsByAdapter: metricWithLabelsAndSet(),
    eventDeliveryQueueByAdapter: metricWithLabelsAndSet(),
    eventDeliveryOldestAgeByAdapter: metricWithLabelsAndSet(),
    eventDeliveryBacklogConcentration: metricWithLabelsAndSet(),
    eventDeliveryLaneCounts: metricWithLabelsAndSet(),
    eventDeliveryLatency: metricWithLabelsAndObserve(),
    eventDeliveryAdapterExecutions: metricWithLabels(),
    eventDeliverySnapshotSourceUsage: metricWithLabels(),
    webhookDeliveryAttempts: metricWithLabels(),
    webhookDeliveriesSucceeded: metricWithLabels(),
    webhookDeliveriesFailed: metricWithLabels(),
    webhookDeliveryFailuresByCategory: metricWithLabels(),
    webhookDeliveriesExhausted: metricWithLabels(),
    webhookDeliveriesCancelled: metricWithLabels(),
    webhookRetriesScheduled: metricWithLabels(),
    webhookReplays: metricWithLabels(),
    webhookEndpointCounts: metricWithLabelsAndSet(),
    webhookDeliveryQueue: metricWithLabelsAndSet(),
    webhookDeliveryLatency: metricWithLabelsAndObserve(),
    webhookActiveDispatches: metricWithSet()
  };
  const service = new PlatformEventsService(
    platformEvents as never,
    webhookEndpoints as never,
    redisStreamEndpoints as never,
    webhookDeliveries as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        switch (key) {
          case 'events.webhooks.enabled':
            return true;
          case 'app.nodeEnv':
            return options.nodeEnv ?? 'development';
          case 'NODE_ENV':
            return options.nodeEnv ?? 'development';
          case 'events.webhooks.defaultTimeoutMs':
            return 1000;
          case 'events.webhooks.defaultMaxAttempts':
            return 3;
          case 'events.webhooks.defaultInitialBackoffMs':
            return 250;
          case 'events.webhooks.pollIntervalMs':
            return 1000;
          case 'events.webhooks.leaseMs':
            return 1000;
          case 'events.webhooks.concurrency':
            return options.deliveryConcurrency ?? 4;
          case 'events.webhooks.maxBatchPerPump':
            return options.deliveryMaxBatchPerPump ?? 16;
          case 'events.webhooks.maxConcurrentPerEndpoint':
            return options.deliveryMaxConcurrentPerEndpoint ?? 2;
          case 'events.webhooks.secretEncryptionKey':
            return 'encryption-key';
          case 'events.retention.eventRetentionDays':
            return 30;
          case 'events.retention.deliveryRetentionDays':
            return 14;
          case 'events.retention.exhaustedDeliveryRetentionDays':
            return 30;
          case 'events.retention.cleanupIntervalMs':
            return 60000;
          case 'jwt.accessSecret':
            return 'jwt-secret';
          default:
            return fallback;
        }
      }),
      getOrThrow: jest.fn(() => 'jwt-secret')
    } as never,
    metrics as never,
    {
      localNodeId: jest.fn(() => 'node-a')
    } as never,
    adapterRegistry as never
  );
  return {
    service,
    platformEvents,
    webhookEndpoints,
    redisStreamEndpoints,
    webhookDeliveries,
    metrics,
    adapterRegistry,
    redisService
  };
}

function createModel() {
  return {
    aggregate: jest.fn(async () => []),
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(),
    deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
    distinct: jest.fn(async () => []),
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    insertMany: jest.fn(async () => undefined),
    updateMany: jest.fn(async () => ({ modifiedCount: 0 }))
  };
}

function createEndpoint(
  service: PlatformEventsService,
  overrides: Record<string, any> = {}
): Record<string, any> {
  const encrypted = (service as any).encryptSecret(overrides.signingSecret ?? 'super-secret-signing-key');
  return {
    adapterKind: 'webhook',
    id: overrides.id ?? 'endpoint-1',
    enabled: overrides.enabled ?? true,
    name: overrides.name ?? 'Ops webhook',
    url: overrides.url ?? 'https://hooks.example.test/events',
    subscribedEventTypes: overrides.subscribedEventTypes ?? ['room.created'],
    roomFilterIds: overrides.roomFilterIds ?? [],
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxAttempts: overrides.maxAttempts ?? 3,
    initialBackoffMs: overrides.initialBackoffMs ?? 250,
    signingAlgorithm: 'hmac-sha256',
    secretFingerprint: overrides.secretFingerprint ?? 'fingerprint-1',
    secretLastRotatedAt: overrides.secretLastRotatedAt ?? new Date('2026-06-19T09:55:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-06-19T10:00:00.000Z'),
    signingSecretCiphertext: overrides.signingSecretCiphertext ?? encrypted.ciphertext,
    signingSecretIv: overrides.signingSecretIv ?? encrypted.iv,
    signingSecretAuthTag: overrides.signingSecretAuthTag ?? encrypted.authTag,
    health: overrides.health ?? {
      status: 'healthy',
      consecutiveFailures: 0
    },
    save: overrides.save ?? jest.fn(async () => undefined)
  };
}

function createRedisStreamEndpointDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    adapterKind: 'redis-stream',
    id: overrides.id ?? 'redis-endpoint-1',
    enabled: overrides.enabled ?? true,
    name: overrides.name ?? 'Ops redis stream',
    streamKey: overrides.streamKey ?? 'ops:events',
    maxLen: overrides.maxLen,
    subscribedEventTypes: overrides.subscribedEventTypes ?? ['room.created'],
    roomFilterIds: overrides.roomFilterIds ?? [],
    timeoutMs: overrides.timeoutMs ?? 750,
    maxAttempts: overrides.maxAttempts ?? 2,
    initialBackoffMs: overrides.initialBackoffMs ?? 500,
    updatedAt: overrides.updatedAt ?? new Date('2026-06-19T10:00:00.000Z'),
    health: overrides.health ?? {
      status: 'healthy',
      consecutiveFailures: 0
    },
    save: overrides.save ?? jest.fn(async () => undefined)
  };
}

function createDelivery(
  service: PlatformEventsService,
  endpoint: Record<string, any>,
  overrides: Record<string, any> = {}
): Record<string, any> {
  const snapshot =
    overrides.endpointSnapshot
    ?? (service as any).createDeliverySnapshotFromEndpoint(endpoint);
  return {
    id: overrides.id ?? 'delivery-1',
    adapterKind: overrides.adapterKind ?? 'webhook',
    endpointId: overrides.endpointId ?? endpoint.id,
    eventId: overrides.eventId ?? 'event-1',
    eventType: overrides.eventType ?? 'room.created',
    roomId: overrides.roomId ?? 'room-1',
    status: overrides.status ?? 'queued',
    snapshotSource: overrides.snapshotSource ?? 'queued_endpoint_state',
    endpointSnapshot: snapshot,
    attemptCount: overrides.attemptCount ?? 0,
    attempts: overrides.attempts ?? [],
    replayOfDeliveryId: overrides.replayOfDeliveryId,
    replayedBy: overrides.replayedBy,
    createdAt: overrides.createdAt ?? new Date('2026-06-19T10:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-06-19T10:00:00.000Z'),
    nextAttemptAt: overrides.nextAttemptAt ?? new Date('2026-06-19T10:00:00.000Z'),
    save: overrides.save ?? jest.fn(async () => undefined)
  };
}

function createEventDoc(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'event-1',
    type: overrides.type ?? 'room.created',
    roomId: overrides.roomId ?? 'room-1',
    occurredAt: overrides.occurredAt ?? new Date('2026-06-19T10:00:00.000Z'),
    event: overrides.event ?? {
      schemaVersion: 1,
      type: 'room.created',
      roomId: 'room-1',
      sourceNodeId: 'node-a',
      timestamp: '2026-06-19T10:00:00.000Z',
      payload: {
        room: { roomId: 'room-1' },
        host: { participantId: 'host-1', admitted: true }
      }
    },
    createdAt: overrides.createdAt ?? new Date('2026-06-19T10:00:00.000Z')
  };
}

function metricWithLabels() {
  const inc = jest.fn();
  return {
    labels: jest.fn(() => ({ inc }))
  };
}

function metricWithLabelsAndSet() {
  const set = jest.fn();
  return {
    labels: jest.fn(() => ({ set }))
  };
}

function metricWithLabelsAndObserve() {
  const observe = jest.fn();
  return {
    labels: jest.fn(() => ({ observe }))
  };
}

function metricWithSet() {
  return {
    set: jest.fn()
  };
}

function selectQuery<T>(value: T) {
  return {
    select: jest.fn().mockResolvedValue(value)
  };
}

function sortQuery<T>(value: T) {
  return {
    sort: jest.fn().mockResolvedValue(value)
  };
}

async function captureError<T>(operation: () => Promise<T>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}
