import { BadRequestException, Injectable, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { Model } from 'mongoose';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { SOCIAL_FLOW_INDEXES, SOCIAL_USER_INDEXES } from './social-auth.indexes';
import { AuthService, RequestContext, TokenPair } from './auth.service';
import { SocialOAuthClient } from './social-oauth.client';
import { SocialAuthFlow, SocialAuthFlowDocument, SocialProvider } from './social-auth.schema';

@Injectable()
export class SocialAuthService implements OnModuleInit {
  constructor(
    @InjectModel(SocialAuthFlow.name) private readonly flows: Model<SocialAuthFlowDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly oauth: SocialOAuthClient,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.oauth.enabled('google') && !this.oauth.enabled('apple')) return;
    if (this.config.get<string>('app.nodeEnv') !== 'production') await Promise.all([this.flows.init(), this.users.init()]);
    for (const [model, required] of [[this.users, SOCIAL_USER_INDEXES], [this.flows, SOCIAL_FLOW_INDEXES]] as const) {
      const actual = await model.collection.indexes();
      for (const expected of required) {
        const found = actual.find(index => JSON.stringify(index.key) === JSON.stringify(expected.key));
        if (!found || ('unique' in expected && found.unique !== true) || ('sparse' in expected && found.sparse !== true) || ('expireAfterSeconds' in expected && found.expireAfterSeconds !== expected.expireAfterSeconds)) {
          throw new Error('Social sign-in requires its database indexes. Run npm run setup:social-auth before enabling a provider.');
        }
      }
    }
  }

  providers(): { google: boolean; apple: boolean } {
    return { google: this.oauth.enabled('google'), apple: this.oauth.enabled('apple') };
  }

  async start(provider: SocialProvider, role: 'student' | 'teacher', challenge: string, link?: { userId: string; tokenId: string; authVersion: number }, desktopRedirectUri?: string): Promise<{ authorizationUrl: string }> {
    if (desktopRedirectUri !== undefined && (link || !this.desktopDestination(desktopRedirectUri))) throw new BadRequestException('Invalid desktop callback.');
    if (!this.oauth.enabled(provider)) throw new ServiceUnavailableException('This sign-in provider is not available yet. Please use email and password.');
    const state = this.opaque(), nonce = this.opaque();
    const codeVerifier = provider === 'google' ? this.opaque() : undefined;
    await this.flows.create({ stateHash: this.hash(state), nonce, codeVerifier, provider, role, challenge, ...(desktopRedirectUri ? { desktopRedirectUri } : {}), ...(link ? { purpose: 'link', linkUserId: link.userId, linkTokenId: link.tokenId, linkAuthVersion: link.authVersion } : {}), status: 'pending', expiresAt: new Date(Date.now() + 10 * 60000) });
    return { authorizationUrl: this.oauth.authorizationUrl(provider, state, nonce, codeVerifier) };
  }

  async callback(provider: SocialProvider, input: { state?: string; code?: string; error?: string; user?: string }): Promise<string> {
    const destination = new URL('/auth/social/callback', this.config.getOrThrow<string>('socialAuth.frontendUrl'));
    destination.hash = 'error=failed';
    if (!input.state || input.state.length > 128 || !this.oauth.enabled(provider)) return destination.href;
    const flow = await this.flows.findOneAndUpdate({ stateHash: this.hash(input.state), provider, status: 'pending', expiresAt: { $gt: new Date() } }, { $set: { status: 'processing' } }, { new: true });
    if (!flow) return destination.href;
    const desktop = flow.purpose !== 'link' && flow.desktopRedirectUri ? this.desktopDestination(flow.desktopRedirectUri) : null;
    if (desktop) { destination.href = desktop.href; destination.search = 'error=failed'; }
    if (flow.purpose === 'link') destination.pathname = '/account/link-provider';
    try {
      if (input.error) {
        if (desktop) destination.search = 'error=cancelled'; else destination.hash = 'error=cancelled';
        return destination.href;
      }
      if (!input.code || input.code.length > 4096 || (input.user?.length ?? 0) > 8192) return destination.href;
      const identity = await this.oauth.exchange(provider, input.code, flow.nonce, flow.codeVerifier, input.user);
      const ticket = this.opaque();
      await this.flows.updateOne({ _id: flow.id, status: 'processing' }, { $set: { status: 'ready', ticketHash: this.hash(ticket), identity, expiresAt: new Date(Date.now() + 2 * 60000) }, $unset: { nonce: 1, codeVerifier: 1 } });
      if (desktop) destination.search = `ticket=${ticket}`; else destination.hash = `ticket=${ticket}`;
      return destination.href;
    } catch {
      return destination.href;
    } finally {
      await this.flows.deleteOne({ _id: flow.id, status: 'processing' });
    }
  }

  async exchange(ticket: string, verifier: string, credentials: { email: string; password: string } | undefined, context: RequestContext): Promise<TokenPair> {
    const flow = await this.flows.findOneAndUpdate({ purpose: { $ne: 'link' }, ticketHash: this.hash(ticket), challenge: this.hash(verifier), status: 'ready', attempts: { $lt: 5 }, expiresAt: { $gt: new Date() } }, { $set: { status: 'exchanging' }, $inc: { attempts: 1 } }, { new: true });
    if (!flow?.identity) throw new UnauthorizedException('This sign-in attempt expired or belongs to another browser. Please start again.');
    try {
      const result = await this.auth.socialLogin(flow.identity, flow.role, credentials, context);
      await this.flows.deleteOne({ _id: flow.id, status: 'exchanging' });
      return result;
    } catch (error) {
      await this.flows.updateOne({ _id: flow.id, status: 'exchanging' }, { $set: { status: 'ready' } });
      throw error;
    }
  }
  async completeLink(ticket: string, verifier: string, user: { sub: string; tokenId: string }, context: RequestContext): Promise<void> {
    const flow = await this.flows.findOneAndUpdate({ purpose: 'link', linkUserId: user.sub, linkTokenId: user.tokenId, ticketHash: this.hash(ticket), challenge: this.hash(verifier), status: 'ready', expiresAt: { $gt: new Date() } }, { $set: { status: 'exchanging' } }, { new: true });
    if (!flow?.identity || flow.linkAuthVersion === undefined) throw new UnauthorizedException('This connection attempt expired or belongs to another account or device.');
    try { await this.auth.linkSocialIdentity(user.sub, flow.identity, flow.linkAuthVersion, flow.role, context); }
    finally { await this.flows.deleteOne({ _id: flow.id }); }
  }
  private opaque(): string { return randomBytes(32).toString('base64url'); }
  private desktopDestination(value: string): URL | null {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/oauth\/callback\/[A-Za-z0-9_-]{43}$/.test(value)) return null;
    try { const url = new URL(value); return Number(url.port) >= 1024 && url.href === value ? url : null; } catch { return null; }
  }
  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
}
