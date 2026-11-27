import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, PipelineStage } from 'mongoose';
import {
  assertBalancedLedgerLines,
  type LedgerAccount,
  type LedgerEntryRecord,
  type PageResult,
  type PaymentCurrency,
  type TeacherBalance,
} from '@native-sfu/contracts';
import { LedgerEntryDocument, type LedgerEntryMongo } from './payment.schemas';
import { naturalBalance, type LedgerEntryDraft } from './ledger-entries';

export interface AccountTotals {
  account: LedgerAccount;
  teacherId?: string;
  currency: PaymentCurrency;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(@InjectModel(LedgerEntryDocument.name) private readonly entries: Model<LedgerEntryMongo>) {}

  /**
   * Writes a balanced entry exactly once. Returns false when an entry with the
   * same key already exists (the business event was already recorded).
   */
  async post(draft: LedgerEntryDraft, session?: ClientSession): Promise<boolean> {
    assertBalancedLedgerLines(draft.lines);
    if (session) {
      const existing = await this.entries.findOne({ key: draft.key }).session(session).lean();
      if (existing) {
        const facts = (value: LedgerEntryDraft | LedgerEntryDocument) => JSON.stringify({
          type: value.type, currency: value.currency, paymentId: value.paymentId, bookingOrderId: value.bookingOrderId,
          refundId: value.refundId, payoutId: value.payoutId, teacherId: value.teacherId,
          lines: value.lines.map(line => ({ account: line.account, teacherId: line.teacherId, debitMinor: line.debitMinor, creditMinor: line.creditMinor })),
        });
        if (facts(existing) !== facts(draft)) throw new Error('Existing journal entry conflicts with the verified financial facts.');
        return false;
      }
      await this.entries.create([draft], { session });
      return true;
    }
    try {
      await this.entries.create({ ...draft });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      this.logger.error(`Ledger posting ${draft.key} failed.`);
      throw error;
    }
  }

  async exists(key: string, session?: ClientSession): Promise<boolean> {
    return Boolean(await this.entries.exists({ key }).session(session ?? null).exec());
  }

  toRecord(doc: LedgerEntryMongo | LedgerEntryDocument): LedgerEntryRecord {
    return {
      id: String(doc._id),
      key: doc.key,
      type: doc.type,
      currency: doc.currency,
      occurredAt: doc.occurredAt.toISOString(),
      memo: doc.memo,
      paymentId: doc.paymentId,
      bookingOrderId: doc.bookingOrderId,
      refundId: doc.refundId,
      disputeId: doc.disputeId,
      payoutId: doc.payoutId,
      teacherId: doc.teacherId,
      lines: doc.lines.map((line) => ({
        account: line.account,
        ...(line.teacherId ? { teacherId: line.teacherId } : {}),
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      })),
    };
  }

  async forPayment(paymentId: string): Promise<LedgerEntryRecord[]> {
    const docs = await this.entries.find({ paymentId }).sort({ occurredAt: 1, createdAt: 1 }).exec();
    return docs.map((doc) => this.toRecord(doc));
  }

  async list(query: { page?: number; type?: string; teacherId?: string; paymentId?: string; payoutId?: string; currency?: string }): Promise<PageResult<LedgerEntryRecord>> {
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(query.page) || 1)));
    const limit = 50;
    const filter: Record<string, unknown> = {};
    if (query.type) filter.type = query.type;
    if (query.teacherId) filter.teacherId = query.teacherId;
    if (query.paymentId) filter.paymentId = query.paymentId;
    if (query.payoutId) filter.payoutId = query.payoutId;
    if (query.currency) filter.currency = query.currency;
    const [docs, total] = await Promise.all([
      this.entries.find(filter).sort({ occurredAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.entries.countDocuments(filter).exec(),
    ]);
    return { items: docs.map((doc) => this.toRecord(doc)), total, page, limit };
  }

  /** Totals per account (and teacher), optionally restricted to a teacher, payment or period. */
  async accountTotals(match: { teacherId?: string; paymentId?: string; bookingOrderId?: string; currency?: PaymentCurrency; from?: Date; to?: Date; types?: string[]; session?: ClientSession } = {}): Promise<AccountTotals[]> {
    const entryMatch: Record<string, unknown> = {};
    if (match.paymentId) entryMatch.paymentId = match.paymentId;
    if (match.bookingOrderId) entryMatch.bookingOrderId = match.bookingOrderId;
    if (match.currency) entryMatch.currency = match.currency;
    if (match.types) entryMatch.type = { $in: match.types };
    if (match.from || match.to) entryMatch.occurredAt = { ...(match.from ? { $gte: match.from } : {}), ...(match.to ? { $lt: match.to } : {}) };
    if (match.teacherId) entryMatch['lines.teacherId'] = match.teacherId;
    const pipeline: PipelineStage[] = [
      { $match: entryMatch },
      { $unwind: '$lines' },
      ...(match.teacherId ? [{ $match: { 'lines.teacherId': match.teacherId } } as PipelineStage] : []),
      {
        $group: {
          _id: { account: '$lines.account', teacherId: '$lines.teacherId', currency: '$currency' },
          debitMinor: { $sum: '$lines.debitMinor' },
          creditMinor: { $sum: '$lines.creditMinor' },
        },
      },
    ];
    const rows = await this.entries.aggregate<{ _id: { account: LedgerAccount; teacherId?: string; currency: PaymentCurrency }; debitMinor: number; creditMinor: number }>(pipeline).session(match.session ?? null).exec();
    return rows.map((row) => ({
      account: row._id.account,
      teacherId: row._id.teacherId ?? undefined,
      currency: row._id.currency,
      debitMinor: row.debitMinor,
      creditMinor: row.creditMinor,
      balanceMinor: naturalBalance(row._id.account, row.debitMinor, row.creditMinor),
    }));
  }

  /** Balance of one teacher account attributable to a single payment. */
  async paymentTeacherBalance(paymentId: string, teacherId: string, account: LedgerAccount): Promise<number> {
    const totals = await this.accountTotals({ paymentId, teacherId });
    return totals.filter((row) => row.account === account && row.teacherId === teacherId).reduce((sum, row) => sum + row.balanceMinor, 0);
  }

  async teacherAccountBalance(teacherId: string, currency: PaymentCurrency, account: LedgerAccount, session?: ClientSession): Promise<number> {
    const totals = await this.accountTotals({ teacherId, currency, session });
    return totals.filter((row) => row.account === account).reduce((sum, row) => sum + row.balanceMinor, 0);
  }

  /** Current balances for a teacher in every currency they have activity in. */
  async teacherBalances(teacherId: string): Promise<TeacherBalance[]> {
    const [totals, flows] = await Promise.all([
      this.accountTotals({ teacherId }),
      this.entries
        .aggregate<{ _id: { currency: PaymentCurrency; type: string }; amount: number }>([
          { $match: { teacherId, type: { $in: ['payment_captured', 'refund', 'dispute_lost', 'payout_paid', 'payout_reversed'] } } },
          { $unwind: '$lines' },
          {
            $group: {
              _id: { currency: '$currency', type: '$type' },
              amount: {
                $sum: {
                  $switch: {
                    branches: [
                      { case: { $eq: ['$type', 'payment_captured'] }, then: { $subtract: ['$lines.debitMinor', { $cond: [{ $eq: ['$lines.account', 'tax_payable'] }, '$lines.creditMinor', 0] }] } },
                      { case: { $eq: ['$type', 'refund'] }, then: '$lines.creditMinor' },
                      { case: { $eq: ['$type', 'dispute_lost'] }, then: '$lines.creditMinor' },
                      { case: { $eq: ['$type', 'payout_paid'] }, then: '$lines.debitMinor' },
                      { case: { $eq: ['$type', 'payout_reversed'] }, then: '$lines.creditMinor' },
                    ],
                    default: 0,
                  },
                },
              },
              commission: {
                $sum: { $cond: [{ $and: [{ $eq: ['$type', 'payment_captured'] }, { $eq: ['$lines.account', 'platform_revenue'] }] }, '$lines.creditMinor', 0] },
              },
            },
          },
        ])
        .exec(),
    ]);
    const currencies = new Set<PaymentCurrency>([...totals.map((row) => row.currency), ...flows.map((row) => row._id.currency)]);
    return [...currencies].map((currency) => {
      const balance = (account: LedgerAccount) =>
        totals.filter((row) => row.currency === currency && row.account === account).reduce((sum, row) => sum + row.balanceMinor, 0);
      const flow = (type: string) => flows.find((row) => row._id.currency === currency && row._id.type === type)?.amount ?? 0;
      const commission = (flows.find((row) => row._id.currency === currency && row._id.type === 'payment_captured') as { commission?: number } | undefined)?.commission ?? 0;
      return {
        currency,
        pendingMinor: balance('teacher_pending'),
        availableMinor: balance('teacher_available'),
        reservedMinor: balance('teacher_reserved'),
        frozenMinor: balance('teacher_frozen'),
        paidOutMinor: flow('payout_paid') - flow('payout_reversed'),
        grossMinor: flow('payment_captured'),
        commissionMinor: commission,
        refundedMinor: flow('refund') + flow('dispute_lost'),
      };
    });
  }

  /** Verifies that every stored entry balances and that total debits equal total credits per currency. */
  async trialBalance(): Promise<{ balanced: boolean; unbalancedEntries: number; byCurrency: Array<{ currency: string; debitMinor: number; creditMinor: number }> }> {
    const [unbalanced, totals] = await Promise.all([
      this.entries
        .countDocuments({ $expr: { $ne: [{ $sum: '$lines.debitMinor' }, { $sum: '$lines.creditMinor' }] } })
        .exec(),
      this.entries
        .aggregate<{ _id: string; debitMinor: number; creditMinor: number }>([
          { $unwind: '$lines' },
          { $group: { _id: '$currency', debitMinor: { $sum: '$lines.debitMinor' }, creditMinor: { $sum: '$lines.creditMinor' } } },
        ])
        .exec(),
    ]);
    const byCurrency = totals.map((row) => ({ currency: row._id, debitMinor: row.debitMinor, creditMinor: row.creditMinor }));
    return { balanced: unbalanced === 0 && byCurrency.every((row) => row.debitMinor === row.creditMinor), unbalancedEntries: unbalanced, byCurrency };
  }

  /** Daily captured and refunded amounts for charts. */
  async daily(currency: PaymentCurrency, from: Date, to: Date): Promise<Array<{ date: string; grossMinor: number; commissionMinor: number; refundsMinor: number; payments: number }>> {
    const rows = await this.entries
      .aggregate<{ _id: string; grossMinor: number; commissionMinor: number; refundsMinor: number; payments: number }>([
        { $match: { currency, type: { $in: ['payment_captured', 'refund'] }, occurredAt: { $gte: from, $lt: to } } },
        { $unwind: '$lines' },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
            grossMinor: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'payment_captured'] }, { $eq: ['$lines.account', 'gateway_clearing'] }] }, '$lines.debitMinor', 0] } },
            commissionMinor: {
              $sum: {
                $cond: [
                  { $eq: ['$lines.account', 'platform_revenue'] },
                  { $subtract: ['$lines.creditMinor', '$lines.debitMinor'] },
                  0,
                ],
              },
            },
            refundsMinor: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'refund'] }, { $eq: ['$lines.account', 'gateway_clearing'] }] }, '$lines.creditMinor', 0] } },
            payments: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'payment_captured'] }, { $eq: ['$lines.account', 'gateway_clearing'] }] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();
    return rows.map((row) => ({ date: row._id, grossMinor: row.grossMinor, commissionMinor: row.commissionMinor, refundsMinor: row.refundsMinor, payments: row.payments }));
  }

  /** Keys of capture entries for the given payments, for reconciliation. */
  async capturedTeacherShares(paymentIds: string[]): Promise<Map<string, number>> {
    if (!paymentIds.length) return new Map();
    const rows = await this.entries
      .aggregate<{ _id: string; teacherMinor: number }>([
        { $match: { type: 'payment_captured', paymentId: { $in: paymentIds } } },
        { $unwind: '$lines' },
        { $group: { _id: '$paymentId', teacherMinor: { $sum: { $cond: [{ $eq: ['$lines.account', 'teacher_pending'] }, '$lines.creditMinor', 0] } } } },
      ])
      .exec();
    return new Map(rows.map((row) => [row._id, row.teacherMinor]));
  }
}
