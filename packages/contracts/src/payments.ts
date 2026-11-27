import { CURRENCY_DECIMALS, SUPPORTED_CURRENCIES, majorToMinor, type CurrencyCode } from './money';

/**
 * Payments, earnings and payouts.
 *
 * Every persisted amount is an integer number of minor units (cents for USD,
 * paise for INR) together with an explicit ISO 4217 currency code. Amounts in
 * different currencies are never added together or converted.
 */

export interface PaymentCurrencyDefinition {
  code: string;
  name: string;
  symbol: string;
  /** Number of decimal places used by the currency's minor unit. */
  minorUnits: number;
  /** Locale used when formatting amounts for display. */
  locale: string;
}

/**
 * Registry of currencies the platform knows about. Adding a currency here makes
 * it selectable; it only becomes payable once an admin enables it in finance
 * settings and the configured gateway supports it.
 */
const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });
export const PAYMENT_CURRENCIES = Object.fromEntries(SUPPORTED_CURRENCIES.map(code => [code, {
  code,
  name: code === 'USD' ? 'US Dollar' : code === 'INR' ? 'Indian Rupee' : currencyNames.of(code) ?? code,
  symbol: new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(part => part.type === 'currency')?.value ?? code,
  minorUnits: CURRENCY_DECIMALS[code],
  locale: code === 'INR' ? 'en-IN' : 'en-US',
}])) as Record<CurrencyCode, PaymentCurrencyDefinition>;

export type PaymentCurrency = CurrencyCode;
export const PAYMENT_CURRENCY_CODES = SUPPORTED_CURRENCIES;
export const DEFAULT_PAYMENT_CURRENCY: PaymentCurrency = 'USD';
/** Currencies enabled for new installations. INR is registered but disabled. */
export const INITIAL_ENABLED_CURRENCIES: PaymentCurrency[] = ['USD'];

export function isPaymentCurrency(value: unknown): value is PaymentCurrency {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PAYMENT_CURRENCIES, value);
}

export function currencyDefinition(currency: PaymentCurrency): PaymentCurrencyDefinition {
  return PAYMENT_CURRENCIES[currency];
}

/** Converts a major-unit amount (e.g. 49.99) to integer minor units (4999). */
export function toMinorUnits(amount: number, currency: PaymentCurrency): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a finite, non-negative number.');
  return majorToMinor(amount, currency);
}

export function fromMinorUnits(minor: number, currency: PaymentCurrency): number {
  return minor / 10 ** PAYMENT_CURRENCIES[currency].minorUnits;
}

export function formatPaymentMoney(minor: number, currency: string, locale?: string): string {
  const known = isPaymentCurrency(currency) ? PAYMENT_CURRENCIES[currency] : undefined;
  const digits = known?.minorUnits ?? 2;
  return new Intl.NumberFormat(locale ?? known?.locale ?? 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

export const MAX_COMMISSION_BPS = 10_000;
export const MAX_PAYMENT_MINOR = 100_000_000;

function assertMinor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer amount.`);
}

/**
 * Splits a gross payment into platform commission and teacher share.
 * Commission is rounded half-up; the teacher receives the exact remainder so
 * the two parts always add up to the gross amount.
 */
export function splitCommission(grossMinor: number, commissionBps: number): { commissionMinor: number; teacherMinor: number } {
  assertMinor(grossMinor, 'Gross amount');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > MAX_COMMISSION_BPS) {
    throw new Error('Commission must be between 0 and 10000 basis points.');
  }
  const commissionMinor = Number((BigInt(grossMinor) * BigInt(commissionBps) + 5000n) / 10000n);
  return { commissionMinor, teacherMinor: grossMinor - commissionMinor };
}

export interface RefundSplitState {
  amountMinor: number;
  commissionMinor: number;
  refundedMinor: number;
  refundedCommissionMinor: number;
}

/**
 * Allocates a refund between platform commission and teacher share in
 * proportion to the original split. Allocation is cumulative, so a series of
 * partial refunds that ends in a full refund returns exactly the original
 * commission and teacher share without rounding drift.
 */
export function splitRefund(state: RefundSplitState, refundMinor: number): { commissionMinor: number; teacherMinor: number } {
  assertMinor(refundMinor, 'Refund amount');
  if (refundMinor === 0) throw new Error('Refund amount must be greater than zero.');
  if (state.refundedMinor + refundMinor > state.amountMinor) throw new Error('Refund exceeds the remaining paid amount.');
  if (state.amountMinor === 0) return { commissionMinor: 0, teacherMinor: 0 };
  const totalRefunded = BigInt(state.refundedMinor + refundMinor);
  const amount = BigInt(state.amountMinor);
  const commissionTarget = Number((BigInt(state.commissionMinor) * totalRefunded * 2n + amount) / (amount * 2n));
  const commissionMinor = Math.max(0, Math.min(refundMinor, commissionTarget - state.refundedCommissionMinor));
  return { commissionMinor, teacherMinor: refundMinor - commissionMinor };
}

export function bpsToPercentLabel(bps: number): string {
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'expired', 'cancelled', 'partially_refunded', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_DISPUTE_STATES = ['none', 'open', 'won', 'lost'] as const;
export type PaymentDisputeState = (typeof PAYMENT_DISPUTE_STATES)[number];

/** Whether the paid class access was granted. */
export type PaymentEnrollmentState = 'pending' | 'granted' | 'refund_required' | 'not_granted';

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const DISPUTE_STATUSES = ['needs_response', 'under_review', 'won', 'lost', 'closed'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const PAYOUT_STATUSES = ['requested', 'processing', 'paid', 'rejected', 'cancelled', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type PaymentGatewayId = 'stripe' | 'test';

export function paymentStatusLabel(status: PaymentStatus): string {
  return {
    pending: 'Awaiting payment',
    succeeded: 'Paid',
    failed: 'Failed',
    expired: 'Expired',
    cancelled: 'Cancelled',
    partially_refunded: 'Partly refunded',
    refunded: 'Refunded',
  }[status];
}

export function payoutStatusLabel(status: PayoutStatus): string {
  return {
    requested: 'Requested',
    processing: 'Processing',
    paid: 'Paid',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    failed: 'Failed',
  }[status];
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Double-entry accounts.
 * - gateway_clearing: money held for the platform at the gateway (asset).
 * - platform_revenue: commission earned (revenue).
 * - gateway_fees: processing and dispute fees borne by the platform (expense).
 * - dispute_hold: disputed funds withdrawn by the gateway pending a decision (asset).
 * - teacher_*: amounts owed to a teacher (liabilities), split by state.
 */
export const LEDGER_ACCOUNTS = [
  'gateway_clearing',
  'platform_revenue',
  'tax_payable',
  'gateway_fees',
  'dispute_hold',
  'teacher_pending',
  'teacher_available',
  'teacher_reserved',
  'teacher_frozen',
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];
export const TEACHER_LEDGER_ACCOUNTS: LedgerAccount[] = ['teacher_pending', 'teacher_available', 'teacher_reserved', 'teacher_frozen'];
/** Accounts whose natural balance is a debit; all others are credit-normal. */
export const DEBIT_NORMAL_ACCOUNTS: LedgerAccount[] = ['gateway_clearing', 'gateway_fees', 'dispute_hold'];

export const LEDGER_ENTRY_TYPES = [
  'payment_captured',
  'gateway_fee',
  'earnings_released',
  'refund',
  'dispute_opened',
  'dispute_fee',
  'dispute_won',
  'dispute_lost',
  'payout_requested',
  'payout_released',
  'payout_paid',
  'payout_reversed',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface LedgerLine {
  account: LedgerAccount;
  teacherId?: string;
  debitMinor: number;
  creditMinor: number;
}

export interface LedgerEntryRecord {
  id: string;
  key: string;
  type: LedgerEntryType;
  currency: PaymentCurrency;
  occurredAt: string;
  memo: string;
  paymentId?: string;
  bookingOrderId?: string;
  refundId?: string;
  disputeId?: string;
  payoutId?: string;
  teacherId?: string;
  lines: LedgerLine[];
}

/** Throws unless the lines are well-formed and debits equal credits. */
export function assertBalancedLedgerLines(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new Error('A ledger entry needs at least two lines.');
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (!(LEDGER_ACCOUNTS as readonly string[]).includes(line.account)) throw new Error(`Unknown ledger account ${line.account}.`);
    assertMinor(line.debitMinor, 'Debit');
    assertMinor(line.creditMinor, 'Credit');
    if ((line.debitMinor > 0) === (line.creditMinor > 0)) throw new Error('Each ledger line must be either a debit or a credit.');
    if (TEACHER_LEDGER_ACCOUNTS.includes(line.account) && !line.teacherId) throw new Error('Teacher ledger lines need a teacher.');
    debit += line.debitMinor;
    credit += line.creditMinor;
  }
  if (debit !== credit) throw new Error(`Ledger entry is unbalanced (${debit} debit, ${credit} credit).`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TeacherCommissionOverride {
  teacherId: string;
  teacherName?: string;
  commissionBps: number;
}

export interface FinanceSettings {
  version: number;
  /** Default platform commission in basis points (1500 = 15%). */
  commissionBps: number;
  /** Days a teacher's share stays pending before it can be paid out. */
  holdDays: number;
  /** Smallest payout a teacher may request, in minor units of the default currency. */
  minimumPayoutMinor: number;
  defaultCurrency: PaymentCurrency;
  /** Explicit payout minimums for currencies other than the default. */
  payoutMinimums?: PayoutCurrencyMinimum[];
  enabledCurrencies: PaymentCurrency[];
  teacherOverrides: TeacherCommissionOverride[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface PayoutCurrencyMinimum {
  currency: PaymentCurrency;
  minimumMinor: number;
}

export function minimumPayoutFor(settings: Pick<FinanceSettings, 'defaultCurrency' | 'minimumPayoutMinor' | 'payoutMinimums'>, currency: PaymentCurrency): number | undefined {
  return currency === settings.defaultCurrency ? settings.minimumPayoutMinor : settings.payoutMinimums?.find(item => item.currency === currency)?.minimumMinor;
}

export interface FinanceSettingsUpdate {
  payoutMinimums?: PayoutCurrencyMinimum[];
  version: number;
  commissionBps: number;
  holdDays: number;
  minimumPayoutMinor: number;
  enabledCurrencies: PaymentCurrency[];
  teacherOverrides: TeacherCommissionOverride[];
}

export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = {
  version: 0,
  commissionBps: 1500,
  holdDays: 7,
  minimumPayoutMinor: 2000,
  defaultCurrency: DEFAULT_PAYMENT_CURRENCY,
  enabledCurrencies: INITIAL_ENABLED_CURRENCIES,
  teacherOverrides: [],
};

export function commissionBpsForTeacher(settings: Pick<FinanceSettings, 'commissionBps' | 'teacherOverrides'>, teacherId: string): number {
  return settings.teacherOverrides.find((item) => item.teacherId === teacherId)?.commissionBps ?? settings.commissionBps;
}

// ---------------------------------------------------------------------------
// API records
// ---------------------------------------------------------------------------

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PaymentGatewayStatus {
  enabled: boolean;
  gateway: PaymentGatewayId;
  testMode: boolean;
  currencies: PaymentCurrency[];
}

export interface CheckoutRequest {
  batchId: string;
}

export interface CheckoutResponse {
  paymentId: string;
  checkoutUrl: string;
  expiresAt: string;
  /** True when an unfinished checkout for the same batch was reused. */
  reused: boolean;
}

export interface RefundSummary {
  id: string;
  amountMinor: number;
  status: RefundStatus;
  reason: string;
  createdAt: string;
  completedAt?: string;
}

export interface StudentPaymentRecord {
  id: string;
  receiptNumber?: string;
  batchId: string;
  batchName: string;
  teacherId: string;
  teacherName: string;
  currency: PaymentCurrency;
  amountMinor: number;
  refundedMinor: number;
  status: PaymentStatus;
  disputeState: PaymentDisputeState;
  enrollmentState: PaymentEnrollmentState;
  description: string;
  createdAt: string;
  paidAt?: string;
  expiresAt?: string;
  failureReason?: string;
  /** Present while the checkout can still be completed. */
  checkoutUrl?: string;
  refunds: RefundSummary[];
}

export interface AdminPaymentRecord extends StudentPaymentRecord {
  studentId: string;
  studentName: string;
  studentEmail: string;
  gateway: PaymentGatewayId;
  gatewaySessionId?: string;
  gatewayPaymentId?: string;
  commissionBps: number;
  commissionMinor: number;
  teacherMinor: number;
  gatewayFeeMinor: number;
  refundedCommissionMinor: number;
  refundedTeacherMinor: number;
  earningsReleasedAt?: string;
  earningsAvailableAt?: string;
  ledger?: LedgerEntryRecord[];
}

export interface PaymentListQuery {
  page?: number;
  status?: PaymentStatus | 'all';
  q?: string;
  teacherId?: string;
  from?: string;
  to?: string;
  currency?: PaymentCurrency;
}

export interface RefundRecord {
  id: string;
  paymentId: string;
  currency: PaymentCurrency;
  amountMinor: number;
  commissionMinor: number;
  teacherMinor: number;
  reason: string;
  status: RefundStatus;
  initiatedBy: 'admin' | 'system' | 'gateway';
  requestedByName?: string;
  studentName: string;
  teacherName: string;
  batchName: string;
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface CreateRefundRequest {
  /** Omit for a full refund of the remaining amount. */
  amountMinor?: number;
  reason: string;
  /** Client-generated key so a retried request cannot refund twice. */
  requestId: string;
}

export interface DisputeRecord {
  id: string;
  paymentId: string;
  gatewayDisputeId: string;
  currency: PaymentCurrency;
  amountMinor: number;
  reason: string;
  status: DisputeStatus;
  evidenceDueBy?: string;
  studentName: string;
  teacherName: string;
  batchName: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface PayoutRecord {
  reversedMinor?: number;
  id: string;
  teacherId: string;
  teacherName: string;
  currency: PaymentCurrency;
  amountMinor: number;
  status: PayoutStatus;
  note?: string;
  adminNote?: string;
  failureReason?: string;
  gatewayTransferId?: string;
  requestedAt: string;
  decidedAt?: string;
  decidedByName?: string;
  paidAt?: string;
}

export interface PayoutRequestInput {
  currency: PaymentCurrency;
  amountMinor: number;
  note?: string;
  requestId: string;
}

export interface PayoutDecisionInput {
  note?: string;
}

export interface TeacherBalance {
  minimumPayoutMinor?: number;
  payoutBlockedReason?: string;
  currency: PaymentCurrency;
  pendingMinor: number;
  availableMinor: number;
  reservedMinor: number;
  frozenMinor: number;
  paidOutMinor: number;
  grossMinor: number;
  commissionMinor: number;
  refundedMinor: number;
}

export interface PayoutAccountStatus {
  gateway: PaymentGatewayId;
  connected: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  /** Last four characters of the gateway account, for recognition only. */
  accountHint?: string;
  updatedAt?: string;
}

export interface TeacherEarningsSummary {
  balances: TeacherBalance[];
  commissionBps: number;
  holdDays: number;
  minimumPayoutMinor: number;
  defaultCurrency: PaymentCurrency;
  payoutAccount: PayoutAccountStatus;
  payoutsEnabled: boolean;
}

export interface TeacherEarningsLine {
  bookingOrderId?: string;
  taxMinor?: number;
  id: string;
  type: LedgerEntryType;
  occurredAt: string;
  currency: PaymentCurrency;
  description: string;
  paymentId?: string;
  payoutId?: string;
  batchName?: string;
  studentName?: string;
  grossMinor?: number;
  commissionMinor?: number;
  /** Signed change to the teacher's total balance (pending + available + reserved + frozen). */
  netMinor: number;
  /** Signed change to the amount the teacher can request now. */
  availableDeltaMinor: number;
}

export interface FinanceDailyPoint {
  date: string;
  grossMinor: number;
  commissionMinor: number;
  refundsMinor: number;
  payments: number;
}

export interface FinanceOverview {
  bookingDisputeReviewCount?: number;
  unrecordedBookingFeeCount?: number;
  taxPayableMinor?: number;
  currency: PaymentCurrency;
  from: string;
  to: string;
  grossMinor: number;
  refundedMinor: number;
  commissionMinor: number;
  refundedCommissionMinor: number;
  gatewayFeesMinor: number;
  /** Commission kept after refunds and lost disputes, minus gateway fees. */
  platformNetMinor: number;
  teacherEarningsMinor: number;
  successfulPayments: number;
  failedPayments: number;
  /** Current balances (not limited to the date range). */
  teacherPendingMinor: number;
  teacherAvailableMinor: number;
  teacherReservedMinor: number;
  teacherFrozenMinor: number;
  paidOutMinor: number;
  openDisputes: number;
  pendingPayoutRequests: number;
  failedGatewayEvents: number;
  ledgerBalanced: boolean;
  daily: FinanceDailyPoint[];
}

export interface TeacherFinanceRow {
  teacherId: string;
  teacherName: string;
  currency: PaymentCurrency;
  grossMinor: number;
  commissionMinor: number;
  refundedMinor: number;
  pendingMinor: number;
  availableMinor: number;
  reservedMinor: number;
  frozenMinor: number;
  paidOutMinor: number;
}

export interface GatewayEventRecord {
  id: string;
  gateway: PaymentGatewayId;
  type: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'ignored';
  attempts: number;
  lastError?: string;
  receivedAt: string;
  processedAt?: string;
  paymentId?: string;
}

export interface ReconciliationReport {
  bookingEarnings?: BookingEarningsReconciliation;
  checkedAt: string;
  ledgerBalanced: boolean;
  unbalancedEntries: number;
  /** Paid payments whose ledger capture entry is missing. */
  paymentsMissingLedger: string[];
  /** Payments whose stored teacher share differs from the ledger. */
  paymentsWithMismatchedSplit: string[];
  /** Paid payments still waiting for class access. */
  paymentsAwaitingEnrollment: string[];
  failedEvents: GatewayEventRecord[];
  stalePendingPayments: number;
}


/** Immutable allocation agreed when reserving a booking, or explicitly reviewed for a historical payment. */
export interface BookingEarningsPolicy {
  version: 1;
  settingsVersion: number;
  commissionBps: number;
  commissionMinor: number;
  teacherMinor: number;
  holdDays: number;
  source: 'reservation' | 'legacy_review';
  reviewedBy?: string;
  reviewedAt?: string;
  reason?: string;
}

export interface BookingEarningsReview {
  orderId: string;
  teacherName: string;
  title: string;
  currency: PaymentCurrency;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  refundedMinor: number;
  paidAt: string;
  updatedAt: string;
}

export interface AdoptBookingEarningsInput {
  commissionBps: number;
  holdDays: number;
  reason: string;
  expectedUpdatedAt: string;
}

export interface BookingEarningsReconciliation {
  /** Open and lost booking disputes block this teacher/currency until provider resolution or settlement review. */
  disputedOrderIds: string[];
  unfulfilledOrderIds: string[];
  feesAwaitingProvider: number;
  feesInOtherCurrency: number;
  legacyCount: number;
  missingCaptureOrderIds: string[];
  missingRefundOrderIds: string[];
  missingReleaseOrderIds: string[];
  nextCursor?: string;
  mismatchedOrderIds: string[];
  /** Bounded scans are explicit; never infer complete coverage from a sample. */
  checkedOrders: number;
  totalOrders: number;
  hasMore: boolean;
}

export interface BookingEarningsRefundAllocation {
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  commissionMinor: number;
  teacherMinor: number;
}
