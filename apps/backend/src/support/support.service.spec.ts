import { ForbiddenException } from '@nestjs/common';
import { SupportService } from './support.service';

describe('SupportService', () => {
  it('lets an enrolled student create a support request for their class session', async () => {
    const { service, supportRequests, enrollments } = createService();
    supportRequests.create.mockImplementation(async (payload: Record<string, unknown>) => supportDoc(payload));

    const result = await service.createStudentRequest(studentUser(), {
      issueType: 'audio_video',
      subject: 'Microphone failed',
      message: 'My microphone stopped working during class.',
      batchId: 'batch-1',
      sessionId: 'session-1',
      diagnostics: { route: '/class-session/student?token=secret', userAgent: 'Browser 1' }
    });

    expect(enrollments.isStudentHistoricallyEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
    const persisted = supportRequests.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persisted.studentId).toBe('student-1');
    expect(persisted.batchId).toBe('batch-1');
    expect(persisted.sessionId).toBe('session-1');
    expect(persisted.roomId).toBe('room-1');
    expect(persisted.issueType).toBe('audio_video');
    expect(persisted.subject).toBe('Microphone failed');
    expect(result.requestId).toBe('request-1');
    expect(result.diagnostics?.route).toContain('token=[redacted]');
  });

  it('rejects support requests for guessed sessions when the student is not enrolled', async () => {
    const { service, enrollments } = createService();
    enrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.createStudentRequest(studentUser(), {
        issueType: 'access',
        subject: 'Cannot join',
        message: 'I found this session id but cannot join.',
        sessionId: 'session-1'
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ForbiddenException).toBe(true);
  });

  it('lets students read only their own support requests', async () => {
    const { service, supportRequests } = createService();
    supportRequests.findOne.mockReturnValue(query(supportDoc({ requestId: 'request-2', studentId: 'student-2' })));

    let thrown: unknown;
    try {
      await service.getStudentRequest(studentUser(), 'request-2');
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ForbiddenException).toBe(true);
  });

  it('lets admins update status and add a student-visible response', async () => {
    const { service, supportRequests } = createService();
    const doc = supportDoc({ requestId: 'request-1', status: 'open' });
    supportRequests.findOne.mockReturnValue(query(doc));

    const result = await service.updateAdminRequest(
      { sub: 'admin-1', email: 'admin@example.test', roles: ['ADMIN'], permissions: [], tokenId: 'token-1' },
      'request-1',
      { status: 'resolved', response: 'We fixed the recording access.' }
    );

    expect(doc.save).toHaveBeenCalled();
    expect(result.status).toBe('resolved');
    expect(result.comments.length).toBe(1);
    expect(result.comments[0]?.visibleToStudent).toBe(true);
  });
});

function createService() {
  const supportRequests = {
    create: jest.fn(),
    findOne: jest.fn().mockReturnValue(query(supportDoc({}))),
    find: jest.fn().mockReturnValue(chain([])),
    countDocuments: jest.fn().mockReturnValue(query(0))
  };
  const batches = {
    findOne: jest.fn().mockReturnValue(query(batchDoc()))
  };
  const classSessions = {
    findById: jest.fn().mockReturnValue(query(classSessionDoc()))
  };
  const recordings = {
    findOne: jest.fn().mockReturnValue(query(null))
  };
  const users = {
    findById: jest.fn().mockImplementation((id: string) =>
      query({
        id,
        displayName: id === 'admin-1' ? 'Admin User' : 'Student One',
        email: id === 'admin-1' ? 'admin@example.test' : 'student@example.test'
      })
    )
  };
  const enrollments = {
    isStudentHistoricallyEnrolledInBatch: jest.fn().mockResolvedValue(true)
  };
  const activity = { record: jest.fn() };
  const auditLogs = { record: jest.fn() };
  return {
    service: new SupportService(
      supportRequests as any,
      batches as any,
      classSessions as any,
      recordings as any,
      users as any,
      enrollments as any,
      activity as any,
      auditLogs as any
    ),
    supportRequests,
    enrollments
  };
}

function studentUser() {
  return { sub: 'student-1', email: 'student@example.test', roles: ['STUDENT'], permissions: [], tokenId: 'token-1' };
}

function batchDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    _id: 'batch-1',
    name: 'Algebra Batch',
    teacherId: 'teacher-1',
    ...overrides
  };
}

function classSessionDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    _id: 'session-1',
    batchId: 'batch-1',
    teacherId: 'teacher-1',
    title: 'Linear equations',
    roomId: 'room-1',
    ...overrides
  };
}

function supportDoc(overrides: Record<string, unknown>) {
  return {
    id: 'mongo-request-1',
    requestId: 'request-1',
    studentId: 'student-1',
    studentName: 'Student One',
    studentEmail: 'student@example.test',
    batchId: 'batch-1',
    batchName: 'Algebra Batch',
    teacherId: 'teacher-1',
    sessionId: 'session-1',
    sessionTitle: 'Linear equations',
    roomId: 'room-1',
    issueType: 'audio_video',
    status: 'open',
    subject: 'Microphone failed',
    message: 'My microphone stopped working.',
    diagnostics: undefined,
    comments: [],
    createdAt: new Date('2026-07-08T10:00:00.000Z'),
    updatedAt: new Date('2026-07-08T10:00:00.000Z'),
    save: jest.fn(async () => undefined),
    ...overrides
  };
}

function query<T>(value: T) {
  return { exec: jest.fn(async () => value) };
}

function chain<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn(async () => value)
  };
}
