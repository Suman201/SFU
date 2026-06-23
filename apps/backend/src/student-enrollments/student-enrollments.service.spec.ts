import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StudentEnrollmentsService } from './student-enrollments.service';

describe('StudentEnrollmentsService', () => {
  it('checks active enrollment using the dedicated student_enrollments access filter', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValue({ _id: 'enrollment-1' });

    const enrolled = await service.isStudentEnrolledInBatch('student-1', 'batch-1');
    expect(enrolled).toBe(true);
    expect(enrollments.exists).toHaveBeenCalledWith({
      studentId: 'student-1',
      batchId: 'batch-1',
      status: 'active',
      deletedAt: { $exists: false }
    });
  });

  it('denies access when the student has no active enrollment', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.assertStudentEnrolledInBatch('student-2', 'batch-1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('prevents duplicate active enrollments for the same student and batch', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValue({ _id: 'existing-enrollment' });

    let thrown: unknown;
    try {
      await service.enrollStudent({ studentId: 'student-1', batchId: 'batch-1', actorUserId: 'admin-1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
  });

  it('lets a student self-enroll in an eligible batch', async () => {
    const { service, enrollments, batches, schedules, users } = createService();
    enrollments.exists.mockResolvedValueOnce(null);
    enrollments.countDocuments.mockReturnValueOnce(queryResult(0));
    enrollments.find.mockReturnValueOnce(queryResult([enrollmentDoc()]));
    batches.find.mockReturnValueOnce(queryResult([batchDoc()]));
    schedules.find.mockReturnValueOnce({ sort: jest.fn(() => queryResult([{ batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' }])) });
    enrollments.find.mockReturnValueOnce({
      select: jest.fn(() => queryResult([{ batchId: 'batch-1' }]))
    });
    users.find.mockReturnValueOnce(queryResult([{ id: 'teacher-1', _id: 'teacher-1', displayName: 'Teacher One', name: 'Teacher One' }]));

    const result = await service.selfEnrollStudent(authUser('student-1', ['STUDENT']), 'batch-1');

    expect(result.id).toBe('batch-1');
    expect(result.enrollmentStatus).toBe('active');
    const payload = enrollments.create.mock.calls[0]?.[0];
    expect(payload.studentId).toBe('student-1');
    expect(payload.batchId).toBe('batch-1');
    expect(payload.status).toBe('active');
    expect(payload.createdBy).toBe('student-1');
    expect(payload.updatedBy).toBe('student-1');
  });

  it('rejects duplicate active self-enrollment', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValueOnce({ _id: 'existing-enrollment' });

    let thrown: unknown;
    try {
      await service.selfEnrollStudent(authUser('student-1', ['STUDENT']), 'batch-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('rejects self-enrollment when a batch is full', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValueOnce(null);
    enrollments.countDocuments.mockReturnValueOnce(queryResult(30));

    let thrown: unknown;
    try {
      await service.selfEnrollStudent(authUser('student-1', ['STUDENT']), 'batch-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('rejects self-enrollment for non-active batches', async () => {
    const { service, batches } = createService();
    batches.findOne.mockReturnValueOnce(queryResult(batchDoc({ status: 'INACTIVE' })));

    let thrown: unknown;
    try {
      await service.selfEnrollStudent(authUser('student-1', ['STUDENT']), 'batch-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('rejects self-enrollment for non-student callers', async () => {
    const { service, enrollments } = createService();

    let thrown: unknown;
    try {
      await service.selfEnrollStudent(authUser('teacher-1', ['TEACHER']), 'batch-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('lets a student cancel only their own active batch enrollment', async () => {
    const { service, enrollments } = createService();
    const activeEnrollment = enrollmentDoc();
    const cancelledEnrollment = enrollmentDoc({ status: 'cancelled', cancelledAt: new Date('2026-01-03T00:00:00.000Z') });
    enrollments.findOne.mockReturnValueOnce(queryResult(activeEnrollment)).mockReturnValueOnce(queryResult(activeEnrollment));
    enrollments.findOneAndUpdate.mockReturnValueOnce(queryResult(cancelledEnrollment));

    const result = await service.selfCancelStudentEnrollment(authUser('student-1', ['STUDENT']), 'batch-1');

    expect(result.id).toBe('enrollment-1');
    expect(result.status).toBe('cancelled');
    expect(enrollments.findOne.mock.calls[0]?.[0]).toEqual({
      studentId: 'student-1',
      batchId: 'batch-1',
      status: 'active',
      deletedAt: { $exists: false }
    });
    const updateCall = enrollments.findOneAndUpdate.mock.calls[0];
    expect(updateCall?.[0]).toEqual({ _id: 'enrollment-1', deletedAt: { $exists: false } });
    expect(updateCall?.[1].$set.status).toBe('cancelled');
    expect(updateCall?.[1].$set.updatedBy).toBe('student-1');
    expect(updateCall?.[2]).toEqual({ new: true });
  });

  it('does not let a student cancel another student enrollment', async () => {
    const { service, enrollments } = createService();
    enrollments.findOne.mockReturnValueOnce(queryResult(null));

    let thrown: unknown;
    try {
      await service.selfCancelStudentEnrollment(authUser('student-2', ['STUDENT']), 'batch-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(enrollments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not let soft-deleted enrollments grant access', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValue(null);

    const enrolled = await service.isStudentEnrolledInBatch('student-1', 'batch-1');
    expect(enrolled).toBe(false);
    expect(enrollments.exists.mock.calls[0]?.[0]).toEqual({
      studentId: 'student-1',
      batchId: 'batch-1',
      status: 'active',
      deletedAt: { $exists: false }
    });
  });

  it('returns only enrolled student batches for the student dashboard', async () => {
    const { service, enrollments, batches, schedules, users } = createService();
    enrollments.find.mockReturnValueOnce(queryResult([enrollmentDoc()]));
    batches.find.mockReturnValueOnce(queryResult([batchDoc()]));
    schedules.find.mockReturnValueOnce({ sort: jest.fn(() => queryResult([{ batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' }])) });
    enrollments.find.mockReturnValueOnce({
      select: jest.fn(() => queryResult([{ batchId: 'batch-1' }]))
    });
    users.find.mockReturnValueOnce(queryResult([{ id: 'teacher-1', _id: 'teacher-1', displayName: 'Teacher One', name: 'Teacher One' }]));

    const results = await service.listStudentBatches('student-1');

    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe('batch-1');
    expect(results[0]?.teacherName).toBe('Teacher One');
    expect(enrollments.find.mock.calls[0]?.[0]).toEqual({
      studentId: 'student-1',
      deletedAt: { $exists: false },
      status: 'active'
    });
  });

  it('lists admin enrollments with access impact and summary counts', async () => {
    const { service, enrollments } = createService();
    const suspended = enrollmentDoc({
      id: 'enrollment-2',
      _id: 'enrollment-2',
      studentId: 'student-2',
      studentName: 'Student Two',
      studentEmail: 'student.two@example.test',
      status: 'suspended',
      suspendedAt: new Date('2026-01-04T00:00:00.000Z')
    });
    enrollments.find.mockReturnValueOnce(paginatedQueryResult([enrollmentDoc(), suspended]));
    enrollments.countDocuments
      .mockReturnValueOnce(queryResult(2))
      .mockReturnValueOnce(queryResult(2))
      .mockReturnValueOnce(queryResult(1))
      .mockReturnValueOnce(queryResult(1))
      .mockReturnValueOnce(queryResult(1));

    const result = await service.listAdminEnrollments({ status: 'all', search: 'student', page: 1, limit: 25 }, authUser('admin-1', ['ADMIN']));

    expect(result.total).toBe(2);
    expect(result.summary).toEqual({
      totalEnrollments: 2,
      activeEnrollments: 1,
      suspendedEnrollments: 1,
      recentlyAdded: 1,
      lowEnrollmentBatches: 0
    });
    expect(result.items[0]?.access.canAccessClassSessions).toBe(true);
    expect(result.items[1]?.access.canAccessClassSessions).toBe(false);
    const filter = enrollments.find.mock.calls[0]?.[0] as { deletedAt?: unknown; $or?: unknown[] };
    expect(filter.deletedAt).toEqual({ $exists: false });
    expect(Array.isArray(filter.$or)).toBe(true);
  });

  it('rejects admin enrollment listing for non-admin users', async () => {
    const { service, enrollments } = createService();

    let thrown: unknown;
    try {
      await service.listAdminEnrollments({}, authUser('teacher-1', ['TEACHER']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(enrollments.find).not.toHaveBeenCalled();
  });

  it('creates admin enrollments through the existing enrollment path', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValueOnce(null);
    enrollments.findOne.mockReturnValueOnce(queryResult(enrollmentDoc()));

    const result = await service.createAdminEnrollment({ studentId: 'student-1', batchId: 'batch-1' }, authUser('admin-1', ['ADMIN']));

    expect(result.id).toBe('enrollment-1');
    expect(result.access.canAccessClassSessions).toBe(true);
    const payload = enrollments.create.mock.calls[0]?.[0];
    expect(payload.studentId).toBe('student-1');
    expect(payload.batchId).toBe('batch-1');
    expect(payload.status).toBe('active');
    expect(payload.createdBy).toBe('admin-1');
    expect(payload.updatedBy).toBe('admin-1');
  });

  it('rejects duplicate active admin enrollment creation', async () => {
    const { service, enrollments } = createService();
    enrollments.exists.mockResolvedValueOnce({ _id: 'existing-enrollment' });

    let thrown: unknown;
    try {
      await service.createAdminEnrollment({ studentId: 'student-1', batchId: 'batch-1' }, authUser('admin-1', ['ADMIN']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('suspends and reactivates admin enrollments, changing class-session access impact', async () => {
    const { service, enrollments } = createService();
    const active = enrollmentDoc();
    const suspended = enrollmentDoc({ status: 'suspended', suspendedAt: new Date('2026-01-04T00:00:00.000Z') });
    enrollments.findOne.mockReturnValueOnce(queryResult(active)).mockReturnValueOnce(queryResult(suspended));
    enrollments.findOneAndUpdate.mockReturnValueOnce(queryResult(suspended));

    const suspendedResult = await service.transitionAdminEnrollment('enrollment-1', 'suspended', authUser('admin-1', ['ADMIN']));

    expect(suspendedResult.status).toBe('suspended');
    expect(suspendedResult.access.canAccessClassSessions).toBe(false);
    expect(enrollments.findOneAndUpdate.mock.calls[0]?.[1].$set.status).toBe('suspended');

    enrollments.exists.mockResolvedValueOnce(null);
    enrollments.findOne.mockReturnValueOnce(queryResult(suspended)).mockReturnValueOnce(queryResult(active));
    enrollments.findOneAndUpdate.mockReturnValueOnce(queryResult(active));

    const activeResult = await service.transitionAdminEnrollment('enrollment-1', 'active', authUser('admin-1', ['ADMIN']));

    expect(activeResult.status).toBe('active');
    expect(activeResult.access.canAccessClassSessions).toBe(true);
    expect(enrollments.findOneAndUpdate.mock.calls[1]?.[1].$unset).toEqual({
      cancelledAt: '',
      suspendedAt: '',
      completedAt: ''
    });
  });
});

function createService(): {
  service: StudentEnrollmentsService;
  enrollments: {
    exists: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    countDocuments: jest.Mock;
  };
  batches: { findOne: jest.Mock; find: jest.Mock };
  schedules: { find: jest.Mock };
  users: { findOne: jest.Mock; find: jest.Mock };
} {
  const enrollments = {
    exists: jest.fn(async () => null),
    create: jest.fn(async (payload: Record<string, unknown>) => enrollmentDoc(payload)),
    find: jest.fn(() => queryResult([])),
    findOne: jest.fn(() => queryResult(null)),
    findOneAndUpdate: jest.fn(() => queryResult(null)),
    countDocuments: jest.fn(() => queryResult(0))
  };
  const batches = {
    findOne: jest.fn(() => queryResult(batchDoc())),
    find: jest.fn(() => queryResult([]))
  };
  const schedules = {
    find: jest.fn(() => ({ sort: jest.fn(() => queryResult([])) }))
  };
  const users = {
    findOne: jest.fn(() => queryResult(userDoc())),
    find: jest.fn(() => queryResult([]))
  };
  return {
    service: new StudentEnrollmentsService(enrollments as never, batches as never, schedules as never, users as never),
    enrollments,
    batches,
    schedules,
    users
  };
}

function enrollmentDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'enrollment-1',
    _id: 'enrollment-1',
    studentId: 'student-1',
    studentName: 'Student One',
    studentEmail: 'student.one@example.test',
    batchId: 'batch-1',
    batchName: 'Native SFU',
    teacherId: 'teacher-1',
    status: 'active',
    enrolledAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides
  };
}

function batchDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'batch-1',
    _id: 'batch-1',
    name: 'Native SFU',
    courseName: 'Realtime media',
    teacherId: 'teacher-1',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    maxCapacity: 30,
    status: 'ACTIVE',
    ...overrides
  };
}

function userDoc(): Record<string, unknown> {
  return {
    id: 'student-1',
    _id: 'student-1',
    displayName: 'Student One',
    email: 'student.one@example.test',
    roles: ['STUDENT']
  };
}

function authUser(sub: string, roles: string[]) {
  return {
    sub,
    email: `${sub}@example.test`,
    roles,
    permissions: [],
    tokenId: 'token-1'
  };
}

function queryResult<T>(value: T): { exec: jest.Mock<Promise<T>, []>; sort: jest.Mock; select: jest.Mock } {
  return {
    exec: jest.fn(async () => value),
    sort: jest.fn(() => queryResult(value)),
    select: jest.fn(() => queryResult(value))
  };
}

function paginatedQueryResult<T>(value: T): unknown {
  return {
    sort: jest.fn(() => ({
      skip: jest.fn(() => ({
        limit: jest.fn(() => ({ exec: jest.fn(async () => value) }))
      })),
      exec: jest.fn(async () => value)
    }))
  };
}
