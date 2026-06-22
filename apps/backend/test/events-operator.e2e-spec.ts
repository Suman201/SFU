import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { EventsController } from '../src/events/events.controller';
import { PlatformEventsService } from '../src/events/platform-events.service';
import { OperationsTokenGuard } from '../src/common/guards/operations-token.guard';

describe('Eventing operator routes (e2e)', () => {
  let app: INestApplication;

  const events = {
    createWebhookEndpoint: jest.fn(async () => ({
      endpoint: {
        id: 'endpoint-1',
        name: 'Ops Audit',
        enabled: true,
        url: 'https://hooks.example.test/events',
        subscribedEventTypes: ['room.created'],
        timeoutMs: 1000,
        maxAttempts: 3,
        initialBackoffMs: 100,
        signingAlgorithm: 'hmac-sha256',
        secretConfigured: true,
        health: {
          status: 'healthy',
          consecutiveFailures: 0
        },
        createdAt: '2026-06-19T10:00:00.000Z',
        updatedAt: '2026-06-19T10:00:00.000Z'
      },
      signingSecret: 'secret-value'
    })),
    createRedisStreamEndpoint: jest.fn(async () => ({
      id: 'redis-endpoint-1',
      adapterKind: 'redis-stream',
      name: 'Ops Stream',
      enabled: true,
      streamKey: 'ops:events',
      maxLen: 500,
      subscribedEventTypes: ['room.created'],
      timeoutMs: 750,
      maxAttempts: 2,
      initialBackoffMs: 500,
      health: {
        status: 'healthy',
        consecutiveFailures: 0
      },
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T10:00:00.000Z'
    })),
    diagnosticsSummary: jest.fn(async () => ({
      observedAt: '2026-06-20T10:00:00.000Z',
      endpointCounts: {
        total: 5,
        enabled: 4,
        disabled: 1,
        unhealthy: 1
      },
      endpointCountsByAdapter: {
        webhook: 3,
        'redis-stream': 2
      },
      deliveryCounts: {
        queued: 2,
        retrying: 1,
        dispatching: 0,
        delivered: 8,
        exhausted: 1,
        cancelled: 0
      },
      deliveryCountsByAdapter: {
        webhook: {
          queued: 1,
          retrying: 1,
          dispatching: 0,
          delivered: 4,
          exhausted: 1,
          cancelled: 0
        },
        'redis-stream': {
          queued: 1,
          retrying: 0,
          dispatching: 0,
          delivered: 4,
          exhausted: 0,
          cancelled: 0
        }
      },
      failureCategoryCounts: {
        http: 1,
        timeout: 0,
        network: 0,
        auth: 0,
        configuration: 0,
        storage: 0,
        throttled: 0,
        endpoint_disabled: 0,
        endpoint_missing: 0,
        event_missing: 0
      },
      snapshotSourceCounts: {
        queued_endpoint_state: 5,
        original_delivery_snapshot: 0,
        current_endpoint_state: 0
      },
      adapterCounts: {
        webhook: 2,
        'redis-stream': 1
      },
      dispatch: {
        concurrency: 4,
        maxBatchPerPump: 16,
        maxConcurrentPerEndpoint: 2,
        activeDispatches: 0,
        nextClaimPrefers: 'queued'
      },
      activeDispatchesByAdapter: {
        webhook: 0,
        'redis-stream': 0
      },
      leaseCounts: {
        active: 0,
        expired: 0
      },
      backlogAging: {
        queued: 30_000,
        retrying: 10_000,
        dispatching: 0
      },
      backlogAgingByAdapter: {
        webhook: {
          queued: 30_000,
          retrying: 10_000,
          dispatching: 0
        },
        'redis-stream': {
          queued: 15_000,
          retrying: 0,
          dispatching: 0
        }
      },
      fairness: {
        activeLaneCount: 3,
        queuedLaneCount: 2,
        retryingLaneCount: 1,
        dispatchingLaneCount: 0,
        largestBacklogEndpointShare: 0.5,
        largestBacklogEndpointShareByAdapter: {
          webhook: 0.5,
          'redis-stream': 1
        }
      },
      topBacklogEndpoints: [],
      retention: {
        eventRetentionDays: 30,
        deliveryRetentionDays: 14,
        exhaustedDeliveryRetentionDays: 30,
        cleanupIntervalMs: 60_000
      },
      recentEventCount: 12,
      lastEventAt: '2026-06-20T10:00:00.000Z'
    })),
    listEvents: jest.fn(async () => ({
      events: []
    }))
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        OperationsTokenGuard,
        { provide: PlatformEventsService, useValue: events },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === 'security.operationsToken' ? 'ops-token' : undefined))
          }
        }
      ]
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects requests without the operations token', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/events/log');

    expect(response.status).toBe(401);
  });

  it('routes webhook creation through the operator API surface', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/events/webhooks')
      .set('x-operations-token', 'ops-token')
      .send({
        name: 'Ops Audit',
        url: 'https://hooks.example.test/events',
        subscribedEventTypes: ['room.created']
      });
    const body = response.body;

    expect(response.status).toBe(201);
    expect(body.endpoint.id).toBe('endpoint-1');
    const requestBody = (events.createWebhookEndpoint.mock.calls as any)[0][0];
    const actor = (events.createWebhookEndpoint.mock.calls as any)[0][1];
    expect((requestBody as any).name).toBe('Ops Audit');
    expect((requestBody as any).url).toBe('https://hooks.example.test/events');
    expect((requestBody as any).subscribedEventTypes).toEqual(['room.created']);
    expect((actor as any).type).toBe('operator');
    expect((actor as any).label).toBe('operations-token');
  });

  it('routes redis-stream endpoint creation through the operator API surface', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/events/redis-streams')
      .set('x-operations-token', 'ops-token')
      .send({
        name: 'Ops Stream',
        streamKey: 'ops:events',
        maxLen: 500,
        subscribedEventTypes: ['room.created']
      });
    const body = response.body;

    expect(response.status).toBe(201);
    expect(body.id).toBe('redis-endpoint-1');
    expect(body.adapterKind).toBe('redis-stream');
    const requestBody = (events.createRedisStreamEndpoint.mock.calls as any)[0][0];
    const actor = (events.createRedisStreamEndpoint.mock.calls as any)[0][1];
    expect((requestBody as any).name).toBe('Ops Stream');
    expect((requestBody as any).streamKey).toBe('ops:events');
    expect((requestBody as any).maxLen).toBe(500);
    expect((requestBody as any).subscribedEventTypes).toEqual(['room.created']);
    expect((actor as any).type).toBe('operator');
    expect((actor as any).label).toBe('operations-token');
  });

  it('normalizes event-log query parameters before delegating to the service', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/events/log')
      .query({
        roomId: 'room-1',
        eventTypes: 'room.created,room.closed',
        limit: '12'
      })
      .set('x-operations-token', 'ops-token');

    expect(response.status).toBe(200);
    expect((events.listEvents.mock.calls as any)[0][0]).toEqual({
      roomId: 'room-1',
      eventTypes: ['room.created', 'room.closed'],
      limit: 12
    });
  });

  it('exposes the eventing diagnostics summary through the operator route', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/events/diagnostics/summary')
      .set('x-operations-token', 'ops-token');

    expect(response.status).toBe(200);
    expect(response.body.fairness.largestBacklogEndpointShare).toBe(0.5);
    expect(response.body.backlogAgingByAdapter['redis-stream'].queued).toBe(15000);
    expect(events.diagnosticsSummary).toHaveBeenCalledTimes(1);
  });
});
