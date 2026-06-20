import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, finalize, map, tap, throwError } from 'rxjs';
import { API_BASE_URL } from '../../core/services/app-environment';

export type BatchDayOfWeek = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';
export type TeacherBatchStatus = 'ACTIVE' | 'INACTIVE' | 'COMPLETED' | 'CANCELLED';
export type TeacherSessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';
export type TeacherBatchStudentStatus = 'active' | 'invited' | 'paused' | 'suspended' | 'blocked';

export interface TeacherBatchSchedule {
  id?: string;
  dayOfWeek: BatchDayOfWeek;
  startTime: string;
}

export interface CreateTeacherBatchInput {
  name: string;
  courseId?: string;
  courseName?: string;
  year: number;
  maxCapacity: number;
  schedule: TeacherBatchSchedule[];
}

export interface TeacherSession {
  id: string;
  batchId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  durationMinutes: number;
  status: TeacherSessionStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface TeacherBatchStudent {
  id: string;
  displayName: string;
  email: string;
  attendanceRate: number;
  joinedAt: string;
  status: TeacherBatchStudentStatus;
}

export interface TeacherBatch {
  id: string;
  name: string;
  courseId?: string;
  courseName: string;
  cohortCode: string;
  year: number;
  startDate: string;
  endDate: string;
  maxCapacity: number;
  capacity: number;
  enrolledCount: number;
  status: TeacherBatchStatus;
  schedule: TeacherBatchSchedule[];
  weeklyDay: number;
  startTime: string;
  durationMinutes: number;
  totalWeeks: number;
  createdAt: string;
  updatedAt?: string;
  students: TeacherBatchStudent[];
  sessions: TeacherSession[];
}

interface BackendTeacherBatch {
  id: string;
  name: string;
  courseId?: string;
  courseName?: string;
  year: number;
  startDate: string;
  endDate: string;
  maxCapacity: number;
  enrolledCount: number;
  status: TeacherBatchStatus;
  schedule: TeacherBatchSchedule[];
  createdAt: string;
  updatedAt?: string;
}

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

const DAY_INDEX: Record<BatchDayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6
};

const SESSION_DURATION_MINUTES = 60;
const WEEK_IN_DAYS = 7;

@Injectable({ providedIn: 'root' })
export class TeacherDashboardStore {
  private readonly http = inject(HttpClient);
  private readonly batchesSignal = signal<TeacherBatch[]>([]);
  private readonly loadingSignal = signal(false);
  private readonly savingSignal = signal(false);
  private readonly errorSignal = signal('');

  readonly loading = this.loadingSignal.asReadonly();
  readonly saving = this.savingSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly batches = computed(() =>
    [...this.batchesSignal()].sort((left, right) => this.nextSessionTime(left) - this.nextSessionTime(right))
  );
  readonly sessions = computed(() =>
    this.batches()
      .flatMap((batch) => batch.sessions)
      .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())
  );
  readonly liveSession = computed(() => this.sessions().find((session) => session.status === 'live') ?? null);
  readonly upcomingSessions = computed(() => this.sessions().filter((session) => session.status === 'scheduled').slice(0, 6));

  loadBatches(): void {
    this.loadingSignal.set(true);
    this.errorSignal.set('');
    this.http.get<BackendTeacherBatch[] | ApiEnvelope<BackendTeacherBatch[]>>(`${API_BASE_URL}/teacher/batches`).pipe(
      map((response) => this.unwrapResponse(response).map((batch) => this.normalizeBatch(batch))),
      catchError((error) => {
        this.errorSignal.set(this.errorMessage(error));
        return throwError(() => error);
      })
    ).subscribe({
      next: (batches) => this.batchesSignal.set(batches),
      error: () => this.loadingSignal.set(false),
      complete: () => this.loadingSignal.set(false)
    });
  }

  createBatch(input: CreateTeacherBatchInput): Observable<TeacherBatch> {
    this.savingSignal.set(true);
    this.errorSignal.set('');
    return this.http.post<BackendTeacherBatch | ApiEnvelope<BackendTeacherBatch>>(`${API_BASE_URL}/teacher/batches`, input).pipe(
      map((response) => this.normalizeBatch(this.unwrapResponse(response))),
      tap((batch) => this.batchesSignal.update((batches) => [batch, ...batches.filter((item) => item.id !== batch.id)])),
      catchError((error) => {
        this.errorSignal.set(this.errorMessage(error));
        return throwError(() => error);
      }),
      finalize(() => this.savingSignal.set(false))
    );
  }

  deleteBatch(batchId: string): void {
    this.http.delete<void | ApiEnvelope<void>>(`${API_BASE_URL}/teacher/batches/${encodeURIComponent(batchId)}`).subscribe({
      next: () => this.batchesSignal.update((batches) => batches.filter((batch) => batch.id !== batchId)),
      error: (error) => this.errorSignal.set(this.errorMessage(error))
    });
  }

  startSession(sessionId: string): TeacherSession | null {
    let startedSession: TeacherSession | null = null;
    const startedAt = new Date().toISOString();
    this.batchesSignal.update((batches) =>
      batches.map((batch) => ({
        ...batch,
        sessions: batch.sessions.map((session) => {
          if (session.status === 'live' && session.id !== sessionId) {
            return { ...session, status: 'completed', completedAt: startedAt };
          }
          if (session.id !== sessionId || session.status === 'completed' || session.status === 'cancelled') {
            return session;
          }
          startedSession = { ...session, status: 'live', startedAt };
          return startedSession;
        })
      }))
    );
    return startedSession;
  }

  completeSession(sessionId: string): void {
    const completedAt = new Date().toISOString();
    this.batchesSignal.update((batches) =>
      batches.map((batch) => ({
        ...batch,
        sessions: batch.sessions.map((session) =>
          session.id === sessionId ? { ...session, status: 'completed', completedAt } : session
        )
      }))
    );
  }

  cancelSession(sessionId: string): void {
    const cancelledAt = new Date().toISOString();
    this.batchesSignal.update((batches) =>
      batches.map((batch) => ({
        ...batch,
        sessions: batch.sessions.map((session) =>
          session.id === sessionId ? { ...session, status: 'cancelled', completedAt: cancelledAt } : session
        )
      }))
    );
  }

  updateStudentStatus(batchId: string, studentId: string, status: TeacherBatchStudentStatus): void {
    this.batchesSignal.update((batches) =>
      batches.map((batch) =>
        batch.id === batchId
          ? {
              ...batch,
              students: batch.students.map((student) => (student.id === studentId ? { ...student, status } : student))
            }
          : batch
      )
    );
  }

  sessionBatch(sessionId: string): TeacherBatch | null {
    return this.batches().find((batch) => batch.sessions.some((session) => session.id === sessionId)) ?? null;
  }

  nextSession(batch: TeacherBatch): TeacherSession | null {
    return (
      [...batch.sessions]
        .filter((session) => session.status === 'scheduled' || session.status === 'live')
        .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())[0] ?? null
    );
  }

  averageAttendance(batch: TeacherBatch): number | null {
    if (!batch.students.length) {
      return null;
    }
    const total = batch.students.reduce((sum, student) => sum + student.attendanceRate, 0);
    return Math.round(total / batch.students.length);
  }

  private normalizeBatch(batch: BackendTeacherBatch): TeacherBatch {
    const schedule = [...(batch.schedule ?? [])].sort((left, right) => DAY_INDEX[left.dayOfWeek] - DAY_INDEX[right.dayOfWeek]);
    const sessions = this.createSessions(batch, schedule);
    const capacity = Number(batch.maxCapacity) || 0;
    const enrolledCount = Math.min(Number(batch.enrolledCount) || 0, capacity);
    const createdAt = batch.createdAt ?? new Date().toISOString();

    return {
      id: batch.id,
      name: batch.name,
      courseId: batch.courseId,
      courseName: batch.courseName ?? 'General course',
      cohortCode: `${batch.year}`,
      year: batch.year,
      startDate: batch.startDate,
      endDate: batch.endDate,
      maxCapacity: capacity,
      capacity,
      enrolledCount,
      status: batch.status,
      schedule,
      weeklyDay: schedule.length ? DAY_INDEX[schedule[0]!.dayOfWeek] : 1,
      startTime: schedule[0]?.startTime ?? '',
      durationMinutes: SESSION_DURATION_MINUTES,
      totalWeeks: sessions.length,
      createdAt,
      updatedAt: batch.updatedAt,
      students: [],
      sessions
    };
  }

  private createSessions(batch: BackendTeacherBatch, schedule: TeacherBatchSchedule[]): TeacherSession[] {
    const start = new Date(`${batch.startDate}T00:00:00`);
    const end = new Date(`${batch.endDate}T23:59:59`);
    const sessions: TeacherSession[] = [];

    for (const item of schedule) {
      const current = new Date(start);
      const dayOffset = (DAY_INDEX[item.dayOfWeek] - current.getDay() + WEEK_IN_DAYS) % WEEK_IN_DAYS;
      current.setDate(current.getDate() + dayOffset);
      const [hours = 0, minutes = 0] = item.startTime.split(':').map(Number);
      current.setHours(hours, minutes, 0, 0);

      while (current <= end) {
        sessions.push({
          id: `${batch.id}-${item.dayOfWeek}-${current.toISOString().slice(0, 10)}`,
          batchId: batch.id,
          title: `${batch.name} - ${this.dayLabel(item.dayOfWeek)}`,
          sessionNumber: 0,
          scheduledAt: current.toISOString(),
          durationMinutes: SESSION_DURATION_MINUTES,
          status: 'scheduled'
        });
        current.setDate(current.getDate() + WEEK_IN_DAYS);
      }
    }

    return sessions
      .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())
      .map((session, index) => ({
        ...session,
        title: `${batch.name} - Session ${index + 1}`,
        sessionNumber: index + 1
      }));
  }

  private nextSessionTime(batch: TeacherBatch): number {
    return new Date(this.nextSession(batch)?.scheduledAt ?? batch.createdAt).getTime();
  }

  private dayLabel(day: BatchDayOfWeek): string {
    return day[0] + day.slice(1).toLowerCase();
  }

  private unwrapResponse<T>(response: T | ApiEnvelope<T>): T {
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as ApiEnvelope<T>).data;
      if (data !== undefined && data !== null) {
        return data;
      }
    }
    return response as T;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const backendMessage = this.backendMessage(error.error);
      if (backendMessage) return backendMessage;
      if (error.status === 0) return 'Unable to reach the server. Please check your connection and try again.';
      if (error.status === 409) return 'A batch with this name already exists for the selected year.';
      if (error.status === 403) return 'Only teacher accounts can manage batches.';
      return 'Unable to save the batch right now. Please try again.';
    }
    return 'Unable to save the batch right now. Please try again.';
  }

  private backendMessage(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    const body = error as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.map((item) => this.backendMessage(item) || String(item)).filter(Boolean).join(' ');
    if (Array.isArray(body.error)) return body.error.map((item) => this.backendMessage(item) || String(item)).filter(Boolean).join(' ');
    return '';
  }
}
