import { DatePipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import type {
  ContactSubmission,
  ContactSubmissionCategory,
  ContactSubmissionListQuery,
  ContactSubmissionPriority,
  ContactSubmissionStatus
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../core/services/admin-api.service';

type ContactStatusFilter = ContactSubmissionStatus | 'all';
type ContactCategoryFilter = ContactSubmissionCategory | 'all';
type ContactPriorityFilter = ContactSubmissionPriority | 'all';

@Component({
  selector: 'sfu-contact-inbox',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, TitleCasePipe],
  templateUrl: './contact-inbox.html',
  styleUrl: './contact-inbox.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class ContactInbox implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<ContactSubmission[]>([]);
  protected readonly selected = signal<ContactSubmission | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as ContactStatusFilter],
    category: ['all' as ContactCategoryFilter],
    priority: ['all' as ContactPriorityFilter],
    assignedToUserId: [''],
    search: [''],
    dateFrom: [''],
    dateTo: ['']
  });

  protected readonly updateForm = this.formBuilder.nonNullable.group({
    status: ['open' as ContactSubmissionStatus],
    priority: ['normal' as ContactSubmissionPriority],
    assignedToName: [''],
    internalNotes: ['']
  });

  protected readonly replyForm = this.formBuilder.nonNullable.group({
    message: ['']
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
      category: 'all',
      priority: 'all',
      assignedToUserId: '',
      search: '',
      dateFrom: '',
      dateTo: ''
    });
    this.load(1);
  }

  protected select(row: ContactSubmission): void {
    this.selected.set(row);
    this.updateForm.reset({
      status: row.status === 'new' ? 'open' : row.status,
      priority: row.priority,
      assignedToName: row.assignedToName ?? '',
      internalNotes: row.internalNotes ?? ''
    });
    this.replyForm.reset({ message: '' });
    this.error.set('');
    this.success.set('');
  }

  protected updateSelected(): void {
    const row = this.selected();
    if (!row || this.saving()) return;
    const value = this.updateForm.getRawValue();
    this.runSave(
      this.api.updateContactSubmission(row.submissionId, {
        status: value.status,
        priority: value.priority,
        ...(value.assignedToName.trim() ? { assignedToName: value.assignedToName.trim() } : { assignedToName: '' }),
        internalNotes: value.internalNotes
      }),
      'Contact submission updated.'
    );
  }

  protected reply(): void {
    const row = this.selected();
    const message = this.replyForm.controls.message.value.trim();
    if (!row || this.saving() || !message) return;
    this.runSave(this.api.replyToContactSubmission(row.submissionId, { message }), 'Reply stored and delivery status updated.', () =>
      this.replyForm.reset({ message: '' })
    );
  }

  protected archive(row = this.selected()): void {
    if (!row || this.saving()) return;
    this.runSave(this.api.archiveContactSubmission(row.submissionId), 'Contact submission archived.');
  }

  protected markSpam(row = this.selected()): void {
    if (!row || this.saving()) return;
    this.runSave(this.api.markContactSubmissionSpam(row.submissionId), 'Contact submission marked as spam.');
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

  protected label(value: string): string {
    return value.replace(/_/g, ' ');
  }

  protected statusClass(status: string): string {
    return `status-${status.replace(/_/g, '-')}`;
  }

  protected priorityClass(priority: string): string {
    return `priority-${priority}`;
  }

  protected initials(row: ContactSubmission): string {
    return row.name
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected trackBySubmission(_index: number, row: ContactSubmission): string {
    return row.submissionId;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listContactSubmissions(this.toQuery(page))
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

  private runSave(request: ReturnType<AdminApiService['updateContactSubmission']>, message: string, after?: () => void): void {
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    request.pipe(finalize(() => this.saving.set(false))).subscribe({
      next: (updated) => {
        this.success.set(message);
        this.selected.set(updated);
        this.rows.update((rows) => rows.map((row) => (row.submissionId === updated.submissionId ? updated : row)));
        this.select(updated);
        after?.();
      },
      error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
    });
  }

  private toQuery(page: number): ContactSubmissionListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.category !== 'all' ? { category: value.category } : {}),
      ...(value.priority !== 'all' ? { priority: value.priority } : {}),
      ...(value.assignedToUserId.trim() ? { assignedToUserId: value.assignedToUserId.trim() } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      ...(value.dateFrom ? { dateFrom: new Date(value.dateFrom).toISOString() } : {}),
      ...(value.dateTo ? { dateTo: new Date(value.dateTo).toISOString() } : {})
    };
  }
}
