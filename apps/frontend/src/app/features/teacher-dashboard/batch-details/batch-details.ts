import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, form as signalForm, maxLength, required } from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import {
  TeacherDashboardStore,
  type TeacherBatch,
  type TeacherBatchSchedule,
  type TeacherBatchStudent,
  type TeacherBatchStudentStatus,
  type TeacherSession,
  type TeacherSessionStatus
} from '../teacher-dashboard.store';

interface WeekdayOption {
  value: number;
  label: string;
}

interface MessageFormModel {
  message: string;
}

@Component({
  selector: 'sfu-batch-details',
  standalone: true,
  imports: [Footer, FormField, FormRoot, Header, RouterLink],
  templateUrl: './batch-details.html',
  styleUrl: './batch-details.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class BatchDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly dashboard = inject(TeacherDashboardStore);

  private readonly paramMap = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected readonly weekdays: WeekdayOption[] = [
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
    { value: 0, label: 'Sunday' }
  ];
  protected readonly batchId = computed(() => this.paramMap().get('batchId') ?? '');
  protected readonly batch = computed(() => this.dashboard.batches().find((item) => item.id === this.batchId()) ?? null);
  protected readonly sessions = computed(() => this.batch()?.sessions ?? []);
  protected readonly students = computed(() => this.batch()?.students ?? []);
  protected readonly nextSession = computed(() => {
    const batch = this.batch();
    return batch ? this.dashboard.nextSession(batch) : null;
  });
  protected readonly completedCount = computed(() => this.sessions().filter((session) => session.status === 'completed').length);
  protected readonly averageAttendance = computed(() => {
    const batch = this.batch();
    return batch ? this.dashboard.averageAttendance(batch) : null;
  });
  protected readonly averageAttendanceLabel = computed(() => {
    const averageAttendance = this.averageAttendance();
    return averageAttendance === null ? 'N/A' : `${averageAttendance}%`;
  });
  protected readonly openStudentMenuId = signal<string | null>(null);
  protected readonly openSessionMenuId = signal<string | null>(null);
  protected readonly openSessionMenuPosition = signal<'above' | 'below'>('below');
  protected readonly messageTargetId = signal<string | null>(null);
  protected readonly actionNotice = signal('');
  protected readonly actionError = signal('');
  protected readonly sessionActionLoadingId = this.dashboard.sessionActionLoadingId;
  protected readonly messageModel = signal<MessageFormModel>({ message: '' });
  protected readonly messageForm = signalForm(this.messageModel, (path) => {
    required(path.message);
    maxLength(path.message, 500);
  });
  protected readonly messageTarget = computed(() => {
    const targetId = this.messageTargetId();
    return targetId ? this.students().find((student) => student.id === targetId) ?? null : null;
  });

  constructor() {
    this.dashboard.loadBatches();
  }

  protected async startSession(session: TeacherSession): Promise<void> {
    this.actionError.set('');
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
    this.actionError.set('');
    this.dashboard.completeSession(session).subscribe({
      next: () => {
        this.actionNotice.set(`Session ${session.sessionNumber} has ended.`);
      },
      error: () => {
        this.actionError.set(this.dashboard.error());
      }
    });
  }

  protected batchProgress(batch: TeacherBatch): number {
    if (!batch.sessions.length) {
      return 0;
    }
    const completed = batch.sessions.filter((session) => session.status === 'completed').length;
    return Math.round((completed / batch.sessions.length) * 100);
  }

  protected statusLabel(status: TeacherSessionStatus): string {
    if (status === 'live') {
      return 'Live now';
    }
    return status[0]!.toUpperCase() + status.slice(1);
  }

  protected studentStatusLabel(status: TeacherBatchStudentStatus): string {
    return status[0]!.toUpperCase() + status.slice(1);
  }

  protected studentStatusTone(status: TeacherBatchStudentStatus): string {
    if (status === 'active') {
      return 'success';
    }
    if (status === 'blocked' || status === 'paused' || status === 'suspended') {
      return 'danger';
    }
    return 'warning';
  }

  protected attendanceLabel(value: number): string {
    return `${Math.round(value)}%`;
  }

  protected weekdayLabel(value: number): string {
    return this.weekdays.find((weekday) => weekday.value === value)?.label ?? 'Weekly';
  }

  protected scheduleLabel(schedule: TeacherBatchSchedule[]): string {
    return schedule.map((item) => `${this.dayLabel(item.dayOfWeek)} at ${item.startTime}`).join(', ');
  }

  private dayLabel(value: TeacherBatchSchedule['dayOfWeek']): string {
    return value[0] + value.slice(1).toLowerCase();
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

  protected trackSession(_index: number, session: TeacherSession): string {
    return session.id;
  }

  protected trackStudent(_index: number, student: TeacherBatchStudent): string {
    return student.id;
  }

  protected toggleStudentMenu(studentId: string): void {
    this.openStudentMenuId.update((openId) => (openId === studentId ? null : studentId));
  }

  protected toggleSessionMenu(sessionId: string, event: MouseEvent): void {
    const button = event.currentTarget as HTMLElement | null;
    const openId = this.openSessionMenuId();

    if (openId === sessionId) {
      this.openSessionMenuId.set(null);
      return;
    }

    const preferredDirection: 'above' | 'below' = (() => {
      if (!button) {
        return 'below';
      }
      const rect = button.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      return spaceBelow < 200 && spaceAbove > spaceBelow ? 'above' : 'below';
    })();

    this.openSessionMenuPosition.set(preferredDirection);
    this.openSessionMenuId.set(sessionId);
  }

  protected closeSessionMenu(): void {
    this.openSessionMenuId.set(null);
    this.openSessionMenuPosition.set('below');
  }

  protected async rescheduleSession(session: TeacherSession): Promise<void> {
    this.closeSessionMenu();
    await this.router.navigate([`/teacher/dashboard/batches`, session.batchId], {
      queryParams: { action: 'reschedule', sessionId: session.id }
    });
  }

  protected cancelSession(session: TeacherSession): void {
    this.closeSessionMenu();
    this.dashboard.cancelSession(session.id);
    this.actionNotice.set(`Session ${session.sessionNumber} has been cancelled.`);
  }

  protected sessionActionItems(session: TeacherSession): Array<{ label: string; handler: (session: TeacherSession) => void | Promise<void> }> {
    const actions = [] as Array<{ label: string; handler: (session: TeacherSession) => void | Promise<void> }>;

    if (session.status === 'live') {
      actions.push({ label: 'Open', handler: async (session) => {
        this.closeSessionMenu();
        await this.openSession(session);
      }});
      actions.push({ label: 'Complete', handler: (session) => {
        this.completeSession(session);
        this.closeSessionMenu();
      }});
      actions.push({ label: 'Cancel', handler: (session) => this.cancelSession(session) });
    }

    if (session.status === 'scheduled') {
      actions.push({ label: 'Start session', handler: async (session) => {
        await this.startSession(session);
        this.closeSessionMenu();
      }});
      actions.push({ label: 'Reschedule', handler: async (session) => this.rescheduleSession(session) });
      actions.push({ label: 'Cancel', handler: (session) => this.cancelSession(session) });
    }

    return actions;
  }

  protected closeStudentMenu(): void {
    this.openStudentMenuId.set(null);
  }

  protected openMessageComposer(student: TeacherBatchStudent): void {
    this.messageTargetId.set(student.id);
    this.messageModel.set({ message: '' });
    this.messageForm().reset();
    this.closeStudentMenu();
  }

  protected cancelMessage(): void {
    this.messageTargetId.set(null);
    this.messageModel.set({ message: '' });
    this.messageForm().reset();
  }

  protected submitMessage(event?: Event): void {
    event?.preventDefault();
    this.messageForm().markAsTouched();
    const target = this.messageTarget();
    const message = this.messageModel().message.trim();

    if (!target || !message || this.messageForm().invalid()) {
      return;
    }

    this.actionNotice.set(`Message queued for ${target.displayName}.`);
    this.cancelMessage();
  }

  protected suspendStudent(student: TeacherBatchStudent): void {
    this.dashboard.updateStudentStatus(this.batchId(), student.id, 'suspended');
    this.actionNotice.set(`${student.displayName} has been suspended.`);
    this.closeStudentMenu();
  }

  protected blockStudent(student: TeacherBatchStudent): void {
    this.dashboard.updateStudentStatus(this.batchId(), student.id, 'blocked');
    this.actionNotice.set(`${student.displayName} has been blocked.`);
    this.closeStudentMenu();
  }

  protected async copyProfileLink(student: TeacherBatchStudent): Promise<void> {
    const profileLink = `${globalThis.location.origin}/teacher/dashboard/batches/${this.batchId()}?studentId=${encodeURIComponent(student.id)}`;
    this.closeStudentMenu();

    try {
      await globalThis.navigator.clipboard.writeText(profileLink);
      this.actionNotice.set(`Profile link copied for ${student.displayName}.`);
    } catch {
      this.actionNotice.set(profileLink);
    }
  }
}
