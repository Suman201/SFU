import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormField, FormRoot, form as signalForm, max, maxLength, min, required } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';
import {
  TeacherDashboardStore,
  type CreateTeacherBatchInput,
  type TeacherBatch,
  type TeacherSession
} from './teacher-dashboard.store';

interface WeekdayOption {
  value: number;
  label: string;
}

interface BatchFormModel {
  name: string;
  courseName: string;
  cohortCode: string;
  capacity: number;
  enrolledCount: number;
  startDate: string;
  weeklyDay: string;
  startTime: string;
  durationMinutes: string;
  totalWeeks: number;
}

@Component({
  selector: 'sfu-teacher-dashboard',
  standalone: true,
  imports: [Footer, FormField, FormRoot, Header, RouterLink],
  templateUrl: './teacher-dashboard.html',
  styleUrl: './teacher-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherDashboard {
  private readonly router = inject(Router);
  protected readonly dashboard = inject(TeacherDashboardStore);

  protected readonly createDrawerOpen = signal(false);
  protected readonly weekdays: WeekdayOption[] = [
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
    { value: 0, label: 'Sunday' }
  ];
  protected readonly durations = [45, 60, 75, 90, 120];
  protected readonly batches = this.dashboard.batches;

  protected readonly batchModel = signal<BatchFormModel>(this.initialBatchModel());
  protected readonly batchForm = signalForm(this.batchModel, (path) => {
    required(path.name);
    maxLength(path.name, 80);
    required(path.courseName);
    maxLength(path.courseName, 120);
    required(path.cohortCode);
    maxLength(path.cohortCode, 32);
    required(path.capacity);
    min(path.capacity, 1);
    max(path.capacity, 250);
    required(path.enrolledCount);
    min(path.enrolledCount, 0);
    max(path.enrolledCount, 250);
    required(path.startDate);
    required(path.weeklyDay);
    required(path.startTime);
    required(path.durationMinutes);
    required(path.totalWeeks);
    min(path.totalWeeks, 1);
    max(path.totalWeeks, 52);
  });

  protected createBatch(event?: Event): void {
    event?.preventDefault();
    this.batchForm().markAsTouched();

    if (this.batchForm().invalid()) {
      return;
    }
    const value = this.normalizedBatchFormValue();
    this.dashboard.createBatch({
      ...value,
      enrolledCount: Math.min(value.enrolledCount, value.capacity)
    });
    this.batchModel.set(this.initialBatchModel());
    this.batchForm().reset();
    this.createDrawerOpen.set(false);
  }

  protected deleteBatch(batch: TeacherBatch): void {
    this.dashboard.deleteBatch(batch.id);
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

    await this.startSession(session);
  }

  private async startSession(session: TeacherSession): Promise<void> {
    const startedSession = this.dashboard.startSession(session.id);
    if (!startedSession) {
      return;
    }
    await this.openSession(startedSession);
  }

  private async openSession(session: TeacherSession): Promise<void> {
    await this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: session.batchId,
        sessionId: session.id
      }
    });
  }

  protected weekdayLabel(value: number): string {
    return this.weekdays.find((weekday) => weekday.value === value)?.label ?? 'Weekly';
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
    this.createDrawerOpen.set(true);
  }

  protected closeCreateDrawer(): void {
    this.createDrawerOpen.set(false);
  }

  private todayInputValue(): string {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${today.getFullYear()}-${month}-${day}`;
  }

  private defaultWeekday(): number {
    const day = new Date().getDay();
    return day === 0 ? 1 : day;
  }

  private initialBatchModel(): BatchFormModel {
    return {
      name: 'Foundation Batch',
      courseName: 'Native WebRTC SFU',
      cohortCode: 'SFU-WEEKLY-01',
      capacity: 24,
      enrolledCount: 18,
      startDate: this.todayInputValue(),
      weeklyDay: String(this.defaultWeekday()),
      startTime: '18:00',
      durationMinutes: '60',
      totalWeeks: 8
    };
  }

  private normalizedBatchFormValue(): CreateTeacherBatchInput {
    const value = this.batchModel();
    return {
      ...value,
      capacity: Number(value.capacity),
      enrolledCount: Number(value.enrolledCount),
      weeklyDay: Number(value.weeklyDay),
      durationMinutes: Number(value.durationMinutes),
      totalWeeks: Number(value.totalWeeks)
    };
  }
}
