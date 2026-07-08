import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SupportIssueType, SupportRequest, SupportRequestStatus } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../core/services/admin-api.service';

type SupportStatusFilter = SupportRequestStatus | 'all';
type SupportIssueFilter = SupportIssueType | 'all';

@Component({
  selector: 'sfu-admin-support-requests',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './support-requests.html',
  styleUrl: './support-requests.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class SupportRequests {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<SupportRequest[]>([]);
  protected readonly selected = signal<SupportRequest | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as SupportStatusFilter],
    issueType: ['all' as SupportIssueFilter],
    search: [''],
    batchId: [''],
    sessionId: [''],
    studentId: ['']
  });

  protected readonly updateForm = this.formBuilder.nonNullable.group({
    status: ['in_review' as SupportRequestStatus],
    assignedToName: [''],
    response: [''],
    internalNote: ['']
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
      issueType: 'all',
      search: '',
      batchId: '',
      sessionId: '',
      studentId: ''
    });
    this.load(1);
  }

  protected select(row: SupportRequest): void {
    this.selected.set(row);
    this.updateForm.reset({
      status: row.status,
      assignedToName: row.assignedToName ?? '',
      response: '',
      internalNote: ''
    });
    this.error.set('');
    this.success.set('');
  }

  protected updateSelected(): void {
    const row = this.selected();
    if (!row || this.saving()) {
      return;
    }
    const value = this.updateForm.getRawValue();
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .updateSupportRequest(row.requestId, {
        status: value.status,
        ...(value.assignedToName.trim() ? { assignedToName: value.assignedToName.trim() } : {}),
        ...(value.response.trim() ? { response: value.response.trim() } : {}),
        ...(value.internalNote.trim() ? { internalNote: value.internalNote.trim() } : {})
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.success.set(`Support request ${updated.requestId.slice(0, 8)} updated.`);
          this.selected.set(updated);
          this.rows.update((rows) => rows.map((item) => (item.requestId === updated.requestId ? updated : item)));
          this.updateForm.patchValue({ response: '', internalNote: '' });
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
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

  protected statusLabel(status: string): string {
    return status.replace(/_/g, ' ');
  }

  protected issueLabel(issueType: string): string {
    return issueType.replace(/_/g, ' ');
  }

  protected statusClass(status: string): string {
    return `status-${status.replace(/_/g, '-')}`;
  }

  protected initials(row: SupportRequest): string {
    return row.studentName
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected contextLabel(row: SupportRequest): string {
    return row.sessionTitle || row.batchName || row.recordingId || 'General';
  }

  protected trackByRequest(_index: number, row: SupportRequest): string {
    return row.requestId;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listSupportRequests(this.toQuery(page))
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

  private toQuery(page: number) {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.issueType !== 'all' ? { issueType: value.issueType } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      ...(value.batchId.trim() ? { batchId: value.batchId.trim() } : {}),
      ...(value.sessionId.trim() ? { sessionId: value.sessionId.trim() } : {}),
      ...(value.studentId.trim() ? { studentId: value.studentId.trim() } : {})
    };
  }
}
