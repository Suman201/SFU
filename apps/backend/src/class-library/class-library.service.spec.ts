import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ClassLibraryService } from './class-library.service';

describe('ClassLibraryService', () => {
  const teacher: AuthenticatedUser = {
    sub: 'teacher-1',
    email: 'teacher@example.test',
    roles: ['TEACHER'],
    permissions: [],
    tokenId: 'token-teacher'
  };
  const otherTeacher: AuthenticatedUser = {
    sub: 'teacher-2',
    email: 'teacher2@example.test',
    roles: ['TEACHER'],
    permissions: [],
    tokenId: 'token-teacher-2'
  };
  const student: AuthenticatedUser = {
    sub: 'student-1',
    email: 'student@example.test',
    roles: ['STUDENT'],
    permissions: [],
    tokenId: 'token-student'
  };
  const admin: AuthenticatedUser = {
    sub: 'admin-1',
    email: 'admin@example.test',
    roles: ['ADMIN'],
    permissions: [],
    tokenId: 'token-admin'
  };

  it('lets students search only authorized published class artifacts without private Q&A bodies', async () => {
    const { service, studentEnrollments } = createService();
    studentEnrollments.listStudentClassHistoryBatchIds.mockResolvedValue(['batch-1']);

    const response = await service.search({ q: 'limits', limit: 50 }, student);

    expect(response.items.some((item: { batchId?: string }) => item.batchId === 'batch-2')).toBe(false);
    expect(response.items.some((item: { id?: string }) => item.id === 'material:material-private')).toBe(false);
    expect(response.items.some((item: { id?: string }) => item.id === 'material:material-public')).toBe(true);
    expect(response.items.some((item: { id?: string }) => item.id === 'whiteboard:session-1')).toBe(true);
    expect(JSON.stringify(response)).not.toContain('private answer body');
    expect(JSON.stringify(response)).not.toContain('storage/key');
    expect(JSON.stringify(response)).not.toContain('/tmp/material.pdf');
  });

  it('lets teachers search owned artifacts and blocks non-owned teacher discovery through empty results', async () => {
    const owned = await createService().service.search({ q: 'private', artifactType: 'material' }, teacher);
    expect(owned.items.map((item: { id?: string }) => item.id)).toContain('material:material-private');

    const nonOwner = await createService().service.search({ q: 'limits' }, otherTeacher);
    expect(nonOwner.items).toEqual([]);
  });

  it('lets admins search across batches and filters by type/status/date metadata', async () => {
    const { service } = createService();

    const all = await service.search({ q: 'limits', limit: 50 }, admin, { adminOnly: true });
    expect(all.items.some((item: { batchId?: string }) => item.batchId === 'batch-2')).toBe(true);

    const recordings = await service.search({ artifactType: 'recording', status: 'stopped' }, admin, { adminOnly: true });
    expect(recordings.items.length).toBe(1);
    expect(recordings.items[0]?.artifactType).toBe('recording');

    const dated = await service.search({ dateFrom: '2026-06-23', dateTo: '2026-06-24' }, admin, { adminOnly: true });
    expect(dated.items.every((item: { batchId?: string }) => item.batchId === 'batch-2')).toBe(true);
  });

  it('rejects admin alias search for non-admin users', async () => {
    let thrown: unknown;
    try {
      await createService().service.search({}, teacher, { adminOnly: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  function createService() {
    const batches = model([
      doc({
        id: 'batch-1',
        _id: 'batch-1',
        name: 'Calculus 101',
        courseId: 'course-1',
        courseName: 'Calculus',
        teacherId: 'teacher-1',
        updatedAt: new Date('2026-06-22T11:00:00.000Z')
      }),
      doc({
        id: 'batch-2',
        _id: 'batch-2',
        name: 'Physics 101',
        courseId: 'course-2',
        courseName: 'Physics',
        teacherId: 'teacher-3',
        updatedAt: new Date('2026-06-23T11:00:00.000Z')
      })
    ]);
    const classSessions = model([
      doc({
        id: 'session-1',
        _id: 'session-1',
        batchId: 'batch-1',
        teacherId: 'teacher-1',
        title: 'Limits and continuity',
        sessionNumber: 3,
        status: 'completed',
        scheduledAt: new Date('2026-06-22T10:00:00.000Z'),
        completedAt: new Date('2026-06-22T11:00:00.000Z'),
        durationMinutes: 60,
        createdAt: new Date('2026-06-22T09:50:00.000Z'),
        updatedAt: new Date('2026-06-22T11:00:00.000Z')
      }),
      doc({
        id: 'session-2',
        _id: 'session-2',
        batchId: 'batch-2',
        teacherId: 'teacher-3',
        title: 'Motion limits',
        sessionNumber: 1,
        status: 'completed',
        scheduledAt: new Date('2026-06-23T10:00:00.000Z'),
        completedAt: new Date('2026-06-23T11:00:00.000Z'),
        durationMinutes: 60,
        createdAt: new Date('2026-06-23T09:50:00.000Z'),
        updatedAt: new Date('2026-06-23T11:00:00.000Z')
      })
    ]);
    const materials = model([
      doc({
        materialId: 'material-public',
        sessionId: 'session-1',
        batchId: 'batch-1',
        title: 'Limits worksheet',
        description: 'Practice limits',
        kind: 'pdf',
        source: 'upload',
        fileName: 'limits.pdf',
        storageKey: 'storage/key',
        path: '/tmp/material.pdf',
        shared: true,
        uploadedByUserId: 'teacher-1',
        createdAt: new Date('2026-06-22T11:03:00.000Z'),
        updatedAt: new Date('2026-06-22T11:03:00.000Z')
      }),
      doc({
        materialId: 'material-private',
        sessionId: 'session-1',
        batchId: 'batch-1',
        title: 'Private limits solution',
        description: 'Teacher-only private solution',
        kind: 'document',
        source: 'upload',
        shared: false,
        uploadedByUserId: 'teacher-1',
        createdAt: new Date('2026-06-22T11:04:00.000Z'),
        updatedAt: new Date('2026-06-22T11:04:00.000Z')
      })
    ]);
    const recordings = model([
      doc({
        id: 'recording-1',
        recordingId: 'recording-1',
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        scope: 'screen',
        status: 'stopped',
        publishedAt: new Date('2026-06-22T11:10:00.000Z'),
        storageDriver: 'local',
        storageKey: 'recording/key',
        startedAt: new Date('2026-06-22T10:00:00.000Z'),
        createdAt: new Date('2026-06-22T10:00:00.000Z'),
        updatedAt: new Date('2026-06-22T11:10:00.000Z')
      })
    ]);
    const whiteboards = model([
      doc({
        sessionId: 'session-1',
        batchId: 'batch-1',
        whiteboardChannelId: 'whiteboard-1',
        snapshotVersion: 2,
        pageCount: 1,
        elementCount: 8,
        pages: [{ title: 'Limits notes', tags: ['limits'], pageId: 'p1', order: 0, elementCount: 8 }],
        publishedAt: new Date('2026-06-22T11:05:00.000Z'),
        createdAt: new Date('2026-06-22T10:00:00.000Z'),
        updatedAt: new Date('2026-06-22T11:05:00.000Z')
      })
    ]);
    const assignments = model([
      doc({
        assignmentId: 'assignment-1',
        batchId: 'batch-1',
        sessionId: 'session-1',
        teacherId: 'teacher-1',
        title: 'Limits homework',
        instructions: 'Solve limit problems.',
        status: 'published',
        createdAt: new Date('2026-06-22T11:08:00.000Z'),
        updatedAt: new Date('2026-06-22T11:08:00.000Z')
      })
    ]);
    const chatMessages = model([
      doc({
        id: 'broadcast-1',
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        senderId: 'teacher-1',
        senderName: 'Ada Teacher',
        senderRole: 'teacher',
        scope: 'broadcast',
        context: 'post_class',
        message: 'Review limits before homework.',
        createdAt: new Date('2026-06-22T11:06:00.000Z'),
        updatedAt: new Date('2026-06-22T11:06:00.000Z')
      }),
      doc({
        id: 'private-1',
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        senderId: 'student-2',
        senderName: 'Student Two',
        senderRole: 'student',
        recipientId: 'teacher-1',
        scope: 'private',
        context: 'post_class',
        message: 'private answer body',
        createdAt: new Date('2026-06-22T11:07:00.000Z'),
        updatedAt: new Date('2026-06-22T11:07:00.000Z')
      })
    ]);
    const qnaStates = model([
      doc({
        sessionId: 'session-1',
        batchId: 'batch-1',
        teacherId: 'teacher-1',
        studentId: 'student-1',
        threadKey: 'thread-1',
        important: true,
        answered: false,
        followUp: false,
        createdAt: new Date('2026-06-22T11:07:00.000Z'),
        updatedAt: new Date('2026-06-22T11:07:00.000Z')
      })
    ]);
    const studentEnrollments = {
      listStudentClassHistoryBatchIds: jest.fn()
    };
    const service = new ClassLibraryService(
      batches as never,
      classSessions as never,
      materials as never,
      recordings as never,
      whiteboards as never,
      assignments as never,
      chatMessages as never,
      qnaStates as never,
      studentEnrollments as never
    );
    return { service, studentEnrollments };
  }

  function model(items: Record<string, unknown>[]) {
    return {
      find: jest.fn((filter: Record<string, unknown>) => query(items.filter((item) => matchesFilter(item, filter))))
    };
  }

  function query(items: Record<string, unknown>[]) {
    const chain: { sort: jest.Mock; limit: jest.Mock; exec: jest.Mock } = {
      sort: jest.fn(),
      limit: jest.fn(),
      exec: jest.fn(async () => items)
    };
    chain.sort.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    return chain;
  }

  function doc<T extends Record<string, unknown>>(value: T): T {
    return value;
  }

  function matchesFilter(item: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, expected]) => {
      if (key === '$or') {
        return Array.isArray(expected) && expected.some((entry) => matchesFilter(item, entry as Record<string, unknown>));
      }
      const actual = item[key];
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        const condition = expected as Record<string, unknown>;
        if ('$in' in condition) {
          return Array.isArray(condition.$in) && condition.$in.includes(actual as never);
        }
        if ('$exists' in condition) {
          return condition.$exists ? actual !== undefined : actual === undefined;
        }
      }
      return actual === expected;
    });
  }
});
