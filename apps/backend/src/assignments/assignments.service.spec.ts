import { expect, it } from '@jest/globals';
import * as uploadScanner from '../common/security/upload-scanner';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';

describe('AssignmentsService', () => {
  it('lets a teacher create an assignment for an owned batch', async () => {
    const harness = createHarness();
    harness.batches.findOne.mockResolvedValue(batchDoc());
    harness.classSessions.findOne.mockResolvedValue(sessionDoc());
    harness.assignments.create.mockImplementation(async (payload) => assignmentDoc(payload));

    const result = await harness.service.createAssignment(teacherUser(), {
      batchId: 'batch-1',
      sessionId: 'session-1',
      title: 'Practice set',
      instructions: 'Solve the first ten problems.',
      dueAt: '2026-08-01T10:00:00.000Z',
      allowedSubmissionTypes: ['text', 'file'],
      links: [{ title: 'Worksheet', url: 'https://example.com/worksheet' }]
    });

    expect(result.title).toBe('Practice set');
    expect(result.teacherId).toBe('teacher-1');
    expect(result.sessionId).toBe('session-1');
    expect(result.allowedSubmissionTypes).toEqual(['text', 'file']);
    const payload = harness.assignments.create.mock.calls[0]?.[0];
    expect(payload.batchId).toBe('batch-1');
    expect(payload.teacherId).toBe('teacher-1');
    expect(payload.status).toBe('published');
  });

  it('blocks a teacher from creating an assignment for another teacher batch', async () => {
    const harness = createHarness();
    harness.batches.findOne.mockResolvedValue(batchDoc({ teacherId: 'teacher-2' }));

    let thrown: unknown;
    try {
      await harness.service.createAssignment(teacherUser(), {
        batchId: 'batch-1',
        title: 'Practice set',
        instructions: 'Solve the first ten problems.',
        allowedSubmissionTypes: ['text']
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('lists assignments only for active enrolled student batches', async () => {
    const harness = createHarness();
    const assignment = assignmentDoc({ assignmentId: 'assignment-1' });
    harness.enrollments.listStudentBatches.mockResolvedValue([{ id: 'batch-1', title: 'Batch 1' } as never]);
    harness.assignments.find.mockReturnValue(query([assignment]));
    harness.submissions.find.mockReturnValue(query([]));

    const result = await harness.service.listStudentAssignments(studentUser());

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.submission?.status).toBe('assigned');
    const filter = harness.assignments.find.mock.calls[0]?.[0];
    expect(filter.status).toBe('published');
    expect(filter.deletedAt).toEqual({ $exists: false });
  });

  it('blocks non-enrolled students from filtered batch assignment lists', async () => {
    const harness = createHarness();
    harness.enrollments.listStudentBatches.mockResolvedValue([{ id: 'batch-1', title: 'Batch 1' } as never]);

    let thrown: unknown;
    try {
      await harness.service.listStudentAssignments(studentUser(), { batchId: 'batch-2' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('lists historical homework only for an explicitly selected completed session', async () => {
    const h = createHarness();
    h.classSessions.findOne.mockResolvedValue(sessionDoc({ status: 'completed' }));
    h.enrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(true);
    h.assignments.find.mockReturnValue(query([assignmentDoc({ sessionId: 'session-1' })]));
    h.submissions.find.mockReturnValue(query([]));
    const result = await h.service.listStudentAssignments(studentUser(), { batchId: 'batch-1', sessionId: 'session-1' });
    expect(result.items).toHaveLength(1);
    expect(h.classSessions.findOne).toHaveBeenCalledWith({ _id: 'session-1', batchId: 'batch-1', status: 'completed' });
    expect(h.assignments.find).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', batchId: 'batch-1', status: 'published' }));
    await expect(h.service.listStudentAssignments(studentUser(), { batchId: 'batch-1' })).rejects.toBeInstanceOf(ForbiddenException);
    h.enrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(false);
    await expect(h.service.listStudentAssignments(studentUser(), { batchId: 'batch-1', sessionId: 'session-1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns historical assignment detail read-only without creating a submission and denies writes', async () => {
    const h = createHarness();
    h.assignments.findOne.mockResolvedValue(assignmentDoc({ sessionId: 'session-1' }));
    h.enrollments.isStudentEnrolledInBatch.mockResolvedValue(false);
    h.enrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(true);
    h.classSessions.findOne.mockResolvedValue(sessionDoc({ status: 'completed' }));
    h.submissions.findOne.mockResolvedValue(null);
    const result = await h.service.getAssignment(studentUser(), 'assignment-1');
    expect(result.readOnly).toBe(true);
    expect(result.submission?.studentId).toBe('student-1');
    expect(h.submissions.create).not.toHaveBeenCalled();
    await expect(h.service.submitAssignment(studentUser(), 'assignment-1', { text: 'denied' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.markViewed(studentUser(), 'assignment-1')).rejects.toBeInstanceOf(ForbiddenException);
    h.classSessions.findOne.mockResolvedValue(null);
    await expect(h.service.getAssignment(studentUser(), 'assignment-1')).rejects.toBeInstanceOf(ForbiddenException);
    h.classSessions.findOne.mockResolvedValue(sessionDoc({ status: 'completed' }));
    h.enrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(false);
    await expect(h.service.getAssignment(studentUser(), 'assignment-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['persistAssignmentFiles', 'persistSubmissionFiles'])('rejects a scanned assignment file batch before filesystem writes in %s', async method => {
    const h = createHarness(); const directory = await mkdtemp(join(tmpdir(), 'p1-assignment-scan-'));
    h.config.get.mockImplementation((key: string, fallback: unknown) => key === 'assignments.localPath' ? directory : fallback);
    const failure = new BadRequestException('detected');
    const scan = jest.spyOn(uploadScanner, 'assertClassroomUploadSafe').mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const files = ['clean.pdf', 'rejected.pdf'].map(originalname => ({ originalname, mimetype: 'application/pdf', size: 5, buffer: Buffer.from('hello') }));
    try {
      const args = method === 'persistSubmissionFiles' ? [assignmentDoc(), studentUser(), files] : [assignmentDoc(), files];
      await expect((h.service as any)[method](...args)).rejects.toBe(failure);
      expect(scan).toHaveBeenCalledTimes(2); expect(await readdir(directory)).toEqual([]);
    } finally { scan.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });

  it('marks a submission late when submitted after the due date', async () => {
    const harness = createHarness();
    const assignment = assignmentDoc({ dueAt: new Date('2026-01-01T00:00:00.000Z'), allowedSubmissionTypes: ['text'] });
    const submission = submissionDoc({ status: 'assigned' });
    harness.assignments.findOne.mockResolvedValue(assignment);
    harness.enrollments.isStudentEnrolledInBatch.mockResolvedValue(true);
    harness.submissions.findOne.mockResolvedValueOnce(null);
    harness.users.findById.mockReturnValue(query({ displayName: 'Student One', email: 'student@example.com' }));
    harness.submissions.create.mockResolvedValue(submission);

    const result = await harness.service.submitAssignment(studentUser(), 'assignment-1', { text: 'My answer' });

    expect(result.status).toBe('late');
    expect(submission.save).toHaveBeenCalled();
  });

  it('lets teacher complete a student submission with feedback', async () => {
    const harness = createHarness();
    const assignment = assignmentDoc();
    const submission = submissionDoc({ status: 'submitted' });
    harness.assignments.findOne.mockResolvedValue(assignment);
    harness.submissions.findOne.mockResolvedValue(submission);

    const result = await harness.service.reviewSubmission(teacherUser(), 'assignment-1', 'submission-1', {
      status: 'completed',
      feedback: 'Nice work.'
    });

    expect(result.status).toBe('completed');
    expect(result.feedback).toBe('Nice work.');
    expect((submission as { completedAt?: unknown }).completedAt).toBeInstanceOf(Date);
  });

  it('prevents a student from downloading another student submission file', async () => {
    const harness = createHarness();
    harness.assignments.findOne.mockResolvedValue(assignmentDoc());
    harness.submissions.findOne.mockResolvedValue(
      submissionDoc({
        studentId: 'student-2',
        files: [{ id: 'file-1', type: 'file', title: 'Answer', fileName: 'answer.pdf', mimeType: 'application/pdf', size: 10, path: '/tmp/answer.pdf' }]
      })
    );

    let thrown: unknown;
    try {
      await harness.service.downloadSubmissionAttachment(studentUser(), 'assignment-1', 'submission-1', 'file-1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });
});

function createHarness() {
  const assignments = { create: jest.fn(), find: jest.fn(), findOne: jest.fn() };
  const submissions = { create: jest.fn(), find: jest.fn(), findOne: jest.fn() };
  const batches = { findOne: jest.fn() };
  const classSessions = { findOne: jest.fn() };
  const materials = { find: jest.fn() };
  const users = { findById: jest.fn() };
  const enrollments = {
    isStudentEnrolledInBatch: jest.fn(async () => true),
    isStudentHistoricallyEnrolledInBatch: jest.fn(async () => false),
    listStudentBatches: jest.fn(async () => [])
  };
  const config = { get: jest.fn((_key: string, fallback: unknown) => fallback) };
  return {
    assignments,
    submissions,
    batches,
    classSessions,
    materials,
    users,
    enrollments,
    config,
    service: new AssignmentsService(
      assignments as never,
      submissions as never,
      batches as never,
      classSessions as never,
      materials as never,
      users as never,
      enrollments as never,
      config as never
    )
  };
}

function query<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn(async () => value)
  };
}

function teacherUser(overrides: Record<string, unknown> = {}) {
  return { sub: 'teacher-1', email: 'teacher@example.com', roles: ['TEACHER'], ...overrides } as never;
}

function studentUser(overrides: Record<string, unknown> = {}) {
  return { sub: 'student-1', email: 'student@example.com', roles: ['STUDENT'], ...overrides } as never;
}

function batchDoc(overrides: Record<string, unknown> = {}) {
  return { id: 'batch-1', name: 'Batch 1', teacherId: 'teacher-1', ...overrides };
}

function sessionDoc(overrides: Record<string, unknown> = {}) {
  return { id: 'session-1', title: 'Session 1', batchId: 'batch-1', ...overrides };
}

function assignmentDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assignment-doc-1',
    assignmentId: 'assignment-1',
    batchId: 'batch-1',
    batchName: 'Batch 1',
    teacherId: 'teacher-1',
    title: 'Practice set',
    instructions: 'Solve problems.',
    attachments: [],
    allowedSubmissionTypes: ['text'],
    status: 'published',
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-01T10:00:00.000Z'),
    save: jest.fn(async function save(this: unknown) {
      return this;
    }),
    ...overrides
  };
}

function submissionDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'submission-doc-1',
    submissionId: 'submission-1',
    assignmentId: 'assignment-1',
    batchId: 'batch-1',
    studentId: 'student-1',
    studentName: 'Student One',
    links: [],
    files: [],
    status: 'submitted',
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-01T10:00:00.000Z'),
    save: jest.fn(async function save(this: unknown) {
      return this;
    }),
    ...overrides
  };
}
