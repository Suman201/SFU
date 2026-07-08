import { DatePipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  TeacherAnalyticsBatchSummary,
  TeacherAnalyticsQuery,
  TeacherAnalyticsResponse,
  TeacherAnalyticsRiskIndicator
} from '@native-sfu/contracts';
import { ClassSessionService } from '../../class-session/class-session.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface AnalyticsMetric {
  label: string;
  value: string;
  tone: 'green' | 'rose' | 'coral' | 'amber';
}

@Component({
  selector: 'sfu-teacher-analytics',
  standalone: true,
  imports: [DatePipe, Footer, Header, RouterLink, TitleCasePipe],
  templateUrl: './teacher-analytics.html',
  styleUrl: './teacher-analytics.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherAnalytics implements OnInit {
  private readonly classSessions = inject(ClassSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly batchId = signal('');
  protected readonly courseId = signal('');
  protected readonly studentId = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly analytics = signal<TeacherAnalyticsResponse | null>(null);

  protected readonly metrics = computed<AnalyticsMetric[]>(() => {
    const summary = this.analytics()?.summary;
    if (!summary) return [];
    return [
      { label: 'Attendance rate', value: `${summary.attendanceRate}%`, tone: summary.attendanceRate >= 75 ? 'green' : 'amber' },
      { label: 'Missed classes', value: `${summary.missedClasses}`, tone: summary.missedClasses ? 'amber' : 'green' },
      { label: 'Risk students', value: `${summary.riskStudents}`, tone: summary.riskStudents ? 'rose' : 'green' },
      { label: 'Assignments missing', value: `${summary.assignmentsMissing}`, tone: summary.assignmentsMissing ? 'coral' : 'green' },
      { label: 'Questions asked', value: `${summary.questionsAsked}`, tone: 'coral' },
      { label: 'Weak signals', value: `${summary.weakTopicSignals}`, tone: summary.weakTopicSignals ? 'amber' : 'green' },
      { label: 'Material downloads', value: `${summary.materialDownloads}`, tone: 'green' }
    ];
  });

  protected readonly batches = computed(() => this.analytics()?.batches ?? []);
  protected readonly risks = computed(() => this.analytics()?.risks ?? []);
  protected readonly weakSignals = computed(() => this.analytics()?.weakTopicSignals ?? []);
  protected readonly availabilityNotes = computed(() => {
    const availability = this.analytics()?.availability;
    if (!availability) return [];
    return Object.entries(availability)
      .filter(([, value]) => value.reason)
      .map(([key, value]) => ({ key, ...value }));
  });

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.batchId.set(params.get('batchId') ?? '');
    this.courseId.set(params.get('courseId') ?? '');
    this.studentId.set(params.get('studentId') ?? '');
    this.dateFrom.set(params.get('dateFrom') ?? '');
    this.dateTo.set(params.get('dateTo') ?? '');
    this.load();
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.query(),
      queryParamsHandling: ''
    });
    this.load();
  }

  protected clearFilters(): void {
    this.batchId.set('');
    this.courseId.set('');
    this.studentId.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    void this.router.navigate([], { relativeTo: this.route, queryParams: {} });
    this.load();
  }

  protected updateText(field: 'batchId' | 'courseId' | 'studentId' | 'dateFrom' | 'dateTo', event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    if (field === 'batchId') this.batchId.set(value);
    if (field === 'courseId') this.courseId.set(value);
    if (field === 'studentId') this.studentId.set(value);
    if (field === 'dateFrom') this.dateFrom.set(value);
    if (field === 'dateTo') this.dateTo.set(value);
  }

  protected attendanceLabel(batch: TeacherAnalyticsBatchSummary): string {
    return batch.attendance.enrolledSlots ? `${batch.attendance.attendanceRate}%` : 'N/A';
  }

  protected riskTone(risk: TeacherAnalyticsRiskIndicator): string {
    return risk.riskLevel === 'high' ? 'high' : 'medium';
  }

  protected signalTone(severity: string): string {
    if (severity === 'needs_attention') return 'danger';
    if (severity === 'watch') return 'warning';
    return 'info';
  }

  protected sourceSessionLink(batch: TeacherAnalyticsBatchSummary): unknown[] {
    return ['/teacher/dashboard/batches', batch.batchId];
  }

  protected sourceSessionQuery(batch: TeacherAnalyticsBatchSummary): Record<string, string> {
    const sessionId = batch.sourceSessionIds[0];
    return sessionId ? { reportSessionId: sessionId } : {};
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.classSessions.getTeacherAnalytics(this.query()).subscribe({
      next: (response) => this.analytics.set(response),
      error: (error) => {
        this.analytics.set(null);
        this.error.set(this.classSessions.errorMessage(error));
      },
      complete: () => this.loading.set(false)
    });
  }

  private query(): TeacherAnalyticsQuery {
    return {
      batchId: this.batchId(),
      courseId: this.courseId(),
      studentId: this.studentId(),
      dateFrom: this.dateFrom(),
      dateTo: this.dateTo()
    };
  }
}
