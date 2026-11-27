import { BadRequestException, ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { EmailNotificationService } from '../notifications/email-notification.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AccountService } from './account.service';
import { AccountEmailJob, AccountEmailJobMongo, ACCOUNT_EMAIL_INDEXES } from './account-email.schema';

@Injectable()
export class AccountEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountEmailService.name);
  private timer?: NodeJS.Timeout;
  private processing?: Promise<void>;
  constructor(
    @InjectModel(AccountEmailJob.name) private readonly jobs: Model<AccountEmailJob>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly accounts: AccountService,
    private readonly config: ConfigService,
    private readonly mail: EmailNotificationService,
    private readonly audit: AuditLogsService,
  ) {}
  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('notifications.email.enabled', false)) return;
    if (this.config.get<string>('app.nodeEnv') !== 'production') await this.jobs.init();
    const actual = await this.jobs.collection.indexes();
    for (const expected of ACCOUNT_EMAIL_INDEXES) {
      const index = actual.find(index => JSON.stringify(index.key) === JSON.stringify(expected.key));
      if (!index || ('unique' in expected && !index.unique) || ('sparse' in expected && !index.sparse) || ('expireAfterSeconds' in expected && index.expireAfterSeconds !== expected.expireAfterSeconds)) throw new Error('Run setup:account-settings before enabling account email delivery.');
    }
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick();
  }
  async onModuleDestroy(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.processing; }
  async request(user: AuthenticatedUser, email: string, password: string): Promise<void> {
    if (!(await this.accounts.security(user)).emailDeliveryAvailable || !this.config.get<string>('passwordRecovery.webUrl')) throw new ServiceUnavailableException('Email verification is not available yet. Contact support if you need to change your email.');
    const account = await this.accounts.proof(user.sub, password);
    const targetEmail = email.trim().toLowerCase();
    if (targetEmail === account.email && account.emailVerifiedAt) throw new BadRequestException('Your email is already verified.');
    if (targetEmail !== account.email && await this.users.exists({ email: targetEmail })) throw new ConflictException('This email cannot be used for this account.');
    const now = new Date();
    try {
      const windowFloor = new Date(now.getTime() - 3600000);
      const resetWindow = { $lte: [{ $ifNull: ['$windowStart', new Date(0)] }, windowFloor] };
      await this.jobs.updateOne({ _id: 'email:' + user.sub, $and: [
        { $or: [{ requestedAt: { $lte: new Date(now.getTime() - 60000) } }, { requestedAt: { $exists: false } }] },
        { $or: [{ windowStart: { $lte: windowFloor } }, { windowStart: { $exists: false } }, { requestCount: { $lt: 5 } }] },
        { $or: [{ state: { $ne: 'sending' } }, { leaseUntil: { $lte: now } }] },
      ] }, [{ $set: { userId: user.sub, requestId: randomUUID(), kind: 'confirm', targetEmail: { $literal: targetEmail }, originalEmail: { $literal: account.email }, authVersion: account.authVersion ?? 0, state: 'queued', attempts: 0, requestedAt: now, availableAt: now, expiresAt: new Date(now.getTime() + 3600000), windowStart: { $cond: [resetWindow, now, '$windowStart'] }, requestCount: { $cond: [resetWindow, 1, { $add: [{ $ifNull: ['$requestCount', 0] }, 1] }] } } }, { $unset: ['tokenHash', 'tokenExpiresAt', 'leaseToken', 'leaseUntil'] }], { upsert: true });
    } catch (error) { if ((error as { code?: number }).code === 11000) throw new HttpException('Wait before requesting another verification email.', 429); throw error; }
    await this.audit.record({ actor: user, action: 'account.email_verification_requested', resourceType: 'user', resourceId: user.sub });
    this.tick();
  }
  async cancel(user: AuthenticatedUser): Promise<void> {
    await this.jobs.updateOne({ _id: 'email:' + user.sub }, { $set: { state: 'cancelled' }, $unset: { tokenHash: 1, tokenExpiresAt: 1, targetEmail: 1, originalEmail: 1, leaseToken: 1, leaseUntil: 1 } });
    await this.audit.record({ actor: user, action: 'account.email_change_cancelled', resourceType: 'user', resourceId: user.sub });
  }
  async confirm(token: string): Promise<{ changed: boolean; accountId: string; role: 'teacher' | 'student' }> {
    let userId = '', changed = false; let role: 'teacher' | 'student' = 'student';
    try {
      await this.connection.transaction(async session => {
        const now = new Date();
        const job = await this.jobs.findOneAndUpdate({ tokenHash: this.hash(token), kind: 'confirm', state: { $in: ['sending', 'sent'] }, tokenExpiresAt: { $gt: now }, expiresAt: { $gt: now } }, { $set: { state: 'consumed' } }, { new: true, session }).select('+targetEmail +originalEmail');
        if (!job) throw new BadRequestException('This verification link is invalid, expired or already used. Request a new link.');
        userId = job.userId; changed = job.targetEmail !== job.originalEmail;
        const account = await this.users.findOneAndUpdate({ _id: job.userId, email: job.originalEmail, disabled: false, status: 'active', deletedAt: { $exists: false }, $expr: { $eq: [{ $ifNull: ['$authVersion', 0] }, job.authVersion] } }, { $set: { email: job.targetEmail, emailVerifiedAt: now }, ...(changed ? { $inc: { authVersion: 1 }, $unset: { passwordResetHash: 1, passwordResetExpiresAt: 1, passwordResetIssuedAt: 1 } } : {}) }, { new: true, session });
        if (!account) throw new BadRequestException('Your account changed after this link was requested. Request a new verification email.');
        role = account.roles.some(value => ['TEACHER', 'ADMIN', 'SUPER_ADMIN'].includes(value)) ? 'teacher' : 'student';
        if (changed) await this.jobs.create([{ _id: 'notice:' + job.requestId, userId, requestId: job.requestId, kind: 'changed_notice', targetEmail: job.originalEmail, originalEmail: job.originalEmail, authVersion: account.authVersion ?? 0, state: 'queued', attempts: 0, requestedAt: now, availableAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000) }], { session });
        await this.jobs.updateOne({ _id: job.id, requestId: job.requestId }, { $unset: { tokenHash: 1, targetEmail: 1, originalEmail: 1, leaseToken: 1, leaseUntil: 1 } }, { session });
      });
    } catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('This email cannot be used for this account.'); throw error; }
    await this.audit.record({ actorId: userId, action: changed ? 'account.email_changed' : 'account.email_verified', resourceType: 'user', resourceId: userId });
    this.tick(); return { changed, accountId: userId, role };
  }
  private tick(): void {
    if (!this.config.get<boolean>('notifications.email.enabled', false) || this.processing) return;
    this.processing = this.drain().catch(() => this.logger.warn('Account email delivery is temporarily unavailable.')).finally(() => { this.processing = undefined; });
  }
  private async drain(): Promise<void> {
    await this.jobs.updateMany({ state: 'sending', attempts: { $gte: 5 }, leaseUntil: { $lte: new Date() } }, { $set: { state: 'failed' }, $unset: { tokenHash: 1, leaseToken: 1, leaseUntil: 1 } });
    for (let i = 0; i < 5; i++) {
      const now = new Date(), leaseToken = randomUUID();
      const job = await this.jobs.findOneAndUpdate({ expiresAt: { $gt: now }, attempts: { $lt: 5 }, $or: [{ state: 'queued', availableAt: { $lte: now } }, { state: 'sending', leaseUntil: { $lte: now } }] }, { $set: { state: 'sending', leaseToken, leaseUntil: new Date(now.getTime() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { availableAt: 1 } }).select('+targetEmail +originalEmail');
      if (!job) return;
      try { await this.deliver(job); }
      catch {
        const failed = job.attempts >= 5;
        await this.jobs.updateOne({ _id: job.id, requestId: job.requestId, leaseToken, state: 'sending' }, { $set: { state: failed ? 'failed' : 'queued', availableAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** job.attempts)) }, $unset: { tokenHash: 1, tokenExpiresAt: 1, leaseToken: 1, leaseUntil: 1 } });
      }
    }
  }
  private async deliver(job: AccountEmailJobMongo): Promise<void> {
    let text = 'The sign-in email for your Sapiovian account was changed. If you did not make this change, contact support immediately. Existing sessions were signed out. This message contains no sign-in link.';
    if (job.kind === 'confirm') {
      const account = await this.users.findOne({ _id: job.userId, email: job.originalEmail, disabled: false, status: 'active', deletedAt: { $exists: false }, $expr: { $eq: [{ $ifNull: ['$authVersion', 0] }, job.authVersion] } }).lean();
      if (!account) { await this.jobs.updateOne({ _id: job.id, leaseToken: job.leaseToken }, { $set: { state: 'cancelled' }, $unset: { tokenHash: 1, targetEmail: 1, originalEmail: 1, leaseToken: 1, leaseUntil: 1 } }); return; }
      const token = randomBytes(32).toString('hex');
      const link = new URL('/account/confirm-email', this.config.getOrThrow<string>('passwordRecovery.webUrl')); link.hash = 'token=' + token;
      const issued = await this.jobs.updateOne({ _id: job.id, requestId: job.requestId, leaseToken: job.leaseToken, state: 'sending' }, { $set: { tokenHash: this.hash(token), tokenExpiresAt: new Date(Date.now() + 30 * 60000) } });
      if (!issued.modifiedCount) return;
      text = `Confirm this email address for your Sapiovian account:\n\n${link.href}\n\nThe link expires in 30 minutes and can be used once. Only the newest link works. If you change your sign-in email, all existing sessions will be signed out. If you did not request this, ignore the message.`;
    }
    const result = await this.mail.sendEmail({ to: job.targetEmail, subject: job.kind === 'confirm' ? 'Confirm your Sapiovian email address' : 'Your Sapiovian sign-in email was changed', text, sensitive: true });
    if (result.delivered !== 1) throw new Error('Account email delivery failed.');
    await this.jobs.updateOne({ _id: job.id, requestId: job.requestId, leaseToken: job.leaseToken, state: 'sending' }, { $set: { state: 'sent' }, $unset: { leaseToken: 1, leaseUntil: 1, ...(job.kind === 'changed_notice' ? { targetEmail: 1, originalEmail: 1 } : {}) } });
  }
  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
}
