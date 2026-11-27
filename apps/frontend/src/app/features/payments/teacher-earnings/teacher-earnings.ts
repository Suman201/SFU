import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  bpsToPercentLabel,
  currencyDefinition,
  isPaymentCurrency,
  majorToMinor,
  MAX_PAYMENT_MINOR,
  type PaymentCurrency,
  formatPaymentMoney,
  fromMinorUnits,
  payoutStatusLabel,
  type LedgerEntryType,
  type PayoutRecord,
  type PayoutStatus,
  type TeacherBalance,
  type TeacherEarningsLine,
  type TeacherEarningsSummary,
} from '@native-sfu/contracts';
import { PaymentsApi, openHostedPage, paymentErrorMessage, requestKey } from '../../../core/services/payments.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

type Tab = 'transactions' | 'payouts';

const ENTRY_LABELS: Record<LedgerEntryType, string> = {
  promotion_capture: 'Promotion payment', promotion_refund: 'Promotion refund', promotion_gateway_fee: 'Promotion processing fee',
  payment_captured: 'Student payment',
  gateway_fee: 'Processing fee',
  earnings_released: 'Available for payout',
  refund: 'Refund',
  dispute_opened: 'Dispute opened',
  dispute_fee: 'Dispute fee',
  dispute_won: 'Dispute won',
  dispute_lost: 'Dispute lost',
  payout_requested: 'Payout requested',
  payout_released: 'Payout returned',
  payout_paid: 'Payout sent',
  payout_reversed: 'Payout reversed',
};

@Component({
  selector: 'sfu-teacher-earnings',
  standalone: true,
  imports: [DatePipe, FormsModule, Footer, Header, RouterLink],
  templateUrl: './teacher-earnings.html',
  styleUrl: '../payment-pages.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class TeacherEarnings implements OnInit {
  private readonly api = inject(PaymentsApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly summary = signal<TeacherEarningsSummary | null>(null);
  protected readonly transactions = signal<TeacherEarningsLine[]>([]);
  protected readonly transactionTotal = signal(0);
  protected readonly transactionPage = signal(1);
  protected readonly payouts = signal<PayoutRecord[]>([]);
  protected readonly payoutTotal = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly busy = signal(false);
  protected readonly tab = signal<Tab>('transactions');
  protected readonly amount = signal('');
  protected readonly note = signal('');
  private pendingKey = requestKey();
  private transactionVersion = 0;
  protected readonly selectedCurrency = signal<PaymentCurrency | null>(null);

  protected readonly money = formatPaymentMoney;
  protected readonly percent = bpsToPercentLabel;
  protected readonly payoutLabel = payoutStatusLabel;

  protected readonly balance = computed<TeacherBalance | null>(() => {
    const summary = this.summary();
    return summary?.balances.find(item => item.currency === this.selectedCurrency()) ?? summary?.balances.find(item => [item.pendingMinor, item.availableMinor, item.reservedMinor, item.paidOutMinor, item.frozenMinor, item.grossMinor].some(amount => amount !== 0)) ?? summary?.balances.find(item => item.currency === summary.defaultCurrency) ?? summary?.balances[0] ?? null;
  });
  protected readonly currency = computed<PaymentCurrency>(() => this.balance()?.currency ?? 'USD');
  protected readonly currencySymbol = computed(() => currencyDefinition(this.currency()).symbol);
  protected readonly openPayouts = computed(() => this.payouts().filter(item => item.currency === this.currency() && (item.status === 'requested' || item.status === 'processing')));
  protected readonly canRequest = computed(() => {
    const summary = this.summary();
    const balance = this.balance();
    return Boolean(summary?.payoutsEnabled && summary.payoutAccount.payoutsEnabled && balance && !balance.payoutBlockedReason && balance.minimumPayoutMinor !== undefined && balance.availableMinor >= balance.minimumPayoutMinor);
  });

  ngOnInit(): void {
    const setup = this.route.snapshot.queryParamMap.get('payout_setup');
    if (setup === 'done') {
      this.api.refreshPayoutAccount().subscribe({ next: () => this.loadAll(), error: () => this.loadAll() });
      this.success.set('Payout account details saved. The payment provider may take a few minutes to verify them.');
      return;
    }
    if (setup === 'refresh') this.error.set('The payout setup link expired. Continue setup to get a new link.');
    this.loadAll();
  }

  protected loadAll(): void {
    this.loading.set(true);
    this.api.earningsSummary().subscribe({
      next: (summary) => {
        this.summary.set(summary);
        const balance = this.balance();
        if (balance && !this.selectedCurrency()) this.selectedCurrency.set(balance.currency);
        if (!this.amount() && balance && balance.availableMinor > 0) this.amount.set(this.amountText(balance.availableMinor, balance.currency));
        this.loadTransactions(1);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(paymentErrorMessage(error, 'Your earnings could not be loaded.'));
        this.loading.set(false);
      },
    });
    this.api.payouts(1).subscribe({
      next: (result) => {
        this.payouts.set(result.items);
        this.payoutTotal.set(result.total);
      },
      error: () => undefined,
    });
  }

  protected loadTransactions(page: number): void {
    const version = ++this.transactionVersion;
    this.api.earningsTransactions(page, this.currency()).subscribe({
      next: (result) => {
        if (version !== this.transactionVersion) return;
        this.transactions.set(result.items);
        this.transactionTotal.set(result.total);
        this.transactionPage.set(result.page);
      },
      error: () => undefined,
    });
  }

  protected selectCurrency(value: string): void {
    if (this.busy() || !isPaymentCurrency(value) || !this.summary()?.balances.some(item => item.currency === value)) return;
    this.selectedCurrency.set(value);
    this.amount.set(this.amountText(Math.max(0, this.balance()?.availableMinor ?? 0), value));
    this.pendingKey = requestKey();
    this.error.set('');
    this.loadTransactions(1);
  }

  private amountText(amountMinor: number, currency: PaymentCurrency): string {
    return fromMinorUnits(Math.min(amountMinor, MAX_PAYMENT_MINOR), currency).toFixed(currencyDefinition(currency).minorUnits);
  }

  protected setupPayouts(): void {
    this.busy.set(true);
    this.error.set('');
    this.api.startPayoutSetup().subscribe({
      next: ({ url }) => {
        this.busy.set(false);
        if (new URL(url, window.location.origin).origin === window.location.origin) {
          this.success.set('Payout account connected.');
          this.loadAll();
        } else {
          openHostedPage(url);
        }
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(paymentErrorMessage(error, 'Payout setup could not be started.'));
      },
    });
  }

  protected requestPayout(): void {
    const summary = this.summary();
    if (!summary || !this.canRequest()) return;
    let amountMinor: number;
    try { amountMinor = majorToMinor(this.amount(), this.currency()); if (amountMinor < 1) throw new Error('Enter a positive payout amount.'); }
    catch (error) { this.error.set(error instanceof Error ? error.message : 'Enter a valid amount.'); return; }
    this.busy.set(true);
    this.error.set('');
    this.success.set('');
    this.api.requestPayout({ currency: this.currency(), amountMinor, note: this.note().trim() || undefined, requestId: this.pendingKey }).subscribe({
      next: (payout) => {
        this.busy.set(false);
        this.pendingKey = requestKey();
        this.amount.set('');
        this.note.set('');
        this.tab.set('payouts');
        this.success.set(`Payout of ${formatPaymentMoney(payout.amountMinor, payout.currency)} requested. An administrator will review it shortly.`);
        this.loadAll();
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(paymentErrorMessage(error, 'The payout could not be requested.'));
      },
    });
  }

  protected cancelPayout(payout: PayoutRecord): void {
    this.busy.set(true);
    this.api.cancelPayout(payout.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.success.set('Payout request cancelled. The amount is available again.');
        this.loadAll();
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(paymentErrorMessage(error));
      },
    });
  }

  protected intro(): string {
    const summary = this.summary();
    const fee = summary ? ` (${bpsToPercentLabel(summary.commissionBps)})` : '';
    return `Your share of lesson fees before tax, after the platform fee${fee}. Each booking keeps its agreed commission rate. Payment processing fees are paid by Sapiovian, not deducted from your share.`;
  }

  protected accountLine(currency: string): string {
    const summary = this.summary();
    if (!summary) return '';
    const hint = summary.payoutAccount.accountHint ? ` (••••${summary.payoutAccount.accountHint})` : '';
    const minimum = this.balance()?.minimumPayoutMinor;
    return minimum === undefined ? `Payout account connected${hint}. A minimum for this currency needs to be configured.` : `Payout account connected${hint}. Minimum payout ${formatPaymentMoney(minimum, currency)}.`;
  }

  /** Entries that only move money between balance buckets. */
  protected movement(row: TeacherEarningsLine): string {
    if (row.availableDeltaMinor > 0) return 'Moved to available';
    if (row.type === 'payout_requested') return 'Reserved for payout';
    if (row.type === 'dispute_opened') return 'On hold';
    return row.availableDeltaMinor < 0 ? 'Moved from available' : '—';
  }

  protected totalEarnings(balance: TeacherBalance): number {
    return balance.pendingMinor + balance.availableMinor + balance.reservedMinor + balance.frozenMinor + balance.paidOutMinor;
  }

  /** Teacher's share of refunds and lost disputes, so the breakdown always adds up. */
  protected refundShare(balance: TeacherBalance): number {
    return Math.max(0, balance.grossMinor - balance.commissionMinor - this.totalEarnings(balance));
  }

  protected entryLabel(type: LedgerEntryType): string {
    return ENTRY_LABELS[type] ?? type;
  }

  protected payoutPill(status: PayoutStatus): string {
    if (status === 'paid') return 'success';
    if (status === 'requested' || status === 'processing') return 'warning';
    if (status === 'cancelled') return 'neutral';
    return 'danger';
  }

  protected signed(minor: number, currency: string): string {
    if (minor === 0) return '—';
    return `${minor > 0 ? '+' : '−'}${formatPaymentMoney(Math.abs(minor), currency)}`;
  }
}
