import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminEnrollmentDetail } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-enrollment-detail',
  standalone: true,
  imports: [DatePipe, RouterLink],
  templateUrl: './enrollment-detail.html',
  styleUrl: './enrollment-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class EnrollmentDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);

  protected readonly enrollment = signal<AdminEnrollmentDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly pendingAction = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');

  ngOnInit(): void {
    this.load();
  }

  protected transition(action: 'cancel' | 'suspend' | 'reactivate' | 'complete'): void {
    const enrollment = this.enrollment();
    if (!enrollment || this.pendingAction()) {
      return;
    }
    if ((action === 'cancel' || action === 'suspend') && !confirm(this.confirmMessage(enrollment, action))) {
      return;
    }
    this.pendingAction.set(action);
    this.error.set('');
    this.success.set('');
    this.api
      .transitionEnrollment(enrollment.id, action)
      .pipe(finalize(() => this.pendingAction.set(null)))
      .subscribe({
        next: (updated) => {
          this.enrollment.set(updated);
          this.success.set(`${updated.studentName} is now ${updated.status}.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected statusClass(enrollment: AdminEnrollmentDetail): string {
    return `status-${enrollment.status}`;
  }

  private load(): void {
    const enrollmentId = this.route.snapshot.paramMap.get('enrollmentId');
    if (!enrollmentId) {
      this.error.set('Enrollment id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getEnrollment(enrollmentId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (enrollment) => this.enrollment.set(enrollment),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private confirmMessage(enrollment: AdminEnrollmentDetail, action: 'cancel' | 'suspend' | 'reactivate' | 'complete'): string {
    if (action === 'suspend') {
      return `Suspend ${enrollment.studentName}? They will lose class-session access until reactivated.`;
    }
    if (action === 'cancel') {
      return `Cancel ${enrollment.studentName}'s enrollment? This blocks class-session access for this batch.`;
    }
    return `Update ${enrollment.studentName}'s enrollment?`;
  }
}
