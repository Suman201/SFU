import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import type { BookingOrder } from '@native-sfu/contracts';
import { BookingsApi } from '../../core/services/bookings-api.service';
import { AuthService } from '../../core/services/auth.service';
import { CurrencyService } from '../../core/services/currency.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
@Component({
  selector: 'sfu-my-bookings',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  template: ` <sfu-header />
    <main class="booking-page site-page">
      <div class="list-heading">
        <div>
          <p class="eyebrow">YOUR LEARNING WORKSPACE</p>
          <h1>{{ teacher ? 'Lesson bookings' : 'My bookings' }}</h1>
          <p>
            Reservations, confirmed lessons, payments and refunds in one place.
          </p>
        </div>
        <div class="actions">
          @if (teacher) {
            <a class="primary" routerLink="/teacher/bookings/availability"
              >Manage lesson availability</a
            >
          } @else {
            <a class="primary" routerLink="/teachers">Find a lesson</a>
          }
        </div>
      </div>
      @if (error()) {
        <p class="notice error" role="alert">{{ error() }}</p>
      }
      <section class="data-table-shell">
        <div class="data-table-toolbar">
          <h2>Recent bookings</h2>
          <button
            class="secondary"
            type="button"
            (click)="load()"
            [disabled]="loading()"
          >
            Refresh
          </button>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Lesson</th>
                <th>{{ teacher ? 'Student' : 'Teacher' }}</th>
                <th>Date and time</th>
                <th>Total</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              @for (item of orders(); track item.id) {
                <tr>
                  <td>
                    <strong>{{ item.title }}</strong
                    ><small>{{
                      item.kind === 'batch'
                        ? 'Class enrollment'
                        : 'One-to-one lesson'
                    }}</small>
                  </td>
                  <td>{{ teacher ? item.studentName : item.teacherName }}</td>
                  <td>{{ date(item.startsAt) }}</td>
                  <td>{{ money.display(item.price) }}</td>
                  <td>
                    <span class="data-pill">{{
                      item.status.replaceAll('_', ' ')
                    }}</span>
                  </td>
                  <td>
                    <a
                      class="table-action"
                      [routerLink]="['/bookings', item.id]"
                      >View booking</a
                    >
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="6">
                    {{ loading() ? 'Loading bookings…' : 'No bookings yet.' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="data-table-footer">
          {{ orders().length }} recent bookings
        </div>
      </section>
    </main>
    <sfu-footer />`,
  styleUrl: './booking.scss',
})
export class MyBookings {
  private readonly api = inject(BookingsApi);
  private readonly destroy = inject(DestroyRef);
  protected readonly money = inject(CurrencyService);
  protected readonly teacher = inject(AuthService).role() === 'teacher';
  protected readonly orders = signal<BookingOrder[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  constructor() {
    this.load();
  }
  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .orders(this.teacher)
      .pipe(
        finalize(() => this.loading.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (rows) => this.orders.set(rows),
        error: () => this.error.set('Bookings could not be loaded. Try again.'),
      });
  }
  protected date(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
