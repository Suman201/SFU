import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ProfilesService } from './profiles.service';

describe('ProfilesService', () => {
  it('loads and updates a teacher profile with public fields', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: false
    });
    const { service } = createHarness({ findUser: teacher });

    const updated = await service.updateMyProfile(authUser('teacher-1', ['TEACHER']), {
      displayName: 'Ada Lovelace',
      headline: 'Realtime systems mentor',
      languages: ['English', 'Bengali'],
      skills: ['WebRTC'],
      publicProfileEnabled: true
    });

    expect(teacher.save).toHaveBeenCalled();
    expect(teacher.displayName).toBe('Ada Lovelace');
    expect(teacher.headline).toBe('Realtime systems mentor');
    expect(teacher.publicProfileEnabled).toBe(true);
    expect(updated.displayName).toBe('Ada Lovelace');
    expect(updated.skills).toEqual(['WebRTC']);
    expect(updated.publicProfileEnabled).toBe(true);
  });

  it('rejects student attempts to update teacher-only fields', async () => {
    const student = userDoc({ id: 'student-1', roles: ['STUDENT'], displayName: 'Student One', email: 'student@example.test' });
    const { service } = createHarness({ findUser: student });

    let thrown: unknown;
    try {
      await service.updateMyProfile(authUser('student-1', ['STUDENT']), {
        displayName: 'Student One',
        publicProfileEnabled: true
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(student.save).not.toHaveBeenCalled();
  });

  it('allows students to update safe contact fields without changing enrollment data', async () => {
    const student = userDoc({ id: 'student-1', roles: ['STUDENT'], displayName: 'Student One', email: 'student@example.test' });
    const { service } = createHarness({ findUser: student });

    const updated = await service.updateMyProfile(authUser('student-1', ['STUDENT']), {
      displayName: 'Student One',
      phone: '+15551234567',
      location: 'Kolkata',
      learningGoals: ['WebRTC fundamentals']
    });

    expect(student.save).toHaveBeenCalled();
    expect(student.phone).toBe('+15551234567');
    expect(updated.phone).toBe('+15551234567');
    expect(updated.batches).toEqual([]);
  });

  it('persists normalized self settings with partial updates', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      settings: {
        theme: 'dark',
        locale: 'en-US',
        notifications: {
          email: true,
          classReminders: true,
          chatMessages: true,
          announcements: true,
          recordingReady: true
        },
        privacy: {
          showEmailOnPublicProfile: false,
          allowTeacherMessages: true
        }
      }
    });
    const { service } = createHarness({ findUser: teacher });

    const updated = await service.updateMySettings(authUser('teacher-1', ['TEACHER']), {
      theme: 'light',
      locale: 'en_GB',
      notifications: { chatMessages: false },
      privacy: { showEmailOnPublicProfile: true }
    });

    expect(teacher.save).toHaveBeenCalled();
    expect(updated.settings).toEqual({
      theme: 'light',
      locale: 'en-GB',
      notifications: {
        email: true,
        classReminders: true,
        chatMessages: false,
        announcements: true,
        recordingReady: true
      },
      privacy: {
        showEmailOnPublicProfile: true,
        allowTeacherMessages: true
      }
    });
  });

  it('returns a safe published teacher profile without private contact fields', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      headline: 'Realtime mentor',
      bio: 'Production classroom systems.',
      publicProfileEnabled: true,
      skills: ['WebRTC'],
      credentials: [{ title: 'Certified SFU Mentor', issuer: 'Native SFU', year: '2026' }]
    });
    const batch = batchDoc({ id: 'batch-1', teacherId: 'teacher-1', name: 'WebRTC Foundations' });
    const { service } = createHarness({ publicTeacher: teacher, batches: [batch] });

    const profile = await service.getPublicTeacherProfile('teacher-1');

    expect(profile.id).toBe('teacher-1');
    expect(profile.displayName).toBe('Ada Teacher');
    expect(profile.skills).toEqual(['WebRTC']);
    expect(profile.credentials[0]?.title).toBe('Certified SFU Mentor');
    expect(profile.batches[0]?.title).toBe('WebRTC Foundations');
    expect((profile as unknown as { email?: string }).email).toBeUndefined();
  });

  it('does not expose disabled, missing, or unpublished teacher profiles', async () => {
    const { service } = createHarness({ publicTeacher: null });

    let thrown: unknown;
    try {
      await service.getPublicTeacherProfile('teacher-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('rejects invalid profile media uploads', async () => {
    const user = userDoc({ id: 'teacher-1', roles: ['TEACHER'], displayName: 'Ada Teacher', email: 'ada@example.test' });
    const { service } = createHarness({ findUser: user });

    let thrown: unknown;
    try {
      await service.uploadProfileMedia(authUser('teacher-1', ['TEACHER']), 'avatarUrl', {
        originalname: 'avatar.svg',
        mimetype: 'image/svg+xml',
        size: 128,
        buffer: Buffer.from('<svg />')
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Only JPEG, PNG, GIF, and WebP profile images are allowed.');
  });

  function createHarness(options: {
    findUser?: Record<string, unknown> | null;
    publicTeacher?: Record<string, unknown> | null;
    batches?: Record<string, unknown>[];
  } = {}): { service: ProfilesService } {
    const users = {
      findOne: jest.fn((filter: Record<string, unknown>) => {
        if (filter.roles === 'TEACHER') {
          return queryResult(options.publicTeacher ?? null);
        }
        return queryResult(options.findUser ?? null);
      }),
      find: jest.fn(() => queryResult(options.publicTeacher ? [options.publicTeacher] : []))
    };
    const batches = {
      find: jest.fn(() => queryResult(options.batches ?? []))
    };
    const schedules = {
      find: jest.fn(() => queryResult([]))
    };
    const enrollments = {
      find: jest.fn(() => queryResult([]))
    };
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback)
    };

    return {
      service: new ProfilesService(users as never, batches as never, schedules as never, enrollments as never, config as never)
    };
  }

  function userDoc(values: Record<string, unknown>): Record<string, unknown> & { save: jest.Mock } {
    return {
      name: values.displayName,
      disabled: false,
      status: 'active',
      deletedAt: undefined,
      languages: [],
      skills: [],
      credentials: [],
      education: [],
      experience: [],
      socialLinks: [],
      learningGoals: [],
      interests: [],
      settings: {
        theme: 'system',
        locale: 'en-US',
        notifications: {
          email: true,
          classReminders: true,
          chatMessages: true,
          announcements: true,
          recordingReady: true
        },
        privacy: {
          showEmailOnPublicProfile: false,
          allowTeacherMessages: true
        }
      },
      publicProfileEnabled: false,
      ...values,
      save: jest.fn(async () => undefined)
    };
  }

  function batchDoc(values: Record<string, unknown>): Record<string, unknown> {
    return {
      courseName: 'Native SFU',
      status: 'ACTIVE',
      maxCapacity: 20,
      startDate: new Date('2026-06-24T00:00:00.000Z'),
      ...values
    };
  }

  function authUser(sub: string, roles: string[]): AuthenticatedUser {
    return {
      sub,
      email: `${sub}@example.test`,
      roles,
      permissions: [],
      tokenId: 'token-1'
    };
  }

  interface QueryResult<T> {
    exec: jest.Mock<Promise<T>, []>;
    sort: jest.Mock;
    select: jest.Mock;
  }

  function queryResult<T>(value: T): QueryResult<T> {
    const query: QueryResult<T> = {
      exec: jest.fn(async () => value),
      sort: jest.fn(() => query),
      select: jest.fn(() => query)
    };
    return query;
  }
});
