import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ClassSessionService } from '../../class-session/class-session.service';
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
  protected readonly nextBatch = computed(() => this.enrolledBatches()[0] ?? null);
  protected readonly totalWeeks = computed(() => this.enrolledBatches().reduce((total, batch) => total + batch.totalWeeks, 0));
  protected readonly classOpenLoadingId = signal<string | null>(null);
  protected readonly classOpenError = signal('');

  ngOnInit(): void {
    this.enrollment.loadEnrolledBatches();
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
}
