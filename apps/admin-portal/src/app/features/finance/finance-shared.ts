import {
  formatPaymentMoney,
  paymentStatusLabel,
  payoutStatusLabel,
  type DisputeStatus,
  type LedgerAccount,
  type LedgerEntryType,
  type PaymentStatus,
  type PayoutStatus,
  type RefundStatus,
} from '@native-sfu/contracts';

export const money = formatPaymentMoney;
export const paymentLabel = paymentStatusLabel;
export const payoutLabel = payoutStatusLabel;

/** Pill tone classes defined in finance.scss. */
export function paymentTone(status: PaymentStatus): string {
  if (status === 'succeeded') return 'tone-success';
  if (status === 'pending') return 'tone-attention';
  if (status === 'refunded' || status === 'partially_refunded') return 'tone-live';
  if (status === 'failed') return 'tone-danger';
  return 'tone-muted';
}

export function payoutTone(status: PayoutStatus): string {
  if (status === 'paid') return 'tone-success';
  if (status === 'requested' || status === 'processing') return 'tone-attention';
  if (status === 'failed' || status === 'rejected') return 'tone-danger';
  return 'tone-muted';
}

export function refundTone(status: RefundStatus): string {
  return status === 'succeeded' ? 'tone-success' : status === 'pending' ? 'tone-attention' : 'tone-danger';
}

export function disputeTone(status: DisputeStatus): string {
  if (status === 'won' || status === 'closed') return 'tone-success';
  if (status === 'lost') return 'tone-danger';
  return 'tone-attention';
}

export const DISPUTE_LABELS: Record<DisputeStatus, string> = {
  needs_response: 'Needs response',
  under_review: 'Under review',
  won: 'Won',
  lost: 'Lost',
  closed: 'Closed',
};

export const ENTRY_LABELS: Record<LedgerEntryType, string> = {
  payment_captured: 'Payment captured',
  gateway_fee: 'Processing fee',
  earnings_released: 'Earnings released',
  refund: 'Refund',
  dispute_opened: 'Dispute opened',
  dispute_fee: 'Dispute fee',
  dispute_won: 'Dispute won',
  dispute_lost: 'Dispute lost',
  payout_requested: 'Payout requested',
  payout_released: 'Payout returned',
  payout_paid: 'Payout paid',
  payout_reversed: 'Payout reversed',
};

export const ACCOUNT_LABELS: Record<LedgerAccount, string> = {
  gateway_clearing: 'Gateway clearing',
  platform_revenue: 'Platform revenue',
  tax_payable: 'Tax payable',
  gateway_fees: 'Gateway fees',
  dispute_hold: 'Dispute hold',
  teacher_pending: 'Teacher pending',
  teacher_available: 'Teacher available',
  teacher_reserved: 'Teacher in payout',
  teacher_frozen: 'Teacher frozen',
};

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function isoDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
