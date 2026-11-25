import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminPaymentRecord, PaymentStatus } from '@native-sfu/contracts';
import { FinanceApi, downloadBlob, financeError } from '../../../core/services/finance-api.service';
import { FinanceTabs } from '../finance-tabs';
import { initials, money, paymentLabel, paymentTone } from '../finance-shared';

@Component({
  selector: 'sfu-finance-payments',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, FinanceTabs],
  templateUrl: './finance-payments.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinancePaymentsPage implements OnInit {
  private readonly api = inject(FinanceApi);
  private readonly route = inject(ActivatedRoute);
  protected readonly rows = signal<AdminPaymentRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly loading = signal(true);
  protected readonly exporting = signal(false);
  protected readonly error = signal('');
  protected readonly status = signal<PaymentStatus | 'all'>('all');
  protected readonly q = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly money = money;
  protected readonly label = paymentLabel;
  protected readonly tone = paymentTone;
  protected readonly initials = initials;
  protected readonly statuses: Array<{ value: PaymentStatus | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'succeeded', label: 'Paid' },
    { value: 'pending', label: 'Awaiting payment' },
    { value: 'partially_refunded', label: 'Partly refunded' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'failed', label: 'Failed' },
    { value: 'expired', label: 'Expired' },
    { value: 'cancelled', label: 'Cancelled' },
  ];

  ngOnInit(): void {
    const status = this.route.snapshot.queryParamMap.get('status');
    if (status && this.statuses.some((item) => item.value === status)) this.status.set(status as PaymentStatus);
    this.q.set(this.route.snapshot.queryParamMap.get('q') ?? '');
    this.load(1);
  }

  private params() {
    return { status: this.status(), q: this.q().trim(), from: this.from(), to: this.to() };
  }

  protected load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api.payments({ ...this.params(), page }).subscribe({
      next: (result) => {
        this.rows.set(result.items);
        this.total.set(result.total);
        this.page.set(result.page);
        this.limit.set(result.limit);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(financeError(error, 'Payments could not be loaded.'));
        this.loading.set(false);
      },
    });
  }

  protected setStatus(value: PaymentStatus | 'all'): void {
    this.status.set(value);
    this.load(1);
  }

  protected reset(): void {
    this.status.set('all');
    this.q.set('');
    this.from.set('');
    this.to.set('');
    this.load(1);
  }

  protected exportCsv(): void {
    this.exporting.set(true);
    this.api.paymentsCsv(this.params()).subscribe({
      next: (blob) => {
        downloadBlob(blob, `payments-${new Date().toISOString().slice(0, 10)}.csv`);
        this.exporting.set(false);
      },
      error: (error) => {
        this.error.set(financeError(error, 'The export failed.'));
        this.exporting.set(false);
      },
    });
  }
}
