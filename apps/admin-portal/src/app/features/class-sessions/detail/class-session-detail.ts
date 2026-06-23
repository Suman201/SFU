import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminClassSessionReportRow } from '@native-sfu/contracts';
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
  protected readonly loading = signal(false);
  protected readonly downloading = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    this.load();
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
}
