import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { TeacherBatchesService } from './teacher-batches.service';

describe('TeacherBatchesService', () => {
  it('rejects duplicate weekdays in a batch schedule', async () => {
    const service = serviceWith({ batchExists: false });

    let thrown: unknown;
    try {
      await service.create('teacher-1', {
        name: 'Laravel Morning Batch 2026',
        year: 2026,
        maxCapacity: 30,
        schedule: [
          { dayOfWeek: 'MONDAY', startTime: '10:00' },
          { dayOfWeek: 'MONDAY', startTime: '14:00' }
        ]
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate batch name and year for the same teacher', async () => {
    const service = serviceWith({ batchExists: true });

    let thrown: unknown;
    try {
      await service.create('teacher-1', {
        name: 'Laravel Morning Batch 2026',
        year: 2026,
        maxCapacity: 30,
        schedule: [{ dayOfWeek: 'MONDAY', startTime: '10:00' }]
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
  });

  it('lists teacher batches with schedules and enrollment-backed roster', async () => {
    const service = serviceWith({
      batches: [
        {
          id: 'batch-1',
          name: 'Laravel Morning Batch 2026',
          courseName: 'Laravel',
          teacherId: 'teacher-1',
          year: 2026,
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: new Date(Date.UTC(2026, 11, 31)),
          maxCapacity: 30,
          status: 'ACTIVE',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z')
        }
      ],
      schedules: [
        { id: 'schedule-1', batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' },
        { id: 'schedule-2', batchId: 'batch-1', dayOfWeek: 'WEDNESDAY', startTime: '14:00' }
      ],
      roster: [
        {
          id: 'student-1',
          userId: 'student-1',
          enrollmentId: 'enrollment-1',
          displayName: 'Student One',
          email: 'student.one@example.test',
          status: 'active',
          joinedAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    });

    const results = await service.findAll('teacher-1');
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe('batch-1');
    expect(results[0]?.name).toBe('Laravel Morning Batch 2026');
    expect(results[0]?.enrolledCount).toBe(1);
    expect(results[0]?.maxCapacity).toBe(30);
    expect(results[0]?.students).toEqual([
      {
        id: 'student-1',
        displayName: 'Student One',
        email: 'student.one@example.test',
        attendanceRate: 0,
        joinedAt: '2026-01-02T00:00:00.000Z',
        status: 'active'
      }
    ]);
    expect(results[0]?.schedule).toEqual([
      { id: 'schedule-1', dayOfWeek: 'MONDAY', startTime: '10:00' },
      { id: 'schedule-2', dayOfWeek: 'WEDNESDAY', startTime: '14:00' }
    ]);
  });

  it('lists admin batches with pagination, schedules, teacher, and roster counts', async () => {
    const { service, batches } = harnessWith({
      batches: [batchDoc()],
      schedules: [{ id: 'schedule-1', batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' }],
      roster: [rosterDoc()]
    });

    const result = await service.listAdminBatches({ status: 'ACTIVE', sort: 'start_asc', page: 1, limit: 10 }, authUser('admin-1', ['ADMIN']));

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe('batch-1');
    expect(result.items[0]?.teacherName).toBe('Teacher One');
    expect(result.items[0]?.enrolledCount).toBe(1);
    expect(batches.find.mock.calls[0]?.[0]).toEqual({ deletedAt: { $exists: false }, status: 'ACTIVE' });
    expect(batches.find.mock.results[0]?.value.sort).toHaveBeenCalledWith({ startDate: 1, updatedAt: -1 });
  });

  it('rejects admin batch listing for non-admin users', async () => {
    const { service, batches } = harnessWith({});

    let thrown: unknown;
    try {
      await service.listAdminBatches({}, authUser('student-1', ['STUDENT']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(batches.find).not.toHaveBeenCalled();
  });

  it('validates teacher role before admin batch creation', async () => {
    const { service, users, batches } = harnessWith({});
    users.findOne.mockReturnValueOnce(queryResult(null));

    let thrown: unknown;
    try {
      await service.createAdminBatch(
        'course-1',
        {
          name: 'Batch One',
          teacherId: 'not-teacher',
          courseName: 'Realtime media',
          year: 2026,
          maxCapacity: 20,
          schedule: [{ dayOfWeek: 'MONDAY', startTime: '10:00' }]
        },
        authUser('admin-1', ['ADMIN'])
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('blocks admin capacity updates below active enrollment count', async () => {
    const { service, batches } = harnessWith({ batches: [batchDoc({ maxCapacity: 30 })], roster: [rosterDoc(), rosterDoc({ id: 'student-2', userId: 'student-2' })] });

    let thrown: unknown;
    try {
      await service.updateAdminBatch('batch-1', { maxCapacity: 1 }, authUser('admin-1', ['ADMIN']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(batches.updateOne).not.toHaveBeenCalled();
  });

  it('updates admin batch schedules without touching live or completed sessions', async () => {
    const { service, schedules, classSessions } = harnessWith({
      batches: [batchDoc()],
      schedules: [{ id: 'schedule-1', batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' }]
    });

    await service.updateAdminBatch(
      'batch-1',
      { schedule: [{ dayOfWeek: 'THURSDAY', startTime: '16:30' }] },
      authUser('admin-1', ['ADMIN'])
    );

    expect(classSessions.exists).toHaveBeenCalledWith({ batchId: 'batch-1', status: { $in: ['live', 'completed'] } });
    expect(schedules.deleteMany.mock.calls[0]?.[0]).toEqual({ batchId: 'batch-1' });
    expect(schedules.insertMany.mock.calls[0]?.[0]).toEqual([{ batchId: 'batch-1', dayOfWeek: 'THURSDAY', startTime: '16:30' }]);
  });

  it('rejects empty admin batch schedules', async () => {
    const { service, schedules } = harnessWith({ batches: [batchDoc()] });

    let thrown: unknown;
    try {
      await service.updateAdminBatch('batch-1', { schedule: [] }, authUser('admin-1', ['ADMIN']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(schedules.deleteMany).not.toHaveBeenCalled();
  });

  it('returns active enrolled roster and planned sessions for admin batch detail', async () => {
    const { service, studentEnrollments } = harnessWith({
      batches: [batchDoc()],
      schedules: [{ id: 'schedule-1', batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' }],
      roster: [rosterDoc()]
    });

    const detail = await service.getAdminBatch('batch-1', authUser('admin-1', ['ADMIN']));

    expect(detail.roster).toEqual([
      {
        id: 'student-1',
        enrollmentId: 'enrollment-1',
        userId: 'student-1',
        displayName: 'Student One',
        email: 'student.one@example.test',
        status: 'active',
        joinedAt: '2026-01-02T00:00:00.000Z'
      }
    ]);
    expect(detail.sessions.length).toBeGreaterThan(0);
    expect(studentEnrollments.listBatchRoster.mock.calls[0]?.[0]).toBe('batch-1');
    expect(studentEnrollments.listBatchRoster.mock.calls[0]?.[1]).toBeUndefined();
  });
});

function serviceWith(options: { batchExists?: boolean; batches?: unknown[]; schedules?: unknown[]; roster?: unknown[] }): TeacherBatchesService {
  return harnessWith(options).service;
}

function harnessWith(options: { batchExists?: boolean; batches?: unknown[]; schedules?: unknown[]; roster?: unknown[] }) {
  const batches = {
    exists: jest.fn().mockResolvedValue(options.batchExists ? { _id: 'existing' } : null),
    create: jest.fn(),
    find: jest.fn().mockReturnValue(queryChain(options.batches ?? [])),
    findOne: jest.fn().mockReturnValue(queryChain((options.batches ?? [batchDoc()])[0] ?? null)),
    findOneAndUpdate: jest.fn().mockReturnValue(queryChain((options.batches ?? [batchDoc()])[0] ?? null)),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockReturnValue(queryResult({ matchedCount: 1 })),
    countDocuments: jest.fn().mockReturnValue(queryResult((options.batches ?? []).length))
  };
  const schedules = {
    find: jest.fn().mockReturnValue(queryChain(options.schedules ?? [])),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    insertMany: jest.fn().mockResolvedValue(options.schedules ?? [])
  };
  const classSessions = {
    find: jest.fn().mockReturnValue(queryChain([])),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    exists: jest.fn().mockReturnValue(queryResult(null))
  };
  const users = {
    findOne: jest.fn().mockReturnValue(queryResult(teacherDoc())),
    find: jest.fn().mockReturnValue(queryChain([teacherDoc()]))
  };
  const connection = {
    startSession: jest.fn().mockResolvedValue({
      withTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
      endSession: jest.fn(async () => undefined)
    })
  };
  const studentEnrollments = {
    listBatchRoster: jest.fn(async (_batchId?: string, _options?: unknown) => options.roster ?? []),
    countActiveByBatch: jest.fn(async () => options.roster?.length ?? 0),
    activeCountByBatchIds: jest.fn(async (batchIds: string[]) => new Map(batchIds.map((id) => [id, options.roster?.length ?? 0])))
  };
  return {
    service: new TeacherBatchesService(batches as never, schedules as never, classSessions as never, users as never, connection as never, studentEnrollments as never),
    batches,
    schedules,
    classSessions,
    users,
    studentEnrollments
  };
}

function queryChain<T>(value: T) {
  const chain = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    session: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
    then: jest.fn((resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(value).then(resolve, reject))
  };
  chain.sort.mockImplementation((_sort?: unknown) => chain);
  chain.skip.mockImplementation((_skip?: number) => chain);
  chain.limit.mockImplementation((_limit?: number) => chain);
  chain.session.mockImplementation((_session?: unknown) => chain);
  return chain;
}

function queryResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value)
  };
}

function authUser(sub: string, roles: string[]): AuthenticatedUser {
  return {
    sub,
    email: `${sub}@example.test`,
    roles,
    permissions: [],
    tokenId: `${sub}-token`
  };
}

function batchDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'batch-1',
    _id: 'batch-1',
    name: 'Realtime Batch 2026',
    courseId: 'course-1',
    courseName: 'Realtime media',
    teacherId: 'teacher-1',
    year: 2026,
    startDate: new Date(Date.UTC(2026, 0, 1)),
    endDate: new Date(Date.UTC(2026, 11, 31)),
    maxCapacity: 30,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides
  };
}

function rosterDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'student-1',
    userId: 'student-1',
    enrollmentId: 'enrollment-1',
    displayName: 'Student One',
    email: 'student.one@example.test',
    status: 'active',
    joinedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  };
}

function teacherDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'teacher-1',
    _id: 'teacher-1',
    displayName: 'Teacher One',
    name: 'Teacher One',
    email: 'teacher.one@example.test',
    roles: ['TEACHER'],
    status: 'active',
    disabled: false,
    ...overrides
  };
}
