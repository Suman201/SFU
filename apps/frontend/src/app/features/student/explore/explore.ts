import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { StudentEnrollmentStore, type StudentBatch } from '../student-enrollment.store';

@Component({
  selector: 'sfu-student-explore',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './explore.html',
  styleUrl: './explore.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentExplore implements OnInit {
  protected readonly enrollment = inject(StudentEnrollmentStore);
  protected readonly batches = this.enrollment.batches;
  protected readonly enrolledCount = computed(() => this.enrollment.enrolledBatches().length);

  ngOnInit(): void {
    this.enrollment.loadAvailableBatches();
    this.enrollment.loadEnrolledBatches();
  }

  protected enroll(batch: StudentBatch): void {
    this.enrollment.enroll(batch.id);
  }

  protected isEnrollmentPending(batch: StudentBatch): boolean {
    return this.enrollment.enrollmentActionBatchId() === batch.id;
  }

  protected isEnrolled(batch: StudentBatch): boolean {
    return this.enrollment.isEnrolled(batch.id);
  }

  protected seatsLabel(batch: StudentBatch): string {
    const seatsLeft = this.enrollment.seatsLeft(batch);
    return seatsLeft === 1 ? '1 seat left' : `${seatsLeft} seats left`;
  }

  protected enrollmentPercent(batch: StudentBatch): number {
    return Math.round((this.enrollment.enrollmentCount(batch) / batch.capacity) * 100);
  }

  protected formatStart(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }
}
