import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import {
  formatMoneyWithCode,
  type BookingBatchCatalogue,
  type BookingCatalogue,
  type LessonOffer,
} from '@native-sfu/contracts';
import { BookingsApi } from '../../core/services/bookings-api.service';
import { AuthService } from '../../core/services/auth.service';
import { CurrencyService } from '../../core/services/currency.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';

@Component({
  selector: 'sfu-booking',
  standalone: true,
  imports: [FormsModule, RouterLink, Header, Footer],
  templateUrl: './booking.html',
  styleUrl: './booking.scss',
})
export class Booking {
  protected readonly auth = inject(AuthService);
  protected readonly money = inject(CurrencyService);
  private readonly api = inject(BookingsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  protected readonly catalogue = signal<BookingCatalogue | null>(null);
  protected readonly batch = signal<BookingBatchCatalogue | null>(null);
  protected readonly offerId = signal('');
  protected readonly slotId = signal('');
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly timezone = signal(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  protected readonly timezones = [
    ...new Set([
      this.timezone(),
      'UTC',
      'Europe/London',
      'Europe/Paris',
      'America/New_York',
      'Asia/Kolkata',
      'Asia/Singapore',
      'Australia/Sydney',
    ]),
  ];
  protected billingName = '';
  protected billingAddress = '';
  protected billingCountry = '';
  protected billingVat = '';
  protected goal = '';
  protected readonly currentPath = this.router.url;
  protected readonly offer = computed(
    () =>
      this.catalogue()?.offers.find((offer) => offer.id === this.offerId()) ??
      null,
  );
  protected readonly slots = computed(
    () =>
      this.catalogue()?.slots.filter(
        (slot) => slot.offerId === this.offerId(),
      ) ?? [],
  );
  protected readonly selectedSlot = computed(
    () => this.slots().find((slot) => slot.id === this.slotId()) ?? null,
  );
  protected readonly price = computed(
    () => this.batch()?.price ?? this.offer()?.price ?? null,
  );
  protected readonly payable = computed(
    () =>
      this.batch()?.paymentsAvailable ??
      this.catalogue()?.paymentsAvailable ??
      false,
  );
  constructor() {
    effect(() => {
      const user = this.auth.user();
      if (user && !this.billingName) this.billingName = user.name;
    });
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe(() => this.load());
  }
  protected load(): void {
    const teacherId = this.route.snapshot.paramMap.get('teacherId');
    const batchId = this.route.snapshot.paramMap.get('batchId');
    this.catalogue.set(null);
    this.batch.set(null);
    this.slotId.set('');
    this.error.set('');
    if (!teacherId && !batchId) return;
    this.loading.set(true);
    if (batchId)
      this.api
        .batch(batchId)
        .pipe(
          finalize(() => this.loading.set(false)),
          takeUntilDestroyed(this.destroy),
        )
        .subscribe({
          next: (batch) => this.batch.set(batch),
          error: () =>
            this.error.set(
              'This class is not open for booking. Its price, currency or schedule may need confirmation by the teacher.',
            ),
        });
    else
      this.api
        .catalogue(teacherId!)
        .pipe(
          finalize(() => this.loading.set(false)),
          takeUntilDestroyed(this.destroy),
        )
        .subscribe({
          next: (catalogue) => {
            this.catalogue.set(catalogue);
            this.offerId.set(catalogue.offers[0]?.id ?? '');
          },
          error: () =>
            this.error.set(
              'This teacher is not currently available for booking. Return to the teacher list or try again.',
            ),
        });
  }
  protected selectOffer(id: string): void {
    this.offerId.set(id);
    this.slotId.set('');
    this.error.set('');
  }
  protected format(instant: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: this.timezone(),
    }).format(new Date(instant));
  }
  protected exactPrice(): string {
    const price = this.price();
    return price ? formatMoneyWithCode(price) : '';
  }
  protected reserve(event: SubmitEvent): void {
    event.preventDefault();
    if (
      this.busy() ||
      !this.auth.authenticated() ||
      !(event.target as HTMLFormElement).reportValidity()
    )
      return;
    const price = this.price(),
      batch = this.batch(),
      slot = this.selectedSlot(),
      offer = this.offer();
    if (!price || (!batch && (!slot || !offer))) {
      this.error.set('Choose an available lesson time.');
      return;
    }
    if (price.amountMinor > 0 && !this.payable()) {
      this.error.set(
        'Online payment is not available yet. Please contact the teacher.',
      );
      return;
    }
    const id = batch?.id ?? slot!.id;
    let requestId = crypto.randomUUID();
    try {
      const key = `native-sfu.booking.request.${id}`;
      requestId =
        (sessionStorage.getItem(
          key,
        ) as `${string}-${string}-${string}-${string}-${string}`) || requestId;
      sessionStorage.setItem(key, requestId);
    } catch {
      /* Idempotency remains active for this page session. */
    }
    this.busy.set(true);
    this.error.set('');
    this.api
      .reserve(
        id,
        {
          requestId,
          expectedTotalMinor: price.amountMinor,
          ...(offer ? { expectedOfferVersion: offer.version } : {}),
          billing: {
            name: this.billingName.trim(),
            email: this.auth.user()!.email,
            address: this.billingAddress.trim(),
            countryCode: this.billingCountry.trim().toUpperCase(),
            vatNumber: this.billingVat.trim(),
          },
          goal: this.goal.trim(),
        },
        Boolean(batch),
      )
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (order) => {
          try {
            sessionStorage.removeItem(`native-sfu.booking.request.${id}`);
          } catch {
            /* No billing information is stored in the browser. */
          }
          void this.router.navigate(['/bookings', order.id]);
        },
        error: (error) => {
          const message = error?.error?.message;
          this.error.set(
            typeof message === 'string'
              ? message
              : 'The reservation could not be created. The price or time may have changed; reload availability and try again.',
          );
        },
      });
  }
  protected trackOffer(_index: number, offer: LessonOffer) {
    return offer.id;
  }
}
