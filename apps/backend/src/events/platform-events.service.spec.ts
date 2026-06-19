import { BadRequestException } from '@nestjs/common';
import { PlatformEventsService } from './platform-events.service';

describe('PlatformEventsService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('persists platform events and queues matching webhook deliveries', async () => {
    const harness = createHarness();
    const payload = {
      room: {
        roomId: 'room-1'
      },
      host: {
        participantId: 'host-1',
        admitted: true
      }
    } as const;

    harness.webhookEndpoints.find.mockResolvedValue([
      {
        id: 'endpoint-1',
        enabled: true,
        subscribedEventTypes: ['room.created'],
        roomFilterIds: [],
        health: { consecutiveFailures: 0 }
      }
    ]);
    harness.platformEvents.create.mockImplementation(async (document: Record<string, unknown>) => ({
      id: 'event-1',
      createdAt: new Date('2026-06-19T10:00:00.000Z'),
      ...document
    }));

    const event = await harness.service.appendEvent({
      type: 'room.created',
      roomId: 'room-1',
      payload
    });

    expect(event.id).toBe('event-1');
    expect(harness.platformEvents.create).toHaveBeenCalledTimes(1);
    const queuedDeliveries = (harness.webhookDeliveries.insertMany.mock.calls as any)[0][0] as any[];
    expect(Array.isArray(queuedDeliveries)).toBe(true);
    expect(queuedDeliveries.length).toBe(1);
    expect(queuedDeliveries[0].endpointId).toBe('endpoint-1');
    expect(queuedDeliveries[0].eventId).toBe('event-1');
    expect(queuedDeliveries[0].eventType).toBe('room.created');
    expect(queuedDeliveries[0].roomId).toBe('room-1');
    expect(queuedDeliveries[0].status).toBe('queued');
    expect((harness.metrics.platformEventsEmitted.labels.mock.calls as any)[0][0]).toBe('room.created');
    const created = harness.platformEvents.create.mock.calls[0]?.[0] as { serializedEvent: string; event: Record<string, unknown> };
    expect(created.serializedEvent).toContain('"payload"');
    expect(created.event.type).toBe('room.created');
  });

  it('delivers webhook payloads with HMAC headers and records successful attempts', async () => {
    const harness = createHarness();
    const encrypted = (harness.service as any).encryptSecret('super-secret');
    const delivery = {
      id: 'delivery-1',
      endpointId: 'endpoint-1',
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1',
      attemptCount: 0,
      status: 'queued',
      attempts: [],
      save: jest.fn(async () => undefined)
    };
    const persistedDelivery = {
      ...delivery,
      attempts: [] as Array<Record<string, unknown>>,
      save: jest.fn(async () => undefined)
    };
    const endpoint = {
      id: 'endpoint-1',
      enabled: true,
      url: 'https://hooks.example.test/room-events',
      timeoutMs: 1000,
      maxAttempts: 3,
      initialBackoffMs: 100,
      health: {
        status: 'healthy',
        consecutiveFailures: 0
      },
      signingSecretCiphertext: encrypted.ciphertext,
      signingSecretIv: encrypted.iv,
      signingSecretAuthTag: encrypted.authTag,
      save: jest.fn(async () => undefined)
    };
    const eventDoc = {
      id: 'event-1',
      type: 'room.created',
      roomId: 'room-1',
      occurredAt: new Date('2026-06-19T10:00:00.000Z'),
      event: {
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
      createdAt: new Date('2026-06-19T10:00:00.000Z')
    };
    harness.platformEvents.findById.mockResolvedValue(eventDoc);
    harness.webhookEndpoints.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(endpoint)
    });
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 204
    }));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await (harness.service as any).dispatchDelivery(delivery);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = ((fetchMock.mock.calls as any)[0]?.[1] ?? undefined) as { headers?: Record<string, string> } | undefined;
    expect(request?.headers?.['x-native-sfu-delivery-id']).toBe('delivery-1');
    expect(request?.headers?.['x-native-sfu-event-id']).toBe('event-1');
    expect(request?.headers?.['x-native-sfu-event-type']).toBe('room.created');
    expect(String(request?.headers?.['x-native-sfu-signature'])).toMatch(/^sha256=/);
    expect(persistedDelivery.status).toBe('delivered');
    expect(persistedDelivery.attemptCount).toBe(1);
    expect(endpoint.health.status).toBe('healthy');
    expect((harness.metrics.webhookDeliveriesSucceeded.labels.mock.calls as any)[0][0]).toBe('room.created');
  });

  it('marks deliveries exhausted after the final failed attempt', async () => {
    const harness = createHarness();
    const encrypted = (harness.service as any).encryptSecret('super-secret');
    const delivery = {
      id: 'delivery-1',
      endpointId: 'endpoint-1',
      eventId: 'event-1',
      eventType: 'room.created',
      roomId: 'room-1',
      attemptCount: 0,
      status: 'queued',
      attempts: [],
      save: jest.fn(async () => undefined)
    };
    const persistedDelivery = {
      ...delivery,
      attempts: [] as Array<Record<string, unknown>>,
      save: jest.fn(async () => undefined)
    };
    const endpoint = {
      id: 'endpoint-1',
      enabled: true,
      url: 'https://hooks.example.test/room-events',
      timeoutMs: 1000,
      maxAttempts: 1,
      initialBackoffMs: 100,
      health: {
        status: 'healthy',
        consecutiveFailures: 0
      },
      signingSecretCiphertext: encrypted.ciphertext,
      signingSecretIv: encrypted.iv,
      signingSecretAuthTag: encrypted.authTag,
      save: jest.fn(async () => undefined)
    };
    const eventDoc = {
      id: 'event-1',
      type: 'room.created',
      roomId: 'room-1',
      occurredAt: new Date('2026-06-19T10:00:00.000Z'),
      event: {
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
      createdAt: new Date('2026-06-19T10:00:00.000Z')
    };
    harness.platformEvents.findById.mockResolvedValue(eventDoc);
    harness.webhookEndpoints.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(endpoint)
    });
    harness.webhookDeliveries.findById.mockResolvedValue(persistedDelivery);
    (globalThis as { fetch?: typeof fetch }).fetch = (jest.fn(async () => ({
      ok: false,
      status: 503
    })) as unknown as typeof fetch);

    await (harness.service as any).dispatchDelivery(delivery);

    expect(persistedDelivery.status).toBe('exhausted');
    expect(endpoint.health.status).toBe('failing');
    expect((harness.metrics.webhookDeliveriesExhausted.labels.mock.calls as any)[0][0]).toBe('room.created');
  });

  it('rejects disabled endpoints during manual replay', async () => {
    const harness = createHarness();
    harness.webhookDeliveries.findById.mockResolvedValue({
      id: 'delivery-1',
      endpointId: 'endpoint-1',
      eventId: 'event-1',
      roomId: 'room-1'
    });
    harness.webhookEndpoints.findById.mockResolvedValue({
      id: 'endpoint-1',
      enabled: false
    });
    harness.platformEvents.findById.mockResolvedValue({
      id: 'event-1',
      type: 'room.created',
      roomId: 'room-1'
    });

    let thrown: unknown;
    try {
      await harness.service.replayWebhookDelivery('delivery-1', {
        type: 'operator',
        label: 'operations-token'
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
  });
});

function createHarness() {
  const platformEvents = createModel();
  const webhookEndpoints = createModel();
  const webhookDeliveries = createModel();
  const metrics = {
    platformEventsEmitted: metricWithLabels(),
    platformEventQueries: metricWithLabels(),
    webhookDeliveryAttempts: metricWithLabels(),
    webhookDeliveriesSucceeded: metricWithLabels(),
    webhookDeliveriesFailed: metricWithLabels(),
    webhookDeliveriesExhausted: metricWithLabels(),
    webhookDeliveriesCancelled: metricWithLabels(),
    webhookRetriesScheduled: metricWithLabels(),
    webhookReplays: metricWithLabels(),
    webhookEndpointCounts: metricWithLabelsAndSet(),
    webhookDeliveryQueue: metricWithLabelsAndSet(),
    webhookDeliveryLatency: metricWithLabelsAndObserve()
  };
  const service = new PlatformEventsService(
    platformEvents as never,
    webhookEndpoints as never,
    webhookDeliveries as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        switch (key) {
          case 'events.webhooks.enabled':
            return true;
          case 'events.webhooks.defaultTimeoutMs':
            return 1000;
          case 'events.webhooks.defaultMaxAttempts':
            return 3;
          case 'events.webhooks.defaultInitialBackoffMs':
            return 100;
          case 'events.webhooks.pollIntervalMs':
            return 1000;
          case 'events.webhooks.leaseMs':
            return 1000;
          case 'events.webhooks.secretEncryptionKey':
            return 'encryption-key';
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
    } as never
  );
  return { service, platformEvents, webhookEndpoints, webhookDeliveries, metrics };
}

function createModel() {
  return {
    create: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    countDocuments: jest.fn(async () => 0),
    insertMany: jest.fn(async () => undefined),
    updateMany: jest.fn(async () => ({ modifiedCount: 0 }))
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
