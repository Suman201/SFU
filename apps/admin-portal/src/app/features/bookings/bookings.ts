import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize, timer } from 'rxjs';
import {
  formatMoneyWithCode,
  majorToMinor,
  SUPPORTED_CURRENCIES,
  type AdminBookingDetail,
  type AdminBookingPage,
  type AdminBookingQuery,
} from '@native-sfu/contracts';
import {
  AdminOperationsApi,
  adminOperationError,
  saveAdminBlob,
} from '../../core/services/admin-operations-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
@Component({
  selector: 'sfu-admin-bookings',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './bookings.html',
  styleUrl: '../../shared/admin-operations.scss',
})
export class AdminBookings {
  private readonly api = inject(AdminOperationsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly confirm = inject(ConfirmDialogService);
  protected readonly auth = inject(AuthService);
  protected readonly exact = formatMoneyWithCode;
  protected readonly currencies = SUPPORTED_CURRENCIES;
  protected readonly data = signal<AdminBookingPage>({
    items: [],
    total: 0,
    page: 1,
    limit: 25,
  });
  protected readonly selected = signal<AdminBookingDetail | null>(null);
  protected readonly busy = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected query: AdminBookingQuery = { page: 1, limit: 25 };
  protected amount = '';
  protected reason = '';
  private requestId = crypto.randomUUID();
  private requestVersion = 0;
  private detailVersion = 0;
  private polling = false;
  protected readonly statuses = [
    'awaiting_payment',
    'processing',
    'confirmed',
    'expired',
    'cancelled',
    'refund_pending',
    'refunded',
    'payment_review',
  ] as const;
  constructor() {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((params) => {
        this.query = {
          page: Number(params.get('page') || 1),
          limit: Number(params.get('limit') || 25),
          search: params.get('search') || '',
          status: (params.get('status') ||
            'all') as AdminBookingQuery['status'],
          kind: (params.get('kind') || 'all') as AdminBookingQuery['kind'],
          currency:
            (params.get('currency') as AdminBookingQuery['currency']) ||
            undefined,
          dateFrom: params.get('dateFrom') || '',
          dateTo: params.get('dateTo') || '',
          refundStatus:
            (params.get('refundStatus') as AdminBookingQuery['refundStatus']) ||
            undefined,
        };
        this.load();
        const id = params.get('orderId');
        if (id && id !== this.selected()?.id) this.openId(id);
        if (!id) this.selected.set(null);
      });
    timer(5000, 5000)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe(() => {
        const item = this.selected();
        if (
          item &&
          !this.polling &&
          !this.busy() &&
          (item.status === 'refund_pending' ||
            item.refunds.some(
              (refund) =>
                refund.status === 'queued' || refund.status === 'pending',
            ))
        )
          this.refreshDetail(true);
      });
  }
  protected load() {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.api
      .bookings(this.query)
      .pipe(
        finalize(() => {
          if (version === this.requestVersion) this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (page) => {
          if (version === this.requestVersion) {
            this.data.set(page);
            this.error.set('');
          }
        },
        error: (error) => {
          if (version === this.requestVersion)
            this.error.set(adminOperationError(error));
        },
      });
  }
  protected apply() {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...this.query, page: 1, orderId: this.selected()?.id },
      replaceUrl: false,
    });
  }
  protected reset() {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: 1, limit: 25 },
    });
  }
  protected page(change: number) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        ...this.query,
        page: this.data().page + change,
        orderId: this.selected()?.id,
      },
    });
  }
  protected open(item: AdminBookingDetail) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...this.query, orderId: item.id },
    });
  }
  private openId(id: string) {
    const version = ++this.detailVersion;
    this.selected.set(null);
    this.reason = '';
    this.amount = '';
    this.requestId = crypto.randomUUID();
    this.api
      .booking(id)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (item) => {
          if (version === this.detailVersion) this.selected.set(item);
        },
        error: (error) => {
          if (version === this.detailVersion)
            this.error.set(adminOperationError(error));
        },
      });
  }
  protected close() {
    ++this.detailVersion;
    this.selected.set(null);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...this.query },
    });
  }
  protected refreshDetail(quiet = false) {
    const item = this.selected();
    if (!item || this.polling) return;
    this.polling = true;
    this.api
      .booking(item.id, quiet)
      .pipe(
        finalize(() => (this.polling = false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          if (this.selected()?.id === value.id) this.selected.set(value);
        },
        error: (error) => {
          if (!quiet) this.error.set(adminOperationError(error));
        },
      });
  }
  protected export() {
    this.api
      .bookingsCsv(this.query)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (blob) => saveAdminBlob(blob, 'bookings.csv'),
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected download(creditId?: string) {
    const order = this.selected();
    if (!order) return;
    this.api
      .billingDocument(order.id, creditId)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (blob) =>
          saveAdminBlob(
            blob,
            (creditId ? 'credit-note-' : 'invoice-') + order.id + '.pdf',
          ),
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected async reconcile() {
    const item = this.selected();
    if (!item || this.busy()) return;
    if (this.reason.trim().length < 5) {
      this.error.set('Add a reason of at least five characters.');
      return;
    }
    this.busy.set(true);
    this.api
      .reconcile(item.id, this.reason.trim())
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          this.selected.set(value);
          this.notice.set(
            value.status === 'payment_review'
              ? 'The provider still does not match the agreed order. The payment remains under review.'
              : 'Provider verification completed.',
          );
          this.load();
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected async refund(event: SubmitEvent) {
    event.preventDefault();
    const item = this.selected();
    if (
      !item ||
      this.busy() ||
      !(event.target as HTMLFormElement).reportValidity()
    )
      return;
    let amount: number;
    try {
      amount = majorToMinor(this.amount, item.price.currency);
      if (
        amount < 1 ||
        amount >
          item.price.amountMinor - item.refundedMinor - item.refundPendingMinor
      )
        throw new Error(
          'Enter an amount within the remaining verified balance.',
        );
    } catch (error) {
      this.error.set(adminOperationError(error));
      return;
    }
    if (
      !(await this.confirm.confirm({
        title: 'Refund original payment?',
        message:
          'Return ' +
          this.exact({ amountMinor: amount, currency: item.price.currency }) +
          ' to the original method. A full refund cancels access.',
        confirmLabel: 'Request refund',
        variant: 'danger',
      }))
    )
      return;
    this.busy.set(true);
    this.api
      .refund(item.id, amount, this.reason.trim(), this.requestId)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.requestId = crypto.randomUUID();
          this.notice.set(
            'Refund requested. Completion depends on provider confirmation.',
          );
          this.refreshDetail();
          this.load();
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected canRetry(id: string) {
    const refunds = this.selected()?.refunds ?? [];
    const root =
      refunds.find((refund) => refund.id === id)?.retryOfRefundId ?? id;
    return !refunds.some(
      (refund) => refund.retryOfRefundId === root && refund.status !== 'failed',
    );
  }
  protected async retry(id: string) {
    const item = this.selected();
    if (!item || this.busy()) return;
    if (this.reason.trim().length < 5) {
      this.error.set('Add a reason for retrying this refund.');
      return;
    }
    if (
      !(await this.confirm.confirm({
        title: 'Retry failed refund?',
        message:
          'Create a new request for the same amount. The failed request stays in history.',
        confirmLabel: 'Retry refund',
        variant: 'danger',
      }))
    )
      return;
    this.busy.set(true);
    this.api
      .retryRefund(item.id, id, this.reason.trim(), this.requestId)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          this.selected.set(value);
          this.requestId = crypto.randomUUID();
          this.notice.set('Refund retry queued.');
          this.load();
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected date(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
