import { it, expect } from '@jest/globals';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProtocolVersionGuard } from './protocol-version.guard';

@Controller()
class FixtureController {
  @Get('action') action() { return { executed: true }; }
  @Get('payments/webhooks/stripe') webhook() { return { provider: true }; }
}
describe('client wire protocol compatibility', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [FixtureController], providers: [{ provide: APP_GUARD, useClass: ProtocolVersionGuard }] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
  });
  afterAll(() => app.close());
  it('accepts v1 clients and existing unversioned clients with an advertised server version', async () => {
    await request(app.getHttpServer()).get('/api/action').expect(200).expect('x-sfu-protocol-version', '1');
    await request(app.getHttpServer()).get('/api/action').set('x-sfu-protocol-version', '1').expect(200);
  });
  it.each(['2', '0', 'invalid', '1,2'])('rejects incompatible or malformed version %s before the action', async version => {
    const response = await request(app.getHttpServer()).get('/api/action').set('x-sfu-protocol-version', version).expect(426);
    expect(response.body.message).toContain('update the app');
    expect(response.body.executed).toBeUndefined();
  });
  it('does not impose app headers on provider webhooks', async () => {
    await request(app.getHttpServer()).get('/api/payments/webhooks/stripe').set('x-sfu-protocol-version', 'provider').expect(200);
  });
});
