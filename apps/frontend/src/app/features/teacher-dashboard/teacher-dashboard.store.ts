import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, finalize, forkJoin, map, of, tap, throwError } from 'rxjs';
import type { BatchLiveClassSettingsResponse, ChatThreadSummaryResponse, LiveClassSettingsPatch, Recording } from '@native-sfu/contracts';
import { API_BASE_URL } from '../../core/services/app-environment';
import { ClassSessionService, type ClassroomPayload, type ClassSessionStatus } from '../class-session/class-session.service';

export type BatchDayOfWeek = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';
export type TeacherBatchStatus = 'ACTIVE' | 'INACTIVE' | 'COMPLETED' | 'CANCELLED';
export type TeacherSessionStatus = ClassSessionStatus;
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
  roomId?: string;
  chatChannelId?: string;
  whiteboardChannelId?: string;
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

export interface TeacherSessionActionState {
  canStart: boolean;
  canEnter: boolean;
  canEnd: boolean;
  completed: boolean;
  cancelled: boolean;
  waitingForTeacher: boolean;
}

export interface TeacherRecordingItem extends Recording {
  sessionTitle: string;
  batchName: string;
}

export interface TeacherMessageIndicator {
  sessionId: string;
  batchId: string;
  sessionTitle: string;
  batchName: string;
  unreadCount: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
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
  students?: BackendTeacherBatchStudent[];
  sessions?: BackendTeacherSession[];
  createdAt: string;
  updatedAt?: string;
}

interface BackendTeacherBatchStudent {
  id: string;
  displayName: string;
  email: string;
  attendanceRate?: number;
  joinedAt?: string;
  status?: 'active' | 'invited' | 'paused' | 'suspended' | 'blocked' | 'pending' | 'completed' | 'cancelled';
}

interface BackendTeacherSession {
  id: string;
  batchId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  durationMinutes: number;
  status: TeacherSessionStatus;
  roomId?: string;
  chatChannelId?: string;
  whiteboardChannelId?: string;
  startedAt?: string;
  completedAt?: string;
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
  private readonly classSessions = inject(ClassSessionService);
  private readonly batchesSignal = signal<TeacherBatch[]>([]);
  private readonly loadingSignal = signal(false);
  private readonly savingSignal = signal(false);
  private readonly sessionActionLoadingIdSignal = signal<string | null>(null);
  private readonly recentRecordingsSignal = signal<TeacherRecordingItem[]>([]);
  private readonly messageIndicatorsSignal = signal<TeacherMessageIndicator[]>([]);
  private readonly errorSignal = signal('');

  readonly loading = this.loadingSignal.asReadonly();
  readonly saving = this.savingSignal.asReadonly();
  readonly sessionActionLoadingId = this.sessionActionLoadingIdSignal.asReadonly();
  readonly recentRecordings = this.recentRecordingsSignal.asReadonly();
  readonly messageIndicators = this.messageIndicatorsSignal.asReadonly();
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
  readonly liveSessions = computed(() => this.sessions().filter((session) => session.status === 'live'));
  readonly upcomingSessions = computed(() => this.sessions().filter((session) => session.status === 'scheduled').slice(0, 6));
  readonly todaySessions = computed(() =>
    this.sessions()
      .filter((session) => this.isToday(session.scheduledAt))
      .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())
  );
  readonly completedToday = computed(() => this.todaySessions().filter((session) => session.status === 'completed'));
  readonly totalStudents = computed(() => this.batches().reduce((total, batch) => total + Math.max(batch.enrolledCount, batch.students.length), 0));
  readonly attendanceWarnings = computed(() =>
    this.batches().filter((batch) => {
      const averageAttendance = this.averageAttendance(batch);
      return averageAttendance !== null && averageAttendance < 75;
    })
  );
  readonly rosterWarnings = computed(() => this.batches().filter((batch) => batch.enrolledCount === 0 || batch.enrolledCount >= batch.capacity));
  readonly recordingsReadyCount = computed(() => this.recentRecordings().filter((recording) => recording.status === 'stopped').length);
  readonly unreadMessageCount = computed(() => this.messageIndicators().reduce((total, item) => total + item.unreadCount, 0));

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
      next: (batches) => {
        this.batchesSignal.set(batches);
        this.loadRecentOperations(batches);
      },
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

  getBatchLiveSettings(batchId: string): Observable<BatchLiveClassSettingsResponse> {
    return this.http
      .get<BatchLiveClassSettingsResponse | ApiEnvelope<BatchLiveClassSettingsResponse>>(
        `${API_BASE_URL}/teacher/batches/${encodeURIComponent(batchId)}/live-settings`
      )
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateBatchLiveSettings(batchId: string, request: LiveClassSettingsPatch): Observable<BatchLiveClassSettingsResponse> {
    return this.http
      .patch<BatchLiveClassSettingsResponse | ApiEnvelope<BatchLiveClassSettingsResponse>>(
        `${API_BASE_URL}/teacher/batches/${encodeURIComponent(batchId)}/live-settings`,
        request
      )
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  resetBatchLiveSettings(batchId: string): Observable<BatchLiveClassSettingsResponse> {
    return this.http
      .post<BatchLiveClassSettingsResponse | ApiEnvelope<BatchLiveClassSettingsResponse>>(
        `${API_BASE_URL}/teacher/batches/${encodeURIComponent(batchId)}/live-settings/reset`,
        {}
      )
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  deleteBatch(batchId: string): void {
    this.http.delete<void | ApiEnvelope<void>>(`${API_BASE_URL}/teacher/batches/${encodeURIComponent(batchId)}`).subscribe({
      next: () => this.batchesSignal.update((batches) => batches.filter((batch) => batch.id !== batchId)),
      error: (error) => this.errorSignal.set(this.errorMessage(error))
    });
  }

  startSession(session: TeacherSession): Observable<ClassroomPayload> {
    this.sessionActionLoadingIdSignal.set(session.id);
    this.errorSignal.set('');
    return this.classSessions.startSession(session.id, session.batchId).pipe(
      tap((payload) => this.applySessionPayload(payload)),
      catchError((error) => {
        this.errorSignal.set(this.classSessions.errorMessage(error));
        return throwError(() => error);
      }),
      finalize(() => this.sessionActionLoadingIdSignal.set(null))
    );
  }

  completeSession(session: TeacherSession): Observable<ClassroomPayload> {
    this.sessionActionLoadingIdSignal.set(session.id);
    this.errorSignal.set('');
    return this.classSessions.endSession(session.id).pipe(
      tap((payload) => this.applySessionPayload(payload)),
      catchError((error) => {
        this.errorSignal.set(this.classSessions.errorMessage(error));
        return throwError(() => error);
      }),
      finalize(() => this.sessionActionLoadingIdSignal.set(null))
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

  sessionActionState(session: TeacherSession): TeacherSessionActionState {
    return {
      canStart: session.status === 'scheduled',
      canEnter: session.status === 'live',
      canEnd: session.status === 'live',
      completed: session.status === 'completed',
      cancelled: session.status === 'cancelled',
      waitingForTeacher: session.status === 'scheduled'
    };
  }

  averageAttendance(batch: TeacherBatch): number | null {
    if (!batch.students.length) {
      return null;
    }
    const total = batch.students.reduce((sum, student) => sum + student.attendanceRate, 0);
    return Math.round(total / batch.students.length);
  }

  batchForSession(session: TeacherSession): TeacherBatch | null {
    return this.batches().find((batch) => batch.id === session.batchId) ?? null;
  }

  refreshOperations(): void {
    this.loadBatches();
  }

  private loadRecentOperations(batches: TeacherBatch[]): void {
    const sessions = batches
      .flatMap((batch) => batch.sessions.map((session) => ({ batch, session })))
      .filter(({ session }) => session.status === 'live' || session.status === 'completed')
      .sort((left, right) => new Date(right.session.startedAt ?? right.session.scheduledAt).getTime() - new Date(left.session.startedAt ?? left.session.scheduledAt).getTime())
      .slice(0, 8);

    if (!sessions.length) {
      this.recentRecordingsSignal.set([]);
      this.messageIndicatorsSignal.set([]);
      return;
    }

    forkJoin(
      sessions.map(({ batch, session }) =>
        this.classSessions.listRecordings(session.id, batch.id).pipe(
          map((recordings) => recordings.map((recording) => ({ ...recording, sessionTitle: session.title, batchName: batch.name }))),
          catchError(() => of([] as TeacherRecordingItem[]))
        )
      )
    ).subscribe((groups) => {
      this.recentRecordingsSignal.set(
        groups
          .flat()
          .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
          .slice(0, 6)
      );
    });

    forkJoin(
      sessions.map(({ batch, session }) =>
        this.classSessions.getChatSummary(session.id, { batchId: batch.id }).pipe(
          map((summary) => this.messageIndicator(batch, session, summary)),
          catchError(() => of(null))
        )
      )
    ).subscribe((items) => {
      this.messageIndicatorsSignal.set(
        items
          .filter((item): item is TeacherMessageIndicator => Boolean(item && item.unreadCount > 0))
          .sort((left, right) => new Date(right.lastMessageAt ?? 0).getTime() - new Date(left.lastMessageAt ?? 0).getTime())
          .slice(0, 6)
      );
    });
  }

  private messageIndicator(batch: TeacherBatch, session: TeacherSession, summary: ChatThreadSummaryResponse): TeacherMessageIndicator {
    const threadSummaries = [...summary.threads, ...(summary.broadcast ? [summary.broadcast] : [])];
    const unreadCount = threadSummaries.reduce((total, thread) => total + thread.unreadCount, 0);
    const latest = threadSummaries
      .filter((thread) => thread.lastMessageAt)
      .sort((left, right) => new Date(right.lastMessageAt ?? 0).getTime() - new Date(left.lastMessageAt ?? 0).getTime())[0];
    return {
      sessionId: session.id,
      batchId: batch.id,
      sessionTitle: session.title,
      batchName: batch.name,
      unreadCount,
      ...(latest?.lastMessagePreview ? { lastMessagePreview: latest.lastMessagePreview } : {}),
      ...(latest?.lastMessageAt ? { lastMessageAt: latest.lastMessageAt } : {})
    };
  }

  private normalizeBatch(batch: BackendTeacherBatch): TeacherBatch {
    const schedule = [...(batch.schedule ?? [])].sort((left, right) => DAY_INDEX[left.dayOfWeek] - DAY_INDEX[right.dayOfWeek]);
    const sessions = batch.sessions?.length ? batch.sessions.map((session) => this.normalizeSession(session)) : this.createSessions(batch, schedule);
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
      students: (batch.students ?? []).map((student) => this.normalizeStudent(student)),
      sessions
    };
  }

  private normalizeStudent(student: BackendTeacherBatchStudent): TeacherBatchStudent {
    return {
      id: student.id,
      displayName: student.displayName,
      email: student.email,
      attendanceRate: Number(student.attendanceRate) || 0,
      joinedAt: student.joinedAt ?? new Date().toISOString(),
      status: this.normalizeStudentStatus(student.status)
    };
  }

  private normalizeStudentStatus(status: BackendTeacherBatchStudent['status']): TeacherBatchStudentStatus {
    if (status === 'pending') {
      return 'invited';
    }
    if (status === 'cancelled') {
      return 'blocked';
    }
    if (status === 'completed') {
      return 'paused';
    }
    if (status === 'active' || status === 'invited' || status === 'paused' || status === 'suspended' || status === 'blocked') {
      return status;
    }
    return 'active';
  }

  private normalizeSession(session: BackendTeacherSession): TeacherSession {
    return {
      id: session.id,
      batchId: session.batchId,
      title: session.title,
      sessionNumber: session.sessionNumber,
      scheduledAt: session.scheduledAt,
      durationMinutes: session.durationMinutes,
      status: session.status,
      roomId: session.roomId,
      chatChannelId: session.chatChannelId,
      whiteboardChannelId: session.whiteboardChannelId,
      startedAt: session.startedAt,
      completedAt: session.completedAt
    };
  }

  private applySessionPayload(payload: ClassroomPayload): void {
    this.batchesSignal.update((batches) =>
      batches.map((batch) => {
        if (batch.id !== payload.batchId) {
          return batch;
        }
        const nextSession = this.sessionFromPayload(payload, batch.sessions.find((session) => session.id === payload.sessionId));
        const hasSession = batch.sessions.some((session) => session.id === payload.sessionId);
        const sessions = hasSession
          ? batch.sessions.map((session) => (session.id === payload.sessionId ? nextSession : session))
          : [...batch.sessions, nextSession].sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime());
        return { ...batch, sessions };
      })
    );
  }

  private sessionFromPayload(payload: ClassroomPayload, existing?: TeacherSession): TeacherSession {
    return {
      id: payload.sessionId,
      batchId: payload.batchId,
      title: payload.title,
      sessionNumber: payload.sessionNumber,
      scheduledAt: payload.scheduledAt,
      durationMinutes: payload.durationMinutes,
      status: payload.status,
      roomId: payload.roomId,
      chatChannelId: payload.chatChannelId,
      whiteboardChannelId: payload.whiteboardChannelId,
      startedAt: payload.startedAt ?? existing?.startedAt,
      completedAt: payload.completedAt ?? existing?.completedAt
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

  private isToday(value: string): boolean {
    const date = new Date(value);
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
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
