import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize, map } from 'rxjs';
import {
  formatMoneyWithCode,
  majorToMinor,
  type BookingOrder,
} from '@native-sfu/contracts';
import { API_BASE_URL } from '../../core/services/app-environment';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';

@Component({
  selector: 'sfu-admin-bookings',
  standalone: true,
  imports: [FormsModule],
  template: ` <section class="bookings-admin">
    <header>
      <p class="eyebrow">BUSINESS</p>
      <h1>Bookings and refunds</h1>
      <p>
        Review payment status and return verified payments to their original
        method.
      </p>
    </header>
    @if (error()) {
      <p class="table-error" role="alert">{{ error() }}</p>
    }
    @if (notice()) {
      <p role="status">{{ notice() }}</p>
    }
    <section class="data-table-shell">
      <div class="data-table-toolbar">
        <h2>Recent bookings</h2>
        <button
          type="button"
          class="table-action"
          [disabled]="busy()"
          (click)="load()"
        >
          Refresh
        </button>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Booking</th>
              <th>Student</th>
              <th>Teacher</th>
              <th>Starts</th>
              <th>Paid total</th>
              <th>Refunded / pending</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            @for (order of orders(); track order.id) {
              <tr>
                <td>
                  <strong>{{ order.title }}</strong
                  ><small>{{ order.id }}</small>
                </td>
                <td>{{ order.studentName }}</td>
                <td>{{ order.teacherName }}</td>
                <td>{{ date(order.startsAt) }}</td>
                <td>{{ exact(order.price) }}</td>
                <td>
                  {{
                    exact({
                      amountMinor: order.refundedMinor,
                      currency: order.price.currency,
                    })
                  }}
                  /
                  {{
                    exact({
                      amountMinor: order.refundPendingMinor,
                      currency: order.price.currency,
                    })
                  }}
                </td>
                <td>
                  <span class="data-pill">{{
                    order.status.replaceAll('_', ' ')
                  }}</span>
                </td>
                <td>
                  <button
                    class="table-action"
                    type="button"
                    (click)="select(order)"
                  >
                    Manage
                  </button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="8">
                  {{ busy() ? 'Loading bookings…' : 'No bookings yet.' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="data-table-footer">{{ orders().length }} recent bookings</div>
    </section>
    @if (selected(); as order) {
      <section class="refund-editor">
        <div>
          <h2>{{ order.title }}</h2>
          <p>Booking {{ order.id }}</p>
          <p>
            Confirmed refunds:
            {{
              exact({
                amountMinor: order.refundedMinor,
                currency: order.price.currency,
              })
            }}. Pending refunds:
            {{
              exact({
                amountMinor: order.refundPendingMinor,
                currency: order.price.currency,
              })
            }}.
          </p>
        </div>
        @if (
          order.paidAt &&
          order.price.amountMinor >
            order.refundedMinor + order.refundPendingMinor
        ) {
          <form (ngSubmit)="refund($event)">
            <label
              >Refund amount ({{ order.price.currency }})<input
                name="amount"
                [(ngModel)]="amount"
                inputmode="decimal"
                required /></label
            ><label
              >Reason<textarea
                name="reason"
                [(ngModel)]="reason"
                required
                minlength="5"
                maxlength="500"
                rows="3"
              ></textarea>
            </label>
            <p>
              A full refund cancels class access. Partial refunds preserve the
              booking. End a live lesson before issuing its full refund.
            </p>
            <button class="primary" type="submit" [disabled]="busy()">
              Review refund
            </button>
          </form>
        } @else {
          <p>This order has no unrefunded verified balance available.</p>
        }
        <ul>
          @for (item of order.refunds; track item.id) {
            <li>
              {{
                exact({
                  amountMinor: item.amountMinor,
                  currency: item.currency,
                })
              }}
              · {{ item.status }} · {{ item.reason }}
            </li>
          }
        </ul>
        <button type="button" class="table-action" (click)="selected.set(null)">
          Close
        </button>
      </section>
    }
  </section>`,
  styles: [
    `
      :host {
        display: block;
      }
      .bookings-admin {
        padding: 26px;
        display: grid;
        gap: 22px;
      }
      h1 {
        margin: 5px 0;
        font-size: 28px;
        letter-spacing: -0.035em;
      }
      h2 {
        font-size: 17px;
        margin: 0;
      }
      p {
        font-size: 13px;
        color: var(--muted);
        line-height: 1.7;
      }
      .eyebrow {
        font-size: 10px;
        letter-spacing: 0.16em;
        color: var(--brand-green, #458b73);
        font-weight: 700;
      }
      .refund-editor {
        max-width: 700px;
        padding: 24px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        display: grid;
        gap: 18px;
      }
      form,
      label {
        display: grid;
        gap: 10px;
      }
      form {
        gap: 17px;
      }
      label {
        font-size: 12px;
      }
      input,
      textarea {
        width: 100%;
        padding: 11px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        font: inherit;
        box-sizing: border-box;
      }
      .primary {
        padding: 12px 18px;
        justify-self: start;
        border: 0;
        border-radius: 8px;
        background: var(--brand-green, #458b73);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
      }
      li {
        font-size: 12px;
        margin-bottom: 10px;
      }
      @media (max-width: 600px) {
        .bookings-admin {
          padding: 16px;
        }
        .refund-editor {
          padding: 18px;
        }
      }
    `,
  ],
})
export class AdminBookings {
  private readonly http = inject(HttpClient);
  private readonly destroy = inject(DestroyRef);
  private readonly confirm = inject(ConfirmDialogService);
  protected readonly exact = formatMoneyWithCode;
  protected readonly orders = signal<BookingOrder[]>([]);
  protected readonly selected = signal<BookingOrder | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected amount = '';
  protected reason = '';
  private requestId = crypto.randomUUID();
  constructor() {
    this.load();
  }
  protected load(): void {
    this.busy.set(true);
    this.http
      .get<BookingOrder[] | { data: BookingOrder[] }>(
        API_BASE_URL + '/admin/bookings',
      )
      .pipe(
        map((body) => ('data' in body ? body.data : body)),
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (orders) => {
          this.orders.set(orders);
          const id = this.selected()?.id;
          if (id)
            this.selected.set(orders.find((order) => order.id === id) ?? null);
        },
        error: () => this.error.set('Bookings could not be loaded.'),
      });
  }
  protected select(order: BookingOrder): void {
    this.selected.set(order);
    this.amount = '';
    this.reason = '';
    this.requestId = crypto.randomUUID();
    this.error.set('');
    this.notice.set('');
  }
  protected async refund(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const order = this.selected();
    if (
      !order ||
      this.busy() ||
      !(event.target as HTMLFormElement).reportValidity()
    )
      return;
    let amountMinor: number;
    try {
      amountMinor = majorToMinor(this.amount, order.price.currency);
      if (
        amountMinor < 1 ||
        amountMinor >
          order.price.amountMinor -
            order.refundedMinor -
            order.refundPendingMinor
      )
        throw new Error(
          'Enter an amount within the remaining verified balance.',
        );
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Invalid refund amount.',
      );
      return;
    }
    const approved = await this.confirm.confirm({
      title: 'Refund original payment?',
      message:
        'Return ' +
        this.exact({ amountMinor, currency: order.price.currency }) +
        ' to the original payment method. A full refund cancels the booking.',
      confirmLabel: 'Request refund',
      variant: 'danger',
    });
    if (!approved) return;
    this.busy.set(true);
    this.error.set('');
    this.http
      .post(
        API_BASE_URL +
          '/admin/bookings/' +
          encodeURIComponent(order.id) +
          '/refunds',
        { requestId: this.requestId, amountMinor, reason: this.reason.trim() },
      )
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.notice.set(
            'Refund requested. Its status updates after confirmation from the payment provider.',
          );
          this.requestId = crypto.randomUUID();
          this.load();
        },
        error: () =>
          this.error.set(
            'The refund could not be requested. Refresh the booking to check its latest balance and status.',
          ),
      });
  }
  protected date(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
