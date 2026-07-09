import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  AdminClassSessionHealthResponse,
  AdminClassSessionReportRow,
  ClassSessionReport,
  ClassSessionTimelineCategory,
  ClassSessionTimelineEvent
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-class-session-detail',
  standalone: true,
  imports: [DatePipe, PercentPipe, RouterLink],
  templateUrl: './class-session-detail.html',
  styleUrl: './class-session-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class ClassSessionDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);

  protected readonly session = signal<AdminClassSessionReportRow | null>(null);
  protected readonly health = signal<AdminClassSessionHealthResponse | null>(null);
  protected readonly report = signal<ClassSessionReport | null>(null);
  protected readonly timeline = signal<ClassSessionTimelineEvent[]>([]);
  protected readonly timelineCategory = signal<ClassSessionTimelineCategory | 'all'>('all');
  protected readonly timelineLoading = signal(false);
  protected readonly timelineError = signal('');
  protected readonly timelineHasMore = signal(false);
  protected readonly timelineNextBefore = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly healthLoading = signal(false);
  protected readonly healthError = signal('');
  protected readonly reportLoading = signal(false);
  protected readonly reportError = signal('');
  protected readonly downloading = signal(false);
  protected readonly reportDownloading = signal(false);
  protected readonly error = signal('');
  protected readonly timelineCategories: Array<{ value: ClassSessionTimelineCategory | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'lifecycle', label: 'Lifecycle' },
    { value: 'attendance', label: 'Attendance' },
    { value: 'moderation', label: 'Moderation' },
    { value: 'media', label: 'Media' },
    { value: 'chat', label: 'Chat/Q&A' },
    { value: 'whiteboard', label: 'Whiteboard' },
    { value: 'materials', label: 'Materials' },
    { value: 'recording', label: 'Recording' },
    { value: 'support', label: 'Support' }
  ];

  ngOnInit(): void {
    this.load();
    this.loadHealth();
    this.loadReport();
    this.loadTimeline();
  }

  protected attendancePercent(session: AdminClassSessionReportRow): number {
    return session.attendance.enrolled ? session.attendance.present / session.attendance.enrolled : 0;
  }

  protected downloadAttendance(): void {
    const session = this.session();
    if (!session?.roomId || this.downloading()) {
      return;
    }
    this.downloading.set(true);
    this.error.set('');
    this.api
      .downloadAttendance(session.sessionId)
      .pipe(finalize(() => this.downloading.set(false)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, this.attendanceFileName(session)),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected downloadReportCsv(): void {
    const session = this.session();
    if (!session || this.reportDownloading()) {
      return;
    }
    this.reportDownloading.set(true);
    this.reportError.set('');
    this.api
      .downloadClassSessionReportCsv(session.sessionId)
      .pipe(finalize(() => this.reportDownloading.set(false)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, this.reportFileName(session)),
        error: (error: unknown) => this.reportError.set(this.api.apiErrorMessage(error))
      });
  }

  protected printReport(): void {
    if (typeof window !== 'undefined') {
      window.print();
    }
  }

  protected setTimelineCategory(category: ClassSessionTimelineCategory | 'all'): void {
    if (this.timelineCategory() === category) {
      return;
    }
    this.timelineCategory.set(category);
    this.loadTimeline();
  }

  protected loadMoreTimeline(): void {
    const before = this.timelineNextBefore();
    if (!before || this.timelineLoading()) {
      return;
    }
    this.loadTimeline(before, true);
  }

  protected timelineActor(event: ClassSessionTimelineEvent): string {
    return event.actor?.name || event.actor?.email || event.actor?.id || 'System';
  }

  protected timelineTarget(event: ClassSessionTimelineEvent): string {
    return event.target?.name || event.target?.userId || event.target?.id || '';
  }

  protected durationLabel(seconds: number): string {
    if (!seconds) {
      return '0m';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
  }

  protected healthBadgeClass(health: AdminClassSessionHealthResponse): string {
    if (health.teacher.state === 'reconnecting' || health.room?.incidentHealth === 'critical') {
      return 'health-critical';
    }
    if (health.teacher.state === 'absent' || health.room?.incidentHealth === 'degraded' || health.issues.total > 0) {
      return 'health-warning';
    }
    return 'health-ok';
  }

  protected submissionTotal(report: ClassSessionReport): number {
    const submissions = report.assignments.submissions;
    return submissions.submitted + submissions.late + submissions.reviewed + submissions.returned + submissions.completed;
  }

  private load(): void {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (!sessionId) {
      this.error.set('Class session id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getClassSession(sessionId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (session) => this.session.set(session),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private loadReport(): void {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (!sessionId) {
      return;
    }
    this.reportLoading.set(true);
    this.reportError.set('');
    this.api
      .getClassSessionReport(sessionId)
      .pipe(finalize(() => this.reportLoading.set(false)))
      .subscribe({
        next: (report) => this.report.set(report),
        error: (error: unknown) => this.reportError.set(this.api.apiErrorMessage(error))
      });
  }

  private loadHealth(): void {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (!sessionId) {
      return;
    }
    this.healthLoading.set(true);
    this.healthError.set('');
    this.api
      .getClassSessionHealth(sessionId)
      .pipe(finalize(() => this.healthLoading.set(false)))
      .subscribe({
        next: (health) => this.health.set(health),
        error: (error: unknown) => this.healthError.set(this.api.apiErrorMessage(error))
      });
  }

  private loadTimeline(before?: string, append = false): void {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (!sessionId) {
      return;
    }
    this.timelineLoading.set(true);
    this.timelineError.set('');
    this.api
      .getClassSessionTimeline(sessionId, {
        limit: 40,
        ...(before ? { before } : {}),
        category: this.timelineCategory()
      })
      .pipe(finalize(() => this.timelineLoading.set(false)))
      .subscribe({
        next: (response) => {
          this.timeline.set(append ? [...this.timeline(), ...response.items] : response.items);
          this.timelineHasMore.set(response.hasMore);
          this.timelineNextBefore.set(response.nextBefore ?? null);
        },
        error: (error: unknown) => this.timelineError.set(this.api.apiErrorMessage(error))
      });
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private attendanceFileName(session: AdminClassSessionReportRow): string {
    const safe = `${session.batchName}-${session.sessionNumber}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${safe || 'class-session'}-attendance.csv`;
  }

  private reportFileName(session: AdminClassSessionReportRow): string {
    const safe = `${session.batchName}-${session.sessionNumber}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${safe || 'class-session'}-report.csv`;
  }
}
