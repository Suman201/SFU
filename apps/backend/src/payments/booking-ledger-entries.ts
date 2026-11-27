import { splitCommission, splitRefund, type BookingEarningsPolicy, type BookingInvoiceSource } from '@native-sfu/contracts';
import type { LedgerEntryDraft } from './ledger-entries';

export interface BookingFinancialFacts {
  id: string;
  teacherId: string;
  title: string;
  invoiceSource: BookingInvoiceSource;
  earningsPolicy: BookingEarningsPolicy;
}

export function assertBookingFacts(order: BookingFinancialFacts): void {
  const source = order.invoiceSource, policy = order.earningsPolicy;
  const values = [source.netMinor, source.taxMinor, source.totalMinor, policy.commissionMinor, policy.teacherMinor];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || source.netMinor + source.taxMinor !== source.totalMinor) throw new Error('Invalid booking financial amounts.');
  const split = splitCommission(source.netMinor, policy.commissionBps);
  if (policy.version !== 1 || split.commissionMinor !== policy.commissionMinor || split.teacherMinor !== policy.teacherMinor || !Number.isInteger(policy.holdDays) || policy.holdDays < 0 || policy.holdDays > 90) throw new Error('Booking commission policy does not match its financial snapshot.');
}

export function bookingCaptureEntry(order: BookingFinancialFacts, occurredAt: Date): LedgerEntryDraft {
  assertBookingFacts(order);
  const source = order.invoiceSource, policy = order.earningsPolicy;
  return {
    key: `booking:${order.id}:captured`, type: 'payment_captured', currency: source.currency, occurredAt,
    memo: `Booking payment received: ${order.title}`, bookingOrderId: order.id, teacherId: order.teacherId,
    lines: [
      { account: 'gateway_clearing', debitMinor: source.totalMinor, creditMinor: 0 },
      { account: 'platform_revenue', debitMinor: 0, creditMinor: policy.commissionMinor },
      { account: 'teacher_pending', teacherId: order.teacherId, debitMinor: 0, creditMinor: policy.teacherMinor },
      { account: 'tax_payable', debitMinor: 0, creditMinor: source.taxMinor },
    ].filter(line => line.debitMinor || line.creditMinor) as LedgerEntryDraft['lines'],
  };
}

/** Confirmed credit-note tax is authoritative; allocate commission cumulatively on the credited net fee. */
export function bookingRefundAllocation(order: BookingFinancialFacts, credit: { totalMinor: number; taxMinor: number }, previous: { netMinor: number; commissionMinor: number }) {
  assertBookingFacts(order);
  if (!Number.isSafeInteger(credit.totalMinor) || !Number.isSafeInteger(credit.taxMinor) || credit.totalMinor < 1 || credit.taxMinor < 0 || credit.taxMinor > credit.totalMinor) throw new Error('Invalid credit note allocation.');
  const netMinor = credit.totalMinor - credit.taxMinor;
  if (previous.netMinor + netMinor > order.invoiceSource.netMinor) throw new Error('Refunded lesson fees exceed the original amount.');
  const split = netMinor ? splitRefund({ amountMinor: order.invoiceSource.netMinor, commissionMinor: order.earningsPolicy.commissionMinor, refundedMinor: previous.netMinor, refundedCommissionMinor: previous.commissionMinor }, netMinor) : { commissionMinor: 0, teacherMinor: 0 };
  return { ...split, netMinor, taxMinor: credit.taxMinor, totalMinor: credit.totalMinor };
}

export function bookingRefundEntry(order: BookingFinancialFacts, refundId: string, allocation: ReturnType<typeof bookingRefundAllocation>, released: boolean, occurredAt: Date): LedgerEntryDraft {
  return {
    key: `booking:${order.id}:refund:${refundId}`, type: 'refund', currency: order.invoiceSource.currency, occurredAt,
    memo: `Booking refund: ${order.title}`, bookingOrderId: order.id, teacherId: order.teacherId, refundId,
    lines: [
      { account: 'platform_revenue', debitMinor: allocation.commissionMinor, creditMinor: 0 },
      { account: released ? 'teacher_available' : 'teacher_pending', teacherId: order.teacherId, debitMinor: allocation.teacherMinor, creditMinor: 0 },
      { account: 'tax_payable', debitMinor: allocation.taxMinor, creditMinor: 0 },
      { account: 'gateway_clearing', debitMinor: 0, creditMinor: allocation.totalMinor },
    ].filter(line => line.debitMinor || line.creditMinor) as LedgerEntryDraft['lines'],
  };
}
