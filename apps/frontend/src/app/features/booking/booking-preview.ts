import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ProfileService } from '../../core/services/profile.service';
import { ThemeService } from '../../core/services/theme.service';
import { BrandLogo } from '../../shared/brand-mark/brand-logo';

interface LessonOption {
  id: string;
  title: string;
  description: string;
  duration: number;
  price: number;
}
interface BookingTeacher {
  name: string;
  headline: string;
  image: string;
}

/** Interactive design preview. It never writes bookings, enrollments or payments. */
@Component({
  selector: 'sfu-booking-preview',
  standalone: true,
  imports: [FormsModule, RouterLink, BrandLogo],
  templateUrl: './booking-preview.html',
  styleUrl: './booking-preview.scss',
})
export class BookingPreview {
  private readonly route = inject(ActivatedRoute);
  private readonly profiles = inject(ProfileService);
  private readonly destroy = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  protected readonly theme = inject(ThemeService);
  private profileRequest?: Subscription;
  private paymentTimer?: ReturnType<typeof setTimeout>;
  protected readonly teacherId = signal('');
  protected readonly teacher = signal<BookingTeacher>({
    name: 'Alex Morgan',
    headline: 'Mathematics · School and university',
    image: '',
  });
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly step = signal(1);
  protected readonly visited = signal(1);
  protected readonly complete = signal(false);
  protected readonly processing = signal(false);
  protected readonly paymentError = signal('');
  protected readonly card = signal('success');
  protected readonly lessonId = signal('full');
  protected readonly selectedSlot = signal('');
  protected readonly selectedDay = signal('');
  protected readonly weekStart = signal(0);
  protected readonly timezone = signal(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London',
  );
  protected goal = '';
  protected billingName = 'Jamie Taylor';
  protected billingEmail = 'jamie@example.com';
  protected billingCountry = 'DE';
  protected readonly lessons: LessonOption[] = [
    {
      id: 'intro',
      title: 'Introductory lesson',
      description:
        'Meet your teacher, talk through your goals and try a short activity.',
      duration: 25,
      price: 1500,
    },
    {
      id: 'full',
      title: 'Full lesson',
      description:
        'A focused session with time to learn, practise and ask questions.',
      duration: 50,
      price: 2800,
    },
  ];
  protected readonly lesson = computed(
    () => this.lessons.find((item) => item.id === this.lessonId())!,
  );
  protected readonly timezones = [
    ...new Set([
      this.timezone(),
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Madrid',
      'Europe/Helsinki',
      'America/New_York',
      'Asia/Kolkata',
    ]),
  ];
  private readonly sampleSlots = this.makeSlots();
  protected readonly days = computed(() => {
    const unique = new Map<string, string>();
    for (const instant of this.sampleSlots)
      unique.set(this.dayKey(instant), instant);
    return [...unique].map(([key, instant]) => ({ key, instant }));
  });
  protected readonly visibleDays = computed(() =>
    this.days().slice(this.weekStart(), this.weekStart() + 7),
  );
  protected readonly daySlots = computed(() =>
    this.sampleSlots.filter(
      (instant) => this.dayKey(instant) === this.selectedDay(),
    ),
  );
  protected readonly monthLabel = computed(() => {
    const visible = this.visibleDays();
    return visible.length
      ? this.format(visible[0]!.instant, { month: 'long', year: 'numeric' })
      : '';
  });
  protected readonly initials = computed(() =>
    this.teacher()
      .name.split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase(),
  );
  protected readonly backLink = computed(() =>
    this.teacherId() ? ['/teachers', this.teacherId()] : ['/teachers'],
  );
  protected readonly timeLabel = computed(() => {
    const instant = this.selectedSlot();
    if (!instant) return 'Choose a time';
    const end = new Date(
      new Date(instant).getTime() + this.lesson().duration * 60_000,
    ).toISOString();
    return `${this.format(instant, { hour: '2-digit', minute: '2-digit', hour12: false })}–${this.format(end, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  });
  protected readonly dateLabel = computed(() =>
    this.selectedSlot()
      ? this.format(this.selectedSlot(), {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })
      : 'Choose a date and time',
  );

  constructor() {
    this.selectedDay.set(this.days()[0]?.key || '');
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((params) => {
        this.teacherId.set(params.get('teacherId') || '');
        this.reset();
        this.loadTeacher();
      });
    this.destroy.onDestroy(() => {
      this.profileRequest?.unsubscribe();
      clearTimeout(this.paymentTimer);
    });
  }
  protected loadTeacher() {
    this.profileRequest?.unsubscribe();
    this.loadError.set('');
    const id = this.teacherId();
    if (!id) {
      this.loading.set(false);
      this.teacher.set({
        name: 'Alex Morgan',
        headline: 'Mathematics · School and university',
        image: '',
      });
      return;
    }
    this.loading.set(true);
    this.profileRequest = this.profiles.getPublicTeacherProfile(id).subscribe({
      next: (profile) => {
        this.teacher.set({
          name: profile.displayName,
          headline: profile.headline || 'Online lessons',
          image: profile.avatarUrl
            ? this.profiles.resolveMediaUrl(profile.avatarUrl)
            : '',
        });
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.loadError.set(
          'This teacher could not be loaded. Try again or return to the teacher list.',
        );
      },
    });
  }
  protected imageFailed() {
    this.teacher.update((value) => ({ ...value, image: '' }));
  }
  protected money(cents: number) {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
    }).format(cents / 100);
  }
  protected format(instant: string, options: Intl.DateTimeFormatOptions) {
    return new Intl.DateTimeFormat('en-GB', {
      ...options,
      timeZone: this.timezone(),
    }).format(new Date(instant));
  }
  private dayKey(instant: string) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(instant));
  }
  protected chooseDay(key: string) {
    this.selectedDay.set(key);
    this.selectedSlot.set('');
    this.paymentError.set('');
  }
  protected changeWeek(direction: number) {
    const start = Math.max(
      0,
      Math.min(
        Math.floor((this.days().length - 1) / 7) * 7,
        this.weekStart() + direction * 7,
      ),
    );
    this.weekStart.set(start);
    this.chooseDay(this.days()[start]!.key);
  }
  protected changeTimezone(zone: string) {
    this.timezone.set(zone);
    const key = this.selectedSlot()
      ? this.dayKey(this.selectedSlot())
      : this.days()[0]!.key;
    this.selectedDay.set(key);
    this.weekStart.set(
      Math.floor(
        Math.max(
          0,
          this.days().findIndex((day) => day.key === key),
        ) / 7,
      ) * 7,
    );
  }
  protected goTo(step: number) {
    if (
      this.processing() ||
      step > this.visited() ||
      (step === 3 && !this.selectedSlot())
    )
      return;
    this.step.set(step);
    this.focusHeading();
  }
  protected next() {
    if (this.step() === 2 && !this.selectedSlot()) return;
    this.step.update((value) => Math.min(3, value + 1));
    this.visited.update((value) => Math.max(value, this.step()));
    this.focusHeading();
  }
  protected changeCard(value: string) {
    this.card.set(value);
    this.paymentError.set('');
  }
  protected pay(event: SubmitEvent) {
    event.preventDefault();
    if (
      this.processing() ||
      !this.selectedSlot() ||
      !(event.target as HTMLFormElement).reportValidity()
    )
      return;
    this.paymentError.set('');
    this.processing.set(true);
    // Local interaction only. A future gateway must create and verify its own server-side order.
    this.paymentTimer = setTimeout(() => {
      this.processing.set(false);
      if (this.card() === 'declined')
        this.paymentError.set(
          'This sample card was declined. Choose the successful sample card and try again.',
        );
      else {
        this.complete.set(true);
        this.focusHeading();
      }
    }, 700);
  }
  protected reset() {
    clearTimeout(this.paymentTimer);
    this.step.set(1);
    this.visited.set(1);
    this.complete.set(false);
    this.processing.set(false);
    this.paymentError.set('');
    this.card.set('success');
    this.lessonId.set('full');
    this.selectedSlot.set('');
    this.weekStart.set(0);
    this.selectedDay.set(this.days()[0]?.key || '');
    this.goal = '';
    this.billingName = 'Jamie Taylor';
    this.billingEmail = 'jamie@example.com';
    this.billingCountry = 'DE';
  }
  protected downloadSummary() {
    const text = [
      'Sapiovian — booking preview',
      'This is a sample summary. No payment or reservation was made.',
      `Teacher: ${this.teacher().name}`,
      `Lesson: ${this.lesson().title} (${this.lesson().duration} minutes)`,
      `Date: ${this.dateLabel()}`,
      `Time: ${this.timeLabel()} (${this.timezone()})`,
      `Sample total: ${this.money(this.lesson().price)}`,
      'Actual amount charged: €0.00',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = this.document.createElement('a');
    link.href = url;
    link.download = 'sapiovian-booking-preview.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private focusHeading() {
    setTimeout(
      () => this.document.getElementById('booking-heading')?.focus(),
      0,
    );
  }
  private makeSlots() {
    const now = new Date();
    const start = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    return Array.from({ length: 14 }, (_, day) =>
      [9 * 60, 10 * 60 + 30, 13 * 60, 16 * 60 + 30].map((minutes) =>
        new Date(start + day * 86400_000 + minutes * 60_000).toISOString(),
      ),
    ).flat();
  }
}
