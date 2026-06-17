import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
export class StudentDashboard {
  private readonly router = inject(Router);
  protected readonly enrollment = inject(StudentEnrollmentStore);
  protected readonly enrolledBatches = this.enrollment.enrolledBatches;
  protected readonly nextBatch = computed(() => this.enrolledBatches()[0] ?? null);
  protected readonly totalWeeks = computed(() => this.enrolledBatches().reduce((total, batch) => total + batch.totalWeeks, 0));

  protected leave(batch: StudentBatch): void {
    this.enrollment.leave(batch.id);
  }

  protected async openClass(batch: StudentBatch): Promise<void> {
    await this.router.navigate(['/class-session/student'], {
      queryParams: {
        batchId: batch.id
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
