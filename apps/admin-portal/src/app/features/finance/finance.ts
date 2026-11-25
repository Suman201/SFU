import { AuthService } from '../../core/services/auth.service';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import {
  formatMoneyWithCode,
  type AdminFinanceReport,
  type CurrencyCode,
} from '@native-sfu/contracts';
import {
  AdminOperationsApi,
  adminOperationError,
  saveAdminBlob,
} from '../../core/services/admin-operations-api.service';
@Component({
  selector: 'sfu-admin-finance',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './finance.html',
  styleUrls: ['../../shared/admin-operations.scss', './finance.scss'],
})
export class AdminFinance {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(AdminOperationsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  protected readonly exact = formatMoneyWithCode;
  protected readonly report = signal<AdminFinanceReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly currency = signal<CurrencyCode | null>(null);
  protected dateFrom = '';
  protected dateTo = '';
  private version = 0;
  protected readonly chart = computed(
    () =>
      this.report()
        ?.days.filter((day) => day.currency === this.currency())
        .slice(-31) ?? [],
  );
  protected readonly maximum = computed(() =>
    Math.max(
      1,
      ...this.chart().flatMap((day) => [day.collectedMinor, day.refundedMinor]),
    ),
  );
  constructor() {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((params) => {
        this.dateTo =
          params.get('dateTo') || new Date().toISOString().slice(0, 10);
        this.dateFrom =
          params.get('dateFrom') ||
          new Date(
            (Number.isFinite(Date.parse(this.dateTo + 'T00:00:00Z'))
              ? Date.parse(this.dateTo + 'T00:00:00Z')
              : Date.now()) -
              29 * 86400000,
          )
            .toISOString()
            .slice(0, 10);
        this.load();
      });
  }
  protected apply() {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { dateFrom: this.dateFrom, dateTo: this.dateTo },
    });
  }
  protected load() {
    const version = ++this.version;
    this.loading.set(true);
    this.api
      .finance(this.dateFrom, this.dateTo)
      .pipe(
        finalize(() => {
          if (version === this.version) this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (report) => {
          if (version !== this.version) return;
          this.report.set(report);
          if (
            !report.currencies.some((item) => item.currency === this.currency())
          )
            this.currency.set(report.currencies[0]?.currency ?? null);
          this.error.set('');
        },
        error: (error) => {
          if (version === this.version) {
            this.report.set(null);
            this.currency.set(null);
            this.error.set(adminOperationError(error));
          }
        },
      });
  }
  protected export() {
    const report = this.report();
    if (!report) return;
    const lines = [
      [
        'date',
        'currency',
        'created_bookings',
        'paid_bookings',
        'cancellations',
        'collected_minor',
        'refunded_minor',
        'net_collected_minor',
      ].join(','),
      ...report.days.map((day) =>
        [
          day.date,
          day.currency,
          day.createdBookings,
          day.paidBookings,
          day.cancellations,
          day.collectedMinor,
          day.refundedMinor,
          day.netCollectedMinor,
        ].join(','),
      ),
    ];
    saveAdminBlob(
      new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
      'booking-finance-' + report.dateFrom + '-' + report.dateTo + '.csv',
    );
  }
}
