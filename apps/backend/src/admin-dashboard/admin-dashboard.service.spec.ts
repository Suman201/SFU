import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AdminDashboardService } from './admin-dashboard.service';

describe('AdminDashboardService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-24T08:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns an operational dashboard summary for admins', async () => {
    const { service, classSessions, recordings, enrollments, users, batches, attendanceSnapshots } = createHarness();

    const summary = await service.getSummary(admin());

    expect(summary.generatedAt).toBe('2026-06-24T08:30:00.000Z');
    expect(summary.todayStart).toBe('2026-06-24T00:00:00.000Z');
    expect(summary.todayEnd).toBe('2026-06-25T00:00:00.000Z');
    expect(summary.liveSessions).toBe(2);
    expect(summary.scheduledToday).toBe(5);
    expect(summary.completedToday).toBe(3);
    expect(summary.todayAttendanceRate).toBe(90);
    expect(summary.activeRecordings).toBe(1);
    expect(summary.failedRecordings).toBe(2);
    expect(summary.newEnrollmentsToday).toBe(4);
    expect(summary.pendingEnrollments).toBe(6);
    expect(summary.activeEnrollments).toBe(100);
    expect(summary.activeUsers).toBe(200);
    expect(summary.teachers).toBe(12);
    expect(summary.students).toBe(180);
    expect(summary.admins).toBe(8);
    expect(summary.activeCourses).toBe(2);
    expect(summary.activeBatches).toBe(15);
    expect(summary.liveSessionItems[0]?.sessionId).toBe('session-live-1');
    expect(summary.liveSessionItems[0]?.batchName).toBe('Batch One');
    expect(summary.liveSessionItems[0]?.teacherName).toBe('Ada Teacher');
    const issueLabels = summary.issues.map((issue: { label: string }) => issue.label);
    expect(issueLabels).toEqual([
      'Failed recordings need review',
      'Suspended enrollments',
      'Pending enrollments',
      'Disabled user accounts',
      'Cancelled batches in catalog',
      'Live sessions active now'
    ]);

    expect(classSessions.countDocuments).toHaveBeenCalledTimes(3);
    expect(recordings.countDocuments).toHaveBeenCalledTimes(2);
    expect(enrollments.countDocuments).toHaveBeenCalledTimes(4);
    expect(users.countDocuments).toHaveBeenCalledTimes(5);
    expect(batches.countDocuments).toHaveBeenCalledTimes(2);
    expect(attendanceSnapshots.aggregate).toHaveBeenCalled();
  });

  it('uses explicit UTC day bounds for today counts', async () => {
    const { service, classSessions, enrollments, attendanceSnapshots } = createHarness();

    await service.getSummary(admin());

    const scheduledFilter = classSessions.countDocuments.mock.calls[1]?.[0];
    expect(scheduledFilter.scheduledAt.$gte.toISOString()).toBe('2026-06-24T00:00:00.000Z');
    expect(scheduledFilter.scheduledAt.$lt.toISOString()).toBe('2026-06-25T00:00:00.000Z');

    const enrollmentFilter = enrollments.countDocuments.mock.calls[0]?.[0];
    expect(enrollmentFilter.createdAt.$gte.toISOString()).toBe('2026-06-24T00:00:00.000Z');
    expect(enrollmentFilter.createdAt.$lt.toISOString()).toBe('2026-06-25T00:00:00.000Z');

    const attendanceMatch = attendanceSnapshots.aggregate.mock.calls[0]?.[0]?.[0]?.$match;
    expect(attendanceMatch.createdAt.$gte.toISOString()).toBe('2026-06-24T00:00:00.000Z');
    expect(attendanceMatch.createdAt.$lt.toISOString()).toBe('2026-06-25T00:00:00.000Z');
  });

  it('rejects non-admin dashboard access', async () => {
    const { service, classSessions } = createHarness();

    let thrown: unknown;
    try {
      await service.getSummary(student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(classSessions.countDocuments).not.toHaveBeenCalled();
  });

  function createHarness(): {
    service: AdminDashboardService;
    classSessions: { countDocuments: jest.Mock; find: jest.Mock };
    attendanceSnapshots: { aggregate: jest.Mock };
    recordings: { countDocuments: jest.Mock };
    enrollments: { countDocuments: jest.Mock };
    users: { countDocuments: jest.Mock; find: jest.Mock };
    batches: { countDocuments: jest.Mock; find: jest.Mock; aggregate: jest.Mock };
  } {
    const classSessions = {
      countDocuments: jest.fn((filter: Record<string, unknown>) => {
        if (filter.status === 'live') return execResult(2);
        if (filter.status === 'completed') return execResult(3);
        return execResult(5);
      }),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          limit: jest.fn(() =>
            execResult([
              {
                id: 'session-live-1',
                title: 'Live Algebra',
                batchId: 'batch-1',
                teacherId: 'teacher-1',
                startedAt: new Date('2026-06-24T08:00:00.000Z'),
                roomId: 'room-1'
              }
            ])
          )
        }))
      }))
    };
    const attendanceSnapshots = {
      aggregate: jest.fn(() => execResult([{ _id: 'present', count: 9 }, { _id: 'absent', count: 1 }]))
    };
    const recordings = {
      countDocuments: jest.fn((filter: Record<string, unknown>) => execResult(filter.status === 'failed' ? 2 : 1))
    };
    const enrollments = {
      countDocuments: jest.fn((filter: Record<string, unknown>) => {
        if (filter.status === 'pending') return execResult(6);
        if (filter.status === 'active') return execResult(100);
        if (filter.status === 'suspended') return execResult(7);
        return execResult(4);
      })
    };
    const users = {
      countDocuments: jest.fn((filter: Record<string, unknown>) => {
        if (filter.disabled === true) return execResult(3);
        if (filter.roles === 'TEACHER') return execResult(12);
        if (filter.roles === 'STUDENT') return execResult(180);
        if (filter.roles) return execResult(8);
        return execResult(200);
      }),
      find: jest.fn(() =>
        execResult([
          {
            id: 'teacher-1',
            displayName: 'Ada Teacher'
          }
        ])
      )
    };
    const batches = {
      countDocuments: jest.fn((filter: Record<string, unknown>) => execResult(filter.status === 'CANCELLED' ? 2 : 15)),
      find: jest.fn(() =>
        execResult([
          {
            id: 'batch-1',
            name: 'Batch One'
          }
        ])
      ),
      aggregate: jest.fn(() => execResult([{ _id: 'course-1' }, { _id: 'course-2' }]))
    };

    return {
      service: new AdminDashboardService(
        classSessions as never,
        attendanceSnapshots as never,
        recordings as never,
        enrollments as never,
        users as never,
        batches as never
      ),
      classSessions,
      attendanceSnapshots,
      recordings,
      enrollments,
      users,
      batches
    };
  }

  function admin(): AuthenticatedUser {
    return {
      sub: 'admin-1',
      email: 'admin@example.test',
      roles: ['ADMIN'],
      permissions: [],
      tokenId: 'token-1'
    };
  }

  function student(): AuthenticatedUser {
    return {
      sub: 'student-1',
      email: 'student@example.test',
      roles: ['STUDENT'],
      permissions: [],
      tokenId: 'token-2'
    };
  }

  function execResult<T>(value: T): { exec: jest.Mock<Promise<T>, []> } {
    return { exec: jest.fn(async () => value) };
  }
});
