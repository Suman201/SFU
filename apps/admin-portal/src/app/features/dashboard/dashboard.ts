import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminDashboardIssue, AdminDashboardLiveSession, AdminDashboardSummary } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-dashboard',
  standalone: true,
  imports: [DatePipe, PercentPipe, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AdminDashboard implements OnInit {
  private readonly api = inject(AdminApiService);

  protected readonly summary = signal<AdminDashboardSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    this.load();
  }

  protected refresh(): void {
    this.load();
  }

  protected attendanceRate(): number {
    return (this.summary()?.todayAttendanceRate ?? 0) / 100;
  }

  protected issueClass(issue: AdminDashboardIssue): string {
    return `issue-${issue.severity}`;
  }

  protected issuePath(issue: AdminDashboardIssue): string {
    return issue.link.split('?')[0] || '/dashboard';
  }

  protected issueQueryParams(issue: AdminDashboardIssue): Record<string, string> {
    const query = issue.link.split('?')[1];
    if (!query) {
      return {};
    }
    return query.split('&').reduce<Record<string, string>>((params, pair) => {
      const [key, value] = pair.split('=');
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
      }
      return params;
    }, {});
  }

  protected trackByIssue(_index: number, issue: AdminDashboardIssue): string {
    return `${issue.severity}:${issue.label}:${issue.link}`;
  }

  protected trackBySession(_index: number, session: AdminDashboardLiveSession): string {
    return session.sessionId;
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .getDashboardSummary()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (summary) => this.summary.set(summary),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }
}
