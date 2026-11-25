import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  fromMinorUnits,
  isPaymentCurrency,
  type FinanceOverview,
  type PaymentCurrency,
  type PaymentListQuery,
  type ReconciliationReport,
  type TeacherFinanceRow,
} from '@native-sfu/contracts';
import { FinanceSettingsService } from './finance-settings.service';
import { LedgerService } from './ledger.service';
import { DisputeDocument, PaymentDocument, PayoutDocument, type DisputeMongo, type PaymentMongo, type PayoutMongo } from './payment.schemas';
import { PaymentEventsService } from './payment-events.service';
import { PaymentsService } from './payments.service';

function parseDay(value: string | undefined, fallback: Date): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  // Prevent spreadsheet formula injection from user-controlled names.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

@Injectable()
export class FinanceReportsService {
  constructor(
    @InjectModel(PaymentDocument.name) private readonly payments: Model<PaymentMongo>,
    @InjectModel(DisputeDocument.name) private readonly disputes: Model<DisputeMongo>,
    @InjectModel(PayoutDocument.name) private readonly payouts: Model<PayoutMongo>,
    private readonly ledger: LedgerService,
    private readonly settings: FinanceSettingsService,
    private readonly events: PaymentEventsService,
    private readonly paymentsService: PaymentsService,
  ) {}

  private async range(query: { from?: string; to?: string; currency?: string }): Promise<{ from: Date; to: Date; currency: PaymentCurrency }> {
    const settings = await this.settings.get();
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const to = new Date(parseDay(query.to, today).getTime() + 86_400_000);
    const from = parseDay(query.from, new Date(to.getTime() - 30 * 86_400_000));
    if (from >= to || to.getTime() - from.getTime() > 400 * 86_400_000) {
      return { from: new Date(to.getTime() - 30 * 86_400_000), to, currency: isPaymentCurrency(query.currency) ? query.currency : settings.defaultCurrency };
    }
    return { from, to, currency: isPaymentCurrency(query.currency) ? query.currency : settings.defaultCurrency };
  }

  async overview(query: { from?: string; to?: string; currency?: string }): Promise<FinanceOverview> {
    const { from, to, currency } = await this.range(query);
    const [periodTotals, currentTotals, trial, daily, failedPayments, openDisputes, pendingPayoutRequests, failedGatewayEvents, entryTypeTotals] = await Promise.all([
      this.ledger.accountTotals({ currency, from, to }),
      this.ledger.accountTotals({ currency }),
      this.ledger.trialBalance(),
      this.ledger.daily(currency, from, to),
      this.payments.countDocuments({ currency, status: 'failed', createdAt: { $gte: from, $lt: to } }).exec(),
      this.disputes.countDocuments({ status: { $in: ['needs_response', 'under_review'] } }).exec(),
      this.payouts.countDocuments({ status: { $in: ['requested', 'processing'] } }).exec(),
      this.events.countFailed(),
      this.entryTotals(currency, from, to),
    ]);
    const sum = (rows: typeof periodTotals, account: string, field: 'debitMinor' | 'creditMinor' | 'balanceMinor') =>
      rows.filter((row) => row.account === account).reduce((total, row) => total + row[field], 0);
    const commissionMinor = entryTypeTotals.commission;
    const refundedCommissionMinor = entryTypeTotals.refundedCommission;
    const gatewayFeesMinor = sum(periodTotals, 'gateway_fees', 'balanceMinor');
    return {
      currency,
      from: from.toISOString().slice(0, 10),
      to: new Date(to.getTime() - 86_400_000).toISOString().slice(0, 10),
      grossMinor: entryTypeTotals.gross,
      refundedMinor: entryTypeTotals.refunded,
      commissionMinor,
      refundedCommissionMinor,
      gatewayFeesMinor,
      platformNetMinor: sum(periodTotals, 'platform_revenue', 'balanceMinor') - gatewayFeesMinor,
      teacherEarningsMinor: entryTypeTotals.teacher,
      successfulPayments: entryTypeTotals.payments,
      failedPayments,
      teacherPendingMinor: sum(currentTotals, 'teacher_pending', 'balanceMinor'),
      teacherAvailableMinor: sum(currentTotals, 'teacher_available', 'balanceMinor'),
      teacherReservedMinor: sum(currentTotals, 'teacher_reserved', 'balanceMinor'),
      teacherFrozenMinor: sum(currentTotals, 'teacher_frozen', 'balanceMinor'),
      paidOutMinor: entryTypeTotals.paidOutAllTime,
      openDisputes,
      pendingPayoutRequests,
      failedGatewayEvents,
      ledgerBalanced: trial.balanced,
      daily,
    };
  }

  private async entryTotals(currency: PaymentCurrency, from: Date, to: Date) {
    const [period, payouts] = await Promise.all([
      this.ledger.accountTotals({ currency, from, to, types: ['payment_captured'] }),
      this.ledger.accountTotals({ currency, types: ['payout_paid', 'payout_reversed'] }),
    ]);
    const refunds = await this.ledger.accountTotals({ currency, from, to, types: ['refund', 'dispute_lost'] });
    const pick = (rows: typeof period, account: string, field: 'debitMinor' | 'creditMinor') =>
      rows.filter((row) => row.account === account).reduce((total, row) => total + row[field], 0);
    const capturedCount = await this.payments.countDocuments({ currency, paidAt: { $gte: from, $lt: to }, amountMinor: { $gt: 0 } }).exec();
    return {
      gross: pick(period, 'gateway_clearing', 'debitMinor'),
      commission: pick(period, 'platform_revenue', 'creditMinor'),
      teacher: pick(period, 'teacher_pending', 'creditMinor'),
      refunded: pick(refunds, 'gateway_clearing', 'creditMinor') + pick(refunds, 'dispute_hold', 'creditMinor'),
      refundedCommission: pick(refunds, 'platform_revenue', 'debitMinor'),
      paidOutAllTime: pick(payouts, 'teacher_reserved', 'debitMinor') - pick(payouts, 'teacher_available', 'creditMinor'),
      payments: capturedCount,
    };
  }

  async teachers(query: { currency?: string; q?: string }): Promise<TeacherFinanceRow[]> {
    const settings = await this.settings.get();
    const currency = isPaymentCurrency(query.currency) ? query.currency : settings.defaultCurrency;
    const [totals, grossRows, names] = await Promise.all([
      this.ledger.accountTotals({ currency }),
      this.payments
        .aggregate<{ _id: string; grossMinor: number; commissionMinor: number; refundedMinor: number; teacherName: string }>([
          { $match: { currency, status: { $in: ['succeeded', 'partially_refunded', 'refunded'] } } },
          {
            $group: {
              _id: '$teacherId',
              grossMinor: { $sum: '$amountMinor' },
              commissionMinor: { $sum: { $subtract: ['$commissionMinor', '$refundedCommissionMinor'] } },
              refundedMinor: { $sum: '$refundedMinor' },
              teacherName: { $last: '$teacherName' },
            },
          },
        ])
        .exec(),
      this.payouts.aggregate<{ _id: string; teacherName: string; paidOutMinor: number }>([
        { $match: { currency } },
        { $group: { _id: '$teacherId', teacherName: { $last: '$teacherName' }, paidOutMinor: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amountMinor', 0] } } } },
      ]).exec(),
    ]);
    const teacherIds = new Set<string>([...grossRows.map((row) => row._id), ...names.map((row) => row._id), ...totals.map((row) => row.teacherId).filter((id): id is string => Boolean(id))]);
    const balance = (teacherId: string, account: string) =>
      totals.filter((row) => row.teacherId === teacherId && row.account === account).reduce((sum, row) => sum + row.balanceMinor, 0);
    const rows = [...teacherIds].map((teacherId): TeacherFinanceRow => {
      const gross = grossRows.find((row) => row._id === teacherId);
      const payout = names.find((row) => row._id === teacherId);
      return {
        teacherId,
        teacherName: gross?.teacherName ?? payout?.teacherName ?? teacherId,
        currency,
        grossMinor: gross?.grossMinor ?? 0,
        commissionMinor: gross?.commissionMinor ?? 0,
        refundedMinor: gross?.refundedMinor ?? 0,
        pendingMinor: balance(teacherId, 'teacher_pending'),
        availableMinor: balance(teacherId, 'teacher_available'),
        reservedMinor: balance(teacherId, 'teacher_reserved'),
        frozenMinor: balance(teacherId, 'teacher_frozen'),
        paidOutMinor: payout?.paidOutMinor ?? 0,
      };
    });
    const q = query.q?.trim().toLowerCase();
    return rows
      .filter((row) => !q || row.teacherName.toLowerCase().includes(q) || row.teacherId.toLowerCase().includes(q))
      .sort((left, right) => right.grossMinor - left.grossMinor);
  }

  async reconciliation(): Promise<ReconciliationReport> {
    const paid = await this.payments
      .find({ status: { $in: ['succeeded', 'partially_refunded', 'refunded'] }, amountMinor: { $gt: 0 } })
      .select('_id teacherMinor enrollmentState status paidAt')
      .sort({ paidAt: -1 })
      .limit(5_000)
      .exec();
    const [shares, trial, failedEvents, stalePendingPayments] = await Promise.all([
      this.ledger.capturedTeacherShares(paid.map((payment) => payment.id)),
      this.ledger.trialBalance(),
      this.events.failedEvents(),
      this.payments.countDocuments({ status: 'pending', expiresAt: { $lt: new Date(Date.now() - 60 * 60_000) } }).exec(),
    ]);
    const cutoff = Date.now() - 5 * 60_000;
    return {
      checkedAt: new Date().toISOString(),
      ledgerBalanced: trial.balanced,
      unbalancedEntries: trial.unbalancedEntries,
      paymentsMissingLedger: paid.filter((payment) => !shares.has(payment.id)).map((payment) => payment.id),
      paymentsWithMismatchedSplit: paid.filter((payment) => shares.has(payment.id) && shares.get(payment.id) !== payment.teacherMinor).map((payment) => payment.id),
      paymentsAwaitingEnrollment: paid
        .filter((payment) => payment.status === 'succeeded' && payment.enrollmentState === 'pending' && (payment.paidAt?.getTime() ?? 0) < cutoff)
        .map((payment) => payment.id),
      failedEvents,
      stalePendingPayments,
    };
  }

  /** Re-runs the idempotent settlement steps for payments flagged by reconciliation. */
  async repair(): Promise<ReconciliationReport> {
    const report = await this.reconciliation();
    for (const id of [...new Set([...report.paymentsMissingLedger, ...report.paymentsAwaitingEnrollment])]) {
      await this.paymentsService.ensureSettled(id).catch(() => undefined);
    }
    await this.paymentsService.sweep();
    return this.reconciliation();
  }

  async paymentsCsv(query: PaymentListQuery): Promise<string> {
    const rows = await this.paymentsService.adminExportRows(query);
    const header = [
      'Created (UTC)',
      'Paid (UTC)',
      'Receipt',
      'Status',
      'Student',
      'Student email',
      'Teacher',
      'Class',
      'Currency',
      'Amount',
      'Commission %',
      'Commission',
      'Teacher share',
      'Gateway fee',
      'Refunded',
      'Dispute',
      'Gateway payment',
      'Payment ID',
    ];
    const lines = rows.map((row) =>
      [
        row.createdAt,
        row.paidAt ?? '',
        row.receiptNumber ?? '',
        row.status,
        row.studentName,
        row.studentEmail,
        row.teacherName,
        row.batchName,
        row.currency,
        fromMinorUnits(row.amountMinor, row.currency).toFixed(2),
        (row.commissionBps / 100).toFixed(2),
        fromMinorUnits(row.commissionMinor, row.currency).toFixed(2),
        fromMinorUnits(row.teacherMinor, row.currency).toFixed(2),
        fromMinorUnits(row.gatewayFeeMinor, row.currency).toFixed(2),
        fromMinorUnits(row.refundedMinor, row.currency).toFixed(2),
        row.disputeState,
        row.gatewayPaymentId ?? '',
        row.id,
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.map(csvCell).join(','), ...lines].join('\n') + '\n';
  }
}
