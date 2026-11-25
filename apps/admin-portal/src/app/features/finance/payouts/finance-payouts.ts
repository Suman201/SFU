import { AuthService } from '../../../core/services/auth.service';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { PayoutRecord } from '@native-sfu/contracts';
import { FinanceApi, financeError } from '../../../core/services/finance-api.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { FinanceTabs } from '../finance-tabs';
import { initials, money, payoutLabel, payoutTone } from '../finance-shared';

type PayoutFilter = 'open' | 'paid' | 'rejected' | 'failed' | 'all';

@Component({
  selector: 'sfu-finance-payouts',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, FinanceTabs],
  templateUrl: './finance-payouts.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinancePayoutsPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(FinanceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmDialog = inject(ConfirmDialogService);
  protected readonly rows = signal<PayoutRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly loading = signal(true);
  protected readonly savingId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly filter = signal<PayoutFilter>('open');
  protected readonly note = signal('');
  protected readonly money = money;
  protected readonly label = payoutLabel;
  protected readonly tone = payoutTone;
  protected readonly initials = initials;
  protected readonly filters: Array<{ value: PayoutFilter; label: string }> = [
    { value: 'open', label: 'Needs decision' },
    { value: 'paid', label: 'Paid' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'failed', label: 'Failed' },
    { value: 'all', label: 'All' },
  ];

  ngOnInit(): void {
    const status = this.route.snapshot.queryParamMap.get('status') as PayoutFilter | null;
    if (status && this.filters.some((item) => item.value === status)) this.filter.set(status);
    this.load(1);
  }

  protected load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api.payouts({ status: this.filter(), page }).subscribe({
      next: (result) => {
        this.rows.set(result.items);
        this.total.set(result.total);
        this.page.set(result.page);
        this.limit.set(result.limit);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(financeError(error, 'Payouts could not be loaded.'));
        this.loading.set(false);
      },
    });
  }

  protected setFilter(value: PayoutFilter): void {
    this.filter.set(value);
    this.load(1);
  }

  protected async approve(row: PayoutRecord): Promise<void> {
    if (!this.auth.can('admin:finance:write')) return;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Send this payout?',
      message: `${money(row.amountMinor, row.currency)} will be transferred to ${row.teacherName}'s payout account. This cannot be undone from Sapiovian.`,
      confirmLabel: 'Send payout',
      pendingLabel: 'Sending…',
      variant: 'warning',
    });
    if (!confirmed) return;
    this.run(row, this.api.approvePayout(row.id, this.note().trim() || undefined), (payout) =>
      payout.status === 'paid' ? `Sent ${money(payout.amountMinor, payout.currency)} to ${payout.teacherName}.` : `Payout ${payout.status}: ${payout.failureReason ?? ''}`,
    );
  }

  protected async reject(row: PayoutRecord): Promise<void> {
    if (!this.auth.can('admin:finance:write')) return;
    if (this.note().trim().length < 5) {
      this.error.set('Write the reason for rejecting in the note field first. The teacher will see it.');
      return;
    }
    const confirmed = await this.confirmDialog.confirm({
      title: 'Reject this payout?',
      message: `The ${money(row.amountMinor, row.currency)} request returns to ${row.teacherName}'s available balance.`,
      confirmLabel: 'Reject',
      variant: 'danger',
    });
    if (!confirmed) return;
    this.run(row, this.api.rejectPayout(row.id, this.note().trim()), () => 'Payout rejected and returned to the teacher balance.');
  }

  private run(row: PayoutRecord, request: ReturnType<FinanceApi['approvePayout']>, message: (payout: PayoutRecord) => string): void {
    this.savingId.set(row.id);
    this.error.set('');
    this.success.set('');
    request.subscribe({
      next: (payout) => {
        this.savingId.set(null);
        this.note.set('');
        this.success.set(message(payout));
        this.load();
      },
      error: (error) => {
        this.savingId.set(null);
        this.error.set(financeError(error));
        this.load();
      },
    });
  }
}
