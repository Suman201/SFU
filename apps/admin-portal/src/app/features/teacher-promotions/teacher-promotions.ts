import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  TeacherPromotion,
  TeacherPromotionListQuery,
  TeacherPromotionPlacement,
  TeacherPromotionStatus
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../core/services/admin-api.service';

type PromotionStatusFilter = TeacherPromotionStatus | 'all';
type PromotionPlacementFilter = TeacherPromotionPlacement | 'all';
type PromotionAction = 'approve' | 'pause' | 'cancel' | 'reject';

@Component({
  selector: 'sfu-admin-teacher-promotions',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './teacher-promotions.html',
  styleUrl: './teacher-promotions.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherPromotions implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<TeacherPromotion[]>([]);
  protected readonly loading = signal(false);
  protected readonly savingPromotionId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as PromotionStatusFilter],
    placement: ['all' as PromotionPlacementFilter],
    search: [''],
    teacherId: ['']
  });

  protected readonly noteForm = this.formBuilder.nonNullable.group({
    adminNote: ['']
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
      placement: 'all',
      search: '',
      teacherId: ''
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

  protected runAction(row: TeacherPromotion, action: PromotionAction): void {
    if (this.savingPromotionId()) {
      return;
    }
    const request = this.actionRequest();
    this.savingPromotionId.set(row.promotionId);
    this.error.set('');
    this.success.set('');
    const call =
      action === 'approve'
        ? this.api.approveTeacherPromotion(row.promotionId, { ...request, billingStatus: row.billingStatus })
        : action === 'pause'
          ? this.api.pauseTeacherPromotion(row.promotionId, request)
          : action === 'cancel'
            ? this.api.cancelTeacherPromotion(row.promotionId, request)
            : this.api.rejectTeacherPromotion(row.promotionId, request);

    call.pipe(finalize(() => this.savingPromotionId.set(null))).subscribe({
      next: (updated) => {
        this.rows.update((rows) => rows.map((item) => (item.promotionId === updated.promotionId ? updated : item)));
        this.success.set(`${this.actionLabel(action)} saved for ${updated.teacherName || updated.teacherId}.`);
      },
      error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
    });
  }

  protected canApprove(row: TeacherPromotion): boolean {
    return row.status === 'requested' || row.status === 'paused' || row.status === 'scheduled';
  }

  protected canPause(row: TeacherPromotion): boolean {
    return row.status === 'active' || row.status === 'scheduled';
  }

  protected canCancel(row: TeacherPromotion): boolean {
    return row.status === 'requested' || row.status === 'scheduled' || row.status === 'active' || row.status === 'paused';
  }

  protected canReject(row: TeacherPromotion): boolean {
    return row.status === 'requested';
  }

  protected isSaving(row: TeacherPromotion): boolean {
    return this.savingPromotionId() === row.promotionId;
  }

  protected placementLabel(placement: string): string {
    switch (placement) {
      case 'marketplace_featured':
        return 'Marketplace featured';
      case 'profile_badge':
        return 'Profile badge';
      default:
        return 'Search boost';
    }
  }

  protected statusLabel(status: string): string {
    return status.replace(/_/g, ' ');
  }

  protected statusClass(status: string): string {
    return `status-${status.replace(/_/g, '-')}`;
  }

  protected initials(row: TeacherPromotion): string {
    return (row.teacherName || row.teacherId || 'Teacher')
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected trackByPromotion(_index: number, row: TeacherPromotion): string {
    return row.promotionId;
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listTeacherPromotions(this.toQuery(page))
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

  private toQuery(page: number): TeacherPromotionListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.placement !== 'all' ? { placement: value.placement } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {}),
      ...(value.teacherId.trim() ? { teacherId: value.teacherId.trim() } : {})
    };
  }

  private actionRequest(): { adminNote?: string } {
    const note = this.noteForm.getRawValue().adminNote.trim();
    return note ? { adminNote: note } : {};
  }

  private actionLabel(action: PromotionAction): string {
    switch (action) {
      case 'approve':
        return 'Approval';
      case 'pause':
        return 'Pause';
      case 'cancel':
        return 'Cancellation';
      default:
        return 'Rejection';
    }
  }
}
