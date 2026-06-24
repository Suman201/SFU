import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AdminAuditLogListItem, AdminAuditLogQuery, AdminAuditLogStatus } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type AuditStatusFilter = AdminAuditLogStatus | 'all';

@Component({
  selector: 'sfu-admin-audit-logs-list',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './audit-logs-list.html',
  styleUrl: './audit-logs-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AuditLogsList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<AdminAuditLogListItem[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as AuditStatusFilter],
    search: [''],
    actorId: [''],
    action: [''],
    resourceType: [''],
    resourceId: [''],
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
      search: '',
      actorId: '',
      action: '',
      resourceType: '',
      resourceId: '',
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

  protected actor(row: AdminAuditLogListItem): string {
    return row.actorName || row.actorEmail || row.actorId || 'System';
  }

  protected statusClass(status: AdminAuditLogStatus): string {
    return `status-${status}`;
  }

  protected trackByAuditLog(_index: number, row: AdminAuditLogListItem): string {
    return row.id;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listAuditLogs(this.toQuery(page))
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.rows.set(response.items);
          this.page.set(response.page);
          this.limit.set(response.limit);
          this.total.set(response.total);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private toQuery(page: number): AdminAuditLogQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      ...(value.actorId.trim() ? { actorId: value.actorId.trim() } : {}),
      ...(value.action.trim() ? { action: value.action.trim() } : {}),
      ...(value.resourceType.trim() ? { resourceType: value.resourceType.trim() } : {}),
      ...(value.resourceId.trim() ? { resourceId: value.resourceId.trim() } : {}),
      ...(value.dateFrom ? { dateFrom: new Date(value.dateFrom).toISOString() } : {}),
      ...(value.dateTo ? { dateTo: new Date(value.dateTo).toISOString() } : {})
    };
  }
}
