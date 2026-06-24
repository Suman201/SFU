import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminAuditLogDetail, AdminAuditLogStatus } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-audit-log-detail',
  standalone: true,
  imports: [DatePipe, RouterLink],
  templateUrl: './audit-log-detail.html',
  styleUrl: './audit-log-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AuditLogDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);

  protected readonly auditLog = signal<AdminAuditLogDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    this.load();
  }

  protected actor(item: AdminAuditLogDetail): string {
    return item.actorName || item.actorEmail || item.actorId || 'System';
  }

  protected statusClass(status: AdminAuditLogStatus): string {
    return `status-${status}`;
  }

  protected json(value: Record<string, unknown> | undefined): string {
    return value ? JSON.stringify(value, null, 2) : '{}';
  }

  private load(): void {
    const auditLogId = this.route.snapshot.paramMap.get('auditLogId');
    if (!auditLogId) {
      this.error.set('Audit log id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getAuditLog(auditLogId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (auditLog) => this.auditLog.set(auditLog),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }
}
