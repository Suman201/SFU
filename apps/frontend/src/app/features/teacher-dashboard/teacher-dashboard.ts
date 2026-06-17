import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, FormRoot, form as signalForm, max, maxLength, min, required } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';
import {
  TeacherDashboardStore,
  type CreateTeacherBatchInput,
  type TeacherBatch,
  type TeacherSession,
  type TeacherSessionStatus
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
  imports: [Footer, FormField, FormRoot, Header],
  templateUrl: './teacher-dashboard.html',
  styleUrl: './teacher-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherDashboard {
  private readonly router = inject(Router);
  protected readonly dashboard = inject(TeacherDashboardStore);

  protected readonly selectedBatchId = signal<string | null>(null);
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
  protected readonly sessions = this.dashboard.sessions;
  protected readonly upcomingSessions = this.dashboard.upcomingSessions;
  protected readonly liveSession = this.dashboard.liveSession;
  protected readonly activeBatch = computed(() => {
    const batches = this.batches();
    return batches.find((batch) => batch.id === this.selectedBatchId()) ?? batches[0] ?? null;
  });
  protected readonly activeBatchSessions = computed(() => this.activeBatch()?.sessions ?? []);
  protected readonly scheduledCount = computed(() => this.sessions().filter((session) => session.status === 'scheduled').length);
  protected readonly completedCount = computed(() => this.sessions().filter((session) => session.status === 'completed').length);

  protected readonly batchModel = signal<BatchFormModel>({
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
  });
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
    const batch = this.dashboard.createBatch({
      ...value,
      enrolledCount: Math.min(value.enrolledCount, value.capacity)
    });
    this.selectedBatchId.set(batch.id);
  }

  protected selectBatch(batchId: string): void {
    this.selectedBatchId.set(batchId);
  }

  protected async startSession(session: TeacherSession): Promise<void> {
    const startedSession = this.dashboard.startSession(session.id);
    if (!startedSession) {
      return;
    }
    await this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: session.batchId,
        sessionId: session.id
      }
    });
  }

  protected async openSession(session: TeacherSession): Promise<void> {
    await this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: session.batchId,
        sessionId: session.id
      }
    });
  }

  protected startNextSession(batch: TeacherBatch): void {
    const nextSession = this.dashboard.nextSession(batch);
    if (nextSession) {
      void this.startSession(nextSession);
    }
  }

  protected completeSession(session: TeacherSession): void {
    this.dashboard.completeSession(session.id);
  }

  protected deleteBatch(batch: TeacherBatch): void {
    this.dashboard.deleteBatch(batch.id);
    if (this.selectedBatchId() === batch.id) {
      this.selectedBatchId.set(null);
    }
  }

  protected batchProgress(batch: TeacherBatch): number {
    if (!batch.sessions.length) {
      return 0;
    }
    const completed = batch.sessions.filter((session) => session.status === 'completed').length;
    return Math.round((completed / batch.sessions.length) * 100);
  }

  protected nextSession(batch: TeacherBatch): TeacherSession | null {
    return this.dashboard.nextSession(batch);
  }

  protected sessionBatch(session: TeacherSession | null): TeacherBatch | null {
    return session ? this.dashboard.sessionBatch(session.id) : null;
  }

  protected statusLabel(status: TeacherSessionStatus): string {
    if (status === 'live') {
      return 'Live now';
    }
    return status[0]!.toUpperCase() + status.slice(1);
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

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(value));
  }

  protected trackBatch(_index: number, batch: TeacherBatch): string {
    return batch.id;
  }

  protected trackSession(_index: number, session: TeacherSession): string {
    return session.id;
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
