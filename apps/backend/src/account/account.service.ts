import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, isValidObjectId } from 'mongoose';
import bcrypt from 'bcrypt';
import type { AccountSecurity, AccountSessionPage } from '@native-sfu/contracts';
import { UserDocument, UserMongoDocument, SessionDocument, SessionMongoDocument } from '../database/schemas';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AccountEmailJob } from './account-email.schema';

@Injectable()
export class AccountService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly sessions: Model<SessionMongoDocument>,
    @InjectModel(AccountEmailJob.name) private readonly emails: Model<AccountEmailJob>,
    private readonly config: ConfigService,
    private readonly audit: AuditLogsService,
  ) {}
  async security(user: AuthenticatedUser): Promise<AccountSecurity> {
    const account = await this.users.findById(user.sub).select('+passwordHash +googleSubject +appleSubject');
    if (!account) throw new NotFoundException('Account not found.');
    const pending = await this.emails.findOne({ _id: 'email:' + user.sub, kind: 'confirm', authVersion: account.authVersion ?? 0, originalEmail: account.email, state: { $in: ['queued', 'sending', 'sent', 'failed'] }, expiresAt: { $gt: new Date() } }).select('+targetEmail').lean();
    return { email: account.email, emailVerified: Boolean(account.emailVerifiedAt), hasPassword: Boolean(account.passwordHash), googleLinked: Boolean(account.googleSubject), appleLinked: Boolean(account.appleSubject), emailDeliveryAvailable: this.config.get<boolean>('notifications.email.enabled', false) && Boolean(this.config.get<string>('notifications.email.host')) && Boolean(this.config.get<string>('notifications.email.fromEmail')), ...(pending ? { pendingEmail: { email: pending.targetEmail, status: pending.state, requestedAt: pending.requestedAt.toISOString() } } : {}) };
  }
  async proof(userId: string, password: string): Promise<UserMongoDocument> {
    const account = await this.users.findOne({ _id: userId, status: 'active', disabled: false, deletedAt: { $exists: false } }).select('+passwordHash +googleSubject +appleSubject');
    if (!account?.passwordHash || !await bcrypt.compare(password, account.passwordHash)) throw new UnauthorizedException('Confirm your current password to continue.');
    return account;
  }
  async listSessions(user: AuthenticatedUser, page = 1): Promise<AccountSessionPage> {
    const current = await this.users.findById(user.sub).select('authVersion').lean();
    const version = current?.authVersion ?? 0;
    const filter = { userId: user.sub, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() }, $or: [{ authVersion: version }, ...(version === 0 ? [{ authVersion: { $exists: false } }] : [])] };
    const safePage = Math.max(1, Math.min(1000, Math.floor(page) || 1)), limit = 20;
    const [items, total] = await Promise.all([this.sessions.find(filter).select('_id userAgent ipAddress createdAt expiresAt refreshTokenJti').sort({ createdAt: -1, _id: -1 }).skip((safePage - 1) * limit).limit(limit).lean(), this.sessions.countDocuments(filter)]);
    return { page: safePage, limit, total, items: items.map(item => ({ id: String(item._id), device: this.device(item.userAgent ?? ''), ...(item.ipAddress ? { ipAddress: item.ipAddress } : {}), signedInAt: (item.createdAt ?? item.expiresAt).toISOString(), expiresAt: item.expiresAt.toISOString(), current: item.refreshTokenJti === user.tokenId })) };
  }
  async revokeSession(user: AuthenticatedUser, id: string): Promise<{ current: boolean }> {
    if (!isValidObjectId(id)) throw new NotFoundException('Session not found.');
    const row = await this.sessions.findOneAndUpdate({ _id: id, userId: user.sub, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (!row) throw new NotFoundException('Session not found.');
    await this.audit.record({ actor: user, action: 'account.session_revoked', resourceType: 'session', resourceId: id });
    return { current: row.refreshTokenJti === user.tokenId };
  }
  async revokeOthers(user: AuthenticatedUser): Promise<void> {
    await this.sessions.updateMany({ userId: user.sub, refreshTokenJti: { $ne: user.tokenId }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.audit.record({ actor: user, action: 'account.other_sessions_revoked', resourceType: 'user', resourceId: user.sub });
  }
  async unlink(user: AuthenticatedUser, provider: 'google' | 'apple', password: string): Promise<void> {
    const account = await this.proof(user.sub, password);
    const field = provider === 'google' ? 'googleSubject' : 'appleSubject';
    if (!account[field]) throw new BadRequestException('This sign-in method is not connected.');
    const changed = await this.users.updateOne({ _id: user.sub, passwordHash: account.passwordHash, [field]: account[field], $expr: { $eq: [{ $ifNull: ['$authVersion', 0] }, account.authVersion ?? 0] } }, { $unset: { [field]: 1 }, $inc: { authVersion: 1 } });
    if (!changed.modifiedCount) throw new UnauthorizedException('The account changed. Sign in and try again.');
    await this.audit.record({ actor: user, action: 'account.provider_unlinked', resourceType: 'user', resourceId: user.sub, metadata: { provider } });
  }
  private device(agent: string): string {
    const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /(?:Chrome|Chromium)\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
    const platform = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Macintosh|Mac OS/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : 'Unknown device';
    return `${browser} · ${platform}`;
  }
}
