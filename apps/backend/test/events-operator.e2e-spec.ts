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
});
