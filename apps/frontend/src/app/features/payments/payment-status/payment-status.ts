import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { formatMoney, paymentStatusLabel, type StudentPaymentRecord } from '@native-sfu/contracts';
import { PaymentsApi, openHostedPage, paymentErrorMessage, saveBlob } from '../../../core/services/payments.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

type View = 'loading' | 'confirming' | 'paid' | 'open' | 'cancelled' | 'unsuccessful' | 'refunded' | 'error';

@Component({
  selector: 'sfu-payment-status',
  standalone: true,
  imports: [DatePipe, Footer, Header, RouterLink],
  templateUrl: './payment-status.html',
  styleUrl: '../payment-pages.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class PaymentStatusPage implements OnInit {
  private readonly api = inject(PaymentsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;

  protected readonly payment = signal<StudentPaymentRecord | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly timedOut = signal(false);
  protected readonly money = formatMoney;
  protected readonly statusLabel = paymentStatusLabel;
  private readonly returned = this.route.snapshot.queryParamMap.get('checkout');

  protected readonly view = computed<View>(() => {
    const payment = this.payment();
    if (this.error() && !payment) return 'error';
    if (!payment) return 'loading';
    if (payment.status === 'succeeded') return 'paid';
    if (payment.status === 'refunded' || payment.status === 'partially_refunded') return 'refunded';
    if (payment.status === 'pending') {
      if (this.returned === 'success' && !this.timedOut()) return 'confirming';
      if (this.returned === 'cancelled') return 'cancelled';
      return 'open';
    }
    return 'unsuccessful';
  });

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => clearTimeout(this.timer));
    this.load();
  }

  private load(): void {
    const id = this.route.snapshot.paramMap.get('paymentId') ?? '';
    this.api.one(id).subscribe({
      next: (payment) => {
        this.payment.set(payment);
        this.error.set('');
        const waiting = payment.status === 'pending' || (payment.status === 'succeeded' && payment.enrollmentState === 'pending');
        if (this.returned === 'success' && waiting && this.attempts < 30) {
          this.attempts += 1;
          this.timer = setTimeout(() => this.load(), 2000);
        } else if (this.attempts >= 30) {
          this.timedOut.set(true);
        }
      },
      error: (error) => this.error.set(paymentErrorMessage(error, 'This payment could not be found.')),
    });
  }

  protected resume(): void {
    const url = this.payment()?.checkoutUrl;
    if (url) openHostedPage(url);
  }

  protected cancel(): void {
    const payment = this.payment();
    if (!payment) return;
    this.busy.set(true);
    this.api.cancel(payment.id).subscribe({
      next: (updated) => {
        this.payment.set(updated);
        this.busy.set(false);
      },
      error: (error) => {
        this.error.set(paymentErrorMessage(error));
        this.busy.set(false);
      },
    });
  }

  protected receipt(): void {
    const payment = this.payment();
    if (!payment?.receiptNumber) return;
    this.busy.set(true);
    this.api.receipt(payment.id).subscribe({
      next: (blob) => {
        saveBlob(blob, `${payment.receiptNumber}.pdf`);
        this.busy.set(false);
      },
      error: (error) => {
        this.error.set(paymentErrorMessage(error, 'The receipt could not be downloaded.'));
        this.busy.set(false);
      },
    });
  }
}
