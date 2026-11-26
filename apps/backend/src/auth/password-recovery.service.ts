import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SessionDocument, SessionMongoDocument, UserDocument, UserMongoDocument } from '../database/schemas';
import { EmailNotificationService } from '../notifications/email-notification.service';
import type { RequestContext } from './auth.service';
import { PasswordRecoveryJob, PasswordRecoveryJobDocument } from './password-recovery.schema';
import { RECOVERY_JOB_INDEXES, RECOVERY_USER_INDEXES } from './password-recovery.indexes';

@Injectable()
export class PasswordRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private processing?: Promise<void>;
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly sessions: Model<SessionMongoDocument>,
    @InjectModel(PasswordRecoveryJob.name) private readonly jobs: Model<PasswordRecoveryJobDocument>,
    private readonly config: ConfigService,
    private readonly mail: EmailNotificationService,
    private readonly audit: AuditLogsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('notifications.email.enabled', false)) return;
    if (this.config.get<string>('app.nodeEnv') !== 'production') await Promise.all([this.users.init(), this.jobs.init()]);
    for (const [model, expected] of [[this.users, RECOVERY_USER_INDEXES], [this.jobs, RECOVERY_JOB_INDEXES]] as const) {
      const actual = await model.collection.indexes();
      for (const index of expected) {
        const found = actual.find(item => JSON.stringify(item.key) === JSON.stringify(index.key));
        if (!found || ('unique' in index && found.unique !== true) || ('sparse' in index && found.sparse !== true) || ('expireAfterSeconds' in index && found.expireAfterSeconds !== index.expireAfterSeconds)) throw new Error('Password recovery requires database indexes. Run npm run setup:account-recovery before enabling SMTP.');
      }
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.processing;
  }

  /** Queue every address identically. Account lookup and SMTP run outside the public request. */
  async request(email: string): Promise<void> {
    if (!this.config.get<boolean>('notifications.email.enabled', false)) return;
    const normalized = email.toLowerCase();
    const now = new Date(), windowFloor = new Date(now.getTime() - 3600000);
    const resetWindow = { $lte: [{ $ifNull: ['$windowStart', new Date(0)] }, windowFloor] };
    try {
      await this.jobs.updateOne({ _id: 'reset:' + this.hash(normalized), $and: [
        { $or: [{ nextRequestAt: { $lte: now } }, { nextRequestAt: { $exists: false } }] },
        { $or: [{ windowStart: { $lte: windowFloor } }, { windowStart: { $exists: false } }, { count: { $lt: 5 } }] },
        { $or: [{ state: { $ne: 'sending' } }, { leaseUntil: { $lte: now } }] },
      ] }, [{ $set: {
        kind: 'reset', email: { $literal: normalized }, requestId: randomUUID(), requestedAt: now, availableAt: now,
        expiresAt: new Date(now.getTime() + 86400000), nextRequestAt: new Date(now.getTime() + 60000),
        state: 'queued', attempts: 0, windowStart: { $cond: [resetWindow, now, '$windowStart'] },
        count: { $cond: [resetWindow, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] },
      } }, { $unset: ['leaseToken', 'leaseUntil', 'claimedAt'] }], { upsert: true });
    } catch (error) {
      // The unique job id enforces cooldown/hourly limits and prevents replacing in-flight delivery.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  async reset(token: string, password: string, context: RequestContext): Promise<void> {
    if (Buffer.byteLength(password, 'utf8') > 72) throw new BadRequestException('This password is too long. Please use a shorter password.');
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    // Consumption, password replacement and session epoch change are one atomic document update.
    const user = await this.users.findOneAndUpdate({ passwordResetHash: this.hash(token), passwordResetExpiresAt: { $gt: now }, disabled: false, status: 'active', deletedAt: { $exists: false } }, {
      $set: { passwordHash, passwordResetCompletedAt: now }, $inc: { authVersion: 1 },
      $unset: { passwordResetHash: 1, passwordResetExpiresAt: 1, passwordResetIssuedAt: 1 },
    }, { new: true });
    if (!user) throw new BadRequestException('This reset link is invalid, expired or already used. Request a new link.');
    // The epoch is checked by access AND refresh verification, including sessions created in a reset race.
    try { await this.sessions.updateMany({ userId: user.id, revokedAt: { $exists: false }, $or: [{ authVersion: { $lt: user.authVersion ?? 0 } }, { authVersion: { $exists: false } }] }, { $set: { revokedAt: now } }); }
    catch { this.logger.warn('Recovery completed; session rows could not be updated. The authentication epoch still revokes previous credentials.'); }
    await this.audit.record({ actorId: user.id, action: 'auth.password_reset_completed', targetType: 'user', targetId: user.id, ...context });
    try {
      await this.jobs.create({ _id: `changed:${user.id}:${user.authVersion}`, kind: 'changed', email: user.email, requestId: randomUUID(), requestedAt: now, availableAt: now, expiresAt: new Date(now.getTime() + 86400000), attempts: 0, state: 'queued' });
    } catch { this.logger.warn('Recovery completed; the password-change notification could not be queued.'); }
  }

  private tick(): void {
    if (this.processing) return;
    this.processing = this.drain().catch(() => { this.logger.warn('Password recovery delivery is temporarily unavailable.'); }).finally(() => { this.processing = undefined; });
  }

  private async drain(): Promise<void> {
    const now = new Date();
    await this.jobs.updateMany({ state: 'sending', attempts: { $gte: 5 }, leaseUntil: { $lte: now } }, { $set: { state: 'failed' }, $unset: { email: 1 } });
    for (let index = 0; index < 5; index++) {
      const claimedAt = new Date(), leaseToken = randomUUID();
      const job = await this.jobs.findOneAndUpdate({ expiresAt: { $gt: claimedAt }, attempts: { $lt: 5 }, $or: [
        { state: 'queued', availableAt: { $lte: claimedAt } }, { state: 'sending', leaseUntil: { $lte: claimedAt } },
      ] }, { $set: { state: 'sending', leaseToken, claimedAt, leaseUntil: new Date(claimedAt.getTime() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { availableAt: 1 } }).select('+email');
      if (!job) return;
      try { await this.deliver(job); }
      catch {
        const failed = job.attempts >= 5;
        await this.jobs.updateOne({ _id: job.id, leaseToken }, { $set: { state: failed ? 'failed' : 'queued', availableAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** job.attempts)) }, $unset: { leaseToken: 1, leaseUntil: 1, ...(failed ? { email: 1 } : {}) } });
      }
    }
  }

  private async deliver(job: PasswordRecoveryJobDocument): Promise<void> {
    if (!job.email) throw new Error('Missing recipient');
    if (job.kind === 'changed') {
      const result = await this.mail.sendEmail({ to: job.email, subject: 'Your Sapiovian password was changed', text: 'Your Sapiovian password was changed and previous sessions were signed out. If you did not make this change, request another reset and contact support. Never share your password or reset links.', sensitive: true });
      if (result.delivered !== 1) throw new Error('Delivery unavailable');
      await this.finish(job, 'sent'); return;
    }
    const active = { email: job.email, disabled: false, status: 'active', deletedAt: { $exists: false }, $or: [{ passwordResetCompletedAt: { $lt: job.requestedAt } }, { passwordResetCompletedAt: { $exists: false } }] };
    const user = await this.users.findOne(active);
    if (!user) { await this.finish(job, 'skipped'); return; }
    const admin = user.roles.some(role => role === 'ADMIN' || role === 'SUPER_ADMIN');
    const origin = this.config.get<string>(admin ? 'passwordRecovery.adminUrl' : 'passwordRecovery.webUrl');
    if (!origin) throw new Error('Recovery origin is not configured');
    const role = user.roles.includes('TEACHER') ? 'teacher' : 'student';
    const token = randomBytes(32).toString('hex');
    const link = new URL('/reset-password', origin);
    link.hash = new URLSearchParams({ token, ...(!admin ? { role } : {}) }).toString();
    if (!await this.jobs.exists({ _id: job.id, leaseToken: job.leaseToken, leaseUntil: { $gt: new Date() } })) return;
    const issued = await this.users.updateOne({ ...active, _id: user.id, $and: [{ $or: [{ passwordResetIssuedAt: { $lt: job.claimedAt } }, { passwordResetIssuedAt: { $exists: false } }] }] }, { $set: { passwordResetHash: this.hash(token), passwordResetExpiresAt: new Date(Date.now() + 30 * 60000), passwordResetIssuedAt: job.claimedAt } });
    if (!issued.modifiedCount) { await this.finish(job, 'skipped'); return; }
    const result = await this.mail.sendEmail({ to: user.email, subject: 'Reset your Sapiovian password', text: `A password reset was requested for your Sapiovian account.\n\nReset your password: ${link.href}\n\nThis link expires in 30 minutes and can be used once. Only the latest link works. If you did not request this, ignore this email; your password has not changed. Never share this link.`, sensitive: true });
    if (result.delivered !== 1) throw new Error('Delivery unavailable');
    await this.audit.record({ actorId: user.id, action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id });
    await this.finish(job, 'sent');
  }
  private async finish(job: PasswordRecoveryJobDocument, state: 'sent' | 'skipped'): Promise<void> {
    await this.jobs.updateOne({ _id: job.id, leaseToken: job.leaseToken }, { $set: { state }, $unset: { email: 1, leaseToken: 1, leaseUntil: 1 } });
  }
  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
}
