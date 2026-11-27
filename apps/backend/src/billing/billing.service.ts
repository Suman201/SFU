import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { isCurrencyCode, type BillingDocumentLink, type BillingHistory, type BillingPurchase, type BillingRefundPage, type BillingSource, type CustomerBillingProfile, type CustomerBillingUpdate } from '@native-sfu/contracts';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { BookingOrderDocument, BookingCreditNoteDocument, BookingRefundDocument } from '../bookings/booking.schema';
import { PaymentDocument, RefundDocument } from '../payments/payment.schemas';
import { InvoiceDocument } from '../invoices/invoice.schema';
import { BookingBillingService } from '../bookings/booking-billing.service';
import { PaymentsService } from '../payments/payments.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PromotionOrderDocument, PromotionRefundDocument } from '../promotions/promotion.schema';
import { PromotionStripeGateway } from '../promotions/promotion-stripe.gateway';

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(BookingOrderDocument.name) private readonly bookings: Model<BookingOrderDocument>,
    @InjectModel(BookingRefundDocument.name) private readonly bookingRefunds: Model<BookingRefundDocument>,
    @InjectModel(BookingCreditNoteDocument.name) private readonly credits: Model<BookingCreditNoteDocument>,
    @InjectModel(InvoiceDocument.name) private readonly invoices: Model<InvoiceDocument>,
    @InjectModel(PaymentDocument.name) private readonly payments: Model<PaymentDocument>,
    @InjectModel(RefundDocument.name) private readonly paymentRefunds: Model<RefundDocument>,
    @InjectModel(PromotionOrderDocument.name) private readonly promotions: Model<PromotionOrderDocument>,
    @InjectModel(PromotionRefundDocument.name) private readonly promotionRefunds: Model<PromotionRefundDocument>,
    private readonly promotionGateway: PromotionStripeGateway,
    private readonly bookingBilling: BookingBillingService,
    private readonly paymentService: PaymentsService,
    private readonly audit: AuditLogsService,
  ) {}
  async profile(user: AuthenticatedUser): Promise<CustomerBillingProfile> {
    const account = await this.users.findById(user.sub).select('+billingProfile +billingProfileVersion').lean();
    if (!account) throw new NotFoundException('Account not found.');
    const saved = account.billingProfile;
    return { version: account.billingProfileVersion ?? 0, saved: Boolean(saved), name: saved?.name ?? account.displayName, email: account.email, address: saved?.address ?? '', countryCode: saved?.countryCode ?? '', vatNumber: saved?.vatNumber ?? '', locale: this.locale(account.settings?.locale), ...(account.timezone ? { timezone: account.timezone } : {}) };
  }
  async saveProfile(user: AuthenticatedUser, input: CustomerBillingUpdate): Promise<CustomerBillingProfile> {
    const updated = await this.users.updateOne({ _id: user.sub, disabled: false, status: 'active', deletedAt: { $exists: false }, $expr: { $eq: [{ $ifNull: ['$billingProfileVersion', 0] }, input.version] } }, { $set: { billingProfile: { name: input.name.trim(), address: input.address.trim(), countryCode: input.countryCode.toUpperCase(), vatNumber: input.vatNumber.trim() } }, $inc: { billingProfileVersion: 1 } });
    if (!updated.modifiedCount) throw new ConflictException('Your saved billing details changed. Reload them before saving.');
    await this.audit.record({ actor: user, action: 'billing.profile_saved', resourceType: 'user', resourceId: user.sub });
    return this.profile(user);
  }
  async clearProfile(user: AuthenticatedUser, version: number): Promise<CustomerBillingProfile> {
    const updated = await this.users.updateOne({ _id: user.sub, status: 'active', disabled: false, deletedAt: { $exists: false }, $expr: { $eq: [{ $ifNull: ['$billingProfileVersion', 0] }, version] } }, { $unset: { billingProfile: 1 }, $inc: { billingProfileVersion: 1 } });
    if (!updated.modifiedCount) throw new ConflictException('Your saved billing details changed. Reload them before clearing.');
    await this.audit.record({ actor: user, action: 'billing.profile_cleared', resourceType: 'user', resourceId: user.sub }); return this.profile(user);
  }
  async history(user: AuthenticatedUser, query: { page?: string; currency?: string; status?: string; source?: string; q?: string }): Promise<BillingHistory> {
    const page = this.page(query.page), limit = 25;
    if (query.currency && !isCurrencyCode(query.currency)) throw new BadRequestException('Choose a supported currency.');
    const groups: Record<string, string[]> = { paid: ['paid', 'partially_refunded'], open: ['awaiting_payment', 'processing'], refunds: ['refunded', 'partially_refunded', 'refund_pending'], unsuccessful: ['cancelled', 'expired', 'failed'], review: ['review'] };
    if (query.status && query.status !== 'all' && !groups[query.status]) throw new BadRequestException('Choose a valid billing filter.');
    const filter: Record<string, unknown> = {};
    if (query.source && !['booking', 'payment', 'promotion'].includes(query.source)) throw new BadRequestException('Choose a valid purchase type.');
    if (query.source) filter.source = query.source;
    if (query.currency) filter.currency = query.currency;
    if (query.status && query.status !== 'all') filter.status = { $in: groups[query.status] };
    const search = query.q?.trim().slice(0, 80);
    if (search) { const regex = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }; filter.$or = [{ title: regex }, { teacherName: regex }]; }
    const pipeline: PipelineStage[] = [
      { $match: { studentId: user.sub } },
      { $project: { _id: { $concat: ['booking:', '$_id'] }, recordId: '$_id', source: { $literal: 'booking' }, title: 1, teacherName: 1, createdAt: 1, paidAt: 1, currency: '$invoiceSource.currency', amountMinor: '$invoiceSource.totalMinor', refundedMinor: { $ifNull: ['$refundedMinor', 0] }, refundPendingMinor: { $ifNull: ['$refundPendingMinor', 0] }, invoiceId: 1,
        disputed: { $anyElementTrue: [{ $map: { input: { $ifNull: ['$earningsDisputes', []] }, as: 'dispute', in: '$$dispute.blocking' } }] },
        status: { $switch: { branches: [
          { case: { $eq: ['$status', 'payment_review'] }, then: 'review' },
          { case: { $gt: ['$refundPendingMinor', 0] }, then: 'refund_pending' },
          { case: { $and: [{ $gt: ['$invoiceSource.totalMinor', 0] }, { $gte: ['$refundedMinor', '$invoiceSource.totalMinor'] }] }, then: 'refunded' },
          { case: { $gt: ['$refundedMinor', 0] }, then: 'partially_refunded' },
          { case: { $ne: [{ $ifNull: ['$paidAt', null] }, null] }, then: 'paid' },
        ], default: '$status' } },
      } },
      { $unionWith: { coll: 'payments', pipeline: [
        { $match: { studentId: user.sub } },
        { $project: { _id: { $concat: ['payment:', '$_id'] }, recordId: '$_id', source: { $literal: 'payment' }, title: '$batchName', teacherName: 1, createdAt: 1, paidAt: 1, currency: 1, amountMinor: 1, refundedMinor: { $ifNull: ['$refundedMinor', 0] }, refundPendingMinor: { $ifNull: ['$refundPendingMinor', 0] }, receiptNumber: 1, disputed: { $in: ['$disputeState', ['open', 'lost']] }, status: { $switch: { branches: [
          { case: { $gt: ['$refundPendingMinor', 0] }, then: 'refund_pending' },
          { case: { $eq: ['$status', 'succeeded'] }, then: 'paid' },
          { case: { $eq: ['$status', 'pending'] }, then: 'awaiting_payment' },
        ], default: '$status' } } } },
      ] } },
      { $unionWith: { coll: 'promotion_orders', pipeline: [
        { $match: { teacherId: user.sub } },
        { $project: { _id: { $concat: ['promotion:', '$_id'] }, recordId: '$_id', source: { $literal: 'promotion' }, title: '$plan.name', teacherName: 1, createdAt: 1, paidAt: 1, currency: '$plan.currency', amountMinor: { $ifNull: ['$totalMinor', '$plan.amountMinor'] }, refundedMinor: { $ifNull: ['$refundedMinor', 0] }, refundPendingMinor: { $ifNull: ['$refundPendingMinor', 0] }, disputed: { $ifNull: ['$disputed', false] }, invoiceId: 1, invoiceNumber: 1, invoiceReady: 1,
          status: { $switch: { branches: [
            { case: { $eq: ['$status', 'review'] }, then: 'review' },
            { case: { $gt: ['$refundPendingMinor', 0] }, then: 'refund_pending' },
            { case: { $and: [{ $gt: ['$totalMinor', 0] }, { $gte: ['$refundedMinor', '$totalMinor'] }] }, then: 'refunded' },
            { case: { $gt: ['$refundedMinor', 0] }, then: 'partially_refunded' },
          ], default: '$status' } },
        } },
      ] } },
      { $facet: {
        items: [{ $match: filter }, { $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        count: [{ $match: filter }, { $count: 'total' }],
        summary: [{ $group: { _id: '$currency', paidMinor: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$paidAt', null] }, null] }, '$amountMinor', 0] } }, refundedMinor: { $sum: '$refundedMinor' }, refundPendingMinor: { $sum: '$refundPendingMinor' }, paidCount: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$paidAt', null] }, null] }, 1, 0] } }, openCount: { $sum: { $cond: [{ $in: ['$status', ['awaiting_payment', 'processing']] }, 1, 0] } }, disputedCount: { $sum: { $cond: ['$disputed', 1, 0] } } } }, { $sort: { _id: 1 } }],
      } },
    ];
    const [result] = await this.bookings.aggregate<{ items: Array<Omit<BillingPurchase, 'id' | 'createdAt' | 'paidAt' | 'document'> & { _id: string; createdAt: Date; paidAt?: Date; invoiceId?: string; invoiceNumber?: string; invoiceReady?: boolean; receiptNumber?: string }>; count: Array<{ total: number }>; summary: Array<{ _id: BillingPurchase['currency']; paidMinor: number; refundedMinor: number; refundPendingMinor: number; paidCount: number; openCount: number; disputedCount: number }> }>(pipeline).allowDiskUse(true);
    const items = result?.items ?? [];
    const invoices = await this.invoices.find({ _id: { $in: items.filter(item => item.source === 'booking' && item.invoiceId).map(item => item.invoiceId) }, status: 'paid' }).select('_id number').lean();
    const names = new Map(invoices.map(invoice => [invoice._id, invoice.number]));
    return { page, limit, total: result?.count[0]?.total ?? 0, summary: (result?.summary ?? []).filter(row => isCurrencyCode(row._id)).map(({ _id: currency, ...amounts }) => ({ currency, ...amounts })), items: items.map(row => {
      const number = row.source === 'booking' ? row.invoiceId && names.get(row.invoiceId) : row.source === 'promotion' ? row.paidAt && row.invoiceReady && row.invoiceId && (row.invoiceNumber || 'Promotion invoice') : row.receiptNumber;
      return { id: row._id, recordId: row.recordId, source: row.source, title: row.title, teacherName: row.teacherName, createdAt: new Date(row.createdAt).toISOString(), ...(row.paidAt ? { paidAt: new Date(row.paidAt).toISOString() } : {}), currency: row.currency, amountMinor: row.amountMinor, refundedMinor: row.refundedMinor, refundPendingMinor: row.refundPendingMinor, status: row.status, disputed: Boolean(row.disputed), ...(number ? { document: { kind: row.source === 'payment' ? 'receipt' as const : 'invoice' as const, number } } : {}) };
    }) };
  }
  async refunds(user: AuthenticatedUser, source: BillingSource, id: string, pageInput?: string): Promise<BillingRefundPage> {
    await this.owned(user, source, id);
    const page = this.page(pageInput), limit = 25;
    if (source === 'promotion') {
      const filter = { orderId: id };
      const [items, total] = await Promise.all([this.promotionRefunds.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.promotionRefunds.countDocuments(filter)]);
      return { page, limit, total, items: items.map(item => ({ id: item._id, amountMinor: item.amountMinor, currency: item.currency as BillingPurchase['currency'], status: item.status, reason: item.reason, createdAt: item.createdAt.toISOString(), ...(item.status === 'succeeded' && item.creditNoteId ? { creditNote: { id: item.creditNoteId, number: item.creditNumber || 'Credit note' } } : {}) })) };
    }
    if (source === 'booking') {
      const filter = { orderId: id };
      const [items, total] = await Promise.all([this.bookingRefunds.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.bookingRefunds.countDocuments(filter)]);
      const credits = await this.credits.find({ orderId: id, _id: { $in: items.map(item => item.creditNoteId).filter(Boolean) } }).select('_id value.number').lean();
      return { page, limit, total, items: items.map(item => ({ id: item._id, amountMinor: item.amountMinor, currency: item.currency as BillingPurchase['currency'], status: item.status, reason: item.reason, createdAt: item.createdAt.toISOString(), ...(item.creditNoteId && credits.find(credit => credit._id === item.creditNoteId) ? { creditNote: { id: item.creditNoteId, number: credits.find(credit => credit._id === item.creditNoteId)!.value.number ?? 'Credit note' } } : {}) })) };
    }
    const [items, total] = await Promise.all([this.paymentRefunds.find({ paymentId: id }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.paymentRefunds.countDocuments({ paymentId: id })]);
    return { page, limit, total, items: items.map(item => ({ id: String(item._id), amountMinor: item.amountMinor, currency: item.currency, status: item.status, reason: item.reason, createdAt: item.createdAt.toISOString(), ...(item.completedAt ? { completedAt: item.completedAt.toISOString() } : {}) })) };
  }
  async document(user: AuthenticatedUser, source: BillingSource, id: string, creditId?: string): Promise<{ bytes: Buffer; name: string }> {
    const record = await this.owned(user, source, id);
    if (source === 'promotion') throw new NotFoundException('Use the promotion document link.');
    if (source === 'payment') {
      if (creditId) throw new NotFoundException('Document not found.');
      return this.paymentService.receipt(id, user.sub);
    }
    const order = record as BookingOrderDocument;
    if (creditId) {
      const credit = await this.credits.findOne({ _id: creditId, orderId: id }).select('_id').lean();
      if (!credit) throw new NotFoundException('Document not found.');
      return { bytes: await this.bookingBilling.creditPdf(creditId), name: `credit-note-${creditId}.pdf` };
    }
    if (!order.invoiceId || !order.paidAt) throw new BadRequestException('The invoice is available after payment is verified.');
    if (!await this.invoices.exists({ _id: order.invoiceId, orderId: id, status: 'paid' })) throw new NotFoundException('Invoice not found.');
    return { bytes: await this.bookingBilling.pdf(order.invoiceId), name: `invoice-${id}.pdf` };
  }
  async promotionDocument(user: AuthenticatedUser, id: string, creditId?: string): Promise<BillingDocumentLink> {
    const order = await this.owned(user, 'promotion', id) as PromotionOrderDocument;
    if (!order.paidAt || !order.invoiceReady || !order.invoiceId) throw new NotFoundException('Invoice not ready.');
    if (creditId !== undefined && (!creditId || creditId.length > 100 || !await this.promotionRefunds.exists({ orderId: id, status: 'succeeded', creditNoteId: creditId }))) throw new NotFoundException('Credit note not found.');
    return { url: await this.promotionGateway.document(order.invoiceId, creditId, id) };
  }
  private async owned(user: AuthenticatedUser, source: BillingSource, id: string) {
    if (!['booking', 'payment', 'promotion'].includes(source) || !id || id.length > 100) throw new NotFoundException('Purchase not found.');
    const record = source === 'promotion' ? await this.promotions.findOne({ _id: id, teacherId: user.sub }).lean() : source === 'booking' ? await this.bookings.findOne({ _id: id, studentId: user.sub }).lean() : await this.payments.findOne({ _id: id, studentId: user.sub }).lean();
    if (!record) throw new NotFoundException('Purchase not found.'); return record;
  }
  private locale(value?: string): string {
    try { const locale = Intl.getCanonicalLocales(value?.replace('_', '-') || 'en-US')[0]; return locale && Intl.NumberFormat.supportedLocalesOf(locale).length ? locale : 'en-US'; }
    catch { return 'en-US'; }
  }
  private page(value?: string): number { const page = Number(value ?? 1); if (!Number.isInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Choose a valid billing page.'); return page; }
}
