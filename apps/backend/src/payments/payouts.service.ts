import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  commissionBpsForTeacher,
  formatPaymentMoney,
  isPaymentCurrency,
  type PageResult,
  type PayoutAccountStatus,
  type PayoutRecord,
  type PayoutRequestInput,
  type TeacherEarningsLine,
  type TeacherEarningsSummary,
} from '@native-sfu/contracts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserDocument, type UserMongoDocument } from '../database/schemas';
import { EmailNotificationService } from '../notifications/email-notification.service';
import { FinanceSettingsService } from './finance-settings.service';
import { PAYMENT_GATEWAY, type GatewayEvent, type PaymentGateway } from './gateways/payment-gateway';
import { payoutPaidEntry, payoutReleasedEntry, payoutRequestedEntry, payoutReversedEntry, type PayoutFacts } from './ledger-entries';
import { LedgerService } from './ledger.service';
import {
  LedgerEntryDocument,
  PaymentDocument,
  PayoutAccountDocument,
  PayoutDocument,
  TeacherBalanceLockDocument,
  type LedgerEntryMongo,
  type PaymentMongo,
  type PayoutAccountMongo,
  type PayoutMongo,
} from './payment.schemas';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    @InjectModel(PayoutDocument.name) private readonly payouts: Model<PayoutMongo>,
    @InjectModel(PayoutAccountDocument.name) private readonly accounts: Model<PayoutAccountMongo>,
    @InjectModel(TeacherBalanceLockDocument.name) private readonly locks: Model<TeacherBalanceLockDocument>,
    @InjectModel(LedgerEntryDocument.name) private readonly entries: Model<LedgerEntryMongo>,
    @InjectModel(PaymentDocument.name) private readonly payments: Model<PaymentMongo>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly settings: FinanceSettingsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogsService,
    private readonly email: EmailNotificationService,
    private readonly config: ConfigService,
  ) {}

  private webUrl(): string {
    return this.config.get<string>('payments.webUrl', 'http://localhost:4200');
  }

  private assertTeacher(user: AuthenticatedUser): void {
    if (!user.roles.includes('TEACHER')) throw new ForbiddenException('Only teacher accounts have earnings.');
  }

  // -------------------------------------------------------------------------
  // Teacher views
  // -------------------------------------------------------------------------

  async summary(user: AuthenticatedUser): Promise<TeacherEarningsSummary> {
    this.assertTeacher(user);
    const [settings, balances, account] = await Promise.all([this.settings.get(), this.ledger.teacherBalances(user.sub), this.accountStatus(user.sub)]);
    const withDefault = balances.some((balance) => balance.currency === settings.defaultCurrency)
      ? balances
      : [
          {
            currency: settings.defaultCurrency,
            pendingMinor: 0,
            availableMinor: 0,
            reservedMinor: 0,
            frozenMinor: 0,
            paidOutMinor: 0,
            grossMinor: 0,
            commissionMinor: 0,
            refundedMinor: 0,
          },
          ...balances,
        ];
    return {
      balances: withDefault,
      commissionBps: commissionBpsForTeacher(settings, user.sub),
      holdDays: settings.holdDays,
      minimumPayoutMinor: settings.minimumPayoutMinor,
      defaultCurrency: settings.defaultCurrency,
      payoutAccount: account,
      payoutsEnabled: Boolean(this.config.get<boolean>('payments.enabled', false)) && this.gateway.payoutsSupported,
    };
  }

  async transactions(user: AuthenticatedUser, page = 1): Promise<PageResult<TeacherEarningsLine>> {
    this.assertTeacher(user);
    const limit = 30;
    const safePage = Math.max(1, Math.min(10_000, Math.floor(page) || 1));
    const filter = { teacherId: user.sub };
    const [docs, total] = await Promise.all([
      this.entries.find(filter).sort({ occurredAt: -1, _id: 1 }).skip((safePage - 1) * limit).limit(limit).exec(),
      this.entries.countDocuments(filter).exec(),
    ]);
    const paymentIds = [...new Set(docs.map((doc) => doc.paymentId).filter((id): id is string => Boolean(id)))];
    const payments = await this.payments.find({ _id: { $in: paymentIds } }).select('batchName studentName amountMinor commissionMinor').exec();
    const byId = new Map(payments.map((payment) => [payment.id, payment]));
    const teacherAccounts = ['teacher_pending', 'teacher_available', 'teacher_reserved', 'teacher_frozen'];
    const items = docs.map((doc): TeacherEarningsLine => {
      const mine = doc.lines.filter((line) => line.teacherId === user.sub && teacherAccounts.includes(line.account));
      const net = mine.reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
      const available = mine.filter((line) => line.account === 'teacher_available').reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
      const payment = doc.paymentId ? byId.get(doc.paymentId) : undefined;
      const captured = doc.type === 'payment_captured';
      return {
        id: doc.id,
        type: doc.type,
        occurredAt: doc.occurredAt.toISOString(),
        currency: doc.currency,
        description: doc.memo,
        paymentId: doc.paymentId,
        payoutId: doc.payoutId,
        batchName: payment?.batchName,
        studentName: payment?.studentName,
        ...(captured && payment ? { grossMinor: payment.amountMinor, commissionMinor: payment.commissionMinor } : {}),
        // Paid-out money leaves the balance entirely; requested payouts only move between buckets.
        netMinor: doc.type === 'payout_paid' ? -doc.lines.filter((line) => line.account === 'teacher_reserved').reduce((sum, line) => sum + line.debitMinor, 0) : net,
        availableDeltaMinor: available,
      };
    });
    return { items, total, page: safePage, limit };
  }

  async listForTeacher(user: AuthenticatedUser, page = 1): Promise<PageResult<PayoutRecord>> {
    this.assertTeacher(user);
    return this.list({ teacherId: user.sub, page });
  }

  async list(query: { page?: number; status?: string; teacherId?: string }): Promise<PageResult<PayoutRecord>> {
    const limit = 25;
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(query.page) || 1)));
    const filter: Record<string, unknown> = {};
    if (query.teacherId) filter.teacherId = query.teacherId;
    if (query.status === 'open') filter.status = { $in: ['requested', 'processing'] };
    else if (query.status && query.status !== 'all') filter.status = query.status;
    const [docs, total] = await Promise.all([
      this.payouts.find(filter).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.payouts.countDocuments(filter).exec(),
    ]);
    return { items: docs.map((doc) => this.toRecord(doc)), total, page, limit };
  }

  private facts(doc: PayoutMongo): PayoutFacts {
    return { id: String(doc._id), teacherId: doc.teacherId, currency: doc.currency, amountMinor: doc.amountMinor };
  }

  private toRecord(doc: PayoutMongo): PayoutRecord {
    return {
      id: doc.id,
      teacherId: doc.teacherId,
      teacherName: doc.teacherName,
      currency: doc.currency,
      amountMinor: doc.amountMinor,
      status: doc.status,
      note: doc.note,
      adminNote: doc.adminNote,
      failureReason: doc.failureReason,
      gatewayTransferId: doc.gatewayTransferId,
      requestedAt: doc.createdAt.toISOString(),
      decidedAt: doc.decidedAt?.toISOString(),
      decidedByName: doc.decidedByName,
      paidAt: doc.paidAt?.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Payout account (Stripe Connect)
  // -------------------------------------------------------------------------

  async accountStatus(teacherId: string): Promise<PayoutAccountStatus> {
    const account = await this.accounts.findById(teacherId).exec();
    if (!account || account.gateway !== this.gateway.id) {
      return { gateway: this.gateway.id, connected: false, detailsSubmitted: false, payoutsEnabled: false };
    }
    return {
      gateway: account.gateway,
      connected: true,
      detailsSubmitted: account.detailsSubmitted,
      payoutsEnabled: account.payoutsEnabled,
      accountHint: account.accountId.slice(-4),
      updatedAt: account.updatedAt?.toISOString(),
    };
  }

  async startOnboarding(user: AuthenticatedUser): Promise<{ url: string }> {
    this.assertTeacher(user);
    if (!this.config.get<boolean>('payments.enabled', false) || !this.gateway.payoutsSupported) {
      throw new ServiceUnavailableException('Payouts are not available yet.');
    }
    const teacher = await this.users.findById(user.sub).exec();
    if (!teacher) throw new NotFoundException('Teacher account not found.');
    let account = await this.accounts.findById(user.sub).exec();
    if (!account || account.gateway !== this.gateway.id) {
      const created = await this.gateway.createPayoutAccount({ teacherId: user.sub, email: teacher.email });
      account = await this.accounts
        .findOneAndUpdate(
          { _id: user.sub },
          { $set: { gateway: this.gateway.id, accountId: created.accountId, detailsSubmitted: false, payoutsEnabled: false } },
          { upsert: true, new: true },
        )
        .exec();
      await this.audit.record({ actor: user, action: 'payout.account_created', resourceType: 'payout_account', resourceId: user.sub });
    }
    const link = await this.gateway.payoutAccountLink({
      accountId: account!.accountId,
      refreshUrl: `${this.webUrl()}/teacher/earnings?payout_setup=refresh`,
      returnUrl: `${this.webUrl()}/teacher/earnings?payout_setup=done`,
    });
    if (this.gateway.id === 'test') await this.refreshAccount(user);
    return link;
  }

  async refreshAccount(user: AuthenticatedUser): Promise<PayoutAccountStatus> {
    this.assertTeacher(user);
    const account = await this.accounts.findById(user.sub).exec();
    if (account && account.gateway === this.gateway.id) {
      const status = await this.gateway.payoutAccountStatus(account.accountId);
      await this.accounts.updateOne({ _id: user.sub }, { $set: status }).exec();
    }
    return this.accountStatus(user.sub);
  }

  async applyEvent(event: GatewayEvent): Promise<void> {
    if (event.kind === 'payout_account.updated') {
      await this.accounts
        .updateOne({ gateway: this.gateway.id, accountId: event.accountId }, { $set: { detailsSubmitted: event.detailsSubmitted, payoutsEnabled: event.payoutsEnabled } })
        .exec();
      return;
    }
    if (event.kind === 'transfer.reversed') {
      const payout =
        (await this.payouts.findOne({ gatewayTransferId: event.transferId }).exec()) ??
        (event.payoutRef ? await this.payouts.findById(event.payoutRef).exec() : null);
      if (!payout) throw new Error(`No payout matches reversed transfer ${event.transferId}.`);
      const amount = Math.min(payout.amountMinor, event.amountReversedMinor);
      if (amount > 0) await this.ledger.post(payoutReversedEntry(this.facts(payout), amount, new Date()));
      await this.payouts
        .updateOne({ _id: payout.id }, { $set: { status: 'failed', failureReason: 'The transfer was reversed by the payment provider. The amount is available again.' } })
        .exec();
      await this.audit.record({
        actorName: 'Payment provider',
        action: 'payout.reversed',
        resourceType: 'payout',
        resourceId: payout.id,
        targetUserId: payout.teacherId,
        metadata: { amountMinor: amount, currency: payout.currency },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Requests and decisions
  // -------------------------------------------------------------------------

  async request(user: AuthenticatedUser, input: PayoutRequestInput): Promise<PayoutRecord> {
    this.assertTeacher(user);
    if (!this.config.get<boolean>('payments.enabled', false) || !this.gateway.payoutsSupported) {
      throw new ServiceUnavailableException('Payouts are not available yet.');
    }
    if (!isPaymentCurrency(input.currency)) throw new BadRequestException('Choose a supported currency.');
    const existing = await this.payouts.findOne({ teacherId: user.sub, requestKey: input.requestId }).exec();
    if (existing) return this.toRecord(existing);
    const settings = await this.settings.get();
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < settings.minimumPayoutMinor) {
      throw new BadRequestException(`The minimum payout is ${formatPaymentMoney(settings.minimumPayoutMinor, input.currency)}.`);
    }
    const account = await this.accountStatus(user.sub);
    if (!account.payoutsEnabled) throw new BadRequestException('Finish setting up your payout account before requesting a payout.');
    const teacher = await this.users.findById(user.sub).exec();

    const payout = await this.withTeacherLock(user.sub, async () => {
      const available = await this.ledger.teacherAccountBalance(user.sub, input.currency, 'teacher_available');
      if (input.amountMinor > available) {
        throw new BadRequestException(`You can request up to ${formatPaymentMoney(Math.max(0, available), input.currency)} right now.`);
      }
      let created: PayoutMongo;
      try {
        created = await this.payouts.create({
          teacherId: user.sub,
          teacherName: teacher?.displayName || teacher?.name || user.email,
          requestKey: input.requestId,
          currency: input.currency,
          amountMinor: input.amountMinor,
          status: 'requested',
          gateway: this.gateway.id,
          note: input.note?.trim().slice(0, 500) || undefined,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        return (await this.payouts.findOne({ teacherId: user.sub, requestKey: input.requestId }).exec())!;
      }
      await this.ledger.post(payoutRequestedEntry(this.facts(created), created.createdAt));
      return created;
    });
    await this.audit.record({
      actor: user,
      action: 'payout.requested',
      resourceType: 'payout',
      resourceId: payout.id,
      metadata: { amountMinor: payout.amountMinor, currency: payout.currency },
    });
    return this.toRecord(payout);
  }

  async cancel(user: AuthenticatedUser, payoutId: string): Promise<PayoutRecord> {
    this.assertTeacher(user);
    const payout = await this.payouts.findOneAndUpdate({ _id: payoutId, teacherId: user.sub, status: 'requested' }, { $set: { status: 'cancelled' } }, { new: true }).exec();
    if (!payout) throw new ConflictException('Only a payout that has not been processed can be cancelled.');
    await this.ledger.post(payoutReleasedEntry(this.facts(payout), 'Payout request cancelled by the teacher', new Date()));
    await this.audit.record({ actor: user, action: 'payout.cancelled', resourceType: 'payout', resourceId: payout.id });
    return this.toRecord(payout);
  }

  async reject(payoutId: string, note: string, actor: AuthenticatedUser): Promise<PayoutRecord> {
    const reason = note.trim();
    if (reason.length < 5) throw new BadRequestException('Explain why the payout is rejected.');
    const payout = await this.payouts
      .findOneAndUpdate(
        { _id: payoutId, status: 'requested' },
        { $set: { status: 'rejected', adminNote: reason, decidedAt: new Date(), decidedById: actor.sub, decidedByName: actor.email } },
        { new: true },
      )
      .exec();
    if (!payout) throw new ConflictException('Only a requested payout can be rejected. Reload the list.');
    await this.ledger.post(payoutReleasedEntry(this.facts(payout), `Payout rejected: ${reason}`, new Date()));
    await this.audit.record({ actor, action: 'payout.rejected', resourceType: 'payout', resourceId: payout.id, targetUserId: payout.teacherId, metadata: { reason } });
    await this.notifyTeacher(payout, `Your payout request of ${formatPaymentMoney(payout.amountMinor, payout.currency)} was not approved.\nReason: ${reason}\nThe amount is available to request again.`);
    return this.toRecord(payout);
  }

  /**
   * Approves and sends a payout. A lease prevents two admins sending the same
   * payout, and the gateway idempotency key makes a retry after an uncertain
   * failure safe.
   */
  async approve(payoutId: string, note: string | undefined, actor: AuthenticatedUser): Promise<PayoutRecord> {
    const token = randomUUID();
    const now = new Date();
    const claimed = await this.payouts
      .findOneAndUpdate(
        {
          _id: payoutId,
          $or: [{ status: 'requested' }, { status: 'processing', $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }] }],
        },
        {
          $set: {
            status: 'processing',
            leaseToken: token,
            leaseUntil: new Date(now.getTime() + 120_000),
            decidedAt: now,
            decidedById: actor.sub,
            decidedByName: actor.email,
            ...(note?.trim() ? { adminNote: note.trim().slice(0, 500) } : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!claimed) throw new ConflictException('This payout is already being processed or was decided. Reload the list.');
    const account = await this.accounts.findById(claimed.teacherId).exec();
    if (!account || account.gateway !== this.gateway.id || !account.payoutsEnabled) {
      await this.payouts.updateOne({ _id: claimed.id, leaseToken: token }, { $set: { status: 'requested' }, $unset: { leaseToken: '', leaseUntil: '' } }).exec();
      throw new BadRequestException("The teacher's payout account is not ready to receive transfers.");
    }
    try {
      const transfer = await this.gateway.transfer({
        accountId: account.accountId,
        amountMinor: claimed.amountMinor,
        currency: claimed.currency,
        idempotencyKey: `payout:${claimed.id}`,
        payoutId: claimed.id,
        teacherId: claimed.teacherId,
      });
      const paid = await this.payouts
        .findOneAndUpdate(
          { _id: claimed.id, leaseToken: token },
          { $set: { status: 'paid', paidAt: new Date(), gatewayTransferId: transfer.transferId }, $unset: { leaseToken: '', leaseUntil: '', failureReason: '' } },
          { new: true },
        )
        .exec();
      await this.ledger.post(payoutPaidEntry(this.facts(claimed), new Date()));
      await this.audit.record({
        actor,
        action: 'payout.paid',
        resourceType: 'payout',
        resourceId: claimed.id,
        targetUserId: claimed.teacherId,
        metadata: { amountMinor: claimed.amountMinor, currency: claimed.currency, transferId: transfer.transferId },
      });
      await this.notifyTeacher(claimed, `Your payout of ${formatPaymentMoney(claimed.amountMinor, claimed.currency)} has been sent to your payout account.`);
      return this.toRecord(paid ?? claimed);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      const definite = typeof error === 'object' && error !== null && ['StripeCardError', 'StripeInvalidRequestError'].includes((error as { type?: string }).type ?? '');
      if (definite) {
        const failed = await this.payouts
          .findOneAndUpdate(
            { _id: claimed.id, leaseToken: token },
            { $set: { status: 'failed', failureReason: 'The payment provider rejected the transfer. The amount is available again.' }, $unset: { leaseToken: '', leaseUntil: '' } },
            { new: true },
          )
          .exec();
        await this.ledger.post(payoutReleasedEntry(this.facts(claimed), 'Payout transfer failed', new Date()));
        await this.audit.record({ actor, action: 'payout.failed', status: 'failure', resourceType: 'payout', resourceId: claimed.id, metadata: { error: message } });
        return this.toRecord(failed ?? claimed);
      }
      // Unknown outcome: keep it processing; approving again after the lease retries safely.
      await this.payouts.updateOne({ _id: claimed.id, leaseToken: token }, { $set: { failureReason: 'Waiting for the payment provider. Approve again to retry safely.' } }).exec();
      this.logger.warn(`Payout ${claimed.id} transfer outcome unknown: ${message}`);
      throw new ServiceUnavailableException('The payment provider did not confirm the transfer. Try approving again in two minutes; it will not be sent twice.');
    }
  }

  private async notifyTeacher(payout: PayoutMongo, body: string): Promise<void> {
    const teacher = await this.users.findById(payout.teacherId).select('email displayName name').exec();
    if (!teacher?.email) return;
    await this.email
      .sendEmail({ to: teacher.email, subject: 'Sapiovian payout update', text: `Hello ${teacher.displayName || teacher.name || ''},\n\n${body}\n\nSapiovian` })
      .catch(() => undefined);
  }

  private async withTeacherLock<T>(teacherId: string, work: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + 3_000;
    for (;;) {
      try {
        const locked = await this.locks
          .findOneAndUpdate(
            { _id: teacherId, $or: [{ until: { $exists: false } }, { until: { $lt: new Date() } }] },
            { $set: { token, until: new Date(Date.now() + 30_000) } },
            { upsert: true, new: true },
          )
          .exec();
        if (locked?.token === token) break;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      if (Date.now() > deadline) throw new ConflictException('Your balance is being updated. Try again in a moment.');
      await sleep(100);
    }
    try {
      return await work();
    } finally {
      await this.locks.updateOne({ _id: teacherId, token }, { $unset: { token: '', until: '' } }).exec();
    }
  }
}
