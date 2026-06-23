import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  AdminBatchListItem,
  AdminBatchListQuery,
  AdminBatchSort,
  AdminBatchStatus,
  AdminBatchSummary,
  AdminBatchWeekday
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type BatchStatusFilter = AdminBatchStatus | 'all';

@Component({
  selector: 'sfu-admin-batches-list',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './batches-list.html',
  styleUrl: './batches-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class BatchesList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly rows = signal<AdminBatchListItem[]>([]);
  protected readonly summary = signal<AdminBatchSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly pendingBatchId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);
  protected readonly showCreate = signal(false);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as BatchStatusFilter],
    courseId: [''],
    teacherId: [''],
    dateFrom: [''],
    dateTo: [''],
    search: [''],
    sort: ['updated_desc' as AdminBatchSort]
  });

  protected readonly createForm = this.formBuilder.nonNullable.group({
    courseId: ['', [Validators.required, Validators.maxLength(120)]],
    courseName: ['', [Validators.maxLength(120)]],
    name: ['', [Validators.required, Validators.maxLength(120)]],
    teacherId: ['', [Validators.required, Validators.maxLength(120)]],
    year: [new Date().getUTCFullYear(), [Validators.required, Validators.min(2000), Validators.max(2100)]],
    maxCapacity: [30, [Validators.required, Validators.min(1), Validators.max(1000)]],
    dayOfWeek: ['MONDAY' as AdminBatchWeekday],
    startTime: ['10:00', [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)]]
  });

  ngOnInit(): void {
    this.readQueryParams();
    this.load(this.page());
  }

  protected applyFilters(): void {
    void this.updateQueryAndLoad(1);
  }

  protected resetFilters(): void {
    this.filters.reset({ status: 'all', courseId: '', teacherId: '', dateFrom: '', dateTo: '', search: '', sort: 'updated_desc' });
    void this.updateQueryAndLoad(1);
  }

  protected toggleCreate(): void {
    this.showCreate.update((value) => !value);
    this.error.set('');
    this.success.set('');
  }

  protected createBatch(): void {
    this.createForm.markAllAsTouched();
    if (this.createForm.invalid || this.saving()) {
      return;
    }
    const value = this.createForm.getRawValue();
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .createBatch(value.courseId.trim(), {
        name: value.name.trim(),
        teacherId: value.teacherId.trim(),
        courseName: value.courseName.trim(),
        year: Number(value.year),
        maxCapacity: Number(value.maxCapacity),
        schedule: [{ dayOfWeek: value.dayOfWeek, startTime: value.startTime }]
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (batch) => {
          this.success.set(`${batch.name} created.`);
          this.showCreate.set(false);
          this.createForm.patchValue({ name: '', teacherId: '' });
          this.filters.patchValue({ courseId: batch.courseId ?? value.courseId.trim() });
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { courseId: batch.courseId ?? value.courseId.trim(), page: 1 }
          });
          this.load(1);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected transition(row: AdminBatchListItem, action: 'activate' | 'pause' | 'complete' | 'cancel'): void {
    if (this.pendingBatchId()) {
      return;
    }
    if ((action === 'complete' || action === 'cancel') && !confirm(`Mark ${row.name} as ${action}?`)) {
      return;
    }
    this.pendingBatchId.set(row.id);
    this.error.set('');
    this.success.set('');
    this.api
      .transitionBatch(row.id, action)
      .pipe(finalize(() => this.pendingBatchId.set(null)))
      .subscribe({
        next: (updated) => {
          this.success.set(`${updated.name} is now ${updated.status.toLowerCase()}.`);
          this.load();
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected nextPage(): void {
    if (this.page() * this.limit() < this.total()) {
      void this.updateQueryAndLoad(this.page() + 1);
    }
  }

  protected previousPage(): void {
    if (this.page() > 1) {
      void this.updateQueryAndLoad(this.page() - 1);
    }
  }

  protected scheduleLabel(row: AdminBatchListItem): string {
    return row.schedule.map((item) => `${item.dayOfWeek.slice(0, 3)} ${item.startTime}`).join(', ') || 'No schedule';
  }

  protected statusClass(status: AdminBatchStatus): string {
    return `status-${status.toLowerCase()}`;
  }

  protected trackByBatch(_index: number, row: AdminBatchListItem): string {
    return row.id;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listBatches(this.toQuery(page))
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

  private async updateQueryAndLoad(page: number): Promise<void> {
    await this.router.navigate([], { relativeTo: this.route, queryParams: this.queryParams(page) });
    this.load(page);
  }

  private readQueryParams(): void {
    const params = this.route.snapshot.queryParamMap;
    this.page.set(Number(params.get('page') ?? '1') || 1);
    this.filters.reset({
      status: this.toStatus(params.get('status')),
      courseId: params.get('courseId') ?? '',
      teacherId: params.get('teacherId') ?? '',
      dateFrom: params.get('dateFrom') ?? '',
      dateTo: params.get('dateTo') ?? '',
      search: params.get('search') ?? '',
      sort: this.toSort(params.get('sort'))
    });
    const courseId = params.get('courseId');
    if (courseId) {
      this.createForm.patchValue({ courseId });
    }
    if (params.get('create') === '1') {
      this.showCreate.set(true);
    }
  }

  private queryParams(page: number): Record<string, string | number> {
    const query = this.toQuery(page);
    return Object.entries(query).reduce<Record<string, string | number>>((params, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = value;
      }
      return params;
    }, {});
  }

  private toQuery(page: number): AdminBatchListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.courseId.trim() ? { courseId: value.courseId.trim() } : {}),
      ...(value.teacherId.trim() ? { teacherId: value.teacherId.trim() } : {}),
      ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}),
      ...(value.dateTo ? { dateTo: value.dateTo } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      sort: value.sort
    };
  }

  private toStatus(value: string | null): BatchStatusFilter {
    return value === 'ACTIVE' || value === 'INACTIVE' || value === 'COMPLETED' || value === 'CANCELLED' ? value : 'all';
  }

  private toSort(value: string | null): AdminBatchSort {
    return value === 'updated_asc' ||
      value === 'name_asc' ||
      value === 'name_desc' ||
      value === 'start_asc' ||
      value === 'start_desc'
      ? value
      : 'updated_desc';
  }
}
