import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Assignment, AssignmentSubmission } from '@native-sfu/contracts';
import { ClassSessionService, type ClassroomPayload } from '../../class-session/class-session.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { StudentEnrollmentStore, type StudentBatch } from '../student-enrollment.store';

@Component({
  selector: 'sfu-student-dashboard',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentDashboard implements OnInit {
  private readonly router = inject(Router);
  private readonly classSessions = inject(ClassSessionService);
  protected readonly enrollment = inject(StudentEnrollmentStore);
  protected readonly enrolledBatches = this.enrollment.enrolledBatches;
  protected readonly activeEnrolledBatches = computed(() => this.enrolledBatches().filter((batch) => this.isActiveEnrollment(batch)));
  protected readonly nextBatch = computed(() => this.activeEnrolledBatches()[0] ?? null);
  protected readonly totalWeeks = computed(() => this.enrolledBatches().reduce((total, batch) => total + batch.totalWeeks, 0));
  protected readonly classOpenLoadingId = signal<string | null>(null);
  protected readonly classOpenError = signal('');
  protected readonly currentSessions = signal<Record<string, ClassroomPayload | null>>({});
  protected readonly currentSessionErrors = signal<Record<string, string>>({});
  protected readonly currentSessionLoadingIds = signal<Set<string>>(new Set());
  protected readonly assignments = signal<Array<Assignment & { submission?: AssignmentSubmission }>>([]);
  protected readonly assignmentsLoading = signal(false);
  protected readonly assignmentsError = signal('');

  private readonly loadedCurrentSessionBatchIds = new Set<string>();

  constructor() {
    effect(() => {
      const activeBatchIds = new Set(this.activeEnrolledBatches().map((batch) => batch.id));
      this.currentSessions.update((sessions) => this.onlyActiveKeys(sessions, activeBatchIds));
      this.currentSessionErrors.update((errors) => this.onlyActiveKeys(errors, activeBatchIds));

      for (const batch of this.activeEnrolledBatches()) {
        if (!this.loadedCurrentSessionBatchIds.has(batch.id) && !this.currentSessionLoadingIds().has(batch.id)) {
          this.loadCurrentSession(batch.id);
        }
      }
    });
  }

  ngOnInit(): void {
    this.enrollment.loadEnrolledBatches();
    this.loadAssignments();
  }

  protected leave(batch: StudentBatch): void {
    this.enrollment.leave(batch.id);
  }

  protected async openClass(batch: StudentBatch): Promise<void> {
    this.classOpenLoadingId.set(batch.id);
    this.classOpenError.set('');
    this.classSessions.getCurrentForBatch(batch.id).subscribe({
      next: async (payload) => {
        if (!payload.canJoin || payload.status !== 'live') {
          this.classOpenError.set('Waiting for the teacher to start this class.');
          this.classOpenLoadingId.set(null);
          return;
        }
        await this.router.navigate(['/class-session/student'], {
          queryParams: {
            batchId: payload.batchId,
            sessionId: payload.sessionId
          }
        });
        this.classOpenLoadingId.set(null);
      },
      error: (error) => {
        this.classOpenError.set(this.classSessions.errorMessage(error));
        this.classOpenLoadingId.set(null);
      }
    });
  }

  protected formatStart(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected currentSession(batch: StudentBatch): ClassroomPayload | null {
    return this.currentSessions()[batch.id] ?? null;
  }

  protected currentSessionError(batch: StudentBatch): string {
    return this.currentSessionErrors()[batch.id] ?? '';
  }

  protected currentSessionLoading(batch: StudentBatch): boolean {
    return this.currentSessionLoadingIds().has(batch.id);
  }

  protected sessionStatusLabel(batch: StudentBatch): string {
    if (this.currentSessionLoading(batch)) {
      return 'Checking';
    }
    if (this.currentSessionError(batch)) {
      return 'Unavailable';
    }
    const session = this.currentSession(batch);
    if (!session) {
      return 'No upcoming session';
    }
    if (session.status === 'live') {
      return 'Live now';
    }
    if (session.status === 'scheduled') {
      return 'Waiting for teacher';
    }
    return session.status[0]!.toUpperCase() + session.status.slice(1);
  }

  protected sessionTimeLabel(batch: StudentBatch): string {
    const session = this.currentSession(batch);
    return session ? this.formatStart(session.scheduledAt) : 'No scheduled time';
  }

  protected canJoinBatch(batch: StudentBatch): boolean {
    const session = this.currentSession(batch);
    return Boolean(session?.canJoin && session.status === 'live');
  }

  protected isActiveEnrollment(batch: StudentBatch): boolean {
    return !batch.enrollmentStatus || batch.enrollmentStatus === 'active';
  }

  protected assignmentStatus(assignment: Assignment & { submission?: AssignmentSubmission }): string {
    const status = assignment.submission?.status ?? 'assigned';
    return status.replace(/_/g, ' ');
  }

  protected assignmentDueLabel(assignment: Assignment): string {
    return assignment.dueAt ? this.formatStart(assignment.dueAt) : 'No due date';
  }

  protected assignmentBatchLabel(assignment: Assignment): string {
    return assignment.batchName || this.enrolledBatches().find((batch) => batch.id === assignment.batchId)?.title || 'Batch';
  }

  protected dueAssignments(): Array<Assignment & { submission?: AssignmentSubmission }> {
    return this.assignments().filter((assignment) => !['completed', 'reviewed'].includes(assignment.submission?.status ?? ''));
  }

  private loadCurrentSession(batchId: string): void {
    this.currentSessionLoadingIds.update((ids) => new Set(ids).add(batchId));
    this.classSessions.getCurrentForBatch(batchId).subscribe({
      next: (payload) => {
        this.loadedCurrentSessionBatchIds.add(batchId);
        this.currentSessions.update((sessions) => ({ ...sessions, [batchId]: payload }));
        this.currentSessionErrors.update((errors) => {
          const { [batchId]: _removed, ...rest } = errors;
          return rest;
        });
      },
      error: (error) => {
        this.loadedCurrentSessionBatchIds.add(batchId);
        this.currentSessions.update((sessions) => ({ ...sessions, [batchId]: null }));
        const message = this.classSessions.errorMessage(error);
        if (message !== 'Class session not found.') {
          this.currentSessionErrors.update((errors) => ({ ...errors, [batchId]: message }));
        }
        this.clearCurrentSessionLoading(batchId);
      },
      complete: () => this.clearCurrentSessionLoading(batchId)
    });
  }

  private loadAssignments(): void {
    this.assignmentsLoading.set(true);
    this.assignmentsError.set('');
    this.classSessions.listStudentAssignments().subscribe({
      next: (response) => this.assignments.set(response.items),
      error: (error) => this.assignmentsError.set(this.classSessions.errorMessage(error)),
      complete: () => this.assignmentsLoading.set(false)
    });
  }

  private onlyActiveKeys<T>(values: Record<string, T>, activeIds: Set<string>): Record<string, T> {
    return Object.fromEntries(Object.entries(values).filter(([key]) => activeIds.has(key)));
  }

  private clearCurrentSessionLoading(batchId: string): void {
    this.currentSessionLoadingIds.update((ids) => {
      const next = new Set(ids);
      next.delete(batchId);
      return next;
    });
  }
}
