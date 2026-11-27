import { describe, it, expect, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { SocialAuthService } from './social-auth.service';
import { SOCIAL_FLOW_INDEXES, SOCIAL_USER_INDEXES } from './social-auth.indexes';

function fixture(enabled = false) {
  const flows = { create: jest.fn(), findOneAndUpdate: jest.fn<() => Promise<any>>(), updateOne: jest.fn<() => Promise<any>>(), deleteOne: jest.fn<() => Promise<any>>(), collection: { indexes: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([...SOCIAL_FLOW_INDEXES]) } };
  const users = { collection: { indexes: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([...SOCIAL_USER_INDEXES]) } };
  const oauth = { enabled: jest.fn(() => enabled), authorizationUrl: jest.fn(() => 'https://accounts.google.com/authorize'), exchange: jest.fn<() => Promise<any>>().mockResolvedValue({ provider: 'google', subject: 'fixture', email: 'student@example.test', name: 'Student' }) };
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


describe('Native desktop social handoff', () => {
  const destination = 'http://127.0.0.1:54001/oauth/callback/' + 'a'.repeat(43);
  it('stores only a validated loopback destination and keeps provider callbacks unchanged', async () => {
    const { service, flows } = fixture(true);
    await service.start('google', 'teacher', 'c'.repeat(64), undefined, destination);
    expect(flows.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'teacher', desktopRedirectUri: destination, challenge: 'c'.repeat(64) }));
  });
  it.each(['https://attacker.test/', 'http://localhost:54001/oauth/callback/' + 'a'.repeat(43), 'http://127.0.0.2:54001/oauth/callback/' + 'a'.repeat(43), 'http://127.0.0.1:1023/oauth/callback/' + 'a'.repeat(43), 'http://127.0.0.1:99999/oauth/callback/' + 'a'.repeat(43), destination + '?next=https://attacker.test', destination + '#token', destination.replace('/oauth/', '/admin/'), destination.replace('127.0.0.1', 'user@127.0.0.1')])('rejects unsafe desktop callback %s before creating a flow', async value => {
    const { service, flows } = fixture(true);
    await expect(service.start('google', 'student', 'c'.repeat(64), undefined, value)).rejects.toThrow('Invalid desktop callback');
    expect(flows.create).not.toHaveBeenCalled();
  });
  it('cannot mix account-settings linking with a desktop destination', async () => {
    const { service } = fixture(true);
    await expect(service.start('google', 'student', 'c'.repeat(64), { userId: 'u', tokenId: 't', authVersion: 0 }, destination)).rejects.toThrow('Invalid desktop callback');
  });
  it('returns a short-lived ticket rather than session tokens to the loopback listener', async () => {
    const { service, flows } = fixture(true);
    flows.findOneAndUpdate.mockResolvedValue({ id: 'flow', desktopRedirectUri: destination, nonce: 'nonce' });
    const url = new URL(await service.callback('google', { state: 's', code: 'code' }));
    expect(url.origin + url.pathname).toBe(destination);
    expect(url.hash).toBe(''); expect(url.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.size).toBe(1);
    expect(flows.updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ status: 'ready', ticketHash: expect.any(String) }) }));
  });
  it('sends cancellation to the matching local listener and consumes the processing flow', async () => {
    const { service, flows, oauth } = fixture(true);
    flows.findOneAndUpdate.mockResolvedValue({ id: 'flow', desktopRedirectUri: destination });
    expect(await service.callback('apple', { state: 's', error: 'access_denied' })).toBe(destination + '?error=cancelled');
    expect(oauth.exchange).not.toHaveBeenCalled();
    expect(flows.deleteOne).toHaveBeenCalledWith({ _id: 'flow', status: 'processing' });
  });
  it('fails safely on a stored unsafe destination or an unknown flow', async () => {
    const { service, flows } = fixture(true);
    flows.findOneAndUpdate.mockResolvedValueOnce({ id: 'flow', desktopRedirectUri: 'https://attacker.test' }).mockResolvedValueOnce(null);
    expect(await service.callback('google', { state: 's', error: 'cancelled' })).toBe('https://learn.example.test/auth/social/callback#error=cancelled');
    expect(await service.callback('google', { state: 's', code: 'code' })).toBe('https://learn.example.test/auth/social/callback#error=failed');
  });
});
