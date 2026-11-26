import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createPublicKey, type JsonWebKey } from 'node:crypto';
import { isEmail } from 'class-validator';
import { SocialIdentity, SocialProvider } from './social-auth.schema';

export const SOCIAL_ENDPOINTS = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', keys: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] },
  apple: { authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', keys: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] }
} as const;

@Injectable()
export class SocialOAuthClient {
  private readonly keyCache = new Map<string, { keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>; fetchedAt: number }>();
  constructor(private readonly config: ConfigService, private readonly jwt: JwtService) {}

  enabled(provider: SocialProvider): boolean {
    return this.config.get<boolean>(`socialAuth.${provider}.enabled`, false);
  }

  authorizationUrl(provider: SocialProvider, state: string, nonce: string, verifier?: string): string {
    const config = this.settings(provider);
    const url = new URL(SOCIAL_ENDPOINTS[provider].authorize);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: provider === 'google' ? 'openid email profile' : 'name email', state, nonce }).toString();
    if (provider === 'apple') url.searchParams.set('response_mode', 'form_post');
    else {
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier!).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('prompt', 'select_account');
    }
    return url.href;
  }

  async exchange(provider: SocialProvider, code: string, nonce: string, verifier?: string, appleUser?: string): Promise<SocialIdentity> {
    const config = this.settings(provider);
    const clientSecret = provider === 'google' ? config.clientSecret : await this.jwt.signAsync({}, {
      privateKey: config.privateKey, algorithm: 'ES256', keyid: config.keyId,
      issuer: config.teamId, subject: config.clientId, audience: 'https://appleid.apple.com', expiresIn: 300
    });
    const body = new URLSearchParams({ client_id: config.clientId, client_secret: clientSecret!, code, grant_type: 'authorization_code', redirect_uri: config.redirectUri });
    if (provider === 'google') body.set('code_verifier', verifier!);
    const tokens = await this.request(SOCIAL_ENDPOINTS[provider].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16384) throw this.invalid();
    const identity = await this.verify(provider, tokens.id_token, nonce);
    // Apple sends the display name only on the first consent. It is never used as identity evidence.
    if (provider === 'apple' && appleUser) {
      try {
        const user = JSON.parse(appleUser) as { name?: { firstName?: unknown; lastName?: unknown } };
        const name = [user.name?.firstName, user.name?.lastName].filter(value => typeof value === 'string').join(' ').trim();
        if (name) identity.name = name.slice(0, 120);
      } catch { /* The signed token remains authoritative for subject and email. */ }
    }
    return identity;
  }

  async verify(provider: SocialProvider, token: string, nonce: string): Promise<SocialIdentity> {
    try {
      const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { kid?: string; alg?: string };
      if (header.alg !== 'RS256' || !header.kid || header.kid.length > 200) throw this.invalid();
      let cached = this.keyCache.get(provider);
      if (!cached || Date.now() - cached.fetchedAt > 3600000 || (!cached.keys.some(key => key.kid === header.kid) && Date.now() - cached.fetchedAt > 60000)) {
        const response = await this.request(SOCIAL_ENDPOINTS[provider].keys);
        if (!Array.isArray(response.keys) || response.keys.length > 20) throw this.invalid();
        cached = { keys: response.keys, fetchedAt: Date.now() };
        this.keyCache.set(provider, cached);
      }
      const key = cached.keys.find(value => value.kid === header.kid && value.kty === 'RSA' && (!value.use || value.use === 'sig') && (!value.alg || value.alg === 'RS256'));
      if (!key) throw this.invalid();
      const publicKey = createPublicKey({ key, format: 'jwk' }).export({ format: 'pem', type: 'spki' });
      const claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        publicKey, algorithms: ['RS256'], issuer: [...SOCIAL_ENDPOINTS[provider].issuers], audience: this.settings(provider).clientId, clockTolerance: 5
      });
      if (claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
          typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || claims.iat > Date.now() / 1000 + 5 ||
          (claims.azp !== undefined && claims.azp !== this.settings(provider).clientId) ||
          ![true, 'true'].includes(claims.email_verified as boolean | string) || typeof claims.email !== 'string' ||
          claims.email.length > 254 || !isEmail(claims.email)) throw this.invalid();
      return { provider, subject: claims.sub, email: claims.email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : 'New learner' };
    } catch { throw this.invalid(); }
  }

  private settings(provider: SocialProvider): { clientId: string; redirectUri: string; clientSecret?: string; teamId?: string; keyId?: string; privateKey?: string } {
    return this.config.getOrThrow(`socialAuth.${provider}`);
  }

  private async request(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw this.invalid();
    const text = await response.text();
    if (text.length > 128 * 1024) throw this.invalid();
    return JSON.parse(text) as Record<string, unknown>;
  }
  private invalid(): UnauthorizedException { return new UnauthorizedException('The identity provider could not be verified. Please try again.'); }
}
