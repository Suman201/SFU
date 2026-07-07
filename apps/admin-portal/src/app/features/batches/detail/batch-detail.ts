import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  AdminBatchDetail,
  AdminBatchRosterItem,
  AdminBatchScheduleItem,
  AdminBatchSessionItem,
  AdminBatchStatus,
  AdminBatchUpdateRequest,
  AdminBatchWeekday
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';

type ScheduleFormValue = { dayOfWeek: AdminBatchWeekday; startTime: string };
type BatchCalendarView = 'month' | 'week' | 'list';

interface BatchCalendarDay {
  date: Date;
  key: string;
  label: string;
  weekday: string;
  muted: boolean;
  today: boolean;
  sessions: AdminBatchSessionItem[];
}

interface SchedulePreviewItem {
  key: string;
  title: string;
  dateTime: string;
}

@Component({
  selector: 'sfu-admin-batch-detail',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './batch-detail.html',
  styleUrl: './batch-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class BatchDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);
  private readonly confirmDialog = inject(ConfirmDialogService);

  protected readonly batch = signal<AdminBatchDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly pendingAction = signal<string | null>(null);
  protected readonly pendingAttendanceSessionId = signal<string | null>(null);
  protected readonly calendarView = signal<BatchCalendarView>('month');
  protected readonly calendarCursor = signal(new Date());
  protected readonly selectedCalendarSession = signal<AdminBatchSessionItem | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly weekdays: AdminBatchWeekday[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  protected readonly timezoneLabel = computed(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local timezone');
  protected readonly calendarTitle = computed(() => {
    const cursor = this.calendarCursor();
    if (this.calendarView() === 'week') {
      const start = this.startOfWeek(cursor);
      const end = this.addDays(start, 6);
      return `${this.shortMonthDay(start)} - ${this.shortMonthDay(end)}`;
    }
    if (this.calendarView() === 'list') {
      return 'All planned sessions';
    }
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(cursor);
  });
  protected readonly calendarDays = computed(() => this.buildMonthDays(this.calendarCursor(), this.batch()?.sessions ?? []));
  protected readonly calendarWeekDays = computed(() => this.buildWeekDays(this.calendarCursor(), this.batch()?.sessions ?? []));

  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    courseId: ['', [Validators.maxLength(120)]],
    courseName: ['', [Validators.maxLength(120)]],
    teacherId: ['', [Validators.required, Validators.maxLength(120)]],
    year: [new Date().getUTCFullYear(), [Validators.required, Validators.min(2000), Validators.max(2100)]],
    maxCapacity: [30, [Validators.required, Validators.min(1), Validators.max(1000)]],
    status: ['ACTIVE' as AdminBatchStatus],
    schedule: this.formBuilder.array([this.createScheduleGroup()])
  });

  ngOnInit(): void {
    this.load();
  }

  protected async save(): Promise<void> {
    const batch = this.batch();
    if (!batch || this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const request: AdminBatchUpdateRequest = {};
    const name = value.name.trim();
    const courseId = value.courseId.trim();
    const courseName = value.courseName.trim();
    const teacherId = value.teacherId.trim();
    const year = Number(value.year);
    const maxCapacity = Number(value.maxCapacity);
    const schedule = this.currentSchedule();
    const scheduleChanged = !this.sameSchedule(schedule, batch.schedule);
    if (name !== batch.name) request.name = name;
    if (courseId !== (batch.courseId || '')) request.courseId = courseId;
    if (courseName !== (batch.courseName || '')) request.courseName = courseName;
    if (teacherId !== batch.teacherId) request.teacherId = teacherId;
    if (year !== batch.year) request.year = year;
    if (maxCapacity !== batch.maxCapacity) request.maxCapacity = maxCapacity;
    if (value.status !== batch.status) request.status = value.status;
    if (scheduleChanged) request.schedule = schedule;
    if (!Object.keys(request).length) {
      this.success.set('No changes to save.');
      this.error.set('');
      return;
    }
    if (scheduleChanged || request.year !== undefined || request.teacherId !== undefined) {
      const confirmed = await this.confirmDialog.confirm({
        title: 'Update future planned sessions?',
        message: 'Schedule, year, or teacher changes can affect planned sessions that have not started yet.',
        confirmLabel: 'Update sessions',
        pendingLabel: 'Updating...',
        variant: 'warning'
      });
      if (!confirmed) {
        return;
      }
    }
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .updateBatch(batch.id, request)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.batch.set(updated);
          this.patchForm(updated);
          this.success.set(`${updated.name} updated.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected get scheduleRows() {
    return this.form.controls.schedule;
  }

  protected addScheduleRow(): void {
    this.scheduleRows.push(this.createScheduleGroup());
  }

  protected removeScheduleRow(index: number): void {
    if (this.scheduleRows.length <= 1) {
      return;
    }
    this.scheduleRows.removeAt(index);
  }

  protected downloadAttendance(session: AdminBatchSessionItem): void {
    if (this.pendingAttendanceSessionId()) {
      return;
    }
    this.pendingAttendanceSessionId.set(session.id);
    this.error.set('');
    this.api
      .downloadAttendance(session.id)
      .pipe(finalize(() => this.pendingAttendanceSessionId.set(null)))
      .subscribe({
        next: (blob) => this.saveAttendanceBlob(blob, session),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected async transition(action: 'activate' | 'pause' | 'complete' | 'cancel'): Promise<void> {
    const batch = this.batch();
    if (!batch || this.pendingAction()) {
      return;
    }
    if (action === 'complete' || action === 'cancel') {
      const confirmed = await this.confirmDialog.confirm({
        title: `Mark ${batch.name} as ${action}?`,
        message: action === 'cancel' ? 'This batch will be cancelled and future sessions will no longer be available.' : 'This batch will be marked completed.',
        confirmLabel: action === 'cancel' ? 'Cancel batch' : 'Complete batch',
        pendingLabel: 'Updating...',
        variant: action === 'cancel' ? 'danger' : 'warning'
      });
      if (!confirmed) {
        return;
      }
    }
    this.pendingAction.set(action);
    this.error.set('');
    this.success.set('');
    this.api
      .transitionBatch(batch.id, action)
      .pipe(finalize(() => this.pendingAction.set(null)))
      .subscribe({
        next: (updated) => {
          this.batch.set(updated);
          this.patchForm(updated);
          this.success.set(`${updated.name} is now ${updated.status.toLowerCase()}.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected scheduleLabel(batch: AdminBatchDetail): string {
    return batch.schedule.map((item) => `${item.dayOfWeek.slice(0, 3)} ${item.startTime}`).join(', ') || 'No schedule';
  }

  protected statusClass(status: AdminBatchStatus | string): string {
    return `status-${status.toLowerCase()}`;
  }

  protected sessionStatusLabel(status: string): string {
    return status === 'live' ? 'Live now' : status[0]!.toUpperCase() + status.slice(1);
  }

  protected setCalendarView(view: BatchCalendarView): void {
    this.calendarView.set(view);
  }

  protected moveCalendar(direction: -1 | 1): void {
    const cursor = this.calendarCursor();
    if (this.calendarView() === 'week') {
      this.calendarCursor.set(this.addDays(cursor, direction * 7));
      return;
    }
    this.calendarCursor.set(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
  }

  protected resetCalendarToday(): void {
    this.calendarCursor.set(new Date());
  }

  protected focusCalendarSession(session: AdminBatchSessionItem): void {
    this.calendarCursor.set(new Date(session.scheduledAt));
    this.selectedCalendarSession.set(session);
  }

  protected closeCalendarSession(): void {
    this.selectedCalendarSession.set(null);
  }

  protected calendarStatusClass(session: AdminBatchSessionItem): string {
    return `calendar-event status-${this.calendarDisplayStatus(session)}`;
  }

  protected calendarSessionStatusLabel(session: AdminBatchSessionItem): string {
    const status = this.calendarDisplayStatus(session);
    return status === 'rescheduled' ? 'Rescheduled' : this.sessionStatusLabel(status);
  }

  protected sessionTimeRange(session: AdminBatchSessionItem): string {
    const start = new Date(session.scheduledAt);
    const end = new Date(start.getTime() + session.durationMinutes * 60_000);
    const formatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${formatter.format(start)} - ${formatter.format(end)}`;
  }

  protected formatDateTime(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected schedulePreview(): SchedulePreviewItem[] {
    return this.previewSchedule(Number(this.form.controls.year.value), this.currentSchedule()).slice(0, 12);
  }

  protected trackByRoster(_index: number, row: AdminBatchRosterItem): string {
    return row.enrollmentId;
  }

  protected trackBySession(_index: number, row: AdminBatchSessionItem): string {
    return row.id;
  }

  private load(): void {
    const batchId = this.route.snapshot.paramMap.get('batchId');
    if (!batchId) {
      this.error.set('Batch id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getBatch(batchId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (batch) => {
          this.batch.set(batch);
          this.patchForm(batch);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private patchForm(batch: AdminBatchDetail): void {
    this.form.reset({
      name: batch.name,
      courseId: batch.courseId || '',
      courseName: batch.courseName || '',
      teacherId: batch.teacherId,
      year: batch.year,
      maxCapacity: batch.maxCapacity,
      status: batch.status
    });
    this.patchSchedule(batch.schedule);
  }

  private createScheduleGroup(item: Partial<AdminBatchScheduleItem> = {}) {
    return this.formBuilder.nonNullable.group({
      dayOfWeek: [(item.dayOfWeek ?? 'MONDAY') as AdminBatchWeekday, Validators.required],
      startTime: [item.startTime ?? '10:00', [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)]]
    });
  }

  private patchSchedule(schedule: AdminBatchScheduleItem[]): void {
    this.scheduleRows.clear();
    const rows = schedule.length ? schedule : [{ dayOfWeek: 'MONDAY' as AdminBatchWeekday, startTime: '10:00' }];
    for (const item of rows) {
      this.scheduleRows.push(this.createScheduleGroup(item));
    }
  }

  private currentSchedule(): ScheduleFormValue[] {
    return this.scheduleRows
      .getRawValue()
      .map((item) => ({ dayOfWeek: item.dayOfWeek, startTime: item.startTime.trim() }))
      .filter((item) => item.startTime);
  }

  private previewSchedule(year: number, schedule: ScheduleFormValue[]): SchedulePreviewItem[] {
    if (!Number.isFinite(year) || year < 2000 || !schedule.length) {
      return [];
    }

    const end = new Date(year, 11, 31, 23, 59, 59);
    const preview = schedule.flatMap((item) => {
      const weekdayIndex = this.weekdayIndex(item.dayOfWeek);
      const [hours = 0, minutes = 0] = item.startTime.split(':').map((part) => Number(part));
      const first = new Date(year, 0, 1, hours, minutes, 0, 0);
      first.setDate(first.getDate() + ((weekdayIndex - first.getDay() + 7) % 7));
      const dates: SchedulePreviewItem[] = [];
      for (let cursor = first; cursor <= end && dates.length < 16; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7, hours, minutes)) {
        dates.push({
          key: `${item.dayOfWeek}-${cursor.toISOString()}`,
          title: item.dayOfWeek,
          dateTime: this.formatDateTime(cursor.toISOString())
        });
      }
      return dates;
    });

    return preview.sort((left, right) => new Date(left.key.split('-').slice(1).join('-')).getTime() - new Date(right.key.split('-').slice(1).join('-')).getTime());
  }

  private buildMonthDays(cursor: Date, sessions: AdminBatchSessionItem[]): BatchCalendarDay[] {
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = this.startOfWeek(monthStart);
    return Array.from({ length: 42 }, (_value, index) => {
      const date = this.addDays(gridStart, index);
      return this.calendarDay(date, sessions, date.getMonth() !== monthStart.getMonth());
    });
  }

  private buildWeekDays(cursor: Date, sessions: AdminBatchSessionItem[]): BatchCalendarDay[] {
    const weekStart = this.startOfWeek(cursor);
    return Array.from({ length: 7 }, (_value, index) => this.calendarDay(this.addDays(weekStart, index), sessions, false));
  }

  private calendarDay(date: Date, sessions: AdminBatchSessionItem[], muted: boolean): BatchCalendarDay {
    const key = this.dateKey(date);
    return {
      date,
      key,
      label: new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(date),
      weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date),
      muted,
      today: key === this.dateKey(new Date()),
      sessions: sessions
        .filter((session) => this.dateKey(new Date(session.scheduledAt)) === key)
        .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())
    };
  }

  private startOfWeek(date: Date): Date {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() - start.getDay());
    return start;
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  private dateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private shortMonthDay(date: Date): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }

  private calendarDisplayStatus(session: AdminBatchSessionItem): string {
    const plannedDate = this.plannedDateFromSessionId(session.id);
    if (session.status === 'scheduled' && plannedDate && plannedDate !== this.dateKey(new Date(session.scheduledAt))) {
      return 'rescheduled';
    }
    return session.status;
  }

  private plannedDateFromSessionId(sessionId: string): string | null {
    const match = /-(\d{4}-\d{2}-\d{2})$/.exec(sessionId);
    return match?.[1] ?? null;
  }

  private weekdayIndex(day: AdminBatchWeekday): number {
    const index: Record<AdminBatchWeekday, number> = {
      SUNDAY: 0,
      MONDAY: 1,
      TUESDAY: 2,
      WEDNESDAY: 3,
      THURSDAY: 4,
      FRIDAY: 5,
      SATURDAY: 6
    };
    return index[day];
  }

  private sameSchedule(left: AdminBatchScheduleItem[], right: AdminBatchScheduleItem[]): boolean {
    return this.scheduleKey(left) === this.scheduleKey(right);
  }

  private scheduleKey(schedule: AdminBatchScheduleItem[]): string {
    return [...schedule]
      .map((item) => ({ dayOfWeek: item.dayOfWeek, startTime: item.startTime }))
      .sort((left, right) => this.weekdays.indexOf(left.dayOfWeek) - this.weekdays.indexOf(right.dayOfWeek))
      .map((item) => `${item.dayOfWeek}:${item.startTime}`)
      .join('|');
  }

  private saveAttendanceBlob(blob: Blob, session: AdminBatchSessionItem): void {
    const batch = this.batch();
    const safeName = `${batch?.name || 'batch'}-${session.sessionNumber}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName || 'class-session'}-attendance.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
