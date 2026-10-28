import { isDesktopSession } from '../../../core/services/desktop-bridge';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { formatBatchFee } from '../../../shared/formatting/batch-fee';
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
  protected readonly desktop = isDesktopSession();
  protected readonly enrollment = inject(StudentEnrollmentStore);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap,{initialValue:this.route.snapshot.queryParamMap});
  protected readonly scoped = computed(()=>Boolean(this.params().get('teacherId') || this.params().get('batchId')));
  protected readonly batches = computed(()=>this.enrollment.batches().filter(batch =>
    (!this.params().get('teacherId') || batch.teacherId === this.params().get('teacherId')) &&
    (!this.params().get('batchId') || batch.id === this.params().get('batchId'))));
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
    if (batch.capacity <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((this.enrollment.enrollmentCount(batch) / batch.capacity) * 100));
  }

  protected formatStart(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected feeLabel(value: number | null | undefined): string {
    return formatBatchFee(value);
  }
}
