import { Injectable, inject, signal } from '@angular/core';
import { AdminApiService } from './admin-api.service';

export interface AdminLookupOption {
  id: string;
  label: string;
  sublabel?: string;
}

@Injectable({ providedIn: 'root' })
export class AdminLookupService {
  private readonly api = inject(AdminApiService);
  private coursesLoaded = false;
  private teachersLoaded = false;
  private studentsLoaded = false;
  private batchesLoaded = false;

  readonly courses = signal<AdminLookupOption[]>([]);
  readonly teachers = signal<AdminLookupOption[]>([]);
  readonly students = signal<AdminLookupOption[]>([]);
  readonly batches = signal<AdminLookupOption[]>([]);

  loadCourses(): void {
    if (this.coursesLoaded) {
      return;
    }
    this.coursesLoaded = true;
    this.api.listCourses({ limit: 50, sort: 'name_asc' }).subscribe({
      next: (response) =>
        this.courses.set(response.items.map((course) => ({ id: course.courseId, label: course.courseName, sublabel: course.status }))),
      error: () => {
        this.coursesLoaded = false;
      }
    });
  }

  loadTeachers(): void {
    if (this.teachersLoaded) {
      return;
    }
    this.teachersLoaded = true;
    this.api.listUsers({ role: 'teacher', status: 'active', limit: 50, sort: 'name_asc' }).subscribe({
      next: (response) =>
        this.teachers.set(response.items.map((user) => ({ id: user.id, label: user.displayName || user.name, sublabel: user.email }))),
      error: () => {
        this.teachersLoaded = false;
      }
    });
  }

  loadStudents(): void {
    if (this.studentsLoaded) {
      return;
    }
    this.studentsLoaded = true;
    this.api.listUsers({ role: 'student', status: 'active', limit: 50, sort: 'name_asc' }).subscribe({
      next: (response) =>
        this.students.set(response.items.map((user) => ({ id: user.id, label: user.displayName || user.name, sublabel: user.email }))),
      error: () => {
        this.studentsLoaded = false;
      }
    });
  }

  loadBatches(): void {
    if (this.batchesLoaded) {
      return;
    }
    this.batchesLoaded = true;
    this.api.listBatches({ status: 'ACTIVE', limit: 50, sort: 'updated_desc' }).subscribe({
      next: (response) =>
        this.batches.set(
          response.items.map((batch) => ({
            id: batch.id,
            label: batch.name,
            sublabel: [batch.courseName || batch.courseId, batch.teacherName || batch.teacherEmail].filter(Boolean).join(' - ')
          }))
        ),
      error: () => {
        this.batchesLoaded = false;
      }
    });
  }

  loadCourseTeacherBatchLookups(): void {
    this.loadCourses();
    this.loadTeachers();
    this.loadBatches();
  }
}
