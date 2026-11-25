import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { AdminApiService } from './admin-api.service';
import { AuthService, type AuthUser } from './auth.service';
import { AdminLookupService } from './admin-lookup.service';

describe('permission-scoped admin lookups', () => {
  const user = signal<AuthUser | null>(null);
  let service: AdminLookupService;
  let api: jasmine.SpyObj<AdminApiService>;
  function account(id: string, permissions: string[]) {
    user.set({
      id,
      name: id,
      email: id + '@example.test',
      roles: ['ADMIN'],
      permissions,
    });
  }
  beforeEach(() => {
    user.set(null);
    api = jasmine.createSpyObj('AdminApiService', [
      'listUsers',
      'listCourses',
      'listBatches',
    ]);
    api.listUsers.and.returnValue(of({ items: [] } as any));
    api.listCourses.and.returnValue(of({ items: [] } as any));
    api.listBatches.and.returnValue(of({ items: [] } as any));
    TestBed.configureTestingModule({
      providers: [
        { provide: AdminApiService, useValue: api },
        {
          provide: AuthService,
          useValue: {
            user,
            can: (permission: string) =>
              user()?.permissions.includes(permission) ?? false,
          },
        },
      ],
    });
    service = TestBed.inject(AdminLookupService);
  });
  it('keeps accessible teaching filters without requesting a forbidden user directory', () => {
    account('teaching-reviewer', ['admin:teaching:read']);
    service.loadCourseTeacherBatchLookups();
    service.loadStudents();
    expect(api.listCourses).toHaveBeenCalled();
    expect(api.listBatches).toHaveBeenCalled();
    expect(api.listUsers).not.toHaveBeenCalled();
  });
  it('clears private options when permissions are revoked and reloads when access returns', () => {
    api.listUsers.and.returnValue(
      of({
        items: [{ id: 'teacher', name: 'Avery', email: 'avery@example.test' }],
      } as any),
    );
    account('staff', ['admin:users:read']);
    service.loadTeachers();
    expect(service.teachers().length).toBe(1);
    account('staff', []);
    TestBed.tick();
    expect(service.teachers()).toEqual([]);
    service.loadTeachers();
    expect(api.listUsers).toHaveBeenCalledTimes(1);
    account('staff', ['admin:users:read']);
    service.loadTeachers();
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });
  it('does not retain another account’s cached options or accept its late response', () => {
    const pending = new Subject<any>();
    api.listUsers.and.returnValue(pending);
    account('first-admin', ['admin:users:read']);
    service.loadTeachers();
    account('second-admin', ['admin:teaching:read']);
    TestBed.tick();
    pending.next({
      items: [
        {
          id: 'private-teacher',
          name: 'Private',
          email: 'private@example.test',
        },
      ],
    });
    expect(service.teachers()).toEqual([]);
    service.loadTeachers();
    expect(api.listUsers).toHaveBeenCalledTimes(1);
  });
});
