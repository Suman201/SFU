import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('checks MongoDB health', async () => {
    const controller = new HealthController(
      { check: jest.fn((checks) => checks[0]()) } as never,
      {} as never,
      { pingCheck: jest.fn().mockResolvedValue({ mongodb: { status: 'up' } }) } as never,
      {} as never
    );

    await expect(controller.db()).resolves.toEqual({ mongodb: { status: 'up' } });
  });

  it('checks Redis health', async () => {
    const controller = new HealthController(
      { check: jest.fn((checks) => checks[0]()) } as never,
      {} as never,
      {} as never,
      { ping: jest.fn().mockResolvedValue('PONG') } as never
    );

    await expect(controller.redisHealth()).resolves.toEqual({ redis: { status: 'up' } });
  });
});
