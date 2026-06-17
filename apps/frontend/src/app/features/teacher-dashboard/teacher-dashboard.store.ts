import { Injectable, computed, effect, signal } from '@angular/core';

export type TeacherSessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';

export interface CreateTeacherBatchInput {
  name: string;
  courseName: string;
  cohortCode: string;
  capacity: number;
  enrolledCount: number;
  startDate: string;
  weeklyDay: number;
  startTime: string;
  durationMinutes: number;
  totalWeeks: number;
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

export interface TeacherBatch {
  id: string;
  name: string;
  courseName: string;
  cohortCode: string;
  capacity: number;
  enrolledCount: number;
  weeklyDay: number;
  startTime: string;
  durationMinutes: number;
  totalWeeks: number;
  createdAt: string;
  sessions: TeacherSession[];
}

interface TeacherDashboardState {
  batches: TeacherBatch[];
}

const STORAGE_KEY = 'native-sfu-teacher-dashboard';
const WEEK_IN_DAYS = 7;

@Injectable({ providedIn: 'root' })
export class TeacherDashboardStore {
  private readonly state = signal<TeacherDashboardState>(this.loadState());

  readonly batches = computed(() =>
    [...this.state().batches].sort((left, right) => this.nextSessionTime(left) - this.nextSessionTime(right))
  );
  readonly sessions = computed(() =>
    this.batches()
      .flatMap((batch) => batch.sessions)
      .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())
  );
  readonly liveSession = computed(() => this.sessions().find((session) => session.status === 'live') ?? null);
  readonly upcomingSessions = computed(() => this.sessions().filter((session) => session.status === 'scheduled').slice(0, 6));

  constructor() {
    effect(() => this.persistState(this.state()));
  }

  createBatch(input: CreateTeacherBatchInput): TeacherBatch {
    const now = new Date().toISOString();
    const batchId = this.createId('batch');
    const batch: TeacherBatch = {
      id: batchId,
      name: input.name.trim(),
      courseName: input.courseName.trim(),
      cohortCode: input.cohortCode.trim(),
      capacity: input.capacity,
      enrolledCount: Math.min(input.enrolledCount, input.capacity),
      weeklyDay: input.weeklyDay,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      totalWeeks: input.totalWeeks,
      createdAt: now,
      sessions: this.createWeeklySessions(batchId, input)
    };
    this.state.update((state) => ({ batches: [batch, ...state.batches] }));
    return batch;
  }

  startSession(sessionId: string): TeacherSession | null {
    let startedSession: TeacherSession | null = null;
    const startedAt = new Date().toISOString();
    this.state.update((state) => ({
      batches: state.batches.map((batch) => ({
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
    }));
    return startedSession;
  }

  completeSession(sessionId: string): void {
    const completedAt = new Date().toISOString();
    this.state.update((state) => ({
      batches: state.batches.map((batch) => ({
        ...batch,
        sessions: batch.sessions.map((session) =>
          session.id === sessionId ? { ...session, status: 'completed', completedAt } : session
        )
      }))
    }));
  }

  deleteBatch(batchId: string): void {
    this.state.update((state) => ({ batches: state.batches.filter((batch) => batch.id !== batchId) }));
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

  private createWeeklySessions(batchId: string, input: CreateTeacherBatchInput): TeacherSession[] {
    const firstSessionAt = this.firstWeeklyDate(input.startDate, input.weeklyDay, input.startTime);
    return Array.from({ length: input.totalWeeks }, (_, index) => {
      const scheduledAt = new Date(firstSessionAt);
      scheduledAt.setDate(firstSessionAt.getDate() + index * WEEK_IN_DAYS);
      return {
        id: this.createId('session'),
        batchId,
        title: `${input.name.trim()} - Week ${index + 1}`,
        sessionNumber: index + 1,
        scheduledAt: scheduledAt.toISOString(),
        durationMinutes: input.durationMinutes,
        status: 'scheduled' as const
      };
    });
  }

  private firstWeeklyDate(startDate: string, weeklyDay: number, startTime: string): Date {
    const firstDate = new Date(`${startDate}T00:00:00`);
    const [hours = 0, minutes = 0] = startTime.split(':').map(Number);
    const dayOffset = (weeklyDay - firstDate.getDay() + WEEK_IN_DAYS) % WEEK_IN_DAYS;
    firstDate.setDate(firstDate.getDate() + dayOffset);
    firstDate.setHours(hours, minutes, 0, 0);
    return firstDate;
  }

  private nextSessionTime(batch: TeacherBatch): number {
    return new Date(this.nextSession(batch)?.scheduledAt ?? batch.createdAt).getTime();
  }

  private loadState(): TeacherDashboardState {
    try {
      const storedState = localStorage.getItem(STORAGE_KEY);
      if (!storedState) {
        return { batches: [] };
      }
      const parsed = JSON.parse(storedState) as TeacherDashboardState;
      return Array.isArray(parsed.batches) ? parsed : { batches: [] };
    } catch {
      return { batches: [] };
    }
  }

  private persistState(state: TeacherDashboardState): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The dashboard remains usable in memory if storage is unavailable.
    }
  }

  private createId(prefix: string): string {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  }
}
