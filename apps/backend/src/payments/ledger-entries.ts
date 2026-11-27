import { assertBalancedLedgerLines, type LedgerEntryType, type LedgerLine, type PaymentCurrency } from '@native-sfu/contracts';

/**
 * Pure builders for every journal entry the platform posts. Each builder
 * returns a balanced entry with a deterministic key, so posting the same
 * business event twice is a no-op.
 *
 * Sign conventions: gateway_clearing, gateway_fees and dispute_hold are debit
 * normal; platform_revenue and all teacher_* accounts are credit normal.
 */
export interface LedgerEntryDraft {
  key: string;
  type: LedgerEntryType;
  currency: PaymentCurrency;
  occurredAt: Date;
  memo: string;
  paymentId?: string;
  promotionOrderId?: string;
  bookingOrderId?: string;
  refundId?: string;
  disputeId?: string;
  payoutId?: string;
  teacherId?: string;
  lines: LedgerLine[];
}

type TeacherBucket = 'teacher_pending' | 'teacher_available';

const debit = (account: LedgerLine['account'], amount: number, teacherId?: string): LedgerLine => ({
  account,
  ...(teacherId ? { teacherId } : {}),
  debitMinor: amount,
  creditMinor: 0,
});
const credit = (account: LedgerLine['account'], amount: number, teacherId?: string): LedgerLine => ({
  account,
  ...(teacherId ? { teacherId } : {}),
  debitMinor: 0,
  creditMinor: amount,
});

function entry(draft: LedgerEntryDraft): LedgerEntryDraft {
  const lines = draft.lines.filter((line) => line.debitMinor > 0 || line.creditMinor > 0);
  assertBalancedLedgerLines(lines);
  return { ...draft, lines };
}

export interface PaymentFacts {
  id: string;
  teacherId: string;
  currency: PaymentCurrency;
  amountMinor: number;
  commissionMinor: number;
  teacherMinor: number;
  description: string;
}

export function paymentCapturedEntry(payment: PaymentFacts, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `payment:${payment.id}:captured`,
    type: 'payment_captured',
    currency: payment.currency,
    occurredAt,
    memo: `Payment received: ${payment.description}`,
    paymentId: payment.id,
    teacherId: payment.teacherId,
    lines: [
      debit('gateway_clearing', payment.amountMinor),
      credit('platform_revenue', payment.commissionMinor),
      credit('teacher_pending', payment.teacherMinor, payment.teacherId),
    ],
  });
}

/** Processing fees are borne by the platform, never deducted from the teacher. */
export function gatewayFeeEntry(payment: PaymentFacts, feeMinor: number, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `payment:${payment.id}:fee`,
    type: 'gateway_fee',
    currency: payment.currency,
    occurredAt,
    memo: 'Payment processing fee',
    paymentId: payment.id,
    lines: [debit('gateway_fees', feeMinor), credit('gateway_clearing', feeMinor)],
  });
}

export function earningsReleasedEntry(payment: PaymentFacts, amountMinor: number, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `payment:${payment.id}:released`,
    type: 'earnings_released',
    currency: payment.currency,
    occurredAt,
    memo: 'Holding period ended; earnings available for payout',
    paymentId: payment.id,
    teacherId: payment.teacherId,
    lines: [debit('teacher_pending', amountMinor, payment.teacherId), credit('teacher_available', amountMinor, payment.teacherId)],
  });
}

export function refundEntry(
  payment: PaymentFacts,
  refund: { id: string; amountMinor: number; commissionMinor: number; teacherMinor: number },
  teacherBucket: TeacherBucket,
  occurredAt: Date,
): LedgerEntryDraft {
  return entry({
    key: `refund:${refund.id}`,
    type: 'refund',
    currency: payment.currency,
    occurredAt,
    memo: `Refund for ${payment.description}`,
    paymentId: payment.id,
    refundId: refund.id,
    teacherId: payment.teacherId,
    lines: [
      debit('platform_revenue', refund.commissionMinor),
      debit(teacherBucket, refund.teacherMinor, payment.teacherId),
      credit('gateway_clearing', refund.amountMinor),
    ],
  });
}

export interface DisputeFacts {
  id: string;
  amountMinor: number;
  frozenTeacherMinor: number;
  frozenCommissionMinor: number;
}

/** The gateway withdraws the disputed amount; the teacher's share is frozen. */
export function disputeOpenedEntry(payment: PaymentFacts, dispute: DisputeFacts, frozenFrom: TeacherBucket, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `dispute:${dispute.id}:opened`,
    type: 'dispute_opened',
    currency: payment.currency,
    occurredAt,
    memo: `Dispute opened for ${payment.description}`,
    paymentId: payment.id,
    disputeId: dispute.id,
    teacherId: payment.teacherId,
    lines: [
      debit('dispute_hold', dispute.amountMinor),
      credit('gateway_clearing', dispute.amountMinor),
      debit(frozenFrom, dispute.frozenTeacherMinor, payment.teacherId),
      credit('teacher_frozen', dispute.frozenTeacherMinor, payment.teacherId),
    ],
  });
}

export function disputeFeeEntry(payment: PaymentFacts, disputeId: string, feeMinor: number, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `dispute:${disputeId}:fee`,
    type: 'dispute_fee',
    currency: payment.currency,
    occurredAt,
    memo: 'Dispute fee charged by the payment provider',
    paymentId: payment.id,
    disputeId,
    lines: [debit('gateway_fees', feeMinor), credit('gateway_clearing', feeMinor)],
  });
}

/** Funds return from the gateway and the frozen share goes back where it came from. */
export function disputeWonEntry(payment: PaymentFacts, dispute: DisputeFacts, returnTo: TeacherBucket, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `dispute:${dispute.id}:won`,
    type: 'dispute_won',
    currency: payment.currency,
    occurredAt,
    memo: `Dispute won for ${payment.description}`,
    paymentId: payment.id,
    disputeId: dispute.id,
    teacherId: payment.teacherId,
    lines: [
      debit('gateway_clearing', dispute.amountMinor),
      credit('dispute_hold', dispute.amountMinor),
      debit('teacher_frozen', dispute.frozenTeacherMinor, payment.teacherId),
      credit(returnTo, dispute.frozenTeacherMinor, payment.teacherId),
    ],
  });
}

/** A lost dispute is a forced refund: commission and the frozen teacher share are reversed. */
export function disputeLostEntry(payment: PaymentFacts, dispute: DisputeFacts, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `dispute:${dispute.id}:lost`,
    type: 'dispute_lost',
    currency: payment.currency,
    occurredAt,
    memo: `Dispute lost for ${payment.description}`,
    paymentId: payment.id,
    disputeId: dispute.id,
    teacherId: payment.teacherId,
    lines: [
      debit('platform_revenue', dispute.frozenCommissionMinor),
      debit('teacher_frozen', dispute.frozenTeacherMinor, payment.teacherId),
      credit('dispute_hold', dispute.amountMinor),
    ],
  });
}

export interface PayoutFacts {
  id: string;
  teacherId: string;
  currency: PaymentCurrency;
  amountMinor: number;
}

export function payoutRequestedEntry(payout: PayoutFacts, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `payout:${payout.id}:requested`,
    type: 'payout_requested',
    currency: payout.currency,
    occurredAt,
    memo: 'Payout requested',
    payoutId: payout.id,
    teacherId: payout.teacherId,
    lines: [debit('teacher_available', payout.amountMinor, payout.teacherId), credit('teacher_reserved', payout.amountMinor, payout.teacherId)],
  });
}

/** Returns a reserved payout to the available balance (rejected, cancelled or failed). */
export function payoutReleasedEntry(payout: PayoutFacts, reason: string, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `payout:${payout.id}:released`,
    type: 'payout_released',
    currency: payout.currency,
    occurredAt,
    memo: reason,
    payoutId: payout.id,
    teacherId: payout.teacherId,
    lines: [debit('teacher_reserved', payout.amountMinor, payout.teacherId), credit('teacher_available', payout.amountMinor, payout.teacherId)],
  });
}

export function payoutPaidEntry(payout: PayoutFacts, occurredAt: Date): LedgerEntryDraft {
  return entry({
    key: `payout:${payout.id}:paid`,
    type: 'payout_paid',
    currency: payout.currency,
    occurredAt,
    memo: 'Payout sent to teacher',
    payoutId: payout.id,
    teacherId: payout.teacherId,
    lines: [debit('teacher_reserved', payout.amountMinor, payout.teacherId), credit('gateway_clearing', payout.amountMinor)],
  });
}

/** The gateway returned a transfer: the money is owed to the teacher again. */
export function payoutReversedEntry(payout: PayoutFacts, amountMinor: number, occurredAt: Date, cumulativeMinor?: number): LedgerEntryDraft {
  return entry({
    key: cumulativeMinor === undefined ? `payout:${payout.id}:reversed` : `payout:${payout.id}:reversed:${cumulativeMinor}`,
    type: 'payout_reversed',
    currency: payout.currency,
    occurredAt,
    memo: 'Payout transfer reversed by the payment provider',
    payoutId: payout.id,
    teacherId: payout.teacherId,
    lines: [debit('gateway_clearing', amountMinor), credit('teacher_available', amountMinor, payout.teacherId)],
  });
}

/** Signed natural balance for an account from raw debit/credit totals. */
export function naturalBalance(account: LedgerLine['account'], debitMinor: number, creditMinor: number): number {
  return ['gateway_clearing', 'gateway_fees', 'dispute_hold'].includes(account) ? debitMinor - creditMinor : creditMinor - debitMinor;
}
