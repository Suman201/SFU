import { Injectable, effect, inject, signal } from '@angular/core';
import { AdminApiService } from './admin-api.service';
import { AuthService } from './auth.service';

export interface AdminLookupOption {
  id: string;
  label: string;
  sublabel?: string;
}

@Injectable({ providedIn: 'root' })
export class AdminLookupService {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AuthService);
  private scope = this.currentScope();
  private generation = 0;
  private readonly loaded = new Set<string>();
  readonly courses = signal<AdminLookupOption[]>([]);
  readonly teachers = signal<AdminLookupOption[]>([]);
  readonly students = signal<AdminLookupOption[]>([]);
  readonly batches = signal<AdminLookupOption[]>([]);

  constructor() {
    effect(() => this.syncScope());
  }

  private currentScope(): string {
    const user = this.auth.user();
    return JSON.stringify([user?.id, user?.roles, user?.permissions]);
  }

  private syncScope(): void {
    const scope = this.currentScope();
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation++;
    this.loaded.clear();
    this.courses.set([]);
    this.teachers.set([]);
    this.students.set([]);
    this.batches.set([]);
  }

  private begin(key: string, permission: string): number | null {
    this.syncScope();
    if (!this.auth.can(permission) || this.loaded.has(key)) return null;
    this.loaded.add(key);
    return this.generation;
  }

  private receive(generation: number, apply: () => void): void {
    this.syncScope();
    if (generation === this.generation) apply();
  }

  loadCourses(): void {
    const generation = this.begin('courses', 'admin:teaching:read');
    if (generation === null) return;
    this.api.listCourses({ limit: 50, sort: 'name_asc' }).subscribe({
      next: (response) =>
        this.receive(generation, () =>
          this.courses.set(
            response.items.map((course) => ({
              id: course.courseId,
              label: course.courseName,
              sublabel: course.status,
            })),
          ),
        ),
      error: () =>
        this.receive(generation, () => this.loaded.delete('courses')),
    });
  }

  loadTeachers(): void {
    this.loadUsers('teachers', 'teacher');
  }
  loadStudents(): void {
    this.loadUsers('students', 'student');
  }

  private loadUsers(
    key: 'teachers' | 'students',
    role: 'teacher' | 'student',
  ): void {
    const generation = this.begin(key, 'admin:users:read');
    if (generation === null) return;
    this.api
      .listUsers({ role, status: 'active', limit: 50, sort: 'name_asc' })
      .subscribe({
        next: (response) =>
          this.receive(generation, () =>
            this[key].set(
              response.items.map((user) => ({
                id: user.id,
                label: user.displayName || user.name,
                sublabel: user.email,
              })),
            ),
          ),
        error: () => this.receive(generation, () => this.loaded.delete(key)),
      });
  }

  loadBatches(): void {
    const generation = this.begin('batches', 'admin:teaching:read');
    if (generation === null) return;
    this.api
      .listBatches({ status: 'ACTIVE', limit: 50, sort: 'updated_desc' })
      .subscribe({
        next: (response) =>
          this.receive(generation, () =>
            this.batches.set(
              response.items.map((batch) => ({
                id: batch.id,
                label: batch.name,
                sublabel: [
                  batch.courseName || batch.courseId,
                  batch.teacherName || batch.teacherEmail,
                ]
                  .filter(Boolean)
                  .join(' - '),
              })),
            ),
          ),
        error: () =>
          this.receive(generation, () => this.loaded.delete('batches')),
      });
  }

  loadCourseTeacherBatchLookups(): void {
    this.loadCourses();
    this.loadTeachers();
    this.loadBatches();
  }
}
