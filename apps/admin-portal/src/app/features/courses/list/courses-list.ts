import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AdminCourseListItem, AdminCourseListQuery, AdminCourseSort, AdminCourseStatus, AdminCourseSummary } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type CourseStatusFilter = AdminCourseStatus | 'all';

@Component({
  selector: 'sfu-admin-courses-list',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './courses-list.html',
  styleUrl: './courses-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class CoursesList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<AdminCourseListItem[]>([]);
  protected readonly summary = signal<AdminCourseSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as CourseStatusFilter],
    search: [''],
    sort: ['updated_desc' as AdminCourseSort]
  });

  ngOnInit(): void {
    this.load();
  }

  protected applyFilters(): void {
    this.load(1);
  }

  protected resetFilters(): void {
    this.filters.reset({ status: 'all', search: '', sort: 'updated_desc' });
    this.load(1);
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

  protected statusClass(status: AdminCourseStatus): string {
    return `status-${status}`;
  }

  protected initials(row: AdminCourseListItem): string {
    return row.courseName
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected trackByCourse(_index: number, row: AdminCourseListItem): string {
    return row.courseId;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listCourses(this.toQuery(page))
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

  private toQuery(page: number): AdminCourseListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      sort: value.sort
    };
  }
}
