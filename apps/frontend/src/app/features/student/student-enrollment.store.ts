import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { API_BASE_URL } from '../../core/services/app-environment';

export type StudentEnrollmentStatus = 'active' | 'pending' | 'completed' | 'cancelled' | 'suspended';

export interface StudentBatch {
  id: string;
  title: string;
  subject: string;
  teacherId: string;
  teacherName: string;
  teacherTitle: string;
  schedule: string;
  durationMinutes: number;
  totalWeeks: number;
  enrolledCount: number;
  capacity: number;
  startsAt: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  enrollmentStatus?: StudentEnrollmentStatus;
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
}

@Injectable({ providedIn: 'root' })
export class StudentEnrollmentStore {
  private readonly http = inject(HttpClient);
  private readonly remoteAvailableBatches = signal<StudentBatch[]>([]);
  private readonly remoteEnrolledBatches = signal<StudentBatch[]>([]);
  private readonly availableBatchesLoadedSignal = signal(false);
  private readonly enrolledBatchesLoadedSignal = signal(false);
  private readonly loadingAvailableBatchesSignal = signal(false);
  private readonly loadingEnrolledBatchesSignal = signal(false);
  private readonly enrollmentActionBatchIdSignal = signal<string | null>(null);
  private readonly availableBatchesErrorSignal = signal('');
  private readonly enrolledBatchesErrorSignal = signal('');
  private readonly enrollmentErrorSignal = signal('');

  readonly loadingAvailableBatches = this.loadingAvailableBatchesSignal.asReadonly();
  readonly loadingEnrolledBatches = this.loadingEnrolledBatchesSignal.asReadonly();
  readonly availableBatchesLoaded = this.availableBatchesLoadedSignal.asReadonly();
  readonly enrolledBatchesLoaded = this.enrolledBatchesLoadedSignal.asReadonly();
  readonly enrollmentActionBatchId = this.enrollmentActionBatchIdSignal.asReadonly();
  readonly availableBatchesError = this.availableBatchesErrorSignal.asReadonly();
  readonly enrolledBatchesError = this.enrolledBatchesErrorSignal.asReadonly();
  readonly enrollmentError = this.enrollmentErrorSignal.asReadonly();
  readonly batches = computed(() => [...this.remoteAvailableBatches()].sort((left, right) => this.startTime(left) - this.startTime(right)));
  readonly enrolledBatches = computed(() => [...this.remoteEnrolledBatches()].sort((left, right) => this.startTime(left) - this.startTime(right)));
  readonly enrolledBatchIds = computed(() => new Set(this.enrolledBatches().map((batch) => batch.id)));
  readonly availableBatches = computed(() => this.batches().filter((batch) => !this.isEnrolled(batch.id)));

  enroll(batchId: string): void {
    if (this.enrollmentActionBatchIdSignal()) {
      return;
    }

    const batch = this.batches().find((item) => item.id === batchId);
    if (!batch || this.isEnrolled(batchId)) {
      return;
    }

    this.enrollmentActionBatchIdSignal.set(batchId);
    this.enrollmentErrorSignal.set('');
    this.http.post<StudentBatch | ApiEnvelope<StudentBatch>>(`${API_BASE_URL}/student-enrollments/me/batches/${encodeURIComponent(batchId)}`, {}).subscribe({
      next: (response) => {
        const enrolledBatch = this.normalizeRemoteBatch(this.unwrapResponse(response));
        this.remoteEnrolledBatches.update((batches) => this.upsertBatch(batches, enrolledBatch));
        this.remoteAvailableBatches.update((batches) => this.upsertBatch(batches, { ...enrolledBatch, enrollmentStatus: 'active' }));
        this.loadAvailableBatches();
        this.loadEnrolledBatches();
      },
      error: (error) => {
        this.enrollmentErrorSignal.set(this.errorMessage(error));
        this.enrollmentActionBatchIdSignal.set(null);
      },
      complete: () => this.enrollmentActionBatchIdSignal.set(null)
    });
  }

  loadAvailableBatches(): void {
    this.loadingAvailableBatchesSignal.set(true);
    this.availableBatchesErrorSignal.set('');
    this.http.get<StudentBatch[] | ApiEnvelope<StudentBatch[]>>(`${API_BASE_URL}/student-enrollments/batches`).subscribe({
      next: (response) => {
        this.remoteAvailableBatches.set(this.unwrapResponse(response).map((batch) => this.normalizeRemoteBatch(batch)));
        this.availableBatchesLoadedSignal.set(true);
      },
      error: (error) => {
        if (!this.availableBatchesLoadedSignal()) {
          this.remoteAvailableBatches.set([]);
        }
        this.availableBatchesErrorSignal.set(this.errorMessage(error));
        this.loadingAvailableBatchesSignal.set(false);
      },
      complete: () => this.loadingAvailableBatchesSignal.set(false)
    });
  }

  loadEnrolledBatches(): void {
    this.loadingEnrolledBatchesSignal.set(true);
    this.enrolledBatchesErrorSignal.set('');
    this.http.get<StudentBatch[] | ApiEnvelope<StudentBatch[]>>(`${API_BASE_URL}/student-enrollments/me/batches`).subscribe({
      next: (response) => {
        this.remoteEnrolledBatches.set(this.unwrapResponse(response).map((batch) => this.normalizeRemoteBatch(batch)));
        this.enrolledBatchesLoadedSignal.set(true);
      },
      error: (error) => {
        if (!this.enrolledBatchesLoadedSignal()) {
          this.remoteEnrolledBatches.set([]);
        }
        this.enrolledBatchesErrorSignal.set(this.errorMessage(error));
        this.loadingEnrolledBatchesSignal.set(false);
      },
      complete: () => this.loadingEnrolledBatchesSignal.set(false)
    });
  }

  leave(batchId: string): void {
    if (this.enrollmentActionBatchIdSignal()) {
      return;
    }

    this.enrollmentActionBatchIdSignal.set(batchId);
    this.enrollmentErrorSignal.set('');
    this.http.delete<Record<string, unknown> | ApiEnvelope<Record<string, unknown>>>(`${API_BASE_URL}/student-enrollments/me/batches/${encodeURIComponent(batchId)}`).subscribe({
      next: () => {
        this.remoteEnrolledBatches.update((batches) => batches.filter((batch) => batch.id !== batchId));
        this.remoteAvailableBatches.update((batches) =>
          batches.map((batch) => {
            if (batch.id !== batchId) {
              return batch;
            }
            const { enrollmentStatus: _enrollmentStatus, ...availableBatch } = batch;
            return availableBatch;
          })
        );
        this.loadAvailableBatches();
        this.loadEnrolledBatches();
      },
      error: (error) => {
        this.enrollmentErrorSignal.set(this.errorMessage(error));
        this.enrollmentActionBatchIdSignal.set(null);
      },
      complete: () => this.enrollmentActionBatchIdSignal.set(null)
    });
  }

  isEnrolled(batchId: string): boolean {
    return (
      this.enrolledBatchIds().has(batchId) ||
      this.remoteAvailableBatches().some((batch) => batch.id === batchId && batch.enrollmentStatus === 'active')
    );
  }

  enrollmentCount(batch: StudentBatch): number {
    return Math.min(batch.capacity, Math.max(0, batch.enrolledCount));
  }

  seatsLeft(batch: StudentBatch): number {
    return Math.max(0, batch.capacity - this.enrollmentCount(batch));
  }

  private startTime(batch: StudentBatch): number {
    const value = new Date(batch.startsAt).getTime();
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
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

  private normalizeRemoteBatch(batch: StudentBatch): StudentBatch {
    return {
      ...batch,
      level: batch.level ?? 'Intermediate',
      teacherTitle: batch.teacherTitle ?? 'Class instructor',
      schedule: batch.schedule ?? 'Schedule to be announced',
      durationMinutes: batch.durationMinutes ?? 60,
      totalWeeks: batch.totalWeeks ?? 1,
      enrolledCount: batch.enrolledCount ?? 0,
      capacity: batch.capacity ?? 0,
      startsAt: batch.startsAt ?? new Date().toISOString()
    };
  }

  private upsertBatch(batches: StudentBatch[], batch: StudentBatch): StudentBatch[] {
    return [batch, ...batches.filter((item) => item.id !== batch.id)];
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const backendMessage = this.backendMessage(error.error);
      if (backendMessage) return backendMessage;
      if (error.status === 0) return 'Unable to reach the server. Please check your connection and try again.';
      if (error.status === 401) return 'Please sign in with a student account to view enrollments.';
      if (error.status === 403) return 'Only student accounts can manage batch enrollments.';
      if (error.status === 404) return 'This batch is no longer available.';
      if (error.status === 409) return 'This batch is full or you are already enrolled.';
    }
    return 'Unable to load enrollment data right now. Please try again.';
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
