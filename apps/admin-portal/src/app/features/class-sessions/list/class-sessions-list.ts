import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  AdminClassSessionReportQuery,
  AdminClassSessionReportRow,
  AdminClassSessionReportSummary,
  AdminClassSessionStatus
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type SessionStatusFilter = AdminClassSessionStatus | 'all';

@Component({
  selector: 'sfu-admin-class-sessions-list',
  standalone: true,
  imports: [DatePipe, PercentPipe, ReactiveFormsModule, RouterLink],
  templateUrl: './class-sessions-list.html',
  styleUrl: './class-sessions-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class ClassSessionsList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<AdminClassSessionReportRow[]>([]);
  protected readonly summary = signal<AdminClassSessionReportSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly downloadingSessionId = signal<string | null>(null);
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);
  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as SessionStatusFilter],
    teacherId: [''],
    batchId: [''],
    courseId: [''],
    dateFrom: [''],
    dateTo: ['']
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
      teacherId: '',
      batchId: '',
      courseId: '',
      dateFrom: '',
      dateTo: ''
    });
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

  protected attendancePercent(row: AdminClassSessionReportRow): number {
    return row.attendance.enrolled ? row.attendance.present / row.attendance.enrolled : 0;
  }

  protected statusClass(status: AdminClassSessionStatus): string {
    return `status-${status}`;
  }

  protected trackBySession(_index: number, row: AdminClassSessionReportRow): string {
    return row.sessionId;
  }

  protected downloadAttendance(row: AdminClassSessionReportRow): void {
    if (!row.roomId || this.downloadingSessionId()) {
      return;
    }
    this.error.set('');
    this.downloadingSessionId.set(row.sessionId);
    this.api
      .downloadAttendance(row.sessionId)
      .pipe(finalize(() => this.downloadingSessionId.set(null)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, this.attendanceFileName(row)),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    const query = this.toQuery(page);
    this.api
      .listClassSessions(query)
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

  private toQuery(page: number): AdminClassSessionReportQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.teacherId.trim() ? { teacherId: value.teacherId.trim() } : {}),
      ...(value.batchId.trim() ? { batchId: value.batchId.trim() } : {}),
      ...(value.courseId.trim() ? { courseId: value.courseId.trim() } : {}),
      ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}),
      ...(value.dateTo ? { dateTo: value.dateTo } : {})
    };
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private attendanceFileName(row: AdminClassSessionReportRow): string {
    const safe = `${row.batchName}-${row.sessionNumber}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${safe || 'class-session'}-attendance.csv`;
  }
}
