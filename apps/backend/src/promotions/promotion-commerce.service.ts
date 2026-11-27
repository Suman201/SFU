import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, type ClientSession } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { isCurrencyCode, type PromotionOrder, type PromotionPlan } from '@native-sfu/contracts';
import { UserDocument, TeacherPromotionDocument } from '../database/schemas';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LedgerService } from '../payments/ledger.service';
import { PromotionOrderDocument, PromotionPlanDocument, PromotionRefundDocument, PromotionSlotDocument } from './promotion.schema';
import { PromotionStripeGateway } from './promotion-stripe.gateway';

@Injectable()
export class PromotionCommerceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>; private running?: Promise<void>; private readonly logger = new Logger(PromotionCommerceService.name);
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel(PromotionPlanDocument.name) private readonly plans: Model<PromotionPlanDocument>,
    @InjectModel(PromotionOrderDocument.name) private readonly orders: Model<PromotionOrderDocument>,
    @InjectModel(PromotionSlotDocument.name) private readonly slots: Model<PromotionSlotDocument>,
    @InjectModel(PromotionRefundDocument.name) private readonly refunds: Model<PromotionRefundDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserDocument>,
    @InjectModel(TeacherPromotionDocument.name) private readonly campaigns: Model<TeacherPromotionDocument>,
    private readonly gateway: PromotionStripeGateway, private readonly config: ConfigService, private readonly ledger: LedgerService, private readonly audit: AuditLogsService) {}
  onModuleInit(): void { this.timer = setInterval(() => { if (!this.running) { this.running = this.tick().catch(() => this.logger.error('Promotion reconciliation failed.')).finally(() => { this.running = undefined; }); } }, this.config.get<number>('promotions.pollMs', 60000)); this.timer.unref(); }
  async onModuleDestroy(): Promise<void> { clearInterval(this.timer); await this.running; }
  private eligible(user: UserDocument | null): boolean { return Boolean(user && user.roles.includes('TEACHER') && !user.disabled && !user.deletedAt && user.status === 'active' && user.publicProfileEnabled && user.tutorReviewStatus === 'approved'); }
  private dto(row: PromotionOrderDocument): PromotionOrder { return { id: row._id, teacherId: row.teacherId, plan: row.plan, status: row.status, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), paidAt: row.paidAt?.toISOString(), totalMinor: row.totalMinor, taxMinor: row.taxMinor, refundedMinor: row.refundedMinor, refundPendingMinor: row.refundPendingMinor, campaignId: row.campaignId, invoiceNumber: row.invoiceNumber, invoiceReady: row.invoiceReady, reviewReason: row.reviewReason }; }
  async listPlans(admin = false) { return { enabled: this.config.get<boolean>('promotions.enabled', false) && this.gateway.enabled, items: (await this.plans.find(admin ? {} : { 'value.enabled': true }).sort({ 'value.name': 1 }).lean()).map(row => row.value) }; }
  async savePlan(id: string, input: PromotionPlan, actor: AuthenticatedUser): Promise<PromotionPlan> {
    if (!actor.roles.includes('SUPER_ADMIN')) throw new ForbiddenException('Only a super administrator can configure paid promotion plans.');
    if (!this.config.get<string[]>('promotions.currencies', []).includes(input.currency) || input.amountMinor < ({ USD: 50, EUR: 50, GBP: 30, INR: 50, JPY: 50 }[input.currency] ?? Infinity)) throw new BadRequestException('Choose an enabled collection currency and an amount above its Stripe minimum.');
    if (input.automaticTax && !/^txcd_[0-9]{8}$/.test(input.taxCode ?? '')) throw new BadRequestException('Automatic tax requires a valid Stripe product tax code.');
    const value: PromotionPlan = { ...input, id, revision: input.revision + 1, name: input.name.trim() };
    if (!value.name) throw new BadRequestException('Enter a plan name.');
    if (input.revision === 0) { try { await this.plans.create({ _id: id, value }); } catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('This plan already exists. Reload before saving.'); throw error; } }
    else if (!await this.plans.findOneAndUpdate({ _id: id, 'value.revision': input.revision }, { $set: { value } })) throw new ConflictException('The plan changed. Reload before saving.');
    await this.audit.record({ actor, action: 'promotions.plan_saved', resourceType: 'promotion_plan', resourceId: id, metadata: { revision: value.revision, amountMinor: value.amountMinor, currency: value.currency, autoApprove: value.autoApprove, enabled: value.enabled } }); return value;
  }
  async create(user: AuthenticatedUser, input: { requestId: string; planId: string; revision: number; expectedAmountMinor: number; startsAt: string }): Promise<PromotionOrder> {
    const existing = await this.orders.findOne({ teacherId: user.sub, requestId: input.requestId });
    if (existing) { if (existing.plan.id !== input.planId || existing.plan.revision !== input.revision || existing.plan.amountMinor !== input.expectedAmountMinor || existing.startsAt.toISOString() !== new Date(input.startsAt).toISOString()) throw new ConflictException('This request id belongs to a different order.'); return this.dto(existing); }
    if (!this.config.get<boolean>('promotions.enabled', false) || !this.gateway.enabled) throw new ServiceUnavailableException('Online promotion purchases are not enabled.');
    const teacher = await this.users.findById(user.sub); if (!this.eligible(teacher)) throw new ForbiddenException('An active approved public teacher profile is required.');
    const plan = (await this.plans.findById(input.planId))?.value;
    if (!plan?.enabled || plan.revision !== input.revision || plan.amountMinor !== input.expectedAmountMinor) throw new ConflictException('The plan changed. Review the current price before purchasing.');
    const startsAt = new Date(input.startsAt), endsAt = new Date(startsAt.getTime() + plan.durationDays * 86400000);
    if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() < Date.now() + 3600000 || startsAt.getTime() > Date.now() + 180 * 86400000) throw new BadRequestException('Choose a start time between one hour and 180 days from now.');
    if (await this.overlap(user.sub, plan.placement, startsAt, endsAt)) throw new ConflictException('An overlapping campaign already exists.');
    const id = randomUUID(), session = await this.connection.startSession(); let row!: PromotionOrderDocument;
    try { await session.withTransaction(async () => { await this.slots.create([{ _id: user.sub + ':' + plan.placement, orderId: id }], { session }); const created = await this.orders.create([{ _id: id, teacherId: user.sub, teacherName: teacher!.displayName || teacher!.name || 'Teacher', email: user.email, requestId: input.requestId, plan, status: 'awaiting_payment', startsAt, endsAt, expiresAt: new Date(Math.ceil((Date.now() + 31 * 60000) / 1000) * 1000), nextCheckAt: new Date() }], { session }); row = created[0]!; }); }
    catch (error) { if ((error as { code?: number }).code === 11000) { const winner = await this.orders.findOne({ teacherId: user.sub, requestId: input.requestId }); if (winner) return this.create(user, input); throw new ConflictException('Another promotion order is open for this placement. Finish it or wait for it to expire.'); } throw error; } finally { await session.endSession(); }
    return this.dto(row);
  }
  async list(user?: AuthenticatedUser, page = 1) { const filter = user ? { teacherId: user.sub } : {}; const [rows, total] = await Promise.all([this.orders.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 25).limit(25).lean(), this.orders.countDocuments(filter)]); return { items: rows.map(row => this.dto(row)), total, page, limit: 25 }; }
  private async owned(id: string, user?: AuthenticatedUser) { const row = await this.orders.findOne({ _id: id, ...(user ? { teacherId: user.sub } : {}) }).select('+email +checkoutUrl'); if (!row) throw new NotFoundException('Promotion order not found.'); return row; }
  async checkout(id: string, user: AuthenticatedUser) {
    let row = await this.owned(id, user);
    if (row.status !== 'awaiting_payment' || row.expiresAt.getTime() <= Date.now() + 60000) throw new ConflictException('This checkout is no longer available. Refresh the order status.');
    if (row.checkoutUrl) return { url: this.gateway.safeUrl(row.checkoutUrl) };
    if (!this.config.get<boolean>('promotions.enabled', false)) throw new ServiceUnavailableException('New promotion purchases are disabled.');
    // Persist the attempt before contacting Stripe; every retry uses the identical saved quote and expiry.
    await this.orders.updateOne({ _id: id, status: 'awaiting_payment', checkoutAttemptedAt: { $exists: false } }, { $set: { checkoutAttemptedAt: new Date(), expiresAt: new Date(Math.ceil((Date.now() + 31 * 60000) / 1000) * 1000) } });
    row = await this.owned(id, user);
    const checkout = await this.gateway.checkout(row, row.email);
    if (!checkout.url) throw new ServiceUnavailableException('Checkout is not ready. Retry this order.');
    await this.orders.updateOne({ _id: id }, { $set: { checkoutSessionId: checkout.id, checkoutUrl: this.gateway.safeUrl(checkout.url), nextCheckAt: new Date() } });
    return { url: this.gateway.safeUrl(checkout.url) };
  }
  async reconcile(id: string, user?: AuthenticatedUser): Promise<PromotionOrder> { await this.owned(id, user); await this.sync(id); return this.dto(await this.owned(id, user)); }
  async document(id: string, user?: AuthenticatedUser, credit = false) { const row = await this.owned(id, user); if (!row.invoiceId || !row.paidAt) throw new NotFoundException('Invoice not ready.'); const refund = credit ? await this.refunds.findOne({ orderId: id, status: 'succeeded' }) : undefined; if (credit && !refund?.creditNoteId) throw new NotFoundException('Credit note not ready.'); return { url: await this.gateway.document(row.invoiceId, refund?.creditNoteId) }; }
  async requestRefund(id: string, input: { requestId: string; reason: string }, actor: AuthenticatedUser) {
    const row = await this.owned(id); if (!row.paidAt || !row.totalMinor || !row.paymentIntentId || row.disputed || row.refundedMinor) throw new ConflictException('This order requires financial review or has already been refunded.');
    const refundId = 'full-' + id, session = await this.connection.startSession();
    try { await session.withTransaction(async () => { const current = await this.orders.findById(id).session(session); if (!current?.paidAt || current.disputed || current.refundedMinor || current.totalMinor !== row.totalMinor) throw new ConflictException('The order changed. Reload its financial status.'); const existing = await this.refunds.findById(refundId).session(session); if (existing && ['failed','review'].includes(existing.status)) throw new ConflictException('The refund requires Stripe review before any retry.'); if (!existing) await this.refunds.create([{ _id: refundId, orderId: id, requestId: input.requestId, reason: input.reason.trim(), amountMinor: row.totalMinor, currency: row.plan.currency, status: 'queued', nextCheckAt: new Date() }], { session }); await this.orders.updateOne({ _id: id }, { $set: { status: 'refund_pending', refundPendingMinor: row.totalMinor, nextCheckAt: new Date() } }, { session }); await this.campaigns.updateOne({ checkoutOrderId: id, billingStatus: 'paid' }, { $set: { status: 'paused' }, $inc: { __v: 1 } }, { session }); }); } finally { await session.endSession(); }
    await this.audit.record({ actor, action: 'promotions.refund_requested', resourceType: 'promotion_order', resourceId: id }); return this.dto(await this.owned(id));
  }
  async webhook(body: Buffer, signature?: string) {
    const event = this.gateway.webhook(body, signature), object = event.data.object as unknown as { object: string; id: string; metadata?: Record<string, string> };
    // Only schedule work here. Reconciliation always fetches authoritative provider state.
    const intent = await this.gateway.eventIntent(event);
    const match = object.object === 'checkout.session' ? { checkoutSessionId: object.id } : intent ? { paymentIntentId: intent } : undefined;
    if (match) await this.orders.updateMany(match, { $set: { nextCheckAt: new Date() } }); return { received: true };
  }
  async tick(): Promise<void> { const rows = await this.orders.find({ nextCheckAt: { $lte: new Date() }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }] }).sort({ nextCheckAt: 1 }).limit(25).select('_id').lean(); for (const row of rows) { try { await this.sync(row._id); } catch { this.logger.warn('Promotion order requires a reconciliation retry.'); } } }
  private async overlap(teacherId: string, placement: string, startsAt: Date, endsAt: Date, session?: ClientSession) { return this.campaigns.exists({ teacherId, placement, deletedAt: { $exists: false }, status: { $in: ['requested', 'scheduled', 'active', 'paused'] }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt } }).session(session ?? null); }
  private async sync(id: string): Promise<void> {
    const lease = randomUUID(), row = await this.orders.findOneAndUpdate({ _id: id, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }] }, { $set: { leaseToken: lease, leaseUntil: new Date(Date.now() + 120000), nextCheckAt: new Date(Date.now() + 60000) } }, { new: true }).select('+email');
    if (!row) return;
    try {
      if (!row.checkoutSessionId) {
        if (row.checkoutAttemptedAt) {
          if (Date.now() - row.checkoutAttemptedAt.getTime() > 23 * 3600000) { await this.review(id, 'Checkout creation outcome is ambiguous. Inspect Stripe before releasing the placement.'); return; }
          // Recover a lost API response with the original idempotency key, even after purchases are disabled.
          const checkout = await this.gateway.checkout(row, row.email); await this.orders.updateOne({ _id: id }, { $set: { checkoutSessionId: checkout.id, ...(checkout.url ? { checkoutUrl: checkout.url } : {}) } }); return;
        }
        if (row.expiresAt.getTime() <= Date.now()) { await this.orders.updateOne({ _id: id }, { $set: { status: 'expired' }, $unset: { nextCheckAt: 1 } }); await this.slots.deleteOne({ orderId: id }); } return;
      }
      const checkout = await this.gateway.session(row.checkoutSessionId);
      if (checkout.livemode !== this.gateway.live || checkout.metadata?.purpose !== 'teacher_promotion' || checkout.metadata.orderId !== id || checkout.metadata.teacherId !== row.teacherId || checkout.metadata.planId !== row.plan.id || checkout.client_reference_id !== id) { await this.review(id, 'Provider payment identity mismatch.'); return; }
      if (checkout.payment_status !== 'paid') { if (checkout.status === 'expired' && !row.paidAt) { await this.orders.updateOne({ _id: id }, { $set: { status: 'expired' }, $unset: { nextCheckAt: 1 } }); await this.slots.deleteOne({ orderId: id }); } return; }
      const intent = checkout.payment_intent && typeof checkout.payment_intent !== 'string' ? checkout.payment_intent : undefined;
      const charge = intent?.latest_charge && typeof intent.latest_charge !== 'string' ? intent.latest_charge : undefined;
      const tax = checkout.total_details?.amount_tax ?? 0, total = checkout.amount_total ?? 0;
      if (!intent || intent.status !== 'succeeded' || intent.amount_received !== total || intent.currency.toUpperCase() !== row.plan.currency || intent.metadata.orderId !== id || intent.metadata.teacherId !== row.teacherId || intent.metadata.planId !== row.plan.id || intent.metadata.purpose !== 'teacher_promotion' || checkout.currency?.toUpperCase() !== row.plan.currency || checkout.amount_subtotal !== row.plan.amountMinor || total !== row.plan.amountMinor + tax || (checkout.total_details?.amount_discount ?? 0) || (checkout.total_details?.amount_shipping ?? 0) || (row.plan.automaticTax ? checkout.automatic_tax?.status !== 'complete' : tax !== 0)) { await this.review(id, 'Provider amount, currency, tax or payment mismatch.'); return; }
      const invoice = checkout.invoice && typeof checkout.invoice !== 'string' ? checkout.invoice : undefined;
      await this.orders.updateOne({ _id: id }, { $set: { paymentIntentId: intent.id, ...(invoice ? { invoiceId: invoice.id, invoiceNumber: invoice.number ?? undefined, invoiceReady: Boolean(invoice.hosted_invoice_url) } : {}) } });
      const session = await this.connection.startSession();
      try { await session.withTransaction(async () => {
        const current = await this.orders.findById(id).session(session); if (!current) throw new Error('Missing order');
        if (!current.paidAt) {
          const teacher = await this.users.findById(row.teacherId).session(session), overlapping = await this.overlap(row.teacherId, row.plan.placement, row.startsAt, row.endsAt, session);
          const slot = await this.slots.findOne({ _id: row.teacherId + ':' + row.plan.placement, orderId: id }).session(session);
          const reason = !this.eligible(teacher) ? 'Teacher is no longer eligible.' : !slot || overlapping ? 'Placement requires overlap review.' : row.startsAt.getTime() <= Date.now() ? 'Payment arrived after the campaign start.' : undefined;
          await this.ledger.post({ key: 'promotion:' + id + ':capture', type: 'promotion_capture', promotionOrderId: id, currency: row.plan.currency, occurredAt: new Date(), memo: 'Profile promotion payment', lines: [{ account: 'gateway_clearing', debitMinor: total, creditMinor: 0 }, { account: 'platform_revenue', debitMinor: 0, creditMinor: row.plan.amountMinor }, ...(tax ? [{ account: 'tax_payable' as const, debitMinor: 0, creditMinor: tax }] : [])] }, session);
          const campaignId = randomUUID();
          if (!reason) await this.campaigns.create([{ promotionId: campaignId, checkoutOrderId: id, teacherId: row.teacherId, teacherName: row.teacherName, placement: row.plan.placement, status: row.plan.autoApprove ? 'scheduled' : 'requested', ...(row.plan.autoApprove ? { approvedByUserId: 'system:promotion-plan:' + row.plan.id + ':' + row.plan.revision } : {}), startsAt: row.startsAt, endsAt: row.endsAt, requestedByUserId: row.teacherId, billingStatus: 'paid', feeCents: row.plan.amountMinor, currency: row.plan.currency, paymentConfirmedAt: new Date(), paymentReference: intent.id }], { session });
          await this.orders.updateOne({ _id: id }, { $set: { status: reason ? 'review' : 'paid', paidAt: new Date(), totalMinor: total, taxMinor: tax, ...(reason ? { reviewReason: reason } : { campaignId }) } }, { session });
        }
        const transaction = charge?.balance_transaction && typeof charge.balance_transaction !== 'string' ? charge.balance_transaction : undefined;
        if (transaction?.fee && isCurrencyCode(transaction.currency.toUpperCase())) await this.ledger.post({ key: 'promotion:' + id + ':fee', type: 'promotion_gateway_fee', promotionOrderId: id, currency: transaction.currency.toUpperCase() as import('@native-sfu/contracts').PaymentCurrency, occurredAt: new Date(transaction.created * 1000), memo: 'Promotion processing fee in Stripe settlement currency', lines: [{ account: 'gateway_fees', debitMinor: transaction.fee, creditMinor: 0 }, { account: 'gateway_clearing', debitMinor: 0, creditMinor: transaction.fee }] }, session);
      }); } finally { await session.endSession(); }
      if (charge?.disputed) { await this.orders.updateOne({ _id: id }, { $set: { disputed: true } }); await this.review(id, 'Disputed payment. Finance must reconcile the Stripe dispute and settlement.'); return; }
      const observed = await this.gateway.refunds(intent.id);
      if (observed.has_more) { await this.review(id, 'Refund history requires financial review.'); return; }
      const succeeded = observed.data.filter(item => item.status === 'succeeded'), pending = observed.data.filter(item => ['pending', 'requires_action'].includes(item.status ?? ''));
      if (succeeded.some(item => item.currency.toUpperCase() !== row.plan.currency) || succeeded.reduce((sum, item) => sum + item.amount, 0) > total) { await this.review(id, 'Refund currency or amount mismatch.'); return; }
      let refund = succeeded.length === 1 && succeeded[0]!.amount === total ? succeeded[0] : undefined;
      let job = await this.refunds.findById('full-' + id);
      if (!refund && (succeeded.length || (pending.length && !job))) { await this.review(id, 'External partial or pending refund requires financial review.'); return; }
      if (!refund && job && ['queued', 'pending'].includes(job.status)) {
        if (job.providerRefundId) refund = await this.gateway.getRefund(job.providerRefundId);
        else {
          const prior = observed.data.find(item => item.metadata?.requestId === job!._id); if (prior) refund = prior;
          else if (job.firstAttemptAt && Date.now() - job.firstAttemptAt.getTime() > 23 * 3600000) { await this.review(id, 'Refund creation is ambiguous. Inspect Stripe before retrying.'); return; }
          else { if (!job.firstAttemptAt) { job.firstAttemptAt = new Date(); await job.save(); } refund = await this.gateway.refund(intent.id, total, job._id); }
        }
        job.providerRefundId = refund.id; job.status = refund.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(refund.status ?? '') ? 'failed' : 'pending'; await job.save();
        if (job.status === 'failed') { await this.review(id, 'Stripe could not complete the refund. Finance must review it.'); return; }
      }
      if (refund?.status === 'succeeded') {
        if (refund.amount !== total || refund.currency.toUpperCase() !== row.plan.currency || (typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id) !== intent.id) { await this.review(id, 'Refund does not match the full verified payment.'); return; }
        const tx = await this.connection.startSession();
        try { await tx.withTransaction(async () => { await this.ledger.post({ key: 'promotion:' + id + ':refund', type: 'promotion_refund', promotionOrderId: id, currency: row.plan.currency, refundId: refund!.id, occurredAt: new Date(refund!.created * 1000), memo: 'Full promotion refund', lines: [{ account: 'platform_revenue', debitMinor: row.plan.amountMinor, creditMinor: 0 }, ...(tax ? [{ account: 'tax_payable' as const, debitMinor: tax, creditMinor: 0 }] : []), { account: 'gateway_clearing', debitMinor: 0, creditMinor: total }] }, tx); await this.orders.updateOne({ _id: id }, { $set: { status: 'refunded', refundedMinor: total, refundPendingMinor: 0 } }, { session: tx }); await this.campaigns.updateOne({ checkoutOrderId: id }, { $set: { status: 'cancelled', billingStatus: 'refunded' }, $inc: { __v: 1 } }, { session: tx }); await this.slots.deleteOne({ orderId: id }, { session: tx }); await this.refunds.updateOne({ _id: 'full-' + id }, { $set: { orderId: id, requestId: 'external-' + refund!.id, reason: job?.reason ?? 'Verified Stripe refund', amountMinor: total, currency: row.plan.currency, status: 'succeeded', providerRefundId: refund!.id } }, { upsert: true, session: tx }); }); } finally { await tx.endSession(); }
        job = await this.refunds.findById('full-' + id);
        if (invoice && job && !job.creditNoteId) { const credit = await this.gateway.credit(invoice.id, refund); if (credit.total !== total || credit.currency.toUpperCase() !== row.plan.currency) throw new Error('Credit note mismatch'); await this.refunds.updateOne({ _id: job._id }, { $set: { creditNoteId: credit.id, creditNumber: credit.number } }); }
        if (invoice) await this.orders.updateOne({ _id: id }, { $unset: { nextCheckAt: 1 } });
      } else if (row.endsAt.getTime() < Date.now() && !pending.length && !job && row.status === 'paid') { await this.slots.deleteOne({ orderId: id }); await this.orders.updateOne({ _id: id }, { $unset: { nextCheckAt: 1 } }); }
    } finally { await this.orders.updateOne({ _id: id, leaseToken: lease }, { $unset: { leaseToken: 1, leaseUntil: 1 } }); }
  }
  private async review(id: string, reason: string) { await this.orders.updateOne({ _id: id }, { $set: { status: 'review', reviewReason: reason }, $unset: { nextCheckAt: 1 } }); await this.campaigns.updateOne({ checkoutOrderId: id, status: { $in: ['active', 'scheduled'] } }, { $set: { status: 'paused' }, $inc: { __v: 1 } }); }
}
