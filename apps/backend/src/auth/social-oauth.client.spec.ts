import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { SocialOAuthClient, SOCIAL_ENDPOINTS } from './social-oauth.client';

const jwt = new JwtService();
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const appleKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const config = new ConfigService({ socialAuth: {
  google: { enabled: true, clientId: 'google-client', clientSecret: 'test-secret', redirectUri: 'https://api.example.test/api/v1/auth/social/google/callback' },
  apple: { enabled: true, clientId: 'apple-client', teamId: 'TESTTEAMID', keyId: 'TESTKEYID', privateKey: appleKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), redirectUri: 'https://api.example.test/api/v1/auth/social/apple/callback' },
} });

async function token(provider: 'google' | 'apple', claims: Record<string, unknown> = {}, options: Record<string, any> = {}) {
  return jwt.signAsync({ sub: 'subject-1', nonce: 'nonce-1', email: 'Verified@example.test', email_verified: true, ...claims }, { privateKey, algorithm: 'RS256', keyid: 'test-key', audience: provider + '-client', issuer: SOCIAL_ENDPOINTS[provider].issuers[0], expiresIn: 300, ...options });
}
describe('SocialOAuthClient signed provider tokens', () => {
  let client: SocialOAuthClient;
  let request: jest.SpiedFunction<typeof global.fetch>;
  beforeEach(() => {
    client = new SocialOAuthClient(config, jwt);
    request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it.each(['google', 'apple'] as const)('accepts a signed %s identity and normalizes email', async provider => {
    expect(await client.verify(provider, await token(provider, { email_verified: 'true' }), 'nonce-1')).toMatchObject({ provider, subject: 'subject-1', email: 'verified@example.test' });
    expect(request).toHaveBeenCalledWith(SOCIAL_ENDPOINTS[provider].keys, expect.objectContaining({ redirect: 'error' }));
  });
  it.each([
    ['nonce', { nonce: 'another-flow' }, {}], ['unverified', { email_verified: false }, {}],
    ['email', { email: 'invalid' }, {}], ['subject', { sub: '' }, {}],
    ['audience', {}, { audience: 'another-client' }], ['issuer', {}, { issuer: 'https://attacker.test' }],
    ['expired', {}, { expiresIn: -60 }], ['future', { iat: Math.floor(Date.now()/1000) + 300 }, {}],
    ['authorized party', { azp: 'attacker' }, {}], ['key', {}, { keyid: 'unknown-key' }],
  ])('rejects invalid %s without trusting token claims', async (_, claims, options) => {
    await expect(client.verify('google', await token('google', claims as Record<string, unknown>, options as Record<string, any>), 'nonce-1')).rejects.toThrow('could not be verified');
  });
  it('rejects an HMAC token even when it uses the expected key identifier', async () => {
    const unsigned = await jwt.signAsync({ sub: 'subject-1' }, { secret: 'attacker-secret', algorithm: 'HS256', keyid: 'test-key' });
    await expect(client.verify('apple', unsigned, 'nonce-1')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a forged RSA signature', async () => {
    const signed = await token('google');
    const parts = signed.split('.');
    parts[2] = 'A'.repeat(parts[2]!.length);
    await expect(client.verify('google', parts.join('.'), 'nonce-1')).rejects.toThrow();
  });
  it('uses PKCE for Google and form_post for Apple', () => {
    const google = new URL(client.authorizationUrl('google', 'state', 'nonce', 'verifier'));
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    expect(google.searchParams.get('scope')).toBe('openid email profile');
    const apple = new URL(client.authorizationUrl('apple', 'state', 'nonce'));
    expect(apple.searchParams.get('response_mode')).toBe('form_post');
    expect(apple.searchParams.get('response_type')).toBe('code');
  });
  it('exchanges Google codes with a verifier and verifies the returned ID token', async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify({ id_token: await token('google') }))).mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })));
    expect(await client.exchange('google', 'authorization-code', 'nonce-1', 'pkce-verifier')).toMatchObject({ subject: 'subject-1' });
    const body = new URLSearchParams(request.mock.calls[0]![1]!.body as string);
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('redirect_uri')).toBe('https://api.example.test/api/v1/auth/social/google/callback');
  });
  it('signs an Apple client secret and accepts its first-consent name without using the unsigned email', async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify({ id_token: await token('apple') }))).mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })));
    const identity = await client.exchange('apple', 'code', 'nonce-1', undefined, JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'attacker@example.test' }));
    expect(identity).toMatchObject({ name: 'Ada Lovelace', email: 'verified@example.test' });
    const secret = new URLSearchParams(request.mock.calls[0]![1]!.body as string).get('client_secret')!;
    expect(await jwt.verifyAsync(secret, { publicKey: appleKeys.publicKey.export({ format: 'pem', type: 'spki' }), algorithms: ['ES256'], issuer: 'TESTTEAMID', subject: 'apple-client', audience: 'https://appleid.apple.com' })).toMatchObject({ sub: 'apple-client' });
  });
  it('does not repeatedly fetch keys for attacker-controlled key identifiers', async () => {
    await expect(client.verify('google', await token('google', {}, { keyid: 'bad-1' }), 'nonce-1')).rejects.toThrow();
    await expect(client.verify('google', await token('google', {}, { keyid: 'bad-2' }), 'nonce-1')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
