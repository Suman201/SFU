import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  AdminRecordingListItem,
  AdminRecordingListQuery,
  AdminRecordingSort,
  AdminRecordingStatus,
  AdminRecordingSummary
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type RecordingStatusFilter = AdminRecordingStatus | 'all';

@Component({
  selector: 'sfu-admin-recordings-list',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './recordings-list.html',
  styleUrl: './recordings-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class RecordingsList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly rows = signal<AdminRecordingListItem[]>([]);
  protected readonly summary = signal<AdminRecordingSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);
  protected readonly pendingRecordingId = signal<string | null>(null);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as RecordingStatusFilter],
    sessionId: [''],
    batchId: [''],
    courseId: [''],
    teacherId: [''],
    dateFrom: [''],
    dateTo: [''],
    search: [''],
    sort: ['started_desc' as AdminRecordingSort]
  });

  ngOnInit(): void {
    this.readQueryParams();
    this.load(this.page());
  }

  protected applyFilters(): void {
    void this.updateQueryAndLoad(1);
  }

  protected resetFilters(): void {
    this.filters.reset({
      status: 'all',
      sessionId: '',
      batchId: '',
      courseId: '',
      teacherId: '',
      dateFrom: '',
      dateTo: '',
      search: '',
      sort: 'started_desc'
    });
    void this.updateQueryAndLoad(1);
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

  protected openPlayback(row: AdminRecordingListItem): void {
    if (this.pendingRecordingId()) {
      return;
    }
    this.pendingRecordingId.set(row.recordingId);
    this.error.set('');
    this.success.set('');
    this.api
      .getRecordingPlayback(row.recordingId)
      .pipe(finalize(() => this.pendingRecordingId.set(null)))
      .subscribe({
        next: (playback) => {
          if (playback.playbackUrl) {
            window.open(playback.playbackUrl, '_blank', 'noopener');
            return;
          }
          this.success.set(playback.message || 'Recording playback is not available yet.');
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected download(row: AdminRecordingListItem): void {
    if (this.pendingRecordingId()) {
      return;
    }
    this.pendingRecordingId.set(row.recordingId);
    this.error.set('');
    this.success.set('');
    this.api
      .downloadRecording(row.recordingId)
      .pipe(finalize(() => this.pendingRecordingId.set(null)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, `${row.sessionTitle || row.recordingId}-recording.json`),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected statusClass(status: AdminRecordingStatus): string {
    return `status-${status}`;
  }

  protected duration(seconds?: number): string {
    if (seconds === undefined) return 'Unknown';
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${remaining}s`;
  }

  protected size(bytes?: number): string {
    if (bytes === undefined) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${Math.round(bytes / 104857.6) / 10} MB`;
  }

  protected initials(row: AdminRecordingListItem): string {
    return (row.sessionTitle || row.recordingId)
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected trackByRecording(_index: number, row: AdminRecordingListItem): string {
    return row.id;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listRecordings(this.toQuery(page))
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
      sessionId: params.get('sessionId') ?? '',
      batchId: params.get('batchId') ?? '',
      courseId: params.get('courseId') ?? '',
      teacherId: params.get('teacherId') ?? '',
      dateFrom: params.get('dateFrom') ?? '',
      dateTo: params.get('dateTo') ?? '',
      search: params.get('search') ?? '',
      sort: this.toSort(params.get('sort'))
    });
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

  private toQuery(page: number): AdminRecordingListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.sessionId.trim() ? { sessionId: value.sessionId.trim() } : {}),
      ...(value.batchId.trim() ? { batchId: value.batchId.trim() } : {}),
      ...(value.courseId.trim() ? { courseId: value.courseId.trim() } : {}),
      ...(value.teacherId.trim() ? { teacherId: value.teacherId.trim() } : {}),
      ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}),
      ...(value.dateTo ? { dateTo: value.dateTo } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      sort: value.sort
    };
  }

  private toStatus(value: string | null): RecordingStatusFilter {
    return value === 'starting' ||
      value === 'recording' ||
      value === 'stopping' ||
      value === 'stopped' ||
      value === 'failed' ||
      value === 'expired'
      ? value
      : 'all';
  }

  private toSort(value: string | null): AdminRecordingSort {
    return value === 'started_asc' ||
      value === 'retention_asc' ||
      value === 'retention_desc' ||
      value === 'duration_desc'
      ? value
      : 'started_desc';
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const safe = fileName.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'recording.json';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safe;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
