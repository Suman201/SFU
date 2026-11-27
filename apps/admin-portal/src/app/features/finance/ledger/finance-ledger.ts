import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LEDGER_ENTRY_TYPES, majorToMinor, splitCommission, type BookingEarningsReview, type GatewayEventRecord, type LedgerEntryRecord, type ReconciliationReport } from '@native-sfu/contracts';
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
  private readonly confirm = inject(ConfirmDialogService);
  protected readonly auth = inject(AuthService);
  protected readonly report = signal<ReconciliationReport | null>(null);
  protected readonly legacyBookings = signal<BookingEarningsReview[]>([]);
  protected readonly legacyPage = signal(1);
  protected readonly legacyTotal = signal(0);
  protected readonly review = signal<BookingEarningsReview | null>(null);
  protected readonly reviewCommission = signal('15');
  protected readonly reviewHoldDays = signal('7');
  protected readonly reviewReason = signal('');
  protected readonly reviewAllocation = computed(() => {
    const order = this.review();
    if (!order) return null;
    try { const bps = majorToMinor(this.reviewCommission(), 'USD'); if (bps > 10000) return null; return splitCommission(order.netMinor, bps); } catch { return null; }
  });
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
    return report.unbalancedEntries + report.paymentsMissingLedger.length + report.paymentsWithMismatchedSplit.length + report.paymentsAwaitingEnrollment.length + report.failedEvents.length + (report.bookingEarnings?.missingCaptureOrderIds.length ?? 0) + (report.bookingEarnings?.missingRefundOrderIds.length ?? 0) + (report.bookingEarnings?.missingReleaseOrderIds.length ?? 0) + (report.bookingEarnings?.mismatchedOrderIds.length ?? 0);
  });

  ngOnInit(): void {
    this.checkReconciliation();
    this.loadLegacy(1);
    this.loadEntries(1);
    this.loadEvents();
  }

  protected checkReconciliation(bookingAfter?: string): void {
    this.api.reconciliation(bookingAfter).subscribe({ next: (report) => this.report.set(report), error: (error) => this.error.set(financeError(error)) });
  }

  protected loadLegacy(page: number): void {
    this.api.legacyBookingEarnings(page).subscribe({ next: result => { this.legacyBookings.set(result.items); this.legacyTotal.set(result.total); this.legacyPage.set(result.page); }, error: error => this.error.set(financeError(error)) });
  }

  protected beginReview(order: BookingEarningsReview): void {
    if (!this.auth.isSuperAdmin()) return;
    this.review.set(order); this.reviewReason.set('');
  }

  protected async adoptReview(): Promise<void> {
    const order = this.review(), allocation = this.reviewAllocation(), holdDays = Number(this.reviewHoldDays());
    if (!this.auth.isSuperAdmin() || !order || !allocation || this.busy()) return;
    if (!Number.isInteger(holdDays) || holdDays < 0 || holdDays > 90 || this.reviewReason().trim().length < 10) { this.error.set('Choose 0–90 whole holding days and explain the historical commission policy.'); return; }
    const confirmed = await this.confirm.confirm({ title: 'Approve historical booking earnings?', message: `Record ${this.money(allocation.teacherMinor, order.currency)} in teacher earnings and ${this.money(allocation.commissionMinor, order.currency)} in platform commission for ${order.title}. Existing refunds are deducted before earnings can be released.`, confirmLabel: 'Approve earnings policy', variant: 'warning' });
    if (!confirmed) return;
    this.busy.set(true); this.error.set('');
    this.api.adoptBookingEarnings(order.orderId, { commissionBps: majorToMinor(this.reviewCommission(), 'USD'), holdDays, reason: this.reviewReason().trim(), expectedUpdatedAt: order.updatedAt }).subscribe({
      next: report => { this.busy.set(false); this.report.set(report); this.review.set(null); this.success.set('The reviewed booking and its confirmed refunds are recorded in earnings.'); this.loadLegacy(1); this.loadEntries(1); },
      error: error => { this.busy.set(false); this.error.set(financeError(error)); },
    });
  }

  protected repairBooking(id: string): void {
    if (!this.auth.isSuperAdmin() || this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.api.repairBookingEarnings(id).subscribe({ next: report => { this.busy.set(false); this.report.set(report); this.success.set('Missing booking entries were restored from verified invoices and credit notes.'); this.loadEntries(1); }, error: error => { this.busy.set(false); this.error.set(financeError(error)); } });
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
    if (!this.auth.isSuperAdmin()) return;
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
    if (!this.auth.can('admin:finance:write')) return;
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
