import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { formatPaymentMoney, type StudentPaymentRecord } from '@native-sfu/contracts';
import { PaymentsApi, paymentErrorMessage } from '../../../core/services/payments.service';

/**
 * Stand-in for the hosted Stripe Checkout page when the backend runs the
 * development test gateway. No card is collected and no money moves.
 */
@Component({
  selector: 'sfu-test-checkout',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './test-checkout.html',
  styleUrl: '../payment-pages.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class TestCheckout implements OnInit {
  private readonly api = inject(PaymentsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly payment = signal<StudentPaymentRecord | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<'succeed' | 'decline' | null>(null);
  protected readonly money = formatPaymentMoney;

  ngOnInit(): void {
    this.api.one(this.id()).subscribe({
      next: (payment) => this.payment.set(payment),
      error: (error) => this.error.set(paymentErrorMessage(error, 'This checkout could not be found.')),
    });
  }

  private id(): string {
    return this.route.snapshot.paramMap.get('paymentId') ?? '';
  }

  protected complete(outcome: 'succeed' | 'decline'): void {
    this.busy.set(outcome);
    this.error.set('');
    this.api.testComplete(this.id(), outcome).subscribe({
      next: (payment) => {
        this.busy.set(null);
        if (outcome === 'succeed') {
          void this.router.navigate(['/payments', payment.id], { queryParams: { checkout: 'success' } });
        } else {
          this.payment.set(payment);
          this.error.set(payment.failureReason ?? 'The card was declined.');
        }
      },
      error: (error) => {
        this.busy.set(null);
        this.error.set(paymentErrorMessage(error, 'The test payment could not be completed.'));
      },
    });
  }

  protected back(): void {
    void this.router.navigate(['/payments', this.id()], { queryParams: { checkout: 'cancelled' } });
  }
}
