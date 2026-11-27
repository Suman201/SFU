import { ClassSessionDocument, StudentEnrollmentDocument } from '../database/schemas';
import { needsBookingRefundReview } from '../bookings/refund-review';
import { StripeGateway as BookingStripeGateway, type VerifiedBookingDispute, type VerifiedBookingFee } from '../bookings/stripe.gateway';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { commissionBpsForTeacher, splitCommission, type AdoptBookingEarningsInput, type BookingEarningsPolicy, type BookingEarningsReconciliation, type BookingEarningsReview, type PageResult, type PaymentCurrency } from '@native-sfu/contracts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BookingCreditNoteDocument, BookingOrderDocument, BookingRefundDocument, type BookingOrderMongo } from '../bookings/booking.schema';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { InvoiceDocument } from '../invoices/invoice.schema';
import { assertBookingFacts, bookingCaptureEntry, bookingRefundAllocation, bookingRefundEntry, type BookingFinancialFacts } from './booking-ledger-entries';
import { FinanceSettingsService } from './finance-settings.service';
import { LedgerService } from './ledger.service';
import { LedgerEntryDocument } from './payment.schemas';
import type { GatewayEvent } from './gateways/payment-gateway';
import { TeacherFinanceTransactions } from './teacher-finance-transactions.service';

@Injectable()
export class BookingFinanceService {
  private readonly logger = new Logger(BookingFinanceService.name);
  constructor(
    @InjectModel(BookingOrderDocument.name) private readonly orders: Model<BookingOrderMongo>,
    @InjectModel(BookingRefundDocument.name) private readonly refunds: Model<BookingRefundDocument>,
    @InjectModel(BookingCreditNoteDocument.name) private readonly credits: Model<BookingCreditNoteDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classes: Model<ClassSessionDocument>,
    @InjectModel(StudentEnrollmentDocument.name) private readonly enrollments: Model<StudentEnrollmentDocument>,
    @InjectModel(InvoiceDocument.name) private readonly invoices: Model<InvoiceDocument>,
    @InjectModel(LedgerEntryDocument.name) private readonly entries: Model<LedgerEntryDocument>,
    private readonly settings: FinanceSettingsService,
    private readonly ledger: LedgerService,
    readonly transactions: TeacherFinanceTransactions,
    private readonly audit: AuditLogsService,
    private readonly bookingGateway: BookingStripeGateway,
  ) {}

  async snapshot(teacherId: string, netMinor: number): Promise<BookingEarningsPolicy> {
    const settings = await this.settings.get();
    const commissionBps = commissionBpsForTeacher(settings, teacherId);
    return { version: 1, settingsVersion: settings.version, commissionBps, ...splitCommission(netMinor, commissionBps), holdDays: settings.holdDays, source: 'reservation' };
  }

  private facts(order: BookingOrderMongo): BookingFinancialFacts {
    if (!order.earningsPolicy) throw new Error('Booking has no reviewed earnings policy.');
    const facts = { id: order.id, teacherId: order.teacherId, title: order.title, invoiceSource: order.invoiceSource, earningsPolicy: order.earningsPolicy };
    assertBookingFacts(facts);
    return facts;
  }

  /** Runs inside the same transaction as fulfillment; a failed journal write cannot leave a confirmed uncredited payment. */
  async capture(order: BookingOrderMongo, session: ClientSession): Promise<void> {
    if (!order.earningsPolicy) return;
    if (!order.paidAt || !order.invoiceId || (order.invoiceSource.totalMinor > 0 && !order.paymentIntentId)) throw new Error('Booking payment has not been verified.');
    await this.transactions.lock(order.teacherId, session);
    const facts = this.facts(order);
    const invoice = await this.invoices.findById(order.invoiceId).session(session).lean();
    if (!invoice || invoice.orderId !== order.id || invoice.status !== 'paid' || invoice.input.currency !== order.invoiceSource.currency || invoice.totals.subtotalMinor !== order.invoiceSource.netMinor || invoice.totals.taxMinor !== order.invoiceSource.taxMinor || invoice.totals.totalMinor !== order.invoiceSource.totalMinor || invoice.paymentReference !== order.invoiceSource.paymentReference) throw new Error('Booking financial snapshot does not match the paid invoice.');
    if (order.invoiceSource.totalMinor > 0) await this.ledger.post(bookingCaptureEntry(facts, order.paidAt), session);
    order.earningsCreditedAt ??= order.paidAt;
    order.earningsAvailableAt = new Date(Math.max(order.endsAt.getTime(), order.paidAt.getTime() + order.earningsPolicy.holdDays * 86_400_000));
    if (!order.earningsNextCheckAt || order.earningsNextCheckAt < order.earningsAvailableAt) order.earningsNextCheckAt = order.earningsAvailableAt;
  }

  async refund(order: BookingOrderMongo, refund: BookingRefundDocument, session: ClientSession): Promise<void> {
    if (!order.earningsPolicy || refund.status !== 'succeeded') return;
    await this.transactions.lock(order.teacherId, session);
    const facts = this.facts(order);
    if (!refund.creditNoteId) throw new Error('Confirmed refund needs its fiscal credit note.');
    const credit = await this.credits.findById(refund.creditNoteId).session(session).lean();
    if (!credit || credit.orderId !== order.id || credit.value.currency !== order.invoiceSource.currency || credit.value.totals.totalMinor !== refund.amountMinor) throw new Error('Refund does not match its fiscal credit note.');
    const key = `booking:${order.id}:refund:${refund._id}`;
    const previous = await this.entries.find({ bookingOrderId: order.id, type: 'refund' }).session(session).lean();
    const existing = previous.find(entry => entry.key === key);
    if (existing) {
      if (existing.currency !== order.invoiceSource.currency || existing.lines.filter(line => line.account === 'gateway_clearing').reduce((sum, line) => sum + line.creditMinor, 0) !== refund.amountMinor || existing.lines.filter(line => line.account === 'tax_payable').reduce((sum, line) => sum + line.debitMinor, 0) !== credit.value.totals.taxMinor) throw new Error('Recorded refund differs from its confirmed credit note.');
      return;
    }
    const commissionMinor = previous.flatMap(entry => entry.lines).filter(line => line.account === 'platform_revenue').reduce((sum, line) => sum + line.debitMinor, 0);
    const teacherMinor = previous.flatMap(entry => entry.lines).filter(line => line.account === 'teacher_pending' || line.account === 'teacher_available').reduce((sum, line) => sum + line.debitMinor, 0);
    const allocation = refund.earningsAllocation ?? bookingRefundAllocation(facts, credit.value.totals, { netMinor: commissionMinor + teacherMinor, commissionMinor });
    if (Object.values(allocation).some(value => !Number.isSafeInteger(value) || value < 0) || allocation.totalMinor !== credit.value.totals.totalMinor || allocation.taxMinor !== credit.value.totals.taxMinor || allocation.netMinor + allocation.taxMinor !== allocation.totalMinor || allocation.commissionMinor + allocation.teacherMinor !== allocation.netMinor) throw new Error('Saved refund allocation differs from its fiscal credit note.');
    refund.earningsAllocation = allocation;
    const bucket = refund.earningsBucket ?? (order.earningsReleasedAt ? 'teacher_available' : 'teacher_pending');
    refund.earningsBucket = bucket;
    await this.refunds.updateOne({ _id: refund._id }, { $set: { earningsBucket: bucket, earningsAllocation: allocation } }, { session });
    await this.ledger.post(bookingRefundEntry(facts, refund._id, allocation, bucket === 'teacher_available', new Date(credit.value.createdAt)), session);
  }

  async fee(order: BookingOrderMongo, fee: VerifiedBookingFee, session: ClientSession): Promise<void> {
    if (!order.earningsPolicy || !order.paidAt || !Number.isSafeInteger(fee.amountMinor) || fee.amountMinor < 0 || !/^[A-Za-z]{3}$/.test(fee.currency)) throw new Error('Invalid verified provider fee.');
    await this.transactions.lock(order.teacherId, session);
    const currency = fee.currency.toUpperCase();
    if (order.gatewayFeeCurrency && (order.gatewayFeeCurrency !== currency || order.gatewayFeeMinor !== fee.amountMinor)) throw new Error('The provider fee changed after recording; settlement needs review.');
    order.gatewayFeeCurrency = currency; order.gatewayFeeMinor = fee.amountMinor;
    if (currency !== order.invoiceSource.currency) return; // Preserve the provider denomination for explicit FX settlement review.
    if (fee.amountMinor > 0) await this.ledger.post({ key: `booking:${order.id}:fee`, type: 'gateway_fee', currency: order.invoiceSource.currency, occurredAt: fee.occurredAt ?? order.paidAt, memo: 'Booking payment processing fee', bookingOrderId: order.id, lines: [ { account: 'gateway_fees', debitMinor: fee.amountMinor, creditMinor: 0 }, { account: 'gateway_clearing', debitMinor: 0, creditMinor: fee.amountMinor } ] }, session);
    order.gatewayFeeRecordedAt ??= new Date();
  }

  async recordFee(id: string, fee: VerifiedBookingFee): Promise<void> {
    const initial = await this.orders.findById(id).select('teacherId').lean();
    if (!initial) return;
    await this.transactions.run(initial.teacherId, async session => {
      const order = await this.orders.findById(id).session(session);
      if (!order?.earningsPolicy || !order.paidAt) return;
      await this.capture(order, session); await this.fee(order, fee, session); await order.save({ session });
    });
  }

  async unrecordedFees(currency: PaymentCurrency, from: Date, to: Date): Promise<number> {
    return this.orders.countDocuments({ 'earningsPolicy.version': 1, paidAt: { $gte: from, $lt: to }, 'invoiceSource.currency': currency, 'invoiceSource.totalMinor': { $gt: 0 }, gatewayFeeRecordedAt: { $exists: false } });
  }

  async details(ids: string[], teacherId: string): Promise<Array<Pick<BookingOrderDocument, '_id' | 'title' | 'studentName' | 'invoiceSource' | 'earningsPolicy'>>> {
    return this.orders.find({ _id: { $in: ids }, teacherId }).select('_id title studentName invoiceSource earningsPolicy').lean();
  }

  async incompatiblePaymentMode(teacherId: string, currency: PaymentCurrency, testMode: boolean, session?: ClientSession): Promise<boolean> {
    return Boolean(await this.orders.exists({ teacherId, 'invoiceSource.currency': currency, 'earningsPolicy.version': 1, 'earningsPolicy.teacherMinor': { $gt: 0 }, earningsCreditedAt: { $exists: true }, paymentLivemode: { $ne: !testMode }, $expr: { $lt: ['$refundedMinor', '$invoiceSource.totalMinor'] } }).session(session ?? null));
  }

  /** Both Stripe endpoints can receive the same platform event. Booking records retain their own fulfillment/refund inbox. */
  async handleGatewayEvent(event: GatewayEvent): Promise<boolean> {
    if ('sessionId' in event) return Boolean(await this.orders.exists({ stripeSessionId: event.sessionId }));
    if (event.kind !== 'refund.updated' && event.kind !== 'dispute.updated' && event.kind !== 'payment.failed') return false;
    if (!await this.orders.exists({ paymentIntentId: event.gatewayPaymentId })) return false;
    if (event.kind === 'dispute.updated') {
      const remote = await this.bookingGateway.retrieveDispute(event.gatewayDisputeId);
      if (remote.paymentIntentId !== event.gatewayPaymentId) throw new Error('The provider dispute belongs to a different payment.');
      await this.recordDispute(remote);
    }
    return true;
  }

  /** A provider loss never becomes an ordinary refund: fiscal credits and chargeback settlement require review. */
  async recordDispute(remote: VerifiedBookingDispute): Promise<void> {
    const initial = await this.orders.findOne({ paymentIntentId: remote.paymentIntentId }).lean();
    if (!initial) {
      if (remote.orderId && await this.orders.exists({ _id: remote.orderId })) throw new Error('Booking fulfillment is not ready for dispute reconciliation.');
      return; // The legacy payment path owns non-booking payments.
    }
    if (!Number.isSafeInteger(remote.amountMinor) || remote.amountMinor < 1 || remote.currency !== initial.invoiceSource.currency || remote.livemode !== this.bookingGateway.live || remote.livemode !== initial.paymentLivemode) throw new Error('Dispute does not match the verified booking payment.');
    await this.transactions.run(initial.teacherId, async session => {
      const order = await this.orders.findById(initial._id).session(session);
      if (!order?.paidAt) throw new Error('Disputed booking payment is not fulfilled.');
      const records = order.earningsDisputes ?? [];
      const previous = records.find(item => item.id === remote.id);
      const safe = ['won', 'warning_closed', 'prevented'];
      // Concurrent workers may have fetched an older open state before a terminal result.
      if (previous && ['lost', ...safe].includes(previous.status) && !['lost', ...safe].includes(remote.status)) return;
      const record = { id: remote.id, status: remote.status, amountMinor: remote.amountMinor, blocking: !safe.includes(remote.status), checkedAt: new Date() };
      order.earningsDisputes = [...records.filter(item => item.id !== remote.id), record];
      await order.save({ session });
    });
  }

  async disputedCount(currency: PaymentCurrency): Promise<number> {
    return this.orders.countDocuments({ 'invoiceSource.currency': currency, earningsDisputes: { $elemMatch: { blocking: true } } });
  }

  async disputed(teacherId: string, currency: PaymentCurrency, session?: ClientSession): Promise<boolean> {
    return Boolean(await this.orders.exists({ teacherId, 'invoiceSource.currency': currency, earningsDisputes: { $elemMatch: { blocking: true } } }).session(session ?? null));
  }

  async pendingRefund(teacherId: string, currency: PaymentCurrency, session?: ClientSession): Promise<boolean> {
    return Boolean(await this.orders.exists({ teacherId, 'earningsPolicy.version': 1, 'invoiceSource.currency': currency, paidAt: { $exists: true }, $or: [{ refundPendingMinor: { $gt: 0 } }, { refundReviewRequired: true }] }).session(session ?? null));
  }

  async releaseDue(limit = 50): Promise<number> {
    const due = await this.orders.find({ 'earningsPolicy.version': 1, earningsCreditedAt: { $exists: true }, earningsReleasedAt: { $exists: false }, earningsEligible: true, cancelledAt: { $exists: false }, refundReviewRequired: { $ne: true }, earningsDisputes: { $not: { $elemMatch: { blocking: true } } }, refundPendingMinor: 0, earningsNextCheckAt: { $lte: new Date() } }).sort({ earningsNextCheckAt: 1 }).limit(limit).select('_id teacherId').lean();
    let released = 0;
    for (const candidate of due) {
      try {
        const didRelease = await this.transactions.run(candidate.teacherId, async session => {
          const order = await this.orders.findById(candidate._id).session(session);
          if (!order || !order.earningsEligible || order.cancelledAt || order.earningsDisputes?.some(item => item.blocking) || order.refundReviewRequired || order.earningsReleasedAt || !order.earningsAvailableAt || order.earningsAvailableAt > new Date() || order.refundPendingMinor > 0) return false;
          await this.capture(order, session);
          if (order.earningsAvailableAt! > new Date()) { await order.save({ session }); return false; }
          const completed = order.kind === 'lesson'
            ? Boolean(order.sessionId && await this.classes.exists({ _id: order.sessionId, status: 'completed' }).session(session))
            : Boolean(await this.classes.exists({ batchId: order.batchId, status: 'completed' }).session(session)) && !await this.classes.exists({ batchId: order.batchId, status: { $nin: ['completed', 'cancelled'] } }).session(session);
          if (!completed) { order.earningsNextCheckAt = new Date(Date.now() + 5 * 60000); await order.save({ session }); return false; }
          const existingRelease = await this.entries.findOne({ key: `booking:${order.id}:released` }).session(session).lean();
          if (existingRelease) {
            if (existingRelease.currency !== order.invoiceSource.currency) throw new Error('Release journal currency differs from the booking.');
            order.earningsReleasedAt = existingRelease.occurredAt;
            order.earningsReleasedMinor = existingRelease.lines.filter(line => line.account === 'teacher_available' && line.teacherId === order.teacherId).reduce((sum, line) => sum + line.creditMinor, 0);
            await order.save({ session }); return true;
          }
          const totals = await this.ledger.accountTotals({ bookingOrderId: order.id, teacherId: order.teacherId, session });
          const amount = totals.filter(row => row.account === 'teacher_pending').reduce((sum, row) => sum + row.balanceMinor, 0);
          if (amount < 0) throw new Error('Booking pending balance is negative.');
          const now = new Date();
          if (amount > 0) await this.ledger.post({ key: `booking:${order.id}:released`, type: 'earnings_released', currency: order.invoiceSource.currency, occurredAt: now, memo: 'Booking completed and holding period ended', bookingOrderId: order.id, teacherId: order.teacherId, lines: [
            { account: 'teacher_pending', teacherId: order.teacherId, debitMinor: amount, creditMinor: 0 },
            { account: 'teacher_available', teacherId: order.teacherId, debitMinor: 0, creditMinor: amount },
          ] }, session);
          order.earningsReleasedAt = now;
          order.earningsReleasedMinor = amount;
          await order.save({ session });
          return true;
        });
        if (didRelease) released++;
      } catch { this.logger.error(`Booking earnings release failed for ${candidate._id}; financial state retained for retry.`); }
    }
    return released;
  }

  async legacy(pageInput = 1): Promise<PageResult<BookingEarningsReview>> {
    const page = Math.max(1, Math.min(10000, Math.floor(Number(pageInput)) || 1)), limit = 25;
    const filter = { paidAt: { $exists: true }, 'invoiceSource.totalMinor': { $gt: 0 }, earningsPolicy: { $exists: false } };
    const [orders, total] = await Promise.all([this.orders.find(filter).sort({ paidAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(), this.orders.countDocuments(filter)]);
    return { page, limit, total, items: orders.map(order => ({ orderId: order._id, teacherName: order.teacherName, title: order.title, currency: order.invoiceSource.currency, netMinor: order.invoiceSource.netMinor, taxMinor: order.invoiceSource.taxMinor, totalMinor: order.invoiceSource.totalMinor, refundedMinor: order.refundedMinor, paidAt: order.paidAt!.toISOString(), updatedAt: order.updatedAt.toISOString() })) };
  }

  async adopt(id: string, input: AdoptBookingEarningsInput, actor: AuthenticatedUser): Promise<void> {
    if (!actor.roles.includes('SUPER_ADMIN')) throw new ForbiddenException('Only super administrators can review historical earnings.');
    if (!Number.isInteger(input.commissionBps) || input.commissionBps < 0 || input.commissionBps > 10000 || !Number.isInteger(input.holdDays) || input.holdDays < 0 || input.holdDays > 90 || input.reason.trim().length < 10) throw new BadRequestException('Review the commission, holding period and reason.');
    const initial = await this.orders.findById(id).lean();
    if (!initial) throw new NotFoundException('Booking not found.');
    const remote = !initial.earningsPolicy && initial.stripeSessionId ? await this.bookingGateway.retrieveCheckout(initial.stripeSessionId) : undefined;
    if (!initial.earningsPolicy && (!remote?.paid || remote.orderId !== initial._id || remote.studentId !== initial.studentId || remote.paymentIntentId !== initial.paymentIntentId || remote.amountMinor !== initial.invoiceSource.totalMinor || remote.currency.toUpperCase() !== initial.invoiceSource.currency || remote.livemode !== this.bookingGateway.live)) throw new ConflictException('The original provider payment must be verified before historical earnings can be adopted.');
    const disputes = !initial.earningsPolicy && initial.paymentIntentId ? await this.bookingGateway.disputesFor(initial.paymentIntentId) : [];
    if (disputes.some(item => item.paymentIntentId !== initial.paymentIntentId || item.currency !== initial.invoiceSource.currency || item.livemode !== remote!.livemode || !Number.isSafeInteger(item.amountMinor) || item.amountMinor < 1)) throw new ConflictException('Historical dispute facts do not match the provider payment.');
    const adopted = await this.transactions.run(initial.teacherId, async session => {
      const order = await this.orders.findById(id).session(session);
      if (!order?.paidAt || !order.paymentIntentId || order.invoiceSource.totalMinor <= 0) throw new ConflictException('Only a verified paid booking can be reviewed.');
      if (order.earningsPolicy) {
        if (order.earningsPolicy.source !== 'legacy_review' || order.earningsPolicy.commissionBps !== input.commissionBps || order.earningsPolicy.holdDays !== input.holdDays || order.earningsPolicy.reason !== input.reason.trim()) throw new ConflictException('This booking already has an earnings policy.');
        return false;
      }
      if (order.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new ConflictException('The booking changed. Reload its financial details before reviewing.');
      order.earningsEligible = Boolean(await this.enrollments.exists({ paymentOrderId: order.id }).session(session));
      order.paymentLivemode = remote!.livemode;
      order.earningsDisputes = [...(order.earningsDisputes ?? []).filter(item => !disputes.some(remote => remote.id === item.id)), ...disputes.map(item => ({ id: item.id, status: item.status, amountMinor: item.amountMinor, blocking: !['won', 'warning_closed', 'prevented'].includes(item.status), checkedAt: new Date() }))];
      order.earningsPolicy = { version: 1, settingsVersion: (await this.settings.get()).version, commissionBps: input.commissionBps, ...splitCommission(order.invoiceSource.netMinor, input.commissionBps), holdDays: input.holdDays, source: 'legacy_review', reviewedBy: actor.sub, reviewedAt: new Date().toISOString(), reason: input.reason.trim() };
      await this.restore(order, session);
      if (remote?.fee) { await this.fee(order, remote.fee, session); await order.save({ session }); }
      return true;
    });
    if (adopted) await this.audit.record({ actor, action: 'booking.earnings_policy_reviewed', resourceType: 'booking', resourceId: id, targetUserId: initial.teacherId, metadata: { commissionBps: input.commissionBps, holdDays: input.holdDays, reason: input.reason.trim(), currency: initial.invoiceSource.currency, netMinor: initial.invoiceSource.netMinor } });
  }

  private async restore(order: BookingOrderMongo, session: ClientSession): Promise<void> {
    await this.capture(order, session);
    const refunds = await this.refunds.find({ orderId: order.id, status: 'succeeded' }).sort({ createdAt: 1, _id: 1 }).session(session);
    for (const refund of refunds) await this.refund(order, refund, session);
    order.refundReviewRequired = order.refundedMinor < order.invoiceSource.totalMinor && needsBookingRefundReview(await this.refunds.find({ orderId: order.id }).session(session).lean());
    if (order.earningsReleasedAt && order.earningsReleasedMinor) await this.ledger.post({ key: `booking:${order.id}:released`, type: 'earnings_released', currency: order.invoiceSource.currency, occurredAt: order.earningsReleasedAt, memo: 'Booking completed and holding period ended', bookingOrderId: order.id, teacherId: order.teacherId, lines: [
      { account: 'teacher_pending', teacherId: order.teacherId, debitMinor: order.earningsReleasedMinor, creditMinor: 0 },
      { account: 'teacher_available', teacherId: order.teacherId, debitMinor: 0, creditMinor: order.earningsReleasedMinor },
    ] }, session);
    await order.save({ session });
  }

  async repairOrder(id: string, actor?: AuthenticatedUser): Promise<void> {
    const initial = await this.orders.findById(id).lean();
    if (!initial?.earningsPolicy || !initial.paidAt) return;
    await this.transactions.run(initial.teacherId, async session => {
      const order = await this.orders.findById(id).session(session);
      if (order?.earningsPolicy && order.paidAt) await this.restore(order, session);
    });
    await this.audit.record({ ...(actor ? { actor } : { actorId: 'finance-reconciliation' }), action: 'booking.earnings_repaired', resourceType: 'booking', resourceId: id, targetUserId: initial.teacherId });
  }

  async reconciliation(after?: string): Promise<BookingEarningsReconciliation> {
    if (after && (after.length > 64 || !/^[a-zA-Z0-9-]+$/.test(after))) throw new BadRequestException('Invalid booking reconciliation cursor.');
    const filter = { 'earningsPolicy.version': 1, paidAt: { $exists: true }, 'invoiceSource.totalMinor': { $gt: 0 } };
    const [candidates, totalOrders, legacyCount, feesAwaitingProvider, feesInOtherCurrency] = await Promise.all([this.orders.find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) }).sort({ _id: 1 }).limit(1001).lean(), this.orders.countDocuments(filter), this.orders.countDocuments({ paidAt: { $exists: true }, 'invoiceSource.totalMinor': { $gt: 0 }, earningsPolicy: { $exists: false } }), this.orders.countDocuments({ ...filter, gatewayFeeCurrency: { $exists: false } }), this.orders.countDocuments({ ...filter, gatewayFeeCurrency: { $type: 'string' }, $expr: { $ne: ['$gatewayFeeCurrency', '$invoiceSource.currency'] } })]);
    const orders = candidates.slice(0, 1000);
    const entries = await this.entries.find({ bookingOrderId: { $in: orders.map(order => order._id) } }).lean();
    const unfulfilledOrderIds: string[] = [];
    const missingCaptureOrderIds: string[] = [], missingRefundOrderIds: string[] = [], missingReleaseOrderIds: string[] = [], mismatchedOrderIds: string[] = [];
    for (const order of orders) {
      if (order.earningsEligible === false && order.refundedMinor < order.invoiceSource.totalMinor) unfulfilledOrderIds.push(order._id);
      const capture = entries.find(entry => entry.key === `booking:${order._id}:captured`);
      if (!capture) missingCaptureOrderIds.push(order._id);
      else if (capture.currency !== order.invoiceSource.currency || capture.lines.filter(line => line.account === 'teacher_pending').reduce((sum, line) => sum + line.creditMinor, 0) !== order.earningsPolicy!.teacherMinor || capture.lines.filter(line => line.account === 'platform_revenue').reduce((sum, line) => sum + line.creditMinor, 0) !== order.earningsPolicy!.commissionMinor || capture.lines.filter(line => line.account === 'tax_payable').reduce((sum, line) => sum + line.creditMinor, 0) !== order.invoiceSource.taxMinor || capture.lines.filter(line => line.account === 'gateway_clearing').reduce((sum, line) => sum + line.debitMinor, 0) !== order.invoiceSource.totalMinor) mismatchedOrderIds.push(order._id);
      if (order.earningsReleasedMinor && !entries.some(entry => entry.key === `booking:${order._id}:released`)) missingReleaseOrderIds.push(order._id);
      const refunded = entries.filter(entry => entry.bookingOrderId === order._id && entry.type === 'refund').flatMap(entry => entry.lines).filter(line => line.account === 'gateway_clearing').reduce((sum, line) => sum + line.creditMinor, 0);
      if (refunded !== order.refundedMinor) missingRefundOrderIds.push(order._id);
    }
    return { disputedOrderIds: orders.filter(order => order.earningsDisputes?.some(item => item.blocking)).map(order => order._id), legacyCount, feesAwaitingProvider, feesInOtherCurrency, unfulfilledOrderIds, missingCaptureOrderIds, missingRefundOrderIds, missingReleaseOrderIds, mismatchedOrderIds, checkedOrders: orders.length, totalOrders, hasMore: candidates.length > 1000, ...(candidates.length > 1000 ? { nextCursor: orders.at(-1)!._id } : {}) };
  }
}
