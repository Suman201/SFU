import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatPaymentMoney, paymentStatusLabel, type PaymentStatus, type StudentPaymentRecord } from '@native-sfu/contracts';
import { PaymentsApi, paymentErrorMessage, saveBlob } from '../../../core/services/payments.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

type StatusFilter = 'all' | 'paid' | 'open' | 'refunded' | 'unsuccessful';

@Component({
  selector: 'sfu-student-payments',
  standalone: true,
  imports: [DatePipe, Footer, Header, RouterLink],
  templateUrl: './student-payments.html',
  styleUrl: '../payment-pages.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class StudentPayments implements OnInit {
  private readonly api = inject(PaymentsApi);
  protected readonly rows = signal<StudentPaymentRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly downloading = signal<string | null>(null);
  protected readonly filter = signal<StatusFilter>('all');
  protected readonly money = formatPaymentMoney;
  protected readonly statusLabel = paymentStatusLabel;

  protected readonly filtered = computed(() => {
    const filter = this.filter();
    return this.rows().filter((row) => {
      if (filter === 'paid') return row.status === 'succeeded';
      if (filter === 'open') return row.status === 'pending';
      if (filter === 'refunded') return row.status === 'refunded' || row.status === 'partially_refunded';
      if (filter === 'unsuccessful') return ['failed', 'expired', 'cancelled'].includes(row.status);
      return true;
    });
  });

  protected readonly totals = computed(() => {
    const paid = this.rows().filter((row) => ['succeeded', 'partially_refunded', 'refunded'].includes(row.status));
    const currency = paid[0]?.currency ?? 'USD';
    const same = paid.filter((row) => row.currency === currency);
    return {
      currency,
      paidMinor: same.reduce((sum, row) => sum + row.amountMinor, 0),
      refundedMinor: same.reduce((sum, row) => sum + row.refundedMinor, 0),
      count: paid.length,
      open: this.rows().filter((row) => row.status === 'pending').length,
    };
  });

  protected readonly filters: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'paid', label: 'Paid' },
    { id: 'open', label: 'Awaiting payment' },
    { id: 'refunded', label: 'Refunded' },
    { id: 'unsuccessful', label: 'Unsuccessful' },
  ];

  ngOnInit(): void {
    this.load();
  }

  protected load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api.mine(page).subscribe({
      next: (result) => {
        this.rows.set(result.items);
        this.total.set(result.total);
        this.page.set(result.page);
        this.limit.set(result.limit);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(paymentErrorMessage(error, 'Your payments could not be loaded.'));
        this.loading.set(false);
      },
    });
  }

  protected pillClass(status: PaymentStatus): string {
    if (status === 'succeeded') return 'success';
    if (status === 'pending') return 'warning';
    if (status === 'refunded' || status === 'partially_refunded') return 'info';
    if (status === 'cancelled' || status === 'expired') return 'neutral';
    return 'danger';
  }

  protected download(row: StudentPaymentRecord): void {
    if (!row.receiptNumber) return;
    this.downloading.set(row.id);
    this.api.receipt(row.id).subscribe({
      next: (blob) => {
        saveBlob(blob, `${row.receiptNumber}.pdf`);
        this.downloading.set(null);
      },
      error: (error) => {
        this.error.set(paymentErrorMessage(error, 'The receipt could not be downloaded.'));
        this.downloading.set(null);
      },
    });
  }
}
