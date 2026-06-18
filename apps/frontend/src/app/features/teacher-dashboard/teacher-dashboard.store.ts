import { Injectable, computed, effect, signal } from '@angular/core';

export type TeacherSessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';
export type TeacherBatchStudentStatus = 'active' | 'invited' | 'paused' | 'suspended' | 'blocked';

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
  courseName: string;
  cohortCode: string;
  capacity: number;
  enrolledCount: number;
  weeklyDay: number;
  startTime: string;
  durationMinutes: number;
  totalWeeks: number;
  createdAt: string;
  students: TeacherBatchStudent[];
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
    const enrolledCount = Math.min(input.enrolledCount, input.capacity);
    const batch: TeacherBatch = {
      id: batchId,
      name: input.name.trim(),
      courseName: input.courseName.trim(),
      cohortCode: input.cohortCode.trim(),
      capacity: input.capacity,
      enrolledCount,
      weeklyDay: input.weeklyDay,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      totalWeeks: input.totalWeeks,
      createdAt: now,
      students: this.createStudents(batchId, enrolledCount, now),
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

  updateStudentStatus(batchId: string, studentId: string, status: TeacherBatchStudentStatus): void {
    this.state.update((state) => ({
      batches: state.batches.map((batch) =>
        batch.id === batchId
          ? {
              ...batch,
              students: batch.students.map((student) => (student.id === studentId ? { ...student, status } : student))
            }
          : batch
      )
    }));
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

  private createStudents(batchId: string, count: number, joinedAt: string): TeacherBatchStudent[] {
    const names = [
      'Aarav Sharma',
      'Mia Patel',
      'Rohan Das',
      'Sophia Roy',
      'Kabir Mehta',
      'Ananya Sen',
      'Ishaan Gupta',
      'Diya Nair',
      'Vihaan Rao',
      'Zara Khan',
      'Arjun Iyer',
      'Sara Thomas',
      'Neil Kapoor',
      'Ira Bose',
      'Reyansh Jain',
      'Tara Malhotra',
      'Dev Menon',
      'Nisha Reddy',
      'Yash Verma',
      'Aisha Ali'
    ];

    return Array.from({ length: count }, (_, index) => {
      const baseName = names[index % names.length]!;
      const displayName = index < names.length ? baseName : `${baseName} ${Math.floor(index / names.length) + 1}`;
      const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '');
      return {
        id: `${batchId}-student-${index + 1}`,
        displayName,
        email: `${slug}@student.example.com`,
        attendanceRate: 72 + ((index * 7) % 27),
        joinedAt,
        status: this.studentStatus(index)
      };
    });
  }

  private studentStatus(index: number): TeacherBatchStudentStatus {
    if ((index + 1) % 13 === 0) {
      return 'paused';
    }
    if ((index + 1) % 9 === 0) {
      return 'invited';
    }
    return 'active';
  }

  private normalizeBatch(batch: TeacherBatch): TeacherBatch {
    const capacity = Number(batch.capacity) || 0;
    const enrolledCount = Math.min(Number(batch.enrolledCount) || 0, capacity);
    const createdAt = batch.createdAt ?? new Date().toISOString();
    const id = batch.id ?? this.createId('batch');
    const students = Array.isArray(batch.students)
      ? batch.students.map((student, index) => this.normalizeStudent(student, id, createdAt, index)).slice(0, capacity)
      : this.createStudents(id, enrolledCount, createdAt);

    return {
      ...batch,
      id,
      capacity,
      enrolledCount: students.length || enrolledCount,
      createdAt,
      students,
      sessions: Array.isArray(batch.sessions) ? batch.sessions : []
    };
  }

  private normalizeStudent(
    student: TeacherBatchStudent,
    batchId: string,
    joinedAt: string,
    index: number
  ): TeacherBatchStudent {
    return {
      id: student.id ?? `${batchId}-student-${index + 1}`,
      displayName: student.displayName ?? `Student ${index + 1}`,
      email: student.email ?? `student.${index + 1}@student.example.com`,
      attendanceRate: Number.isFinite(student.attendanceRate) ? student.attendanceRate : 0,
      joinedAt: student.joinedAt ?? joinedAt,
      status: student.status ?? 'active'
    };
  }

  private loadState(): TeacherDashboardState {
    try {
      const storedState = localStorage.getItem(STORAGE_KEY);
      if (!storedState) {
        return { batches: [] };
      }
      const parsed = JSON.parse(storedState) as TeacherDashboardState;
      return Array.isArray(parsed.batches) ? { batches: parsed.batches.map((batch) => this.normalizeBatch(batch)) } : { batches: [] };
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
