import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import {
  CURRENCY_DECIMALS,
  isCurrencyCode,
  majorToMinor,
  utcInstantsForLocal,
  type LessonOffer,
} from '@native-sfu/contracts';
import {
  BookingsApi,
  type TeacherAvailability,
} from '../../core/services/bookings-api.service';
import { CurrencyService } from '../../core/services/currency.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
@Component({
  selector: 'sfu-teacher-bookings',
  standalone: true,
  imports: [FormsModule, RouterLink, Header, Footer],
  templateUrl: './teacher-bookings.html',
  styleUrl: './booking.scss',
})
export class TeacherBookings {
  private readonly api = inject(BookingsApi);
  private readonly destroy = inject(DestroyRef);
  protected readonly money = inject(CurrencyService);
  protected readonly data = signal<TeacherAvailability | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected title = '';
  protected description = '';
  protected duration = 50;
  protected amount = '';
  protected currency = 'EUR';
  protected offerId = '';
  protected localTime = signal('');
  protected timezone = signal(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  protected chosenInstant = '';
  protected readonly instants = computed(() => {
    try {
      return utcInstantsForLocal(this.localTime(), this.timezone());
    } catch {
      return [];
    }
  });
  constructor() {
    this.load();
  }
  protected load(): void {
    this.api
      .availability()
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (data) => {
          this.data.set(data);
          if (!this.offerId)
            this.offerId = data.offers.find((offer) => offer.active)?.id ?? '';
        },
        error: () =>
          this.error.set(
            'Lesson availability could not be loaded. Your public tutor profile must be approved before offering lessons.',
          ),
      });
  }
  protected step(): number {
    return isCurrencyCode(this.currency)
      ? 10 ** -CURRENCY_DECIMALS[this.currency]
      : 0.01;
  }
  protected createOffer(event: SubmitEvent): void {
    event.preventDefault();
    if (this.busy() || !(event.target as HTMLFormElement).reportValidity())
      return;
    let amountMinor: number;
    try {
      if (!isCurrencyCode(this.currency))
        throw new Error('Choose a supported currency.');
      amountMinor = majorToMinor(this.amount, this.currency);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Invalid price.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api
      .saveOffer({
        title: this.title.trim(),
        description: this.description.trim(),
        durationMinutes: Number(this.duration),
        amountMinor,
        currency: this.currency,
        active: true,
      })
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.notice.set('Lesson offer published. Add available times below.');
          this.title = '';
          this.description = '';
          this.amount = '';
          this.load();
        },
        error: (error) =>
          this.error.set(
            typeof error?.error?.message === 'string'
              ? error.error.message
              : 'The offer could not be published. Check the price and business configuration.',
          ),
      });
  }
  protected toggle(offer: LessonOffer): void {
    this.busy.set(true);
    this.api
      .saveOffer(
        {
          title: offer.title,
          description: offer.description,
          durationMinutes: offer.durationMinutes,
          amountMinor: offer.netMinor,
          currency: offer.price.currency,
          active: !offer.active,
          version: offer.version,
        },
        offer.id,
      )
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => this.load(),
        error: () =>
          this.error.set('The offer changed. Reload before editing.'),
      });
  }
  protected publish(event: SubmitEvent): void {
    event.preventDefault();
    if (this.busy() || !this.offerId) return;
    const candidates = this.instants();
    if (!candidates.length) {
      this.error.set(
        'This local time does not exist in the selected timezone.',
      );
      return;
    }
    const instant =
      candidates.length === 1 ? candidates[0]! : this.chosenInstant;
    if (!candidates.includes(instant)) {
      this.error.set(
        'Choose the intended UTC offset for this repeated clock time.',
      );
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api
      .publishSlot(this.offerId, instant)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.notice.set('Lesson time published.');
          this.localTime.set('');
          this.load();
        },
        error: (error) =>
          this.error.set(
            typeof error?.error?.message === 'string'
              ? error.error.message
              : 'This time conflicts with another class or reservation.',
          ),
      });
  }
  protected withdraw(id: string): void {
    this.busy.set(true);
    this.api
      .withdrawSlot(id)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => this.load(),
        error: () =>
          this.error.set(
            'This time is already reserved. Manage its booking instead.',
          ),
      });
  }
  protected date(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: this.timezone(),
    }).format(new Date(value));
  }
  protected offerTitle(id: string): string {
    return (
      this.data()?.offers.find((offer) => offer.id === id)?.title ?? 'Lesson'
    );
  }
}
