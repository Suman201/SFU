import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';
import {
  BatchDayOfWeek,
  TeacherDashboardStore,
  type CreateTeacherBatchInput,
  type TeacherBatch,
  type TeacherBatchSchedule,
  type TeacherSession
} from './teacher-dashboard.store';

interface WeekdayOption {
  value: BatchDayOfWeek;
  dayIndex: number;
  label: string;
}

interface BatchFormModel {
  name: string;
  courseName: string;
  courseId: string;
  year: number;
  maxCapacity: number | null;
  schedule: Partial<Record<BatchDayOfWeek, string>>;
}

interface DashboardMetric {
  label: string;
  value: string;
  tone: 'green' | 'rose' | 'coral' | 'amber';
}

@Component({
  selector: 'sfu-teacher-dashboard',
  standalone: true,
  imports: [Footer, FormsModule, Header, RouterLink],
  templateUrl: './teacher-dashboard.html',
  styleUrl: './teacher-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherDashboard {
  private readonly router = inject(Router);
  protected readonly dashboard = inject(TeacherDashboardStore);

  protected readonly createDrawerOpen = signal(false);
  protected readonly formSubmitted = signal(false);
  protected readonly backendError = signal('');
  protected readonly weekdays: WeekdayOption[] = [
    { value: 'MONDAY', dayIndex: 1, label: 'Monday' },
    { value: 'TUESDAY', dayIndex: 2, label: 'Tuesday' },
    { value: 'WEDNESDAY', dayIndex: 3, label: 'Wednesday' },
    { value: 'THURSDAY', dayIndex: 4, label: 'Thursday' },
    { value: 'FRIDAY', dayIndex: 5, label: 'Friday' },
    { value: 'SATURDAY', dayIndex: 6, label: 'Saturday' },
    { value: 'SUNDAY', dayIndex: 0, label: 'Sunday' }
  ];
  protected readonly batches = this.dashboard.batches;
  protected readonly loading = this.dashboard.loading;
  protected readonly saving = this.dashboard.saving;
  protected readonly sessionActionLoadingId = this.dashboard.sessionActionLoadingId;
  protected readonly todaySessions = this.dashboard.todaySessions;
  protected readonly liveSessions = this.dashboard.liveSessions;
  protected readonly upcomingSessions = this.dashboard.upcomingSessions;
  protected readonly recentRecordings = this.dashboard.recentRecordings;
  protected readonly messageIndicators = this.dashboard.messageIndicators;
  protected readonly metrics = computed<DashboardMetric[]>(() => [
    { label: 'Live now', value: `${this.liveSessions().length}`, tone: 'coral' },
    { label: "Today's sessions", value: `${this.todaySessions().length}`, tone: 'green' },
    { label: 'Upcoming', value: `${this.upcomingSessions().length}`, tone: 'amber' },
    { label: 'Students enrolled', value: `${this.dashboard.totalStudents()}`, tone: 'rose' },
    { label: 'Attendance alerts', value: `${this.dashboard.attendanceWarnings().length}`, tone: 'amber' },
    { label: 'Recordings ready', value: `${this.dashboard.recordingsReadyCount()}`, tone: 'green' }
  ]);
  protected readonly batchHealth = computed(() =>
    this.batches()
      .map((batch) => ({
        batch,
        nextSession: this.nextSession(batch),
        averageAttendance: this.dashboard.averageAttendance(batch),
        fillPercent: batch.capacity ? Math.round((batch.enrolledCount / batch.capacity) * 100) : 0,
        warning:
          batch.enrolledCount === 0
            ? 'No active roster'
            : batch.enrolledCount >= batch.capacity
              ? 'Batch at capacity'
              : this.dashboard.averageAttendance(batch) !== null && (this.dashboard.averageAttendance(batch) ?? 100) < 75
                ? 'Attendance needs review'
                : ''
      }))
      .sort((left, right) => Number(Boolean(right.warning)) - Number(Boolean(left.warning)))
      .slice(0, 6)
  );
  protected readonly batchModel = signal<BatchFormModel>(this.initialBatchModel());
  protected readonly selectedSchedule = computed(() => this.scheduleFromModel(this.batchModel()));
  protected readonly dateRangeLabel = computed(() => {
    const year = this.batchModel().year;
    return `01 Jan ${year} to 31 Dec ${year}`;
  });
  protected readonly formErrors = computed(() => this.validateForm(this.batchModel()));
  protected readonly formInvalid = computed(() => this.formErrors().length > 0);

  constructor() {
    this.dashboard.loadBatches();
  }

  protected createBatch(event?: Event): void {
    event?.preventDefault();
    this.formSubmitted.set(true);
    this.backendError.set('');

    if (this.formInvalid()) {
      return;
    }

    const payload = this.normalizedBatchFormValue();
    this.dashboard.createBatch(payload).subscribe({
      next: async (batch) => {
        this.batchModel.set(this.initialBatchModel());
        this.formSubmitted.set(false);
        this.createDrawerOpen.set(false);
        await this.router.navigate(['/teacher/dashboard/batches', batch.id]);
      },
      error: () => this.backendError.set(this.dashboard.error())
    });
  }

  protected deleteBatch(batch: TeacherBatch): void {
    this.dashboard.deleteBatch(batch.id);
  }

  protected toggleWeekday(day: BatchDayOfWeek, checked: boolean): void {
    this.batchModel.update((model) => {
      const schedule = { ...model.schedule };
      if (checked) {
        schedule[day] = schedule[day] ?? '';
      } else {
        delete schedule[day];
      }
      return { ...model, schedule };
    });
  }

  protected setScheduleTime(day: BatchDayOfWeek, value: string): void {
    this.batchModel.update((model) => ({ ...model, schedule: { ...model.schedule, [day]: value } }));
  }

  protected isWeekdaySelected(day: BatchDayOfWeek): boolean {
    return Object.prototype.hasOwnProperty.call(this.batchModel().schedule, day);
  }

  protected weekdayTime(day: BatchDayOfWeek): string {
    return this.batchModel().schedule[day] ?? '';
  }

  protected updateModel<K extends keyof BatchFormModel>(key: K, value: BatchFormModel[K]): void {
    this.batchModel.update((model) => ({ ...model, [key]: value }));
  }

  protected nextSession(batch: TeacherBatch): TeacherSession | null {
    return this.dashboard.nextSession(batch);
  }

  protected averageAttendanceLabel(batch: TeacherBatch): string {
    const averageAttendance = this.dashboard.averageAttendance(batch);
    return averageAttendance === null ? 'N/A' : `${averageAttendance}%`;
  }

  protected sessionActionLabel(batch: TeacherBatch): string {
    return this.nextSession(batch)?.status === 'live' ? 'Open session' : 'Start session';
  }

  protected async runSessionAction(batch: TeacherBatch): Promise<void> {
    const session = this.nextSession(batch);
    if (!session) {
      return;
    }

    if (session.status === 'live') {
      await this.openSession(session);
      return;
    }

    this.startSession(session);
  }

  protected startSession(session: TeacherSession): void {
    this.dashboard.startSession(session).subscribe({
      next: (payload) => {
        void this.router.navigate(['/class-session/teacher'], {
          queryParams: {
            batchId: payload.batchId,
            sessionId: payload.sessionId
          }
        });
      }
    });
  }

  protected enterSession(session: TeacherSession): void {
    void this.openSession(session);
  }

  protected endSession(session: TeacherSession): void {
    if (!confirm(`End ${session.title} for everyone?`)) {
      return;
    }
    this.dashboard.completeSession(session).subscribe();
  }

  protected openMessageIndicator(message: { sessionId: string; batchId: string }): void {
    void this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: message.batchId,
        sessionId: message.sessionId
      }
    });
  }

  protected refreshDashboard(): void {
    this.dashboard.refreshOperations();
  }

  protected sessionStatusLabel(session: TeacherSession): string {
    switch (session.status) {
      case 'live':
        return 'Live';
      case 'completed':
        return 'Completed';
      case 'cancelled':
        return 'Cancelled';
      case 'scheduled':
      default:
        return 'Scheduled';
    }
  }

  protected sessionBatchName(session: TeacherSession): string {
    return this.dashboard.batchForSession(session)?.name ?? 'Batch';
  }

  protected sessionActionDisabled(session: TeacherSession): boolean {
    return this.sessionActionLoadingId() === session.id;
  }

  protected actionState(session: TeacherSession) {
    return this.dashboard.sessionActionState(session);
  }

  private async openSession(session: TeacherSession): Promise<void> {
    await this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: session.batchId,
        sessionId: session.id
      }
    });
  }

  protected weekdayLabel(value: number | BatchDayOfWeek): string {
    if (typeof value === 'string') {
      return this.weekdays.find((weekday) => weekday.value === value)?.label ?? 'Weekly';
    }
    return this.weekdays.find((weekday) => weekday.dayIndex === value)?.label ?? 'Weekly';
  }

  protected scheduleLabel(batch: TeacherBatch): string {
    return batch.schedule.map((item) => `${this.weekdayLabel(item.dayOfWeek)} ${item.startTime}`).join(', ');
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

  protected openCreateDrawer(): void {
    this.backendError.set('');
    this.createDrawerOpen.set(true);
  }

  protected closeCreateDrawer(): void {
    if (this.saving()) {
      return;
    }
    this.createDrawerOpen.set(false);
  }

  protected showValidation(): boolean {
    return this.formSubmitted();
  }

  private initialBatchModel(): BatchFormModel {
    const year = new Date().getFullYear();
    return {
      name: '',
      courseName: '',
      courseId: '',
      year,
      maxCapacity: 30,
      schedule: {}
    };
  }

  private normalizedBatchFormValue(): CreateTeacherBatchInput {
    const value = this.batchModel();
    return {
      name: value.name.trim(),
      courseId: value.courseId.trim() || undefined,
      courseName: value.courseName.trim() || undefined,
      year: Number(value.year),
      maxCapacity: Number(value.maxCapacity),
      schedule: this.scheduleFromModel(value)
    };
  }

  private scheduleFromModel(model: BatchFormModel): TeacherBatchSchedule[] {
    return this.weekdays
      .filter((weekday) => Object.prototype.hasOwnProperty.call(model.schedule, weekday.value))
      .map((weekday) => ({ dayOfWeek: weekday.value, startTime: model.schedule[weekday.value] ?? '' }));
  }

  private validateForm(model: BatchFormModel): string[] {
    const errors: string[] = [];
    const schedule = this.scheduleFromModel(model);
    if (!model.name.trim()) errors.push('Batch name is required.');
    if (!model.year || Number(model.year) < 2000) errors.push('Year is required.');
    if (!model.maxCapacity || Number(model.maxCapacity) <= 0) errors.push('Max capacity must be greater than 0.');
    if (!schedule.length) errors.push('Select at least one weekday.');
    if (schedule.some((item) => !item.startTime)) errors.push('Every selected weekday must have a start time.');
    return errors;
  }
}
