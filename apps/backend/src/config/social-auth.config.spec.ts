import { describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { validateSocialAuthConfig } from './social-auth.config';
const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const base = { NODE_ENV: 'production', FRONTEND_URL: 'https://learn.example.test', GOOGLE_AUTH_ENABLED: true, GOOGLE_AUTH_CLIENT_ID: 'client', GOOGLE_AUTH_CLIENT_SECRET: 'secret', GOOGLE_AUTH_REDIRECT_URI: 'https://api.example.test/api/v1/auth/social/google/callback' };
describe('Social sign-in configuration', () => {
  it('allows an unconfigured installation with providers disabled', () => { const errors: string[] = []; validateSocialAuthConfig({}, errors); expect(errors).toEqual([]); });
  it('requires all enabled provider credentials', () => { const errors: string[] = []; validateSocialAuthConfig({ GOOGLE_AUTH_ENABLED: true }, errors); expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('CLIENT_ID is required'), expect.stringContaining('CLIENT_SECRET is required')])); });
  it('accepts fixed production callbacks', () => { const errors: string[] = []; validateSocialAuthConfig(base, errors); expect(errors).toEqual([]); });
  it.each(['http://example.test/api/v1/auth/social/google/callback', 'https://api.example.test/wrong', 'https://api.example.test/api/v1/auth/social/google/callback?next=https://evil.test', 'https://user:pass@api.example.test/api/v1/auth/social/google/callback'])('rejects unsafe callbacks: %s', url => { const errors: string[] = []; validateSocialAuthConfig({ ...base, GOOGLE_AUTH_REDIRECT_URI: url }, errors); expect(errors.length).toBeGreaterThan(0); });
  it('validates Apple signing keys', () => { const errors: string[] = []; validateSocialAuthConfig({ ...base, APPLE_AUTH_ENABLED: true, APPLE_AUTH_CLIENT_ID: 'service', APPLE_AUTH_TEAM_ID: 'team', APPLE_AUTH_KEY_ID: 'key', APPLE_AUTH_PRIVATE_KEY: pem, APPLE_AUTH_REDIRECT_URI: 'https://api.example.test/api/v1/auth/social/apple/callback' }, errors); expect(errors).toEqual([]); });
});
