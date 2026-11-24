import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { formatMoneyWithCode, type BookingOrder } from '@native-sfu/contracts';
import { BookingsApi } from '../../core/services/bookings-api.service';
import { AuthService } from '../../core/services/auth.service';
import { CurrencyService } from '../../core/services/currency.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';

@Component({
  selector: 'sfu-booking-order',
  standalone: true,
  imports: [FormsModule, RouterLink, Header, Footer],
  templateUrl: './booking-order.html',
  styleUrl: './booking.scss',
})
export class BookingOrderPage {
  protected readonly auth = inject(AuthService);
  protected readonly money = inject(CurrencyService);
  protected readonly exact = formatMoneyWithCode;
  private readonly api = inject(BookingsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroy = inject(DestroyRef);
  protected readonly order = signal<BookingOrder | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly loading = signal(true);
  protected reason = '';
  private readonly cancelRequest = crypto.randomUUID();
  private readonly id = this.route.snapshot.paramMap.get('orderId')!;
  private polling = false;
  constructor() {
    this.refresh();
    if (this.route.snapshot.queryParamMap.get('checkout') === 'returned')
      this.api
        .refreshPayment(this.id)
        .pipe(takeUntilDestroyed(this.destroy))
        .subscribe({
          next: (order) => this.order.set(order),
          error: () => undefined,
        });
    const timer = setInterval(() => {
      if (
        this.order() &&
        !this.busy() &&
        !this.polling &&
        ['awaiting_payment', 'processing', 'refund_pending'].includes(
          this.order()!.status,
        )
      )
        this.refresh(true);
    }, 3000);
    this.destroy.onDestroy(() => clearInterval(timer));
  }
  protected refresh(quiet = false): void {
    if (this.polling) return;
    this.polling = true;
    this.api
      .order(this.id, quiet)
      .pipe(
        finalize(() => {
          this.polling = false;
          this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (order) => {
          this.order.set(order);
          if (!quiet) this.error.set('');
        },
        error: () => {
          if (!quiet)
            this.error.set(
              'This booking could not be loaded. Try again or return to your bookings.',
            );
        },
      });
  }
  protected pay(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api
      .checkout(this.id)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (order) => {
          this.order.set(order);
          if (order.status === 'awaiting_payment' && order.checkoutUrl) {
            const destination = new URL(order.checkoutUrl);
            if (
              destination.protocol !== 'https:' ||
              destination.hostname !== 'checkout.stripe.com'
            ) {
              this.error.set(
                'The payment destination could not be verified. Please contact support.',
              );
              return;
            }
            window.location.assign(destination.toString());
          }
        },
        error: () =>
          this.error.set(
            'Checkout could not be opened. Your reservation is still shown below; refresh or try again.',
          ),
      });
  }
  protected cancel(): void {
    if (this.busy() || this.reason.trim().length < 5) {
      this.error.set('Add a cancellation reason of at least five characters.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api
      .cancel(this.id, this.reason.trim(), this.cancelRequest)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (order) => this.order.set(order),
        error: () =>
          this.error.set(
            'This booking could not be cancelled. The cancellation deadline may have passed; contact support if you need help.',
          ),
      });
  }
  protected download(creditId?: string): void {
    this.api
      .document(this.id, creditId)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${creditId ? 'credit-note' : 'invoice'}-${this.id}.pdf`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        error: () =>
          this.error.set(
            'The billing document is not available yet. Try again shortly.',
          ),
      });
  }
  protected date(instant: string): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(instant));
  }
  protected statusText(status: BookingOrder['status']): string {
    return {
      awaiting_payment: 'Reserved — awaiting payment',
      processing: 'Payment processing',
      confirmed: 'Booking confirmed',
      expired: 'Reservation expired',
      cancelled: 'Booking cancelled',
      refund_pending: 'Refund in progress',
      refunded: 'Payment refunded',
      payment_review: 'Payment needs review',
    }[status];
  }
}
