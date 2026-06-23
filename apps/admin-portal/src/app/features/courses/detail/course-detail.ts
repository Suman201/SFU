import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminCourseDetail, AdminCourseStatus } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-course-detail',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './course-detail.html',
  styleUrl: './course-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class CourseDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly course = signal<AdminCourseDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');

  protected readonly form = this.formBuilder.nonNullable.group({
    courseName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]]
  });

  ngOnInit(): void {
    this.load();
  }

  protected save(): void {
    const course = this.course();
    if (!course || this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .updateCourse(course.courseId, { courseName: this.form.controls.courseName.value.trim() })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.course.set(updated);
          this.form.reset({ courseName: updated.courseName });
          this.success.set(`${updated.courseName} updated.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected statusClass(status: AdminCourseStatus): string {
    return `status-${status}`;
  }

  protected scheduleLabel(schedule: { dayOfWeek: string; startTime: string }[]): string {
    return schedule.map((item) => `${item.dayOfWeek.slice(0, 3)} ${item.startTime}`).join(', ') || 'No schedule';
  }

  protected trackByBatch(_index: number, batch: { id: string }): string {
    return batch.id;
  }

  private load(): void {
    const courseId = this.route.snapshot.paramMap.get('courseId');
    if (!courseId) {
      this.error.set('Course id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getCourse(courseId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (course) => {
          this.course.set(course);
          this.form.reset({ courseName: course.courseName });
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }
}
