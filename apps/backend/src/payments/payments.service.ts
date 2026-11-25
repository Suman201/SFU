import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  MAX_PAYMENT_MINOR,
  commissionBpsForTeacher,
  formatPaymentMoney,
  splitCommission,
  splitRefund,
  type AdminPaymentRecord,
  type CheckoutResponse,
  type DisputeRecord,
  type PageResult,
  type PaymentGatewayStatus,
  type PaymentListQuery,
  type PaymentStatus,
  type RefundRecord,
  type StudentPaymentRecord,
} from '@native-sfu/contracts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BatchDocument, UserDocument, type BatchMongoDocument, type UserMongoDocument } from '../database/schemas';
import { InvoicesService } from '../invoices/invoices.service';
import { EmailNotificationService } from '../notifications/email-notification.service';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';
import { batchPrice } from './batch-price';
import { FinanceSettingsService } from './finance-settings.service';
import { PAYMENT_GATEWAY, type GatewayEvent, type PaymentGateway } from './gateways/payment-gateway';
import {
  disputeFeeEntry,
  disputeLostEntry,
  disputeOpenedEntry,
  disputeWonEntry,
  earningsReleasedEntry,
  gatewayFeeEntry,
  paymentCapturedEntry,
  refundEntry,
  type PaymentFacts,
} from './ledger-entries';
import { LedgerService } from './ledger.service';
import {
  DisputeDocument,
  FinanceCounterDocument,
  PaymentDocument,
  RefundDocument,
  type DisputeMongo,
  type PaymentMongo,
  type RefundMongo,
} from './payment.schemas';
import { renderReceiptPdf } from './receipt-pdf';

/** Thrown when another worker holds the payment lock; the caller retries later. */
export class PaymentBusyError extends Error {
  constructor() {
    super('The payment is being updated. Try again shortly.');
  }
}

const PAID_STATUSES: PaymentStatus[] = ['succeeded', 'partially_refunded', 'refunded'];
const MAX_RECEIPT_EMAIL_ATTEMPTS = 6;
const SYSTEM_ACTOR: AuthenticatedUser = { sub: 'payments-system', email: '', roles: [], permissions: [], tokenId: 'internal-payments' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displayName(user?: Pick<UserMongoDocument, 'displayName' | 'name' | 'email'> | null): string {
  return user?.displayName || user?.name || user?.email || 'Unknown user';
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(PaymentDocument.name) private readonly payments: Model<PaymentMongo>,
    @InjectModel(RefundDocument.name) private readonly refunds: Model<RefundMongo>,
    @InjectModel(DisputeDocument.name) private readonly disputes: Model<DisputeMongo>,
    @InjectModel(FinanceCounterDocument.name) private readonly counters: Model<FinanceCounterDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly settings: FinanceSettingsService,
    private readonly ledger: LedgerService,
    private readonly enrollments: StudentEnrollmentsService,
    private readonly invoices: InvoicesService,
    private readonly email: EmailNotificationService,
    private readonly audit: AuditLogsService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  enabled(): boolean {
    return Boolean(this.config.get<boolean>('payments.enabled', false));
  }

  gatewayId() {
    return this.gateway.id;
  }

  private webUrl(): string {
    return this.config.get<string>('payments.webUrl', 'http://localhost:4200');
  }

  async status(): Promise<PaymentGatewayStatus> {
    const settings = await this.settings.get();
    return {
      enabled: this.enabled(),
      gateway: this.gateway.id,
      testMode: this.gateway.testMode,
      currencies: settings.enabledCurrencies.filter((currency) => this.gateway.supportsCurrency(currency)),
    };
  }

  private assertEnabled(): void {
    if (!this.enabled()) throw new ServiceUnavailableException('Online payments are not available yet.');
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  async createCheckout(user: AuthenticatedUser, batchId: string): Promise<CheckoutResponse> {
    this.assertEnabled();
    if (!user.roles.includes('STUDENT')) throw new ForbiddenException('Only student accounts can pay for classes.');
    const [batch, student] = await Promise.all([
      this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } }).exec(),
      this.users.findOne({ _id: user.sub, deletedAt: { $exists: false } }).exec(),
    ]);
    if (!batch) throw new NotFoundException('Class not found.');
    if (!student) throw new NotFoundException('Student account not found.');
    if (batch.isPrivateBooking || batch.status !== 'ACTIVE' || (batch.endDate && batch.endDate < new Date())) {
      throw new BadRequestException('This class is not open for enrollment.');
    }
    const settings = await this.settings.get();
    const price = batchPrice(batch, settings.defaultCurrency);
    if (price.amountMinor <= 0) throw new BadRequestException('This class is free. Enroll directly instead.');
    if (price.amountMinor > MAX_PAYMENT_MINOR) throw new BadRequestException('This class fee is too large to collect online.');
    if (!settings.enabledCurrencies.includes(price.currency) || !this.gateway.supportsCurrency(price.currency)) {
      throw new BadRequestException(`Online payments in ${price.currency} are not available yet.`);
    }
    if (await this.enrollments.isStudentEnrolledInBatch(student.id, batch.id)) {
      throw new ConflictException('You are already enrolled in this class.');
    }

    const activeKey = `${student.id}:${batch.id}`;
    const reusable = await this.reusableCheckout(activeKey);
    if (reusable) return reusable;

    const teacher = await this.users.findById(batch.teacherId).exec();
    const commissionBps = commissionBpsForTeacher(settings, batch.teacherId);
    const split = splitCommission(price.amountMinor, commissionBps);
    const ttlMinutes = this.config.get<number>('payments.checkoutTtlMinutes', 30);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const description = `${batch.name}${batch.courseName ? ` · ${batch.courseName}` : ''}`;

    let payment: PaymentMongo | undefined;
    await this.withBatchLock(batch.id, async () => {
      const now = new Date();
      const [active, holds] = await Promise.all([
        this.enrollments.countActiveByBatch(batch.id),
        this.payments.countDocuments({ batchId: batch.id, status: 'pending', seatHoldUntil: { $gt: now } }).exec(),
      ]);
      const currentBatch = await this.batches.findById(batch.id).exec();
      if (!currentBatch || currentBatch.isPrivateBooking || currentBatch.status !== 'ACTIVE') throw new ConflictException('This class is no longer open for enrollment.');
      if (active + holds + (currentBatch.paymentReservedCount ?? 0) >= currentBatch.maxCapacity) {
        throw new ConflictException('This class is full. Places held by students who are checking out are released if they do not finish paying.');
      }
      try {
        payment = await this.payments.create({
          status: 'pending',
          gateway: this.gateway.id,
          currency: price.currency,
          amountMinor: price.amountMinor,
          commissionBps,
          commissionMinor: split.commissionMinor,
          teacherMinor: split.teacherMinor,
          studentId: student.id,
          studentName: displayName(student),
          studentEmail: student.email,
          teacherId: batch.teacherId,
          teacherName: displayName(teacher),
          batchId: batch.id,
          batchName: batch.name,
          description,
          activeKey,
          expiresAt,
          seatHoldUntil: new Date(expiresAt.getTime() + 5 * 60_000),
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    });
    if (!payment) {
      const raced = await this.reusableCheckout(activeKey);
      if (raced) return raced;
      throw new ConflictException('A payment for this class is already in progress. Reload and try again.');
    }

    try {
      const session = await this.gateway.createCheckout({
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        productName: batch.name,
        description: `${description} — taught by ${payment.teacherName}`,
        customerEmail: student.email,
        successUrl: `${this.webUrl()}/payments/${payment.id}?checkout=success`,
        cancelUrl: `${this.webUrl()}/payments/${payment.id}?checkout=cancelled`,
        expiresAt,
        idempotencyKey: `checkout:${payment.id}`,
        metadata: { paymentId: payment.id, batchId: batch.id, studentId: student.id, teacherId: batch.teacherId },
      });
      const saved = await this.payments
        .findOneAndUpdate(
          { _id: payment.id, status: 'pending' },
          { $set: { gatewaySessionId: session.sessionId, checkoutUrl: session.url, expiresAt: session.expiresAt } },
          { new: true },
        )
        .exec();
      if (!saved) throw new ConflictException('The checkout changed while it was being created. Reload and try again.');
      await this.audit.record({
        actor: user,
        action: 'payment.checkout_started',
        resourceType: 'payment',
        resourceId: saved.id,
        resourceLabel: saved.description,
        metadata: { amountMinor: saved.amountMinor, currency: saved.currency, batchId: saved.batchId },
      });
      return { paymentId: saved.id, checkoutUrl: session.url, expiresAt: session.expiresAt.toISOString(), reused: false };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      await this.payments
        .updateOne(
          { _id: payment.id, status: 'pending' },
          {
            $set: { status: 'failed', failedAt: new Date(), failureReason: 'The payment provider could not start checkout.' },
            $unset: { activeKey: '', seatHoldUntil: '', checkoutUrl: '' },
          },
        )
        .exec();
      this.logger.error(`Checkout creation failed for payment ${payment.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ServiceUnavailableException('Payments are temporarily unavailable. Please try again shortly.');
    }
  }

  /** Returns the student's unfinished checkout for the same class, closing it when it can no longer be used. */
  private async reusableCheckout(activeKey: string): Promise<CheckoutResponse | null> {
    const existing = await this.payments.findOne({ activeKey }).exec();
    if (!existing) return null;
    if (existing.status === 'pending') {
      if (existing.checkoutUrl && existing.expiresAt && existing.expiresAt.getTime() > Date.now() + 60_000) {
        return { paymentId: existing.id, checkoutUrl: existing.checkoutUrl, expiresAt: existing.expiresAt.toISOString(), reused: true };
      }
      if (!existing.checkoutUrl && existing.createdAt.getTime() > Date.now() - 60_000) {
        throw new ConflictException('A checkout for this class is being prepared. Try again in a moment.');
      }
      await this.closePending(existing.id, 'expired', 'The checkout expired before payment.');
      return null;
    }
    await this.ensureSettled(existing.id).catch(() => undefined);
    throw new ConflictException('You have already paid for this class. Your access is being set up.');
  }

  async cancelCheckout(user: AuthenticatedUser, paymentId: string): Promise<StudentPaymentRecord> {
    const payment = await this.payments.findOne({ _id: paymentId, studentId: user.sub }).exec();
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.status !== 'pending') return this.getForStudent(user, paymentId);
    await this.closePending(payment.id, 'cancelled', 'Checkout cancelled by the student.');
    if (payment.gatewaySessionId) {
      await this.gateway.expireCheckout(payment.gatewaySessionId).catch(() => this.logger.warn(`Could not expire checkout ${payment.id}.`));
    }
    return this.getForStudent(user, paymentId);
  }

  private async closePending(paymentId: string, status: 'expired' | 'cancelled' | 'failed', reason: string): Promise<void> {
    await this.payments
      .updateOne(
        { _id: paymentId, status: 'pending' },
        {
          $set: { status, failureReason: reason, ...(status === 'failed' ? { failedAt: new Date() } : {}) },
          $unset: { activeKey: '', seatHoldUntil: '', checkoutUrl: '' },
        },
      )
      .exec();
  }

  // -------------------------------------------------------------------------
  // Gateway events
  // -------------------------------------------------------------------------

  /** Applies a verified gateway event. Returns the affected payment id. Throws to request a retry. */
  async applyEvent(event: GatewayEvent): Promise<string | undefined> {
    switch (event.kind) {
      case 'checkout.completed':
      case 'checkout.async_succeeded': {
        const payment = await this.paymentForSession(event.sessionId, event.paymentRef);
        if (event.kind === 'checkout.completed' && !event.paid) {
          await this.payments.updateOne({ _id: payment.id, status: 'pending' }, { $set: { gatewayPaymentId: event.gatewayPaymentId } }).exec();
          return payment.id;
        }
        if (event.currency !== payment.currency || event.amountMinor !== payment.amountMinor) {
          throw new Error(`Paid amount ${event.amountMinor} ${event.currency} does not match payment ${payment.amountMinor} ${payment.currency}.`);
        }
        await this.withPaymentLock(payment.id, () => this.markPaid(payment.id, event.gatewayPaymentId));
        await this.ensureSettled(payment.id);
        return payment.id;
      }
      case 'checkout.async_failed': {
        const payment = await this.paymentForSession(event.sessionId, event.paymentRef);
        await this.closePending(payment.id, 'failed', event.reason);
        return payment.id;
      }
      case 'checkout.expired': {
        const payment = await this.paymentForSession(event.sessionId, event.paymentRef);
        await this.closePending(payment.id, 'expired', 'The checkout expired before payment.');
        return payment.id;
      }
      case 'payment.failed': {
        const payment = await this.payments
          .findOne({ $or: [{ gateway: this.gateway.id, gatewayPaymentId: event.gatewayPaymentId }, ...(event.paymentRef ? [{ _id: event.paymentRef }] : [])] })
          .exec();
        if (!payment) return undefined;
        // The hosted checkout stays open after a decline so the student can try another card.
        await this.payments.updateOne({ _id: payment.id, status: 'pending' }, { $set: { failureReason: event.reason } }).exec();
        return payment.id;
      }
      case 'refund.updated':
        return this.applyRefundEvent(event);
      case 'dispute.updated':
        return this.applyDisputeEvent(event);
      default:
        return undefined;
    }
  }

  private async paymentForSession(sessionId: string, paymentRef?: string): Promise<PaymentMongo> {
    const payment =
      (await this.payments.findOne({ gateway: this.gateway.id, gatewaySessionId: sessionId }).exec()) ??
      (paymentRef ? await this.payments.findOne({ _id: paymentRef, gateway: this.gateway.id }).exec() : null);
    if (!payment) throw new Error(`No payment matches checkout session ${sessionId}.`);
    return payment;
  }

  private async markPaid(paymentId: string, gatewayPaymentId?: string): Promise<void> {
    const current = await this.payments.findById(paymentId).exec();
    if (!current) throw new Error(`Payment ${paymentId} disappeared.`);
    if (PAID_STATUSES.includes(current.status)) return;
    const settings = await this.settings.get();
    const paidAt = new Date();
    const receiptNumber = current.receiptNumber ?? (await this.nextReceiptNumber(paidAt));
    const set: Record<string, unknown> = {
      status: 'succeeded',
      paidAt,
      earningsAvailableAt: new Date(paidAt.getTime() + settings.holdDays * 86_400_000),
      receiptNumber,
      receiptEmail: { status: 'pending', attempts: 0, nextAttemptAt: new Date() },
      ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
    };
    const unset = { seatHoldUntil: '', checkoutUrl: '', failureReason: '' };
    // A late success after the checkout was closed still collected money: reclaim the active key when free.
    const tryKey = current.activeKey ? {} : { activeKey: `${current.studentId}:${current.batchId}` };
    try {
      await this.payments.updateOne({ _id: paymentId, status: current.status }, { $set: { ...set, ...tryKey }, $unset: unset }).exec();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      await this.payments.updateOne({ _id: paymentId, status: current.status }, { $set: set, $unset: unset }).exec();
    }
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      actorName: 'Payment provider',
      action: 'payment.succeeded',
      resourceType: 'payment',
      resourceId: paymentId,
      resourceLabel: current.description,
      targetUserId: current.studentId,
      metadata: { amountMinor: current.amountMinor, currency: current.currency, receiptNumber, lateAfter: current.status },
    });
  }

  private async nextReceiptNumber(at: Date): Promise<string> {
    const year = String(at.getUTCFullYear());
    const counter = await this.counters.findOneAndUpdate({ _id: `receipt:${year}` }, { $inc: { next: 1 } }, { new: true, upsert: true }).exec();
    return `RCPT-${year}-${String(counter!.next).padStart(6, '0')}`;
  }

  private facts(payment: PaymentMongo): PaymentFacts {
    return {
      id: String(payment._id),
      teacherId: payment.teacherId,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      commissionMinor: payment.commissionMinor,
      teacherMinor: payment.teacherMinor,
      description: payment.description,
    };
  }

  /**
   * Completes every follow-up step of a paid payment. Each step is idempotent,
   * so this can run again after a crash or from the reconciliation sweep.
   */
  async ensureSettled(paymentId: string): Promise<void> {
    await this.withPaymentLock(paymentId, async () => {
      const payment = await this.payments.findById(paymentId).exec();
      if (!payment || !PAID_STATUSES.includes(payment.status)) return;
      if (payment.amountMinor > 0) await this.ledger.post(paymentCapturedEntry(this.facts(payment), payment.paidAt ?? new Date()));

      if (!payment.feeRecorded && payment.gatewayPaymentId) {
        const fee = await this.gateway.fetchPaymentFee({ gatewayPaymentId: payment.gatewayPaymentId, amountMinor: payment.amountMinor }).catch(() => null);
        if (fee) {
          if (fee.feeMinor > 0) await this.ledger.post(gatewayFeeEntry(this.facts(payment), fee.feeMinor, payment.paidAt ?? new Date()));
          await this.payments
            .updateOne({ _id: payment.id }, { $set: { feeRecorded: true, gatewayFeeMinor: fee.feeMinor, ...(fee.chargeId ? { gatewayChargeId: fee.chargeId } : {}) } })
            .exec();
        }
      }

      if (payment.enrollmentState === 'pending' && payment.status === 'succeeded' && payment.disputeState !== 'lost') {
        const result = await this.enrollments.enrollPaidStudent({ studentId: payment.studentId, batchId: payment.batchId, paymentId: payment.id });
        if (result.ok) {
          await this.payments.updateOne({ _id: payment.id }, { $set: { enrollmentState: 'granted', enrollmentId: result.enrollmentId } }).exec();
          return;
        }
        if (result.reason === 'busy') throw new PaymentBusyError();
        const why = {
          full: 'The class filled up before the payment completed.',
          closed: 'The class closed before the payment completed.',
          already_enrolled: 'The student was already enrolled in this class.',
          not_student: 'The paying account is not a student account.',
        }[result.reason];
        await this.payments.updateOne({ _id: payment.id }, { $set: { enrollmentState: 'refund_required', failureReason: why } }).exec();
        const refreshed = await this.payments.findById(payment.id).exec();
        await this.refundLocked(refreshed!, {
          reason: `Automatic refund: ${why}`,
          requestKey: 'system:access-not-granted',
          initiatedBy: 'system',
        }).catch((error) => this.logger.error(`Automatic refund for ${payment.id} failed: ${error instanceof Error ? error.message : 'unknown'}`));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  async createRefund(paymentId: string, input: { amountMinor?: number; reason: string; requestId: string }, actor: AuthenticatedUser): Promise<RefundRecord> {
    const reason = input.reason.trim().replace(/\s+/g, ' ');
    if (reason.length < 5) throw new BadRequestException('Add a short reason for the refund.');
    const refund = await this.withPaymentLock(
      paymentId,
      async () => {
        const payment = await this.payments.findById(paymentId).exec();
        if (!payment) throw new NotFoundException('Payment not found.');
        return this.refundLocked(payment, {
          amountMinor: input.amountMinor,
          reason,
          requestKey: `admin:${input.requestId}`,
          initiatedBy: 'admin',
          actor,
        });
      },
      { notFound: true },
    );
    return this.toRefundRecord(refund);
  }

  private async refundLocked(
    payment: PaymentMongo,
    input: { amountMinor?: number; reason: string; requestKey: string; initiatedBy: 'admin' | 'system' | 'gateway'; actor?: AuthenticatedUser },
  ): Promise<RefundMongo> {
    const existing = await this.refunds.findOne({ paymentId: payment.id, requestKey: input.requestKey }).exec();
    if (existing) return existing;
    if (!['succeeded', 'partially_refunded'].includes(payment.status)) throw new BadRequestException('Only completed payments can be refunded.');
    if (payment.disputeState === 'open') throw new ConflictException('This payment is disputed. Resolve the dispute with the payment provider instead of refunding.');
    if (payment.disputeState === 'lost') throw new ConflictException('This payment was charged back through a dispute and cannot be refunded again.');
    if (!payment.gatewayPaymentId) throw new ConflictException('The payment provider reference is missing. Reconcile the payment first.');
    const totals = await this.refundTotals(payment.id);
    const remaining = payment.amountMinor - totals.amountMinor;
    const amount = input.amountMinor ?? remaining;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > remaining) {
      throw new BadRequestException(`Refund between ${formatPaymentMoney(1, payment.currency)} and ${formatPaymentMoney(remaining, payment.currency)}.`);
    }
    const split = splitRefund(
      { amountMinor: payment.amountMinor, commissionMinor: payment.commissionMinor, refundedMinor: totals.amountMinor, refundedCommissionMinor: totals.commissionMinor },
      amount,
    );
    let refund: RefundMongo;
    try {
      refund = await this.refunds.create({
        paymentId: payment.id,
        requestKey: input.requestKey,
        currency: payment.currency,
        amountMinor: amount,
        commissionMinor: split.commissionMinor,
        teacherMinor: split.teacherMinor,
        reason: input.reason,
        status: 'pending',
        initiatedBy: input.initiatedBy,
        requestedById: input.actor?.sub,
        requestedByName: input.actor?.email,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return (await this.refunds.findOne({ paymentId: payment.id, requestKey: input.requestKey }).exec())!;
    }
    await this.syncRefundTotals(payment.id);
    await this.audit.record({
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'payment.refund_requested',
      resourceType: 'payment',
      resourceId: payment.id,
      resourceLabel: payment.description,
      targetUserId: payment.studentId,
      metadata: { refundId: refund.id, amountMinor: amount, currency: payment.currency, reason: input.reason, initiatedBy: input.initiatedBy },
    });
    await this.sendRefundToGateway(payment, refund);
    return (await this.refunds.findById(refund.id).exec())!;
  }

  private async sendRefundToGateway(payment: PaymentMongo, refund: RefundMongo): Promise<void> {
    try {
      const result = await this.gateway.refund({
        gatewayPaymentId: payment.gatewayPaymentId!,
        amountMinor: refund.amountMinor,
        idempotencyKey: `refund:${refund.id}`,
        refundId: refund.id,
        paymentId: payment.id,
      });
      await this.refunds.updateOne({ _id: refund.id }, { $set: { gatewayRefundId: result.gatewayRefundId }, $unset: { failureReason: '' } }).exec();
      if (result.status === 'succeeded') await this.completeRefundLocked(payment.id, refund.id);
      if (result.status === 'failed') await this.failRefundLocked(payment.id, refund.id, result.failureReason ?? 'The payment provider declined the refund.');
    } catch (error) {
      // The outcome is unknown; the retry sweep resends with the same idempotency key.
      await this.refunds.updateOne({ _id: refund.id, status: 'pending' }, { $set: { failureReason: 'Waiting for the payment provider to confirm.' } }).exec();
      this.logger.warn(`Refund ${refund.id} will be retried: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async refundTotals(paymentId: string): Promise<{ amountMinor: number; commissionMinor: number; teacherMinor: number; pendingMinor: number; succeededMinor: number; succeededCommissionMinor: number; succeededTeacherMinor: number }> {
    const rows = await this.refunds.find({ paymentId, status: { $in: ['pending', 'succeeded'] } }).exec();
    const sum = (items: RefundMongo[], key: 'amountMinor' | 'commissionMinor' | 'teacherMinor') => items.reduce((total, item) => total + item[key], 0);
    const succeeded = rows.filter((row) => row.status === 'succeeded');
    return {
      amountMinor: sum(rows, 'amountMinor'),
      commissionMinor: sum(rows, 'commissionMinor'),
      teacherMinor: sum(rows, 'teacherMinor'),
      pendingMinor: sum(rows.filter((row) => row.status === 'pending'), 'amountMinor'),
      succeededMinor: sum(succeeded, 'amountMinor'),
      succeededCommissionMinor: sum(succeeded, 'commissionMinor'),
      succeededTeacherMinor: sum(succeeded, 'teacherMinor'),
    };
  }

  /** Payment refund totals are always derived from refund records, so recomputing them is idempotent. */
  private async syncRefundTotals(paymentId: string): Promise<PaymentMongo> {
    const totals = await this.refundTotals(paymentId);
    const payment = await this.payments.findById(paymentId).exec();
    if (!payment) throw new Error(`Payment ${paymentId} disappeared.`);
    const set: Record<string, unknown> = {
      refundedMinor: totals.succeededMinor,
      refundedCommissionMinor: totals.succeededCommissionMinor,
      refundedTeacherMinor: totals.succeededTeacherMinor,
      refundPendingMinor: totals.pendingMinor,
    };
    const unset: Record<string, ''> = {};
    if (PAID_STATUSES.includes(payment.status)) {
      set.status = totals.succeededMinor <= 0 ? 'succeeded' : totals.succeededMinor >= payment.amountMinor ? 'refunded' : 'partially_refunded';
      if (set.status === 'refunded') unset.activeKey = '';
    }
    return (await this.payments.findOneAndUpdate({ _id: paymentId }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).exec())!;
  }

  private async completeRefundLocked(paymentId: string, refundId: string): Promise<void> {
    const refund =
      (await this.refunds.findOneAndUpdate({ _id: refundId, status: 'pending' }, { $set: { status: 'succeeded', completedAt: new Date() }, $unset: { failureReason: '' } }, { new: true }).exec()) ??
      (await this.refunds.findOne({ _id: refundId, status: 'succeeded' }).exec());
    if (!refund) return;
    const before = await this.payments.findById(paymentId).exec();
    if (!before) return;
    const bucket = before.earningsReleasedAt ? 'teacher_available' : 'teacher_pending';
    await this.ledger.post(
      refundEntry(
        this.facts(before),
        { id: String(refund._id), amountMinor: refund.amountMinor, commissionMinor: refund.commissionMinor, teacherMinor: refund.teacherMinor },
        bucket,
        refund.completedAt ?? new Date(),
      ),
    );
    const payment = await this.syncRefundTotals(paymentId);
    if (payment.status === 'refunded' && payment.enrollmentId && payment.enrollmentState === 'granted') {
      await this.enrollments.revokePaidEnrollment(payment.enrollmentId, payment.id);
      await this.payments.updateOne({ _id: payment.id }, { $set: { enrollmentState: 'not_granted' } }).exec();
    }
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      actorName: 'Payment provider',
      action: 'payment.refund_succeeded',
      resourceType: 'payment',
      resourceId: payment.id,
      resourceLabel: payment.description,
      targetUserId: payment.studentId,
      metadata: { refundId: refund.id, amountMinor: refund.amountMinor, currency: refund.currency },
    });
    await this.email
      .sendEmail({
        to: payment.studentEmail,
        subject: `Refund of ${formatPaymentMoney(refund.amountMinor, refund.currency)} for ${payment.batchName}`,
        text: `Hello ${payment.studentName},\n\nWe have refunded ${formatPaymentMoney(refund.amountMinor, refund.currency)} for ${payment.description} (receipt ${payment.receiptNumber ?? payment.id}).\nRefunds usually reach your card within 5–10 business days.\n\nReason: ${refund.reason}\n\nSapiovian`,
      })
      .catch(() => undefined);
  }

  private async failRefundLocked(paymentId: string, refundId: string, reason: string): Promise<void> {
    const refund = await this.refunds.findOne({ _id: refundId }).exec();
    if (!refund) return;
    if (refund.status === 'succeeded') {
      throw new Error(`Refund ${refundId} failed after it had succeeded. Review it with the payment provider before adjusting the ledger.`);
    }
    await this.refunds.updateOne({ _id: refundId, status: 'pending' }, { $set: { status: 'failed', failureReason: reason, completedAt: new Date() } }).exec();
    await this.syncRefundTotals(paymentId);
  }

  private async applyRefundEvent(event: Extract<GatewayEvent, { kind: 'refund.updated' }>): Promise<string> {
    const payment = await this.payments.findOne({ gateway: this.gateway.id, gatewayPaymentId: event.gatewayPaymentId }).exec();
    if (!payment) throw new Error(`No payment matches refunded payment ${event.gatewayPaymentId}.`);
    await this.withPaymentLock(payment.id, async () => {
      let refund =
        (await this.refunds.findOne({ gatewayRefundId: event.gatewayRefundId }).exec()) ??
        (event.refundRef ? await this.refunds.findOne({ _id: event.refundRef, paymentId: payment.id }).exec() : null);
      if (!refund) {
        if (event.status === 'failed') return;
        // A refund issued directly in the provider dashboard.
        const current = (await this.payments.findById(payment.id).exec())!;
        const totals = await this.refundTotals(payment.id);
        const split = splitRefund(
          { amountMinor: current.amountMinor, commissionMinor: current.commissionMinor, refundedMinor: totals.amountMinor, refundedCommissionMinor: totals.commissionMinor },
          event.amountMinor,
        );
        try {
          refund = await this.refunds.create({
            paymentId: payment.id,
            requestKey: `gateway:${event.gatewayRefundId}`,
            gatewayRefundId: event.gatewayRefundId,
            currency: current.currency,
            amountMinor: event.amountMinor,
            commissionMinor: split.commissionMinor,
            teacherMinor: split.teacherMinor,
            reason: 'Refund issued in the payment provider dashboard',
            status: 'pending',
            initiatedBy: 'gateway',
          });
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          refund = (await this.refunds.findOne({ gatewayRefundId: event.gatewayRefundId }).exec())!;
        }
        await this.syncRefundTotals(payment.id);
      } else if (!refund.gatewayRefundId) {
        await this.refunds.updateOne({ _id: refund.id }, { $set: { gatewayRefundId: event.gatewayRefundId } }).exec();
      }
      if (event.status === 'succeeded') await this.completeRefundLocked(payment.id, refund.id);
      if (event.status === 'failed') await this.failRefundLocked(payment.id, refund.id, event.reason ?? 'The payment provider could not complete the refund.');
    });
    return payment.id;
  }

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------

  private async applyDisputeEvent(event: Extract<GatewayEvent, { kind: 'dispute.updated' }>): Promise<string> {
    const found = await this.payments.findOne({ gateway: this.gateway.id, gatewayPaymentId: event.gatewayPaymentId }).exec();
    if (!found) throw new Error(`No payment matches disputed payment ${event.gatewayPaymentId}.`);
    await this.withPaymentLock(found.id, async () => {
      const payment = (await this.payments.findById(found.id).exec())!;
      let dispute = await this.disputes.findOne({ gatewayDisputeId: event.gatewayDisputeId }).exec();
      if (!dispute) {
        try {
          dispute = await this.disputes.create({
            paymentId: payment.id,
            gatewayDisputeId: event.gatewayDisputeId,
            currency: payment.currency,
            amountMinor: event.amountMinor,
            reason: event.reason,
            status: event.status,
            evidenceDueBy: event.evidenceDueBy ? new Date(event.evidenceDueBy) : undefined,
          });
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          dispute = (await this.disputes.findOne({ gatewayDisputeId: event.gatewayDisputeId }).exec())!;
        }
      }
      const resolved = ['won', 'lost', 'closed'].includes(event.status);
      await this.disputes
        .updateOne(
          { _id: dispute.id },
          { $set: { status: event.status, reason: event.reason, ...(event.evidenceDueBy ? { evidenceDueBy: new Date(event.evidenceDueBy) } : {}), ...(resolved ? { resolvedAt: dispute.resolvedAt ?? new Date() } : {}) } },
        )
        .exec();
      if (event.inquiry) return;

      const facts = this.facts(payment);
      if (!dispute.frozenFrom) {
        const amount = event.amountMinor;
        const remainingTeacher = Math.max(0, payment.teacherMinor - payment.refundedTeacherMinor);
        const proportionalCommission = payment.amountMinor > 0 ? Math.round((payment.commissionMinor * amount) / payment.amountMinor) : 0;
        const frozenTeacherMinor = Math.min(remainingTeacher, Math.max(0, amount - proportionalCommission));
        const frozenCommissionMinor = amount - frozenTeacherMinor;
        const frozenFrom = payment.earningsReleasedAt ? 'teacher_available' : 'teacher_pending';
        await this.ledger.post(disputeOpenedEntry(facts, { id: dispute.id, amountMinor: amount, frozenTeacherMinor, frozenCommissionMinor }, frozenFrom, new Date()));
        dispute = (await this.disputes
          .findOneAndUpdate({ _id: dispute.id }, { $set: { amountMinor: amount, frozenTeacherMinor, frozenCommissionMinor, frozenFrom } }, { new: true })
          .exec())!;
        await this.payments.updateOne({ _id: payment.id }, { $set: { disputeState: 'open' } }).exec();
        await this.audit.record({
          actor: SYSTEM_ACTOR,
          actorName: 'Payment provider',
          action: 'payment.dispute_opened',
          resourceType: 'payment',
          resourceId: payment.id,
          resourceLabel: payment.description,
          metadata: { disputeId: dispute.id, amountMinor: amount, currency: payment.currency, reason: event.reason },
        });
      }
      if (event.feeMinor > 0 && dispute.feeMinor === 0) {
        await this.ledger.post(disputeFeeEntry(facts, dispute.id, event.feeMinor, new Date()));
        await this.disputes.updateOne({ _id: dispute.id }, { $set: { feeMinor: event.feeMinor } }).exec();
      }
      const disputeFacts = { id: dispute.id, amountMinor: dispute.amountMinor, frozenTeacherMinor: dispute.frozenTeacherMinor, frozenCommissionMinor: dispute.frozenCommissionMinor };
      if (event.status === 'won' || event.status === 'closed') {
        await this.ledger.post(disputeWonEntry(facts, disputeFacts, dispute.frozenFrom ?? 'teacher_pending', new Date()));
        await this.payments.updateOne({ _id: payment.id }, { $set: { disputeState: 'won' } }).exec();
      }
      if (event.status === 'lost') {
        await this.ledger.post(disputeLostEntry(facts, disputeFacts, new Date()));
        await this.payments.updateOne({ _id: payment.id }, { $set: { disputeState: 'lost' }, $unset: { activeKey: '' } }).exec();
        if (payment.enrollmentId && payment.enrollmentState === 'granted') {
          await this.enrollments.revokePaidEnrollment(payment.enrollmentId, payment.id);
          await this.payments.updateOne({ _id: payment.id }, { $set: { enrollmentState: 'not_granted' } }).exec();
        }
      }
      if (resolved) {
        await this.audit.record({
          actor: SYSTEM_ACTOR,
          actorName: 'Payment provider',
          action: `payment.dispute_${event.status}`,
          resourceType: 'payment',
          resourceId: payment.id,
          resourceLabel: payment.description,
          metadata: { disputeId: dispute.id },
        });
      }
    });
    return found.id;
  }

  // -------------------------------------------------------------------------
  // Background work
  // -------------------------------------------------------------------------

  /** Moves teacher shares from pending to available once the holding period has passed. */
  async releaseDueEarnings(limit = 50): Promise<number> {
    const due = await this.payments
      .find({
        status: { $in: PAID_STATUSES },
        earningsReleasedAt: { $exists: false },
        earningsAvailableAt: { $lte: new Date() },
        disputeState: { $ne: 'open' },
        refundPendingMinor: 0,
      })
      .select('_id')
      .limit(limit)
      .exec();
    let released = 0;
    for (const { id } of due) {
      try {
        await this.withPaymentLock(id, async () => {
          const payment = await this.payments.findById(id).exec();
          if (!payment || payment.earningsReleasedAt || payment.disputeState === 'open' || payment.refundPendingMinor > 0) return;
          if (payment.amountMinor > 0 && !(await this.ledger.exists(`payment:${payment.id}:captured`))) return;
          const pending = await this.ledger.paymentTeacherBalance(payment.id, payment.teacherId, 'teacher_pending');
          if (pending > 0) await this.ledger.post(earningsReleasedEntry(this.facts(payment), pending, new Date()));
          await this.payments.updateOne({ _id: payment.id }, { $set: { earningsReleasedAt: new Date() } }).exec();
          released += 1;
        });
      } catch (error) {
        if (!(error instanceof PaymentBusyError)) this.logger.error(`Earnings release for ${id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    return released;
  }

  /** Repairs paid payments with missing follow-up steps and closes abandoned checkouts. */
  async sweep(): Promise<void> {
    const graceful = new Date(Date.now() - 15 * 60_000);
    const stale = await this.payments.find({ status: 'pending', expiresAt: { $lt: graceful } }).select('_id').limit(50).exec();
    for (const { id } of stale) await this.closePending(id, 'expired', 'The checkout expired before payment.');

    const unsettled = await this.payments
      .find({
        status: { $in: PAID_STATUSES },
        paidAt: { $lt: new Date(Date.now() - 30_000) },
        $or: [{ enrollmentState: 'pending', status: 'succeeded' }, { feeRecorded: false }],
      })
      .select('_id')
      .limit(25)
      .exec();
    for (const { id } of unsettled) {
      await this.ensureSettled(id).catch((error) => {
        if (!(error instanceof PaymentBusyError)) this.logger.warn(`Settlement retry for ${id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    }

    const unsentRefunds = await this.refunds
      .find({ status: 'pending', gatewayRefundId: { $exists: false }, createdAt: { $lt: new Date(Date.now() - 2 * 60_000) } })
      .limit(10)
      .exec();
    for (const refund of unsentRefunds) {
      await this.withPaymentLock(refund.paymentId, async () => {
        const payment = await this.payments.findById(refund.paymentId).exec();
        const current = await this.refunds.findById(refund.id).exec();
        if (payment && current?.status === 'pending' && !current.gatewayRefundId) await this.sendRefundToGateway(payment, current);
      }).catch(() => undefined);
    }
  }

  async sendDueReceiptEmails(): Promise<void> {
    if (!this.config.get<boolean>('notifications.email.enabled', false)) {
      await this.payments
        .updateMany({ 'receiptEmail.status': 'pending' }, { $set: { 'receiptEmail.status': 'disabled' } })
        .exec();
      return;
    }
    const now = new Date();
    const eligible = {
      receiptNumber: { $type: 'string' },
      'receiptEmail.attempts': { $lt: MAX_RECEIPT_EMAIL_ATTEMPTS },
      $or: [
        { 'receiptEmail.status': 'pending', 'receiptEmail.nextAttemptAt': { $lte: now } },
        { 'receiptEmail.status': 'processing', 'receiptEmail.leaseUntil': { $lte: now } },
      ],
    };
    const candidates = await this.payments.find(eligible).select('_id').limit(10).exec();
    for (const { id } of candidates) {
      const token = randomUUID();
      const claimed = await this.payments
        .findOneAndUpdate(
          { _id: id, ...eligible },
          { $set: { 'receiptEmail.status': 'processing', 'receiptEmail.leaseToken': token, 'receiptEmail.leaseUntil': new Date(Date.now() + 120_000) }, $inc: { 'receiptEmail.attempts': 1 } },
          { new: true },
        )
        .exec();
      if (!claimed) continue;
      let status: 'sent' | 'failed' | 'disabled' = 'failed';
      try {
        const pdf = await this.receiptBytes(claimed);
        const result = await this.email.sendEmail({
          to: claimed.studentEmail,
          subject: `Payment receipt ${claimed.receiptNumber} — ${claimed.batchName}`,
          text: `Hello ${claimed.studentName},\n\nThank you for your payment of ${formatPaymentMoney(claimed.amountMinor, claimed.currency)} for ${claimed.description}.\nYour receipt ${claimed.receiptNumber} is attached. You can also download it from Payments in your Sapiovian account.\n\nSapiovian`,
          attachments: [{ filename: `${claimed.receiptNumber}.pdf`, content: pdf, contentType: 'application/pdf' }],
        });
        status = result.delivered > 0 ? 'sent' : result.skipped > 0 && !result.errors.length ? 'disabled' : 'failed';
      } catch {
        status = 'failed';
      }
      const attempts = claimed.receiptEmail?.attempts ?? 1;
      await this.payments
        .updateOne(
          { _id: id, 'receiptEmail.leaseToken': token },
          {
            $set: {
              'receiptEmail.status': status === 'failed' ? (attempts >= MAX_RECEIPT_EMAIL_ATTEMPTS ? 'failed' : 'pending') : status,
              'receiptEmail.nextAttemptAt': new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** (attempts - 1))),
            },
            $unset: { 'receiptEmail.leaseToken': '', 'receiptEmail.leaseUntil': '' },
          },
        )
        .exec();
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private async refundsFor(paymentIds: string[]): Promise<Map<string, RefundMongo[]>> {
    if (!paymentIds.length) return new Map();
    const rows = await this.refunds.find({ paymentId: { $in: paymentIds } }).sort({ createdAt: 1 }).exec();
    const map = new Map<string, RefundMongo[]>();
    for (const row of rows) map.set(row.paymentId, [...(map.get(row.paymentId) ?? []), row]);
    return map;
  }

  private toStudentRecord(payment: PaymentMongo, refunds: RefundMongo[] = []): StudentPaymentRecord {
    const open = payment.status === 'pending' && payment.checkoutUrl && payment.expiresAt && payment.expiresAt.getTime() > Date.now();
    return {
      id: payment.id,
      receiptNumber: payment.receiptNumber,
      batchId: payment.batchId,
      batchName: payment.batchName,
      teacherId: payment.teacherId,
      teacherName: payment.teacherName,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      refundedMinor: payment.refundedMinor,
      status: payment.status,
      disputeState: payment.disputeState,
      enrollmentState: payment.enrollmentState,
      description: payment.description,
      createdAt: payment.createdAt.toISOString(),
      paidAt: payment.paidAt?.toISOString(),
      expiresAt: payment.expiresAt?.toISOString(),
      failureReason: payment.failureReason,
      ...(open ? { checkoutUrl: payment.checkoutUrl } : {}),
      refunds: refunds.map((refund) => ({
        id: refund.id,
        amountMinor: refund.amountMinor,
        status: refund.status,
        reason: refund.reason,
        createdAt: refund.createdAt.toISOString(),
        completedAt: refund.completedAt?.toISOString(),
      })),
    };
  }

  private toAdminRecord(payment: PaymentMongo, refunds: RefundMongo[] = []): AdminPaymentRecord {
    return {
      ...this.toStudentRecord(payment, refunds),
      checkoutUrl: undefined,
      studentId: payment.studentId,
      studentName: payment.studentName,
      studentEmail: payment.studentEmail,
      gateway: payment.gateway,
      gatewaySessionId: payment.gatewaySessionId,
      gatewayPaymentId: payment.gatewayPaymentId,
      commissionBps: payment.commissionBps,
      commissionMinor: payment.commissionMinor,
      teacherMinor: payment.teacherMinor,
      gatewayFeeMinor: payment.gatewayFeeMinor,
      refundedCommissionMinor: payment.refundedCommissionMinor,
      refundedTeacherMinor: payment.refundedTeacherMinor,
      earningsReleasedAt: payment.earningsReleasedAt?.toISOString(),
      earningsAvailableAt: payment.earningsAvailableAt?.toISOString(),
    };
  }

  toRefundRecord(refund: RefundMongo, payment?: Pick<PaymentMongo, 'studentName' | 'teacherName' | 'batchName'> | null): RefundRecord {
    return {
      id: refund.id,
      paymentId: refund.paymentId,
      currency: refund.currency,
      amountMinor: refund.amountMinor,
      commissionMinor: refund.commissionMinor,
      teacherMinor: refund.teacherMinor,
      reason: refund.reason,
      status: refund.status,
      initiatedBy: refund.initiatedBy,
      requestedByName: refund.requestedByName,
      studentName: payment?.studentName ?? '',
      teacherName: payment?.teacherName ?? '',
      batchName: payment?.batchName ?? '',
      createdAt: refund.createdAt.toISOString(),
      completedAt: refund.completedAt?.toISOString(),
      failureReason: refund.failureReason,
    };
  }

  async listForStudent(user: AuthenticatedUser, page = 1): Promise<PageResult<StudentPaymentRecord>> {
    const limit = 25;
    const safePage = Math.max(1, Math.min(10_000, Math.floor(page) || 1));
    const filter = { studentId: user.sub };
    const [docs, total] = await Promise.all([
      this.payments.find(filter).sort({ createdAt: -1, _id: 1 }).skip((safePage - 1) * limit).limit(limit).exec(),
      this.payments.countDocuments(filter).exec(),
    ]);
    const refunds = await this.refundsFor(docs.map((doc) => doc.id));
    return { items: docs.map((doc) => this.toStudentRecord(doc, refunds.get(doc.id))), total, page: safePage, limit };
  }

  async getForStudent(user: AuthenticatedUser, paymentId: string): Promise<StudentPaymentRecord> {
    const payment = await this.payments.findOne({ _id: paymentId, studentId: user.sub }).exec();
    if (!payment) throw new NotFoundException('Payment not found.');
    const refunds = await this.refundsFor([payment.id]);
    return this.toStudentRecord(payment, refunds.get(payment.id));
  }

  private paymentFilter(query: PaymentListQuery): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.teacherId) filter.teacherId = query.teacherId;
    if (query.currency) filter.currency = query.currency;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      filter.createdAt = {
        ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}),
        ...(to && !Number.isNaN(to.getTime()) ? { $lt: new Date(to.getTime() + 86_400_000) } : {}),
      };
    }
    if (query.q?.trim()) {
      const q = escapeRegex(query.q.trim().slice(0, 100));
      filter.$or = [
        { receiptNumber: { $regex: q, $options: 'i' } },
        { studentName: { $regex: q, $options: 'i' } },
        { studentEmail: { $regex: q, $options: 'i' } },
        { teacherName: { $regex: q, $options: 'i' } },
        { batchName: { $regex: q, $options: 'i' } },
        { gatewayPaymentId: q },
        { _id: q },
      ];
    }
    return filter;
  }

  async adminList(query: PaymentListQuery): Promise<PageResult<AdminPaymentRecord>> {
    const limit = 25;
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(query.page) || 1)));
    const filter = this.paymentFilter(query);
    const [docs, total] = await Promise.all([
      this.payments.find(filter).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.payments.countDocuments(filter).exec(),
    ]);
    const refunds = await this.refundsFor(docs.map((doc) => doc.id));
    return { items: docs.map((doc) => this.toAdminRecord(doc, refunds.get(doc.id))), total, page, limit };
  }

  async adminExportRows(query: PaymentListQuery): Promise<AdminPaymentRecord[]> {
    const docs = await this.payments.find(this.paymentFilter(query)).sort({ createdAt: -1, _id: 1 }).limit(10_000).exec();
    return docs.map((doc) => this.toAdminRecord(doc));
  }

  async adminGet(paymentId: string): Promise<AdminPaymentRecord> {
    const payment = await this.payments.findById(paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found.');
    const [refunds, ledger] = await Promise.all([this.refundsFor([payment.id]), this.ledger.forPayment(payment.id)]);
    return { ...this.toAdminRecord(payment, refunds.get(payment.id)), ledger };
  }

  async listRefunds(query: { page?: number; status?: string }): Promise<PageResult<RefundRecord>> {
    const limit = 25;
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(query.page) || 1)));
    const filter: Record<string, unknown> = {};
    if (query.status && query.status !== 'all') filter.status = query.status;
    const [docs, total] = await Promise.all([
      this.refunds.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.refunds.countDocuments(filter).exec(),
    ]);
    const payments = await this.payments.find({ _id: { $in: docs.map((doc) => doc.paymentId) } }).select('studentName teacherName batchName').exec();
    const byId = new Map(payments.map((payment) => [payment.id, payment]));
    return { items: docs.map((doc) => this.toRefundRecord(doc, byId.get(doc.paymentId))), total, page, limit };
  }

  async listDisputes(query: { page?: number; status?: string }): Promise<PageResult<DisputeRecord>> {
    const limit = 25;
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(query.page) || 1)));
    const filter: Record<string, unknown> = {};
    if (query.status === 'open') filter.status = { $in: ['needs_response', 'under_review'] };
    else if (query.status && query.status !== 'all') filter.status = query.status;
    const [docs, total] = await Promise.all([
      this.disputes.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.disputes.countDocuments(filter).exec(),
    ]);
    const payments = await this.payments.find({ _id: { $in: docs.map((doc) => doc.paymentId) } }).select('studentName teacherName batchName').exec();
    const byId = new Map(payments.map((payment) => [payment.id, payment]));
    return {
      items: docs.map((doc) => ({
        id: doc.id,
        paymentId: doc.paymentId,
        gatewayDisputeId: doc.gatewayDisputeId,
        currency: doc.currency,
        amountMinor: doc.amountMinor,
        reason: doc.reason,
        status: doc.status,
        evidenceDueBy: doc.evidenceDueBy?.toISOString(),
        studentName: byId.get(doc.paymentId)?.studentName ?? '',
        teacherName: byId.get(doc.paymentId)?.teacherName ?? '',
        batchName: byId.get(doc.paymentId)?.batchName ?? '',
        createdAt: doc.createdAt.toISOString(),
        resolvedAt: doc.resolvedAt?.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  async receipt(paymentId: string, studentId?: string): Promise<{ bytes: Buffer; name: string }> {
    const payment = await this.payments.findOne({ _id: paymentId, ...(studentId ? { studentId } : {}) }).exec();
    if (!payment) throw new NotFoundException('Payment not found.');
    if (!payment.receiptNumber || !payment.paidAt) throw new BadRequestException('A receipt is available after the payment succeeds.');
    return { bytes: await this.receiptBytes(payment), name: `${payment.receiptNumber}.pdf` };
  }

  private async receiptBytes(payment: PaymentMongo): Promise<Buffer> {
    const [settings, refunds] = await Promise.all([this.invoices.settings(), this.refunds.find({ paymentId: payment.id, status: 'succeeded' }).sort({ completedAt: 1 }).exec()]);
    return renderReceiptPdf({
      receiptNumber: payment.receiptNumber!,
      paymentId: payment.id,
      status: payment.status,
      paidAt: payment.paidAt!,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      description: payment.description,
      batchName: payment.batchName,
      teacherName: payment.teacherName,
      studentName: payment.studentName,
      studentEmail: payment.studentEmail,
      gatewayPaymentId: payment.gatewayPaymentId,
      seller: settings.seller,
      refunds: refunds.map((refund) => ({ amountMinor: refund.amountMinor, completedAt: refund.completedAt, reason: refund.reason })),
    });
  }

  /** Raw payment for the development test gateway. */
  async findForTestGateway(paymentId: string): Promise<PaymentMongo | null> {
    return this.payments.findById(paymentId).exec();
  }

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  private async withPaymentLock<T>(paymentId: string, work: () => Promise<T>, options: { notFound?: boolean } = {}): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + 4_000;
    for (;;) {
      const locked = await this.payments
        .findOneAndUpdate(
          { _id: paymentId, $or: [{ lockUntil: { $exists: false } }, { lockUntil: { $lt: new Date() } }] },
          { $set: { lockToken: token, lockUntil: new Date(Date.now() + 60_000) } },
          { new: true, timestamps: false },
        )
        .select('_id')
        .exec();
      if (locked) break;
      if (!(await this.payments.exists({ _id: paymentId }).exec())) {
        if (options.notFound) throw new NotFoundException('Payment not found.');
        throw new Error(`Payment ${paymentId} not found.`);
      }
      if (Date.now() > deadline) {
        if (options.notFound) throw new ConflictException('This payment is being updated. Try again in a moment.');
        throw new PaymentBusyError();
      }
      await sleep(120);
    }
    try {
      return await work();
    } finally {
      await this.payments.updateOne({ _id: paymentId, lockToken: token }, { $unset: { lockToken: '', lockUntil: '' } }, { timestamps: false }).exec();
    }
  }

  /** Shares the enrollment lock so seat counting and free enrollment cannot interleave. */
  private async withBatchLock(batchId: string, work: () => Promise<void>): Promise<void> {
    const token = randomUUID();
    const deadline = Date.now() + 3_000;
    for (;;) {
      const locked = await this.batches
        .findOneAndUpdate(
          { _id: batchId, $or: [{ enrollmentLockUntil: { $exists: false } }, { enrollmentLockUntil: { $lt: new Date() } }] },
          { $set: { enrollmentLockToken: token, enrollmentLockUntil: new Date(Date.now() + 120_000) } },
          { new: true, timestamps: false },
        )
        .select('_id')
        .exec();
      if (locked) break;
      if (Date.now() > deadline) throw new ConflictException('Enrollment is being updated. Please try again.');
      await sleep(120);
    }
    try {
      await work();
    } finally {
      await this.batches.updateOne({ _id: batchId, enrollmentLockToken: token }, { $unset: { enrollmentLockToken: '', enrollmentLockUntil: '' } }, { timestamps: false }).exec();
    }
  }
}
