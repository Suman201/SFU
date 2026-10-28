import { WtsCalendarAngularComponent } from '@wts-calendar/angular';
import { listModule } from '@wts-calendar/core/list';
import { timeGridModule } from '@wts-calendar/core/time-grid';
import type {
  CalendarOptions,
  CalendarOptionChanges,
  CalendarEventInput,
  WtsCalendar,
} from '@wts-calendar/core';
import { ThemeService } from '../../core/services/theme.service';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  CalendarClass,
  localDateTime,
  utcInstantsForLocal,
  validTimeZone,
} from '@native-sfu/contracts';
import { CalendarApi } from '../../core/services/calendar.service';
import { AuthService } from '../../core/services/auth.service';
import { isDesktopSession } from '../../core/services/desktop-bridge';
import { Header } from '../../shared/header/header';
@Component({
  selector: 'sfu-calendar',
  standalone: true,
  imports: [FormsModule, RouterLink, Header, WtsCalendarAngularComponent],
  templateUrl: './calendar.html',
  styleUrl: './calendar.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ClassCalendar {
  protected readonly api = inject(CalendarApi);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  protected readonly desktop = isDesktopSession();
  protected readonly teacher = computed(() => this.auth.role() === 'teacher');
  protected readonly zone = signal(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  protected readonly anchor = signal(
    localDateTime(new Date(), this.zone()).slice(0, 10),
  );
  protected readonly view = signal<'month' | 'week'>('month');
  protected readonly classes = signal<CalendarClass[]>([]);
  protected readonly selected = signal<CalendarClass | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly edit = signal<'reschedule' | 'cancel' | null>(null);
  protected readonly dialog =
    viewChild<ElementRef<HTMLDialogElement>>('editDialog');
  protected localTime = '';
  protected reason = '';
  protected chosenInstant = '';
  protected zoneInput = this.zone();
  private readonly theme = inject(ThemeService);
  protected readonly compact = signal(
    window.matchMedia('(max-width:600px)').matches,
  );
  protected readonly initialCalendarOptions: Omit<
    CalendarOptions,
    'container'
  > = {
    view: 'month',
    headerToolbar: false,
    startOfWeek: 1,
    scrollTime: '08:00',
    fixedWeekCount: true,
    editable: false,
    selectable: false,
    plugins: [timeGridModule, listModule],
    height: 'auto',
    branding: 'hidden',
    locale: 'en-GB',
    dayMaxEvents: 4,
    eventClick: (info) => {
      const item = this.classes().find((c) => c.id === info.event.id);
      if (item) this.selected.set(item);
    },
    eventDidMount: (info) => {
      const item = this.classes().find((c) => c.id === info.event.id);
      if (item) {
        info.el.setAttribute('data-class-id', item.id);
        info.el.setAttribute(
          'aria-label',
          `${item.batchName}, ${this.time(item.scheduledAt)}, ${item.status}`,
        );
      }
    },
  };
  protected readonly calendarOptions = computed<CalendarOptionChanges>(() => ({
    timeZone: this.zone(),
    height: this.view() === 'week' && !this.compact() ? 640 : 'auto',
    colorScheme: this.theme.isDark() ? 'dark' : 'light',
    themeTokens: {
      background: 'var(--panel)',
      surface: 'var(--panel)',
      surfaceMuted: 'var(--panel-muted)',
      text: 'var(--text)',
      textMuted: 'var(--muted)',
      border: 'var(--line)',
      primary: 'var(--accent)',
      primaryForeground: 'var(--on-accent)',
      eventBackground: 'var(--accent-soft)',
      eventText: 'var(--text)',
      todayBackground: 'var(--accent-soft)',
      focus: '#f26076',
      fontFamily: 'inherit',
      borderRadius: '8px',
    },
  }));
  private readonly calendarInstance = signal<WtsCalendar | null>(null);
  protected readonly calendarEvents = computed<CalendarEventInput[]>(() =>
    this.classes().map((item) => ({
      id: item.id,
      title: item.batchName,
      start: item.scheduledAt,
      end: new Date(
        Date.parse(item.scheduledAt) + item.durationMinutes * 60000,
      ).toISOString(),
      editable: false,
      classNames: [
        'sapiovian-class',
        `class-${item.status}`,
        item.rescheduledAt ? 'class-rescheduled' : '',
      ].filter(Boolean),
      description:
        item.status === 'cancelled'
          ? 'Cancelled'
          : item.rescheduledAt
            ? 'Time changed'
            : item.title,
    })),
  );
  protected readonly zones = [
    ...new Set([
      this.zone(),
      'UTC',
      'Europe/London',
      'Europe/Dublin',
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Madrid',
      'Europe/Rome',
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Lisbon',
      'Europe/Warsaw',
      'Europe/Prague',
      'Europe/Vienna',
      'Europe/Athens',
      'Europe/Helsinki',
      'Europe/Stockholm',
      'Europe/Copenhagen',
      'Europe/Oslo',
      'Europe/Bucharest',
      'Europe/Zurich',
      'Europe/Kyiv',
      'Europe/Istanbul',
      'Asia/Kolkata',
      'America/New_York',
      'America/Los_Angeles',
    ]),
  ].sort();
  protected readonly dates = computed(() => {
    const first = new Date(
      `${this.anchor().slice(0, this.view() === 'month' ? 7 : 10)}${this.view() === 'month' ? '-01' : ''}T00:00:00Z`,
    );
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
    return Array.from({ length: this.view() === 'month' ? 42 : 7 }, (_, i) =>
      new Date(first.getTime() + i * 86400000).toISOString().slice(0, 10),
    );
  });
  protected readonly title = computed(() =>
    this.view() === 'month'
      ? this.dateLabel(this.anchor(), 'month')
      : `${this.dateLabel(this.dates()[0]!, 'short')} – ${this.dateLabel(this.dates()[6]!, 'short')}`,
  );
  protected readonly upcoming = computed(() =>
    this.classes()
      .filter(
        (c) =>
          c.status === 'live' ||
          (c.status === 'scheduled' && Date.parse(c.scheduledAt) >= Date.now()),
      )
      .slice(0, 3),
  );
  protected readonly google = signal<{
    configured: boolean;
    status: string;
    lastSyncAt?: string;
    message: string;
  } | null>(null);
  protected readonly googleBusy = signal(false);
  protected googleStatus() {
    this.api.googleStatus().subscribe({
      next: (status) => this.google.set(status),
      error: () => this.google.set(null),
    });
  }
  protected connectGoogle() {
    if (this.googleBusy()) return;
    const bridge = window.classroomDesktop;
    const popup = bridge ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    if (!bridge && !popup) {
      this.error.set('Allow a new tab to connect Google Calendar.');
      return;
    }
    this.googleBusy.set(true);
    this.api.connectGoogle().subscribe({
      next: (result) => {
        this.googleBusy.set(false);
        try {
          const url = new URL(result.url);
          if (url.origin !== 'https://accounts.google.com')
            throw new Error('Invalid authorization URL');
          if (bridge)
            void bridge
              .openExternal(url.toString())
              .catch(() =>
                this.error.set(
                  'The Google sign-in page could not open. Try again.',
                ),
              );
          else if (popup) popup.location.href = url.toString();
          this.message.set(
            'Complete the Google Calendar connection in your browser, then return here.',
          );
        } catch {
          popup?.close();
          this.error.set('Google Calendar could not connect. Try again.');
        }
      },
      error: (e) => {
        this.googleBusy.set(false);
        popup?.close();
        this.error.set(
          e?.error?.message ?? 'Google Calendar could not connect. Try again.',
        );
      },
    });
  }
  protected disconnectGoogle() {
    this.googleBusy.set(true);
    this.api.disconnectGoogle().subscribe({
      next: () => {
        this.googleBusy.set(false);
        this.googleStatus();
        this.message.set(
          'Google Calendar disconnected. Previously copied events remain in Google.',
        );
      },
      error: () => {
        this.googleBusy.set(false);
        this.error.set('Google Calendar could not disconnect. Try again.');
      },
    });
  }
  protected syncGoogle() {
    this.api.syncGoogle().subscribe({
      next: () =>
        this.message.set(
          'Calendar sync queued. Your Google Calendar will update shortly.',
        ),
      error: () => this.error.set('Sync could not start. Try again.'),
    });
  }
  private loadVersion = 0;
  constructor() {
    effect(() => {
      const instance = this.calendarInstance();
      const view = this.compact()
        ? this.view() === 'month'
          ? 'list-month'
          : 'list-week'
        : this.view();
      const date = this.anchor();
      if (instance) instance.changeView(view, date);
    });
    if (this.teacher()) this.googleStatus();
    const media = window.matchMedia('(max-width:600px)');
    const resize = () => {
      this.compact.set(media.matches);
      this.refresh(false);
    };
    media.addEventListener('change', resize);
    this.destroy.onDestroy(() => media.removeEventListener('change', resize));
    this.api.preference().subscribe({
      next: (p) => {
        if (p.timeZone && validTimeZone(p.timeZone)) {
          this.zone.set(p.timeZone);
          this.zoneInput = p.timeZone;
        }
        this.refresh();
      },
      error: () => this.refresh(),
    });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.edit()) {
        this.refresh(false);
        if (this.teacher()) this.googleStatus();
      }
    }, 30000);
    this.destroy.onDestroy(() => clearInterval(timer));
  }
  protected calendarReady(api: WtsCalendar) {
    api.setOptions(this.calendarOptions());
    this.calendarInstance.set(api);
  }
  protected calendarRenderError(error: unknown) {
    console.warn('Calendar rendering failed', error);
    this.error.set('The calendar could not render. Try Refresh.');
  }
  protected refresh(showLoading = true) {
    const version = ++this.loadVersion;
    if (showLoading) this.loading.set(true);
    this.error.set('');
    const from = new Date(
      Date.parse(this.dates()[0] + 'T00:00:00Z') - 86400000,
    ).toISOString();
    const to = new Date(
      Date.parse(this.dates().at(-1)! + 'T00:00:00Z') + 2 * 86400000,
    ).toISOString();
    this.api.list(from, to).subscribe({
      next: (rows) => {
        if (version !== this.loadVersion) return;
        const visibleDays = new Set(
          this.dates().filter(
            (day) =>
              !this.compact() ||
              this.view() !== 'month' ||
              day.startsWith(this.anchor().slice(0, 7)),
          ),
        );
        this.classes.set(
          rows.filter((c) =>
            visibleDays.has(
              localDateTime(c.scheduledAt, this.zone()).slice(0, 10),
            ),
          ),
        );
        this.loading.set(false);
        const current = this.selected();
        if (current)
          this.selected.set(rows.find((r) => r.id === current.id) ?? null);
      },
      error: (e) => {
        if (version !== this.loadVersion) return;
        this.loading.set(false);
        this.error.set(
          e?.error?.message ?? 'Your calendar could not load. Try Refresh.',
        );
      },
    });
  }
  protected navigate(direction: number) {
    const date = new Date(this.anchor() + 'T00:00:00Z');
    if (this.view() === 'month') {
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + direction);
    } else date.setUTCDate(date.getUTCDate() + direction * 7);
    this.anchor.set(date.toISOString().slice(0, 10));
    this.selected.set(null);
    this.refresh();
  }
  protected month(value: string) {
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    this.anchor.set(value + '-01');
    this.selected.set(null);
    this.refresh();
  }
  protected today() {
    this.anchor.set(localDateTime(new Date(), this.zone()).slice(0, 10));
    this.selected.set(null);
    this.refresh();
  }
  protected changeView(view: 'month' | 'week') {
    this.view.set(view);
    this.refresh();
  }
  protected setZone() {
    if (!validTimeZone(this.zoneInput)) {
      this.error.set('Enter a valid timezone, for example Europe/Paris.');
      return;
    }
    this.api.saveZone(this.zoneInput).subscribe({
      next: () => {
        this.zone.set(this.zoneInput);
        this.message.set(
          'Timezone saved for your calendar and future class notices.',
        );
        this.refresh();
      },
      error: () => this.error.set('Timezone could not be saved. Try again.'),
    });
  }
  protected dateLabel(day: string, style: 'month' | 'short' | 'full' = 'full') {
    return new Intl.DateTimeFormat(
      'en-GB',
      style === 'month'
        ? { timeZone: 'UTC', month: 'long', year: 'numeric' }
        : style === 'short'
          ? { timeZone: 'UTC', day: 'numeric', month: 'short' }
          : { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' },
    ).format(new Date(day + 'T12:00:00Z'));
  }
  protected localDate(instant: string) {
    return localDateTime(instant, this.zone()).slice(0, 10);
  }
  protected time(instant: string) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.zone(),
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(instant));
  }
  protected isToday(day: string) {
    return localDateTime(new Date(), this.zone()).startsWith(day);
  }
  protected canEdit(item: CalendarClass) {
    return (
      this.teacher() &&
      item.status === 'scheduled' &&
      Date.parse(item.scheduledAt) > Date.now()
    );
  }
  protected beginEdit(action: 'reschedule' | 'cancel') {
    const item = this.selected();
    if (!item) return;
    this.localTime = localDateTime(item.scheduledAt, this.zone());
    this.reason = '';
    this.chosenInstant = '';
    this.error.set('');
    this.edit.set(action);
    setTimeout(() => this.dialog()?.nativeElement.showModal());
  }
  protected closeEdit() {
    if (this.saving()) return;
    this.dialog()?.nativeElement.close();
    this.edit.set(null);
  }
  protected choices() {
    return utcInstantsForLocal(this.localTime, this.zone());
  }
  protected save() {
    const item = this.selected();
    const action = this.edit();
    if (!item || !action || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .change(item, {
        action,
        expectedScheduledAt: item.scheduledAt,
        localTime: this.localTime,
        timeZone: this.zone(),
        chosenInstant: this.chosenInstant || undefined,
        reason: this.reason,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.closeEdit();
          this.message.set(
            action === 'cancel'
              ? 'Class cancelled. The class update will be sent to enrolled students.'
              : 'Class rescheduled. The class update will be sent to enrolled students.',
          );
          this.refresh();
        },
        error: (e) => {
          this.saving.set(false);
          this.error.set(
            Array.isArray(e?.error?.message)
              ? e.error.message.join(' ')
              : (e?.error?.message ??
                  'This change could not be saved. Try again.'),
          );
        },
      });
  }
  protected join(item: CalendarClass) {
    void this.router.navigate(
      this.desktop
        ? ['/desktop/join']
        : ['/class-session', this.teacher() ? 'teacher' : 'student'],
      { queryParams: { sessionId: item.id, batchId: item.batchId } },
    );
  }
}
