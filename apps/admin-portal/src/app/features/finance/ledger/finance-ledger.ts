import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LEDGER_ENTRY_TYPES, type GatewayEventRecord, type LedgerEntryRecord, type ReconciliationReport } from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { FinanceApi, financeError } from '../../../core/services/finance-api.service';
import { FinanceTabs } from '../finance-tabs';
import { ACCOUNT_LABELS, ENTRY_LABELS, money } from '../finance-shared';

@Component({
  selector: 'sfu-finance-ledger',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, FinanceTabs],
  templateUrl: './finance-ledger.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceLedgerPage implements OnInit {
  private readonly api = inject(FinanceApi);
  private readonly auth = inject(AuthService);
  protected readonly report = signal<ReconciliationReport | null>(null);
  protected readonly entries = signal<LedgerEntryRecord[]>([]);
  protected readonly events = signal<GatewayEventRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly limit = signal(50);
  protected readonly type = signal('all');
  protected readonly eventStatus = signal('failed');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly money = money;
  protected readonly types = LEDGER_ENTRY_TYPES;
  protected readonly entryLabels = ENTRY_LABELS;
  protected readonly accountLabels = ACCOUNT_LABELS;
  protected readonly superAdmin = computed(() => (this.auth.user()?.roles ?? []).map((role) => role.toUpperCase()).includes('SUPER_ADMIN'));
  protected readonly issues = computed(() => {
    const report = this.report();
    if (!report) return 0;
    return report.unbalancedEntries + report.paymentsMissingLedger.length + report.paymentsWithMismatchedSplit.length + report.paymentsAwaitingEnrollment.length + report.failedEvents.length;
  });

  ngOnInit(): void {
    this.checkReconciliation();
    this.loadEntries(1);
    this.loadEvents();
  }

  protected checkReconciliation(): void {
    this.api.reconciliation().subscribe({ next: (report) => this.report.set(report), error: (error) => this.error.set(financeError(error)) });
  }

  protected loadEntries(page = this.page()): void {
    this.loading.set(true);
    this.api.ledger({ type: this.type(), page }).subscribe({
      next: (result) => {
        this.entries.set(result.items);
        this.total.set(result.total);
        this.page.set(result.page);
        this.limit.set(result.limit);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(financeError(error, 'Ledger entries could not be loaded.'));
        this.loading.set(false);
      },
    });
  }

  protected loadEvents(): void {
    this.api.events({ status: this.eventStatus() }).subscribe({ next: (result) => this.events.set(result.items), error: () => undefined });
  }

  protected repair(): void {
    this.busy.set(true);
    this.success.set('');
    this.api.repair().subscribe({
      next: (report) => {
        this.busy.set(false);
        this.report.set(report);
        this.success.set('Settlement steps were re-run for flagged payments.');
        this.loadEntries(1);
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(financeError(error));
      },
    });
  }

  protected retry(event: GatewayEventRecord): void {
    this.busy.set(true);
    this.api.retryEvent(event.id).subscribe({
      next: (updated) => {
        this.busy.set(false);
        this.success.set(updated.status === 'done' ? 'Event processed.' : `Event still ${updated.status}: ${updated.lastError ?? ''}`);
        this.loadEvents();
        this.checkReconciliation();
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(financeError(error));
      },
    });
  }

  protected setType(value: string): void {
    this.type.set(value);
    this.loadEntries(1);
  }

  protected setEventStatus(value: string): void {
    this.eventStatus.set(value);
    this.loadEvents();
  }
}
