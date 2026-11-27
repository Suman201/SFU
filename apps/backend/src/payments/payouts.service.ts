import { ClientSession } from 'mongoose';
import { BookingFinanceService } from './booking-finance.service';
import { TeacherFinanceTransactions } from './teacher-finance-transactions.service';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  commissionBpsForTeacher,
  formatPaymentMoney,
  isPaymentCurrency,
  minimumPayoutFor,
  type PaymentCurrency,
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
  type LedgerEntryMongo,
  type PaymentMongo,
  type PayoutAccountMongo,
  type PayoutMongo,
} from './payment.schemas';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    @InjectModel(PayoutDocument.name) private readonly payouts: Model<PayoutMongo>,
    @InjectModel(PayoutAccountDocument.name) private readonly accounts: Model<PayoutAccountMongo>,
    @InjectModel(LedgerEntryDocument.name) private readonly entries: Model<LedgerEntryMongo>,
    @InjectModel(PaymentDocument.name) private readonly payments: Model<PaymentMongo>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly settings: FinanceSettingsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogsService,
    private readonly email: EmailNotificationService,
    private readonly config: ConfigService,
    private readonly financeTransactions: TeacherFinanceTransactions,
    private readonly bookingFinance: BookingFinanceService,
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
      balances: await Promise.all(withDefault.map(async balance => ({
        ...balance,
        minimumPayoutMinor: minimumPayoutFor(settings, balance.currency),
        payoutBlockedReason: await this.payoutBlock(user.sub, balance.currency, balance.availableMinor),
      }))),
      commissionBps: commissionBpsForTeacher(settings, user.sub),
      holdDays: settings.holdDays,
      minimumPayoutMinor: settings.minimumPayoutMinor,
      defaultCurrency: settings.defaultCurrency,
      payoutAccount: account,
      payoutsEnabled: Boolean(this.config.get<boolean>('payments.enabled', false)) && this.gateway.payoutsSupported,
    };
  }

  async transactions(user: AuthenticatedUser, page = 1, currency?: string): Promise<PageResult<TeacherEarningsLine>> {
    this.assertTeacher(user);
    const limit = 30;
    const safePage = Math.max(1, Math.min(10_000, Math.floor(page) || 1));
    if (currency && !isPaymentCurrency(currency)) throw new BadRequestException('Choose a supported currency.');
    const filter = { teacherId: user.sub, ...(currency ? { currency } : {}) };
    const [docs, total] = await Promise.all([
      this.entries.find(filter).sort({ occurredAt: -1, _id: 1 }).skip((safePage - 1) * limit).limit(limit).exec(),
      this.entries.countDocuments(filter).exec(),
    ]);
    const paymentIds = [...new Set(docs.map((doc) => doc.paymentId).filter((id): id is string => Boolean(id)))];
    const payments = await this.payments.find({ _id: { $in: paymentIds } }).select('batchName studentName amountMinor commissionMinor').exec();
    const byId = new Map(payments.map((payment) => [payment.id, payment]));
    const bookingIds = [...new Set(docs.map(doc => doc.bookingOrderId).filter((id): id is string => Boolean(id)))];
    const bookings = await this.bookingFinance.details(bookingIds, user.sub);
    const byBooking = new Map(bookings.map(order => [order._id, order]));
    const teacherAccounts = ['teacher_pending', 'teacher_available', 'teacher_reserved', 'teacher_frozen'];
    const items = docs.map((doc): TeacherEarningsLine => {
      const mine = doc.lines.filter((line) => line.teacherId === user.sub && teacherAccounts.includes(line.account));
      const net = mine.reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
      const available = mine.filter((line) => line.account === 'teacher_available').reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
      const payment = doc.paymentId ? byId.get(doc.paymentId) : undefined;
      const booking = doc.bookingOrderId ? byBooking.get(doc.bookingOrderId) : undefined;
      const captured = doc.type === 'payment_captured';
      return {
        id: doc.id,
        type: doc.type,
        occurredAt: doc.occurredAt.toISOString(),
        currency: doc.currency,
        description: doc.memo,
        paymentId: doc.paymentId,
        bookingOrderId: doc.bookingOrderId,
        payoutId: doc.payoutId,
        batchName: payment?.batchName ?? booking?.title,
        studentName: payment?.studentName ?? booking?.studentName,
        ...(captured && payment ? { grossMinor: payment.amountMinor, commissionMinor: payment.commissionMinor } : {}),
        ...(captured && booking ? { grossMinor: booking.invoiceSource.netMinor, taxMinor: booking.invoiceSource.taxMinor, commissionMinor: booking.earningsPolicy?.commissionMinor } : {}),
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
      reversedMinor: doc.reversedMinor,
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
      const payout = (await this.payouts.findOne({ gatewayTransferId: event.transferId }).exec()) ?? (event.payoutRef ? await this.payouts.findById(event.payoutRef).exec() : null);
      if (!payout || payout.gateway !== this.gateway.id) throw new Error('No payout matches the reversed provider transfer.');
      if (!payout.gatewayTransferId) {
        if (!this.gateway.retrieveTransfer) throw new Error('Provider verification is required before matching an unknown transfer.');
        const verified = await this.gateway.retrieveTransfer(event.transferId);
        await this.recordTransfer(payout.id, { ...verified, amountReversedMinor: Math.max(verified.amountReversedMinor, event.amountReversedMinor) }, true);
        return;
      }
      await this.recordTransfer(payout.id, { transferId: event.transferId, accountId: payout.gatewayAccountId ?? '', amountMinor: payout.amountMinor, currency: payout.currency, amountReversedMinor: event.amountReversedMinor, payoutId: payout.id, teacherId: payout.teacherId, livemode: !this.gateway.testMode }, false);
    }
  }

  /** Reads provider-owned transfer facts; it never sends a replacement transfer. */
  async reconcile(payoutId: string, transferId: string, reason: string, actor: AuthenticatedUser): Promise<PayoutRecord> {
    if (!this.gateway.retrieveTransfer) throw new ServiceUnavailableException('Transfer verification is unavailable for this provider.');
    if (reason.trim().length < 10) throw new BadRequestException('Explain why this transfer needs reconciliation.');
    const transfer = await this.gateway.retrieveTransfer(transferId);
    const payout = await this.recordTransfer(payoutId, transfer, true);
    await this.audit.record({ actor, action: 'payout.transfer_reconciled', resourceType: 'payout', resourceId: payoutId, targetUserId: payout.teacherId, metadata: { transferId, amountMinor: payout.amountMinor, currency: payout.currency, reason: reason.trim() } });
    return this.toRecord(payout);
  }

  private async recordTransfer(payoutId: string, transfer: import('./gateways/payment-gateway').VerifiedTransfer, requireMetadata: boolean): Promise<PayoutMongo> {
    const initial = await this.payouts.findById(payoutId).exec();
    if (!initial) throw new NotFoundException('Payout not found.');
    return this.financeTransactions.run(initial.teacherId, async session => {
      const payout = await this.payouts.findById(payoutId).session(session);
      if (!payout || payout.gateway !== this.gateway.id || !['processing', 'paid', 'failed'].includes(payout.status)) throw new ConflictException('This payout has no provider transfer to reconcile.');
      if (payout.gatewayTestMode !== undefined && payout.gatewayTestMode !== this.gateway.testMode) throw new ConflictException('Reconcile this payout using its original provider environment.');
      if (payout.gatewayTransferId && payout.gatewayTransferId !== transfer.transferId) throw new ConflictException('A different transfer is already recorded for this payout.');
      if (transfer.amountMinor !== payout.amountMinor || transfer.currency !== payout.currency || !Number.isSafeInteger(transfer.amountReversedMinor) || transfer.amountReversedMinor < 0 || transfer.amountReversedMinor > payout.amountMinor) throw new ConflictException('Provider transfer amounts do not match the payout.');
      if (requireMetadata && (transfer.payoutId !== payout.id || transfer.teacherId !== payout.teacherId || !payout.gatewayAccountId || transfer.accountId !== payout.gatewayAccountId || transfer.livemode !== !this.gateway.testMode)) throw new ConflictException('The provider transfer does not belong to this payout and destination.');
      if (!await this.ledger.exists(`payout:${payout.id}:requested`, session)) throw new ConflictException('The payout reservation needs financial review.');
      if (payout.status === 'failed' && !payout.gatewayTransferId) throw new ConflictException('This payout already returned its reservation. Finance must review the provider history.');
      payout.gatewayTransferId = transfer.transferId;
      payout.paidAt ??= new Date();
      await this.ledger.post(payoutPaidEntry(this.facts(payout), payout.paidAt), session);
      const reversals = await this.entries.find({ payoutId: payout.id, type: 'payout_reversed' }).session(session).lean();
      const recorded = reversals.flatMap(entry => entry.lines).filter(line => line.account === 'teacher_available').reduce((sum, line) => sum + line.creditMinor, 0);
      const cumulative = Math.max(recorded, transfer.amountReversedMinor);
      if (cumulative > recorded) await this.ledger.post(payoutReversedEntry(this.facts(payout), cumulative - recorded, new Date(), cumulative), session);
      payout.reversedMinor = cumulative;
      payout.status = cumulative === payout.amountMinor ? 'failed' : 'paid';
      payout.failureReason = cumulative ? cumulative === payout.amountMinor ? 'The provider reversed the transfer. The amount is available again.' : 'The provider partially reversed the transfer; the returned amount is available again.' : undefined;
      payout.leaseToken = undefined; payout.leaseUntil = undefined;
      await payout.save({ session }); return payout;
    });
  }

  // -------------------------------------------------------------------------
  // Requests and decisions
  // -------------------------------------------------------------------------

  private async payoutBlock(teacherId: string, currency: PaymentCurrency, available?: number, session?: ClientSession): Promise<string | undefined> {
    const settings = await this.settings.get();
    if (minimumPayoutFor(settings, currency) === undefined) return 'Finance must configure payouts in this currency before you can withdraw.';
    if (!(this.gateway.supportsPayoutCurrency?.(currency) ?? this.gateway.supportsCurrency(currency))) return 'This payment provider does not support payouts in this currency.';
    if (this.gateway.id === 'stripe' && await this.bookingFinance.incompatiblePaymentMode(teacherId, currency, this.gateway.testMode, session)) return 'Some earnings need finance verification before payout.';
    if (await this.bookingFinance.disputed(teacherId, currency, session)) return 'A booking payment is disputed. Finance must resolve the provider dispute and review settlement before payouts in this currency can resume.';
    if (await this.bookingFinance.pendingRefund(teacherId, currency, session)) return 'Some booking refunds need resolution. Payouts in this currency can resume when they are resolved.';
    if (available !== undefined && available < 0) return 'A refund adjustment must be covered before another payout can be sent.';
    return undefined;
  }

  private sameRequest(existing: PayoutMongo, input: PayoutRequestInput): void {
    if (existing.currency !== input.currency || existing.amountMinor !== input.amountMinor || (existing.note ?? '') !== (input.note?.trim().slice(0, 500) ?? '')) throw new ConflictException('This request ID was already used for a different payout.');
  }

  async request(user: AuthenticatedUser, input: PayoutRequestInput): Promise<PayoutRecord> {
    this.assertTeacher(user);
    if (!this.config.get<boolean>('payments.enabled', false) || !this.gateway.payoutsSupported) throw new ServiceUnavailableException('Payouts are not available yet.');
    if (!isPaymentCurrency(input.currency) || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new BadRequestException('Choose a supported currency and a positive whole minor-unit amount.');
    const settings = await this.settings.get();
    const minimum = minimumPayoutFor(settings, input.currency);
    if (minimum === undefined) throw new BadRequestException('Finance must configure a payout minimum for this currency.');
    if (input.amountMinor < minimum) throw new BadRequestException(`The minimum payout is ${formatPaymentMoney(minimum, input.currency)}.`);
    const account = await this.accountStatus(user.sub);
    if (!account.payoutsEnabled) throw new BadRequestException('Finish setting up your payout account before requesting a payout.');
    const teacher = await this.users.findById(user.sub).exec();
    const result = await this.financeTransactions.run(user.sub, async session => {
      const existing = await this.payouts.findOne({ teacherId: user.sub, requestKey: input.requestId }).session(session);
      if (existing) { this.sameRequest(existing, input); return { payout: existing, created: false }; }
      const available = await this.ledger.teacherAccountBalance(user.sub, input.currency, 'teacher_available', session);
      const blocked = await this.payoutBlock(user.sub, input.currency, available, session);
      if (blocked) throw new BadRequestException(blocked);
      if (input.amountMinor > available) throw new BadRequestException(`You can request up to ${formatPaymentMoney(Math.max(0, available), input.currency)} right now.`);
      const [payout] = await this.payouts.create([{ teacherId: user.sub, teacherName: teacher?.displayName || teacher?.name || user.email, requestKey: input.requestId, currency: input.currency, amountMinor: input.amountMinor, status: 'requested', gateway: this.gateway.id, gatewayTestMode: this.gateway.testMode, note: input.note?.trim().slice(0, 500) || undefined }], { session });
      await this.ledger.post(payoutRequestedEntry(this.facts(payout!), payout!.createdAt), session);
      return { payout: payout!, created: true };
    });
    if (result.created) await this.audit.record({ actor: user, action: 'payout.requested', resourceType: 'payout', resourceId: result.payout.id, metadata: { amountMinor: result.payout.amountMinor, currency: result.payout.currency } });
    return this.toRecord(result.payout);
  }

  private async returnRequested(payoutId: string, teacherId: string, status: 'cancelled' | 'rejected', note: string, actor: AuthenticatedUser): Promise<PayoutMongo> {
    return this.financeTransactions.run(teacherId, async session => {
      const payout = await this.payouts.findById(payoutId).session(session);
      if (!payout || payout.status !== 'requested') throw new ConflictException('Only a payout that has not been processed can be cancelled or rejected. Reload the list.');
      payout.status = status;
      if (status === 'rejected') { payout.adminNote = note; payout.decidedAt = new Date(); payout.decidedById = actor.sub; payout.decidedByName = actor.email; }
      // Legacy orphan rows never reserved funds, so returning them must not create a balance.
      if (await this.ledger.exists(`payout:${payout.id}:requested`, session)) await this.ledger.post(payoutReleasedEntry(this.facts(payout), note, new Date()), session);
      await payout.save({ session });
      return payout;
    });
  }

  async cancel(user: AuthenticatedUser, payoutId: string): Promise<PayoutRecord> {
    this.assertTeacher(user);
    const initial = await this.payouts.findOne({ _id: payoutId, teacherId: user.sub }).exec();
    if (!initial) throw new NotFoundException('Payout not found.');
    const payout = await this.returnRequested(payoutId, user.sub, 'cancelled', 'Payout request cancelled by the teacher', user);
    await this.audit.record({ actor: user, action: 'payout.cancelled', resourceType: 'payout', resourceId: payout.id });
    return this.toRecord(payout);
  }

  async reject(payoutId: string, note: string, actor: AuthenticatedUser): Promise<PayoutRecord> {
    const reason = note.trim();
    if (reason.length < 5) throw new BadRequestException('Explain why the payout is rejected.');
    const initial = await this.payouts.findById(payoutId).exec();
    if (!initial) throw new NotFoundException('Payout not found.');
    const payout = await this.returnRequested(payoutId, initial.teacherId, 'rejected', reason, actor);
    await this.audit.record({ actor, action: 'payout.rejected', resourceType: 'payout', resourceId: payout.id, targetUserId: payout.teacherId, metadata: { reason } });
    await this.notifyTeacher(payout, `Your payout request of ${formatPaymentMoney(payout.amountMinor, payout.currency)} was not approved.\nReason: ${reason}\nThe amount is available to request again.`);
    return this.toRecord(payout);
  }

  async approve(payoutId: string, note: string | undefined, actor: AuthenticatedUser): Promise<PayoutRecord> {
    if (!this.config.get<boolean>('payments.enabled', false) || !this.gateway.payoutsSupported) throw new ServiceUnavailableException('Payouts are not available yet.');
    const initial = await this.payouts.findById(payoutId).exec();
    if (!initial) throw new NotFoundException('Payout not found.');
    const token = randomUUID();
    const claimed = await this.financeTransactions.run(initial.teacherId, async session => {
      const payout = await this.payouts.findById(payoutId).session(session);
      if (!payout || (payout.status !== 'requested' && !(payout.status === 'processing' && (!payout.leaseUntil || payout.leaseUntil < new Date())))) throw new ConflictException('This payout is already being processed or was decided. Reload the list.');
      if (payout.gateway !== this.gateway.id) throw new ConflictException('The payout provider changed. Reconcile the original request before processing it.');
      if (payout.gatewayTestMode !== undefined && payout.gatewayTestMode !== this.gateway.testMode) throw new ConflictException('The payout environment changed. Reconcile the original request with its original provider.');
      if (payout.status === 'processing' && (!payout.transferAttemptedAt || Date.now() - payout.transferAttemptedAt.getTime() >= 23 * 3600000)) throw new ConflictException('Provider confirmation is required before another send attempt. Reconcile the original transfer ID.');
      const account = await this.accounts.findById(payout.teacherId).session(session);
      if (!account || account.gateway !== payout.gateway || !account.payoutsEnabled) throw new BadRequestException("The teacher's payout account is not ready to receive transfers.");
      const available = await this.ledger.teacherAccountBalance(payout.teacherId, payout.currency, 'teacher_available', session);
      const blocked = await this.payoutBlock(payout.teacherId, payout.currency, available, session);
      if (blocked) throw new BadRequestException(blocked);
      if (payout.status === 'requested') {
        if (!await this.ledger.exists(`payout:${payout.id}:requested`, session)) {
          if (available < payout.amountMinor) throw new ConflictException('This legacy payout needs financial reconciliation before approval.');
          await this.ledger.post(payoutRequestedEntry(this.facts(payout), payout.createdAt), session);
        }
      }
      if (payout.gatewayAccountId && payout.gatewayAccountId !== account.accountId) throw new ConflictException('The original payout account changed. Reconcile the original transfer instead of changing its destination.');
      payout.gatewayAccountId ??= account.accountId;
      payout.transferAttemptedAt ??= new Date();
      payout.status = 'processing'; payout.leaseToken = token; payout.leaseUntil = new Date(Date.now() + 120000);
      payout.decidedAt = new Date(); payout.decidedById = actor.sub; payout.decidedByName = actor.email;
      if (note?.trim()) payout.adminNote = note.trim().slice(0, 500);
      await payout.save({ session });
      return { payout, accountId: account.accountId };
    });
    let transfer: { transferId: string };
    try {
      transfer = await this.gateway.transfer({ accountId: claimed.accountId, amountMinor: claimed.payout.amountMinor, currency: claimed.payout.currency, idempotencyKey: `payout:${claimed.payout.id}`, payoutId: claimed.payout.id, teacherId: claimed.payout.teacherId });
    } catch (error) {
      const definite = typeof error === 'object' && error !== null && ['StripeCardError', 'StripeInvalidRequestError'].includes((error as { type?: string }).type ?? '');
      if (definite) {
        const failed = await this.financeTransactions.run(claimed.payout.teacherId, async session => {
          const payout = await this.payouts.findOne({ _id: payoutId, leaseToken: token, status: 'processing' }).session(session);
          if (!payout) throw new ConflictException('Payout processing ownership changed. Reload the request.');
          payout.status = 'failed'; payout.failureReason = 'The payment provider rejected the transfer. The amount is available again.'; payout.leaseToken = undefined; payout.leaseUntil = undefined;
          await this.ledger.post(payoutReleasedEntry(this.facts(payout), 'Payout transfer failed', new Date()), session);
          await payout.save({ session }); return payout;
        });
        await this.audit.record({ actor, action: 'payout.failed', status: 'failure', resourceType: 'payout', resourceId: payoutId });
        return this.toRecord(failed);
      }
      await this.payouts.updateOne({ _id: payoutId, leaseToken: token }, { $set: { failureReason: 'Waiting for payment provider confirmation. Retrying this request preserves the original idempotency key.' } });
      this.logger.warn(`Payout ${payoutId} transfer outcome is unknown; reservation retained.`);
      throw new ServiceUnavailableException('The payment provider did not confirm the transfer. Try approving again in two minutes; the original request will be retried.');
    }
    const paid = await this.financeTransactions.run(claimed.payout.teacherId, async session => {
      const payout = await this.payouts.findOne({ _id: payoutId, leaseToken: token, status: 'processing' }).session(session);
      if (!payout) { const recorded = await this.payouts.findById(payoutId).session(session); if (recorded?.gatewayTransferId === transfer.transferId) return recorded; throw new ConflictException('Payout processing ownership changed. Reload the request.'); }
      payout.status = 'paid'; payout.paidAt = new Date(); payout.gatewayTransferId = transfer.transferId;
      payout.leaseToken = undefined; payout.leaseUntil = undefined; payout.failureReason = undefined;
      await this.ledger.post(payoutPaidEntry(this.facts(payout), payout.paidAt), session);
      await payout.save({ session }); return payout;
    });
    await this.audit.record({ actor, action: 'payout.paid', resourceType: 'payout', resourceId: payoutId, targetUserId: paid.teacherId, metadata: { amountMinor: paid.amountMinor, currency: paid.currency, transferId: transfer.transferId } });
    await this.notifyTeacher(paid, `Your payout of ${formatPaymentMoney(paid.amountMinor, paid.currency)} has been sent to your payout account.`);
    return this.toRecord(paid);
  }

  private async notifyTeacher(payout: PayoutMongo, body: string): Promise<void> {
    const teacher = await this.users.findById(payout.teacherId).select('email displayName name').exec();
    if (!teacher?.email) return;
    await this.email
      .sendEmail({ to: teacher.email, subject: 'Sapiovian payout update', text: `Hello ${teacher.displayName || teacher.name || ''},\n\n${body}\n\nSapiovian` })
      .catch(() => undefined);
  }

}
