import { describe, it, expect, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { SocialAuthService } from './social-auth.service';
import { SOCIAL_FLOW_INDEXES, SOCIAL_USER_INDEXES } from './social-auth.indexes';

function fixture(enabled = false) {
  const flows = { create: jest.fn(), collection: { indexes: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([...SOCIAL_FLOW_INDEXES]) } };
  const users = { collection: { indexes: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([...SOCIAL_USER_INDEXES]) } };
  const oauth = { enabled: jest.fn(() => enabled), authorizationUrl: jest.fn(() => 'https://accounts.google.com/authorize') };
  const config = new ConfigService({ app: { nodeEnv: 'production' }, socialAuth: { frontendUrl: 'https://learn.example.test' } });
  return { flows, users, oauth, service: new SocialAuthService(flows as never, users as never, oauth as never, {} as never, config) };
}
describe('Social auth deployment gates', () => {
  it('keeps disabled providers unavailable without creating a flow', async () => {
    const { service, flows } = fixture();
    expect(service.providers()).toEqual({ google: false, apple: false });
    await service.onModuleInit();
    await expect(service.start('google', 'student', 'a'.repeat(64))).rejects.toThrow('not available yet');
    expect(flows.create).not.toHaveBeenCalled();
  });
  it('does not redirect an invalid callback to caller-controlled URLs', async () => {
    const { service } = fixture();
    expect(await service.callback('google', { error: 'https://attacker.test' })).toBe('https://learn.example.test/auth/social/callback#error=failed');
  });
  it('accepts provisioned identity, replay and TTL indexes', async () => {
    await expect(fixture(true).service.onModuleInit()).resolves.toBeUndefined();
  });
  it('refuses enabled social login when identity uniqueness is absent', async () => {
    const { users, service } = fixture(true);
    users.collection.indexes.mockResolvedValue([{ key: { googleSubject: 1 } }]);
    await expect(service.onModuleInit()).rejects.toThrow('setup:social-auth');
  });
  it('refuses enabled social login when flow expiry is absent', async () => {
    const { flows, service } = fixture(true);
    flows.collection.indexes.mockResolvedValue(SOCIAL_FLOW_INDEXES.filter(index => index.name !== 'expiresAt_1'));
    await expect(service.onModuleInit()).rejects.toThrow('setup:social-auth');
  });
});
