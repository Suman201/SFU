import { Injectable, computed, effect, signal } from '@angular/core';

export interface StudentBatch {
  id: string;
  title: string;
  subject: string;
  teacherName: string;
  teacherTitle: string;
  schedule: string;
  durationMinutes: number;
  totalWeeks: number;
  enrolledCount: number;
  capacity: number;
  startsAt: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
}

interface StudentEnrollmentState {
  enrolledBatchIds: string[];
}

const STORAGE_KEY = 'native-sfu-student-enrollments';

const BATCH_CATALOG: StudentBatch[] = [
  {
    id: 'batch-webrtc-foundation',
    title: 'WebRTC Foundations',
    subject: 'Native SFU architecture',
    teacherName: 'Ananya Sen',
    teacherTitle: 'Realtime systems mentor',
    schedule: 'Mondays at 18:00',
    durationMinutes: 60,
    totalWeeks: 8,
    enrolledCount: 18,
    capacity: 28,
    startsAt: '2026-06-22T18:00:00.000Z',
    level: 'Beginner'
  },
  {
    id: 'batch-media-routing',
    title: 'Media Routing Lab',
    subject: 'RTP, simulcast, and packet flow',
    teacherName: 'Rahul Mehta',
    teacherTitle: 'SFU protocol instructor',
    schedule: 'Wednesdays at 19:30',
    durationMinutes: 75,
    totalWeeks: 10,
    enrolledCount: 14,
    capacity: 24,
    startsAt: '2026-06-24T19:30:00.000Z',
    level: 'Intermediate'
  },
  {
    id: 'batch-angular-classroom',
    title: 'Angular Classroom UI',
    subject: 'Realtime class experience design',
    teacherName: 'Mira Kapoor',
    teacherTitle: 'Frontend systems coach',
    schedule: 'Fridays at 17:00',
    durationMinutes: 60,
    totalWeeks: 6,
    enrolledCount: 21,
    capacity: 32,
    startsAt: '2026-06-26T17:00:00.000Z',
    level: 'Intermediate'
  },
  {
    id: 'batch-scaling-sfu',
    title: 'Scaling SFU Clusters',
    subject: 'Workers, piping, and observability',
    teacherName: 'Dev Arora',
    teacherTitle: 'Distributed media engineer',
    schedule: 'Saturdays at 11:00',
    durationMinutes: 90,
    totalWeeks: 12,
    enrolledCount: 16,
    capacity: 20,
    startsAt: '2026-06-27T11:00:00.000Z',
    level: 'Advanced'
  }
];

@Injectable({ providedIn: 'root' })
export class StudentEnrollmentStore {
  private readonly state = signal<StudentEnrollmentState>(this.loadState());

  readonly batches = computed(() => [...BATCH_CATALOG].sort((left, right) => this.startTime(left) - this.startTime(right)));
  readonly enrolledBatchIds = computed(() => new Set(this.state().enrolledBatchIds));
  readonly enrolledBatches = computed(() => this.batches().filter((batch) => this.enrolledBatchIds().has(batch.id)));
  readonly availableBatches = computed(() => this.batches().filter((batch) => !this.enrolledBatchIds().has(batch.id)));

  constructor() {
    effect(() => this.persistState(this.state()));
  }

  enroll(batchId: string): void {
    if (!BATCH_CATALOG.some((batch) => batch.id === batchId)) {
      return;
    }

    this.state.update((state) => {
      if (state.enrolledBatchIds.includes(batchId)) {
        return state;
      }

      return {
        enrolledBatchIds: [...state.enrolledBatchIds, batchId]
      };
    });
  }

  leave(batchId: string): void {
    this.state.update((state) => ({
      enrolledBatchIds: state.enrolledBatchIds.filter((enrolledBatchId) => enrolledBatchId !== batchId)
    }));
  }

  isEnrolled(batchId: string): boolean {
    return this.enrolledBatchIds().has(batchId);
  }

  enrollmentCount(batch: StudentBatch): number {
    return Math.min(batch.capacity, batch.enrolledCount + (this.isEnrolled(batch.id) ? 1 : 0));
  }

  seatsLeft(batch: StudentBatch): number {
    return Math.max(0, batch.capacity - this.enrollmentCount(batch));
  }

  private startTime(batch: StudentBatch): number {
    return new Date(batch.startsAt).getTime();
  }

  private loadState(): StudentEnrollmentState {
    try {
      const storedState = localStorage.getItem(STORAGE_KEY);
      if (!storedState) {
        return { enrolledBatchIds: [] };
      }

      const parsed = JSON.parse(storedState) as StudentEnrollmentState;
      return Array.isArray(parsed.enrolledBatchIds) ? parsed : { enrolledBatchIds: [] };
    } catch {
      return { enrolledBatchIds: [] };
    }
  }

  private persistState(state: StudentEnrollmentState): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The student pages remain usable in memory if storage is unavailable.
    }
  }
}
