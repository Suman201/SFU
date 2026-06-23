import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  AdminBatchDetail,
  AdminBatchRosterItem,
  AdminBatchScheduleItem,
  AdminBatchSessionItem,
  AdminBatchStatus,
  AdminBatchUpdateRequest,
  AdminBatchWeekday
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type ScheduleFormValue = { dayOfWeek: AdminBatchWeekday; startTime: string };

@Component({
  selector: 'sfu-admin-batch-detail',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './batch-detail.html',
  styleUrl: './batch-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class BatchDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly batch = signal<AdminBatchDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly pendingAction = signal<string | null>(null);
  protected readonly pendingAttendanceSessionId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly weekdays: AdminBatchWeekday[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    courseId: ['', [Validators.maxLength(120)]],
    courseName: ['', [Validators.maxLength(120)]],
    teacherId: ['', [Validators.required, Validators.maxLength(120)]],
    year: [new Date().getUTCFullYear(), [Validators.required, Validators.min(2000), Validators.max(2100)]],
    maxCapacity: [30, [Validators.required, Validators.min(1), Validators.max(1000)]],
    status: ['ACTIVE' as AdminBatchStatus],
    schedule: this.formBuilder.array([this.createScheduleGroup()])
  });

  ngOnInit(): void {
    this.load();
  }

  protected save(): void {
    const batch = this.batch();
    if (!batch || this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const request: AdminBatchUpdateRequest = {};
    const name = value.name.trim();
    const courseId = value.courseId.trim();
    const courseName = value.courseName.trim();
    const teacherId = value.teacherId.trim();
    const year = Number(value.year);
    const maxCapacity = Number(value.maxCapacity);
    const schedule = this.currentSchedule();
    const scheduleChanged = !this.sameSchedule(schedule, batch.schedule);
    if (name !== batch.name) request.name = name;
    if (courseId !== (batch.courseId || '')) request.courseId = courseId;
    if (courseName !== (batch.courseName || '')) request.courseName = courseName;
    if (teacherId !== batch.teacherId) request.teacherId = teacherId;
    if (year !== batch.year) request.year = year;
    if (maxCapacity !== batch.maxCapacity) request.maxCapacity = maxCapacity;
    if (value.status !== batch.status) request.status = value.status;
    if (scheduleChanged) request.schedule = schedule;
    if (!Object.keys(request).length) {
      this.success.set('No changes to save.');
      this.error.set('');
      return;
    }
    if ((scheduleChanged || request.year !== undefined || request.teacherId !== undefined) && !confirm('Update future planned sessions for this batch?')) {
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .updateBatch(batch.id, request)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.batch.set(updated);
          this.patchForm(updated);
          this.success.set(`${updated.name} updated.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected get scheduleRows() {
    return this.form.controls.schedule;
  }

  protected addScheduleRow(): void {
    this.scheduleRows.push(this.createScheduleGroup());
  }

  protected removeScheduleRow(index: number): void {
    if (this.scheduleRows.length <= 1) {
      return;
    }
    this.scheduleRows.removeAt(index);
  }

  protected downloadAttendance(session: AdminBatchSessionItem): void {
    if (this.pendingAttendanceSessionId()) {
      return;
    }
    this.pendingAttendanceSessionId.set(session.id);
    this.error.set('');
    this.api
      .downloadAttendance(session.id)
      .pipe(finalize(() => this.pendingAttendanceSessionId.set(null)))
      .subscribe({
        next: (blob) => this.saveAttendanceBlob(blob, session),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected transition(action: 'activate' | 'pause' | 'complete' | 'cancel'): void {
    const batch = this.batch();
    if (!batch || this.pendingAction()) {
      return;
    }
    if ((action === 'complete' || action === 'cancel') && !confirm(`Mark ${batch.name} as ${action}?`)) {
      return;
    }
    this.pendingAction.set(action);
    this.error.set('');
    this.success.set('');
    this.api
      .transitionBatch(batch.id, action)
      .pipe(finalize(() => this.pendingAction.set(null)))
      .subscribe({
        next: (updated) => {
          this.batch.set(updated);
          this.patchForm(updated);
          this.success.set(`${updated.name} is now ${updated.status.toLowerCase()}.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected scheduleLabel(batch: AdminBatchDetail): string {
    return batch.schedule.map((item) => `${item.dayOfWeek.slice(0, 3)} ${item.startTime}`).join(', ') || 'No schedule';
  }

  protected statusClass(status: AdminBatchStatus | string): string {
    return `status-${status.toLowerCase()}`;
  }

  protected trackByRoster(_index: number, row: AdminBatchRosterItem): string {
    return row.enrollmentId;
  }

  protected trackBySession(_index: number, row: AdminBatchSessionItem): string {
    return row.id;
  }

  private load(): void {
    const batchId = this.route.snapshot.paramMap.get('batchId');
    if (!batchId) {
      this.error.set('Batch id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getBatch(batchId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (batch) => {
          this.batch.set(batch);
          this.patchForm(batch);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private patchForm(batch: AdminBatchDetail): void {
    this.form.reset({
      name: batch.name,
      courseId: batch.courseId || '',
      courseName: batch.courseName || '',
      teacherId: batch.teacherId,
      year: batch.year,
      maxCapacity: batch.maxCapacity,
      status: batch.status
    });
    this.patchSchedule(batch.schedule);
  }

  private createScheduleGroup(item: Partial<AdminBatchScheduleItem> = {}) {
    return this.formBuilder.nonNullable.group({
      dayOfWeek: [(item.dayOfWeek ?? 'MONDAY') as AdminBatchWeekday, Validators.required],
      startTime: [item.startTime ?? '10:00', [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)]]
    });
  }

  private patchSchedule(schedule: AdminBatchScheduleItem[]): void {
    this.scheduleRows.clear();
    const rows = schedule.length ? schedule : [{ dayOfWeek: 'MONDAY' as AdminBatchWeekday, startTime: '10:00' }];
    for (const item of rows) {
      this.scheduleRows.push(this.createScheduleGroup(item));
    }
  }

  private currentSchedule(): ScheduleFormValue[] {
    return this.scheduleRows
      .getRawValue()
      .map((item) => ({ dayOfWeek: item.dayOfWeek, startTime: item.startTime.trim() }))
      .filter((item) => item.startTime);
  }

  private sameSchedule(left: AdminBatchScheduleItem[], right: AdminBatchScheduleItem[]): boolean {
    return this.scheduleKey(left) === this.scheduleKey(right);
  }

  private scheduleKey(schedule: AdminBatchScheduleItem[]): string {
    return [...schedule]
      .map((item) => ({ dayOfWeek: item.dayOfWeek, startTime: item.startTime }))
      .sort((left, right) => this.weekdays.indexOf(left.dayOfWeek) - this.weekdays.indexOf(right.dayOfWeek))
      .map((item) => `${item.dayOfWeek}:${item.startTime}`)
      .join('|');
  }

  private saveAttendanceBlob(blob: Blob, session: AdminBatchSessionItem): void {
    const batch = this.batch();
    const safeName = `${batch?.name || 'batch'}-${session.sessionNumber}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName || 'class-session'}-attendance.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
