import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  AdminEnrollmentListItem,
  AdminEnrollmentListQuery,
  AdminEnrollmentStatus,
  AdminEnrollmentSummary
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type EnrollmentStatusFilter = AdminEnrollmentStatus | 'all';

@Component({
  selector: 'sfu-admin-enrollments-list',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './enrollments-list.html',
  styleUrl: './enrollments-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class EnrollmentsList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<AdminEnrollmentListItem[]>([]);
  protected readonly summary = signal<AdminEnrollmentSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly pendingEnrollmentId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);
  protected readonly showCreate = signal(false);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as EnrollmentStatusFilter],
    search: [''],
    courseId: [''],
    batchId: [''],
    studentId: ['']
  });

  protected readonly createForm = this.formBuilder.nonNullable.group({
    studentId: ['', [Validators.required, Validators.maxLength(120)]],
    batchId: ['', [Validators.required, Validators.maxLength(120)]],
    status: ['active' as AdminEnrollmentStatus]
  });

  ngOnInit(): void {
    this.load();
  }

  protected applyFilters(): void {
    this.load(1);
  }

  protected resetFilters(): void {
    this.filters.reset({
      status: 'all',
      search: '',
      courseId: '',
      batchId: '',
      studentId: ''
    });
    this.load(1);
  }

  protected toggleCreate(): void {
    this.showCreate.update((value) => !value);
    this.error.set('');
    this.success.set('');
  }

  protected createEnrollment(): void {
    this.createForm.markAllAsTouched();
    if (this.createForm.invalid || this.saving()) {
      return;
    }
    const value = this.createForm.getRawValue();
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .createEnrollment({
        studentId: value.studentId.trim(),
        batchId: value.batchId.trim(),
        status: value.status
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (enrollment) => {
          this.success.set(`Enrollment created for ${enrollment.studentName}.`);
          this.createForm.reset({ studentId: '', batchId: '', status: 'active' });
          this.showCreate.set(false);
          this.load(1);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected transition(row: AdminEnrollmentListItem, action: 'cancel' | 'suspend' | 'reactivate' | 'complete'): void {
    if (this.pendingEnrollmentId()) {
      return;
    }
    if ((action === 'cancel' || action === 'suspend') && !confirm(this.confirmMessage(row, action))) {
      return;
    }
    this.pendingEnrollmentId.set(row.id);
    this.error.set('');
    this.success.set('');
    this.api
      .transitionEnrollment(row.id, action)
      .pipe(finalize(() => this.pendingEnrollmentId.set(null)))
      .subscribe({
        next: (updated) => {
          this.success.set(`${updated.studentName} is now ${updated.status}.`);
          this.load();
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected nextPage(): void {
    if (this.page() * this.limit() < this.total()) {
      this.load(this.page() + 1);
    }
  }

  protected previousPage(): void {
    if (this.page() > 1) {
      this.load(this.page() - 1);
    }
  }

  protected initials(row: AdminEnrollmentListItem): string {
    return row.studentName
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected statusClass(status: AdminEnrollmentStatus): string {
    return `status-${status}`;
  }

  protected trackByEnrollment(_index: number, row: AdminEnrollmentListItem): string {
    return row.id;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listEnrollments(this.toQuery(page))
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.rows.set(response.items);
          this.summary.set(response.summary);
          this.page.set(response.page);
          this.limit.set(response.limit);
          this.total.set(response.total);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private toQuery(page: number): AdminEnrollmentListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      ...(value.courseId.trim() ? { courseId: value.courseId.trim() } : {}),
      ...(value.batchId.trim() ? { batchId: value.batchId.trim() } : {}),
      ...(value.studentId.trim() ? { studentId: value.studentId.trim() } : {})
    };
  }

  private confirmMessage(row: AdminEnrollmentListItem, action: 'cancel' | 'suspend' | 'reactivate' | 'complete'): string {
    if (action === 'suspend') {
      return `Suspend ${row.studentName}? They will lose class-session access until reactivated.`;
    }
    if (action === 'cancel') {
      return `Cancel ${row.studentName}'s enrollment? They will no longer be able to access this batch.`;
    }
    return `Update ${row.studentName}'s enrollment?`;
  }
}
