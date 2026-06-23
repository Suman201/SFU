import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  AdminAttendanceQuery,
  AdminAttendanceSessionRow,
  AdminAttendanceStudentRow,
  AdminAttendanceSummary,
  AdminAttendanceTrendPoint,
  AdminClassSessionStatus
} from '@native-sfu/contracts';
import { finalize, forkJoin } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type AttendanceStatusFilter = AdminClassSessionStatus | 'all';
type AttendanceTab = 'sessions' | 'students';

@Component({
  selector: 'sfu-admin-attendance-list',
  standalone: true,
  imports: [DatePipe, PercentPipe, ReactiveFormsModule, RouterLink],
  templateUrl: './attendance-list.html',
  styleUrl: './attendance-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AttendanceList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly sessionRows = signal<AdminAttendanceSessionRow[]>([]);
  protected readonly studentRows = signal<AdminAttendanceStudentRow[]>([]);
  protected readonly trends = signal<AdminAttendanceTrendPoint[]>([]);
  protected readonly summary = signal<AdminAttendanceSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly exporting = signal(false);
  protected readonly error = signal('');
  protected readonly activeTab = signal<AttendanceTab>('sessions');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly sessionsTotal = signal(0);
  protected readonly studentsTotal = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as AttendanceStatusFilter],
    courseId: [''],
    batchId: [''],
    teacherId: [''],
    dateFrom: [''],
    dateTo: ['']
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
      courseId: '',
      batchId: '',
      teacherId: '',
      dateFrom: '',
      dateTo: ''
    });
    void this.updateQueryAndLoad(1);
  }

  protected selectTab(tab: AttendanceTab): void {
    if (this.activeTab() === tab) {
      return;
    }
    this.activeTab.set(tab);
    void this.updateQueryAndLoad(1);
  }

  protected nextPage(): void {
    if (this.page() * this.limit() < this.activeTotal()) {
      void this.updateQueryAndLoad(this.page() + 1);
    }
  }

  protected previousPage(): void {
    if (this.page() > 1) {
      void this.updateQueryAndLoad(this.page() - 1);
    }
  }

  protected activeTotal(): number {
    return this.activeTab() === 'sessions' ? this.sessionsTotal() : this.studentsTotal();
  }

  protected activeCount(): number {
    return this.activeTab() === 'sessions' ? this.sessionRows().length : this.studentRows().length;
  }

  protected averageAttendance(): number {
    return (this.summary()?.averageAttendanceRate ?? 0) / 100;
  }

  protected attendancePercent(value: number): number {
    return value / 100;
  }

  protected duration(seconds?: number): string {
    if (!seconds) {
      return '0m';
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  protected statusClass(status: AdminClassSessionStatus): string {
    return `status-${status}`;
  }

  protected initials(value?: string): string {
    return (value || 'NA')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected trackBySession(_index: number, row: AdminAttendanceSessionRow): string {
    return row.sessionId;
  }

  protected trackByStudent(_index: number, row: AdminAttendanceStudentRow): string {
    return `${row.batchId}:${row.studentId}`;
  }

  protected exportCsv(): void {
    if (this.exporting()) {
      return;
    }
    this.error.set('');
    this.exporting.set(true);
    this.api
      .exportAttendanceCsv(this.toQuery(this.page()))
      .pipe(finalize(() => this.exporting.set(false)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, 'attendance-analytics.csv'),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    const query = this.toQuery(page);
    const aggregateQuery = this.toAggregateQuery();
    forkJoin({
      summary: this.api.getAttendanceSummary(aggregateQuery),
      trends: this.api.getAttendanceTrends(aggregateQuery),
      sessions: this.api.listAttendanceSessions(query),
      students: this.api.listAttendanceStudents(query)
    })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ summary, trends, sessions, students }) => {
          this.summary.set(summary);
          this.trends.set(trends.items);
          this.sessionRows.set(sessions.items);
          this.studentRows.set(students.items);
          this.sessionsTotal.set(sessions.total);
          this.studentsTotal.set(students.total);
          this.page.set(this.activeTab() === 'sessions' ? sessions.page : students.page);
          this.limit.set(this.activeTab() === 'sessions' ? sessions.limit : students.limit);
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
    this.activeTab.set(params.get('tab') === 'students' ? 'students' : 'sessions');
    this.filters.reset({
      status: this.toStatus(params.get('status')),
      courseId: params.get('courseId') ?? '',
      batchId: params.get('batchId') ?? '',
      teacherId: params.get('teacherId') ?? '',
      dateFrom: params.get('dateFrom') ?? '',
      dateTo: params.get('dateTo') ?? ''
    });
  }

  private queryParams(page: number): Record<string, string | number> {
    const query = this.toQuery(page);
    return Object.entries({ ...query, tab: this.activeTab() }).reduce<Record<string, string | number>>((params, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = value;
      }
      return params;
    }, {});
  }

  private toQuery(page: number): AdminAttendanceQuery {
    return {
      ...this.toAggregateQuery(),
      page,
      limit: this.limit()
    };
  }

  private toAggregateQuery(): AdminAttendanceQuery {
    const value = this.filters.getRawValue();
    return {
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.courseId.trim() ? { courseId: value.courseId.trim() } : {}),
      ...(value.batchId.trim() ? { batchId: value.batchId.trim() } : {}),
      ...(value.teacherId.trim() ? { teacherId: value.teacherId.trim() } : {}),
      ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}),
      ...(value.dateTo ? { dateTo: value.dateTo } : {})
    };
  }

  private toStatus(value: string | null): AttendanceStatusFilter {
    return value === 'scheduled' || value === 'live' || value === 'completed' || value === 'cancelled' ? value : 'all';
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const safe = fileName.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'attendance-analytics.csv';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safe;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
