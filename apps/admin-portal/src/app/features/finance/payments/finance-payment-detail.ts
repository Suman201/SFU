import { AuthService } from '../../../core/services/auth.service';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { fromMinorUnits, majorToMinor, type AdminPaymentRecord, type PaymentGatewayStatus } from '@native-sfu/contracts';
import { FinanceApi, downloadBlob, financeError, newRequestId } from '../../../core/services/finance-api.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { FinanceTabs } from '../finance-tabs';
import { ACCOUNT_LABELS, ENTRY_LABELS, money, paymentLabel, paymentTone, refundTone } from '../finance-shared';

@Component({
  selector: 'sfu-finance-payment-detail',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, FinanceTabs],
  templateUrl: './finance-payment-detail.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinancePaymentDetailPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(FinanceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmDialog = inject(ConfirmDialogService);
  protected readonly payment = signal<AdminPaymentRecord | null>(null);
  protected readonly gateway = signal<PaymentGatewayStatus | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly busy = signal(false);
  protected readonly refundAmount = signal('');
  protected readonly refundReason = signal('');
  private refundKey = newRequestId();
  protected readonly money = money;
  protected readonly label = paymentLabel;
  protected readonly tone = paymentTone;
  protected readonly refundTone = refundTone;
  protected readonly entryLabels = ENTRY_LABELS;
  protected readonly accountLabels = ACCOUNT_LABELS;

  protected readonly refundable = computed(() => {
    const payment = this.payment();
    if (!payment) return 0;
    const pending = payment.refunds.filter((refund) => refund.status === 'pending').reduce((sum, refund) => sum + refund.amountMinor, 0);
    return ['succeeded', 'partially_refunded'].includes(payment.status) && payment.disputeState !== 'open' && payment.disputeState !== 'lost'
      ? payment.amountMinor - payment.refundedMinor - pending
      : 0;
  });

  ngOnInit(): void {
    this.api.status().subscribe({ next: (status) => this.gateway.set(status), error: () => undefined });
    this.load();
  }

  private id(): string {
    return this.route.snapshot.paramMap.get('id') ?? '';
  }

  protected load(): void {
    this.api.payment(this.id()).subscribe({
      next: (payment) => {
        this.payment.set(payment);
        if (!this.refundAmount()) {
          const remaining = this.refundable();
          if (remaining > 0) this.refundAmount.set(fromMinorUnits(remaining, payment.currency).toFixed(2));
        }
      },
      error: (error) => this.error.set(financeError(error, 'Payment not found.')),
    });
  }

  protected async refund(): Promise<void> {
    if (!this.auth.can('admin:finance:write')) return;
    const payment = this.payment();
    if (!payment) return;
    const value = Number(this.refundAmount());
    if (!Number.isFinite(value) || value <= 0) {
      this.error.set('Enter a refund amount.');
      return;
    }
    let amountMinor: number;
    try { amountMinor = majorToMinor(this.refundAmount(), payment.currency); }
    catch (error) { this.error.set(error instanceof Error ? error.message : 'Enter an exact refund amount.'); return; }
    if (amountMinor > this.refundable()) {
      this.error.set(`You can refund at most ${money(this.refundable(), payment.currency)}.`);
      return;
    }
    if (this.refundReason().trim().length < 5) {
      this.error.set('Add a short reason for the refund (at least 5 characters).');
      return;
    }
    const full = amountMinor === this.refundable();
    const confirmed = await this.confirmDialog.confirm({
      title: full ? 'Refund the remaining amount?' : 'Issue a partial refund?',
      message: `${money(amountMinor, payment.currency)} will be returned to ${payment.studentName}'s card. Commission and the teacher share are reversed in proportion.${full && payment.enrollmentState === 'granted' && payment.refundedMinor + amountMinor === payment.amountMinor ? ' The student will lose access to this class.' : ''}`,
      confirmLabel: 'Refund',
      pendingLabel: 'Refunding…',
      variant: 'danger',
    });
    if (!confirmed) return;
    this.busy.set(true);
    this.error.set('');
    this.success.set('');
    this.api.refund(payment.id, { amountMinor, reason: this.refundReason().trim(), requestId: this.refundKey }).subscribe({
      next: (refund) => {
        this.busy.set(false);
        this.refundKey = newRequestId();
        this.refundReason.set('');
        this.refundAmount.set('');
        this.success.set(
          refund.status === 'succeeded'
            ? `Refunded ${money(refund.amountMinor, refund.currency)}.`
            : refund.status === 'pending'
              ? 'Refund sent to the payment provider. It will complete when the provider confirms it.'
              : `Refund failed: ${refund.failureReason ?? 'declined by the provider'}.`,
        );
        this.load();
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(financeError(error, 'The refund could not be issued.'));
      },
    });
  }

  protected simulateDispute(status: 'needs_response' | 'won' | 'lost'): void {
    if (!this.auth.can('admin:finance:write')) return;
    this.busy.set(true);
    this.api.testDispute(this.id(), status).subscribe({
      next: (payment) => {
        this.busy.set(false);
        this.payment.set(payment);
        this.success.set(`Test dispute set to ${status.replace('_', ' ')}.`);
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(financeError(error));
      },
    });
  }

  protected receipt(): void {
    const payment = this.payment();
    if (!payment?.receiptNumber) return;
    this.api.receipt(payment.id).subscribe({
      next: (blob) => downloadBlob(blob, `${payment.receiptNumber}.pdf`),
      error: (error) => this.error.set(financeError(error, 'The receipt could not be downloaded.')),
    });
  }
}
