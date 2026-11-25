import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { DisputeRecord, RefundRecord } from '@native-sfu/contracts';
import { FinanceApi, financeError } from '../../../core/services/finance-api.service';
import { FinanceTabs } from '../finance-tabs';
import { DISPUTE_LABELS, disputeTone, money, refundTone } from '../finance-shared';

type View = 'refunds' | 'disputes';

@Component({
  selector: 'sfu-finance-refunds',
  standalone: true,
  imports: [DatePipe, RouterLink, FinanceTabs],
  templateUrl: './finance-refunds.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceRefundsPage implements OnInit {
  private readonly api = inject(FinanceApi);
  private readonly route = inject(ActivatedRoute);
  protected readonly view = signal<View>('refunds');
  protected readonly status = signal('all');
  protected readonly refunds = signal<RefundRecord[]>([]);
  protected readonly disputes = signal<DisputeRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly money = money;
  protected readonly refundTone = refundTone;
  protected readonly disputeTone = disputeTone;
  protected readonly disputeLabels = DISPUTE_LABELS;

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get('view') === 'disputes') {
      this.view.set('disputes');
      this.status.set('open');
    }
    this.load(1);
  }

  protected setView(view: View): void {
    this.view.set(view);
    this.status.set(view === 'disputes' ? 'open' : 'all');
    this.load(1);
  }

  protected setStatus(status: string): void {
    this.status.set(status);
    this.load(1);
  }

  protected statusOptions(): Array<{ value: string; label: string }> {
    return this.view() === 'refunds'
      ? [
          { value: 'all', label: 'All' },
          { value: 'pending', label: 'Pending' },
          { value: 'succeeded', label: 'Succeeded' },
          { value: 'failed', label: 'Failed' },
        ]
      : [
          { value: 'open', label: 'Open' },
          { value: 'won', label: 'Won' },
          { value: 'lost', label: 'Lost' },
          { value: 'all', label: 'All' },
        ];
  }

  protected load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    const done = (result: { total: number; page: number; limit: number }) => {
      this.total.set(result.total);
      this.page.set(result.page);
      this.limit.set(result.limit);
      this.loading.set(false);
    };
    const fail = (error: unknown) => {
      this.error.set(financeError(error, 'Records could not be loaded.'));
      this.loading.set(false);
    };
    if (this.view() === 'refunds') {
      this.api.refunds({ status: this.status(), page }).subscribe({ next: (result) => (this.refunds.set(result.items), done(result)), error: fail });
    } else {
      this.api.disputes({ status: this.status(), page }).subscribe({ next: (result) => (this.disputes.set(result.items), done(result)), error: fail });
    }
  }
}
