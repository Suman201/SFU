import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhiteboardMemorySnapshot } from '@native-sfu/contracts';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ClassSessionsService } from './class-sessions.service';

describe('ClassSessionsService', () => {
  const sessionId = 'batch-1-MONDAY-2026-06-22';
  const batch = {
    id: 'batch-1',
    _id: 'batch-1',
    name: 'Native SFU',
    teacherId: 'teacher-1',
    startDate: new Date('2026-06-22T00:00:00.000Z'),
    endDate: new Date('2026-06-22T23:59:59.000Z'),
    status: 'ACTIVE'
  };
  const schedules = [{ batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' }];
  const teacher: AuthenticatedUser = {
    sub: 'teacher-1',
    email: 'teacher@example.test',
    roles: ['TEACHER'],
    permissions: [],
    tokenId: 'token-1'
  };

  it('returns and emits a live payload when a teacher manually starts a session', async () => {
    const { service, classSessions, rooms, auditLogs, metrics } = createService();
    const startedAt = new Date('2026-06-22T10:01:00.000Z');

    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'scheduled',
        roomId: `classroom:${sessionId}`
      })
    );
    classSessions.exists.mockResolvedValue(null);
    rooms.ensureClassSessionRoom.mockResolvedValue({ id: 'room-1' });
    classSessions.findOneAndUpdate.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt
      })
    );

    const payload = await service.startSession(sessionId, 'batch-1', teacher);

    expect(payload.status).toBe('live');
    expect(payload.canJoin).toBe(true);
    expect(payload.roomId).toBe('room-1');
    expect(payload.startedAt).toBe(startedAt.toISOString());
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$unset).toEqual({
      completedAt: '',
      cancelledAt: '',
      teacherDisconnectedAt: '',
      teacherReconnectDeadlineAt: ''
    });
    expect(rooms.emitClassSessionLifecycleEvent).toHaveBeenCalledWith('session:started', {
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      status: 'live',
      startedAt: startedAt.toISOString()
    });
    const startAudit = auditLogs.record.mock.calls.find(([input]) => input.action === 'class_sessions.start')?.[0];
    expect(startAudit?.resourceId).toBe(sessionId);
    expect(startAudit?.metadata.batchId).toBe('batch-1');
    expect(startAudit?.metadata.roomId).toBe('room-1');
    expect(metrics.classSessionLifecycleTransitions.labels).toHaveBeenCalledWith('started', 'live');
  });

  it('returns the existing live session when the same session is started twice', async () => {
    const { service, classSessions, rooms } = createService();
    const startedAt = new Date('2026-06-22T10:01:00.000Z');
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt
      })
    );
    rooms.ensureClassSessionRoom.mockResolvedValue({ id: 'room-1' });

    const payload = await service.startSession(sessionId, 'batch-1', teacher);

    expect(payload.status).toBe('live');
    expect(payload.roomId).toBe('room-1');
    expect(classSessions.exists).not.toHaveBeenCalled();
    expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
    expect(rooms.emitClassSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it('rejects duplicate live-session races for the same batch', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'scheduled',
        roomId: `classroom:${sessionId}`
      })
    );
    classSessions.exists.mockResolvedValue(null);
    rooms.ensureClassSessionRoom.mockResolvedValue({ id: 'room-race' });
    classSessions.findOneAndUpdate.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: 11000 }));

    let thrown: unknown;
    try {
      await service.startSession(sessionId, 'batch-1', teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(rooms.closeClassSessionRoom).toHaveBeenCalledWith({
      roomId: 'room-race',
      actorUserId: 'teacher-1',
      actorLabel: 'teacher@example.test'
    });
    expect(rooms.emitClassSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it('closes a newly created room when class-session persistence fails', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'scheduled',
        roomId: `classroom:${sessionId}`
      })
    );
    classSessions.exists.mockResolvedValue(null);
    rooms.ensureClassSessionRoom.mockResolvedValue({ id: 'room-failed-start' });
    classSessions.findOneAndUpdate.mockRejectedValue(new Error('database unavailable'));

    let thrown: unknown;
    try {
      await service.startSession(sessionId, 'batch-1', teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('database unavailable');
    expect(rooms.closeClassSessionRoom).toHaveBeenCalledWith({
      roomId: 'room-failed-start',
      actorUserId: 'teacher-1',
      actorLabel: 'teacher@example.test'
    });
    expect(rooms.emitClassSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it('blocks completed sessions from being started', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z'),
        completedAt: new Date('2026-06-22T11:01:00.000Z')
      })
    );

    let thrown: unknown;
    try {
      await service.startSession(sessionId, 'batch-1', teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(rooms.ensureClassSessionRoom).not.toHaveBeenCalled();
    expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns and emits a completed payload when a teacher manually ends a session', async () => {
    const { service, classSessions, rooms, auditLogs, metrics } = createService();
    const startedAt = new Date('2026-06-22T10:01:00.000Z');
    const completedAt = new Date('2026-06-22T11:01:00.000Z');
    const live = persistedSession({
      status: 'live',
      roomId: 'room-1',
      startedAt
    });
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt,
      completedAt
    });

    classSessions.findById.mockResolvedValue(live);
    classSessions.findOneAndUpdate.mockResolvedValue(completed);

    const payload = await service.endSession(sessionId, teacher);

    expect(payload.status).toBe('completed');
    expect(payload.canJoin).toBe(false);
    expect(payload.completedAt).toBe(completedAt.toISOString());
    expect(rooms.closeClassSessionRoom).toHaveBeenCalledWith({
      roomId: 'room-1',
      actorUserId: 'teacher-1',
      actorLabel: 'teacher@example.test'
    });
    expect(rooms.emitClassSessionLifecycleEvent).toHaveBeenCalledWith('session:ended', {
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      status: 'completed',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString()
    });
    const closeOrder = rooms.closeClassSessionRoom.mock.invocationCallOrder[0];
    const updateOrder = classSessions.findOneAndUpdate.mock.invocationCallOrder[0];
    const emitOrder = rooms.emitClassSessionLifecycleEvent.mock.invocationCallOrder[0];
    expect(closeOrder).toBeDefined();
    expect(updateOrder).toBeDefined();
    expect(emitOrder).toBeDefined();
    expect(updateOrder as number).toBeLessThan(closeOrder as number);
    expect(updateOrder as number).toBeLessThan(emitOrder as number);
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({ _id: sessionId, status: 'live' });
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.status).toBe('completed');
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.completedAt).toBeInstanceOf(Date);
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$unset).toEqual({
      teacherDisconnectedAt: '',
      teacherReconnectDeadlineAt: ''
    });
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[2]).toEqual({ new: true });
    const endAudit = auditLogs.record.mock.calls.find(([input]) => input.action === 'class_sessions.end')?.[0];
    expect(endAudit?.resourceId).toBe(sessionId);
    expect(endAudit?.metadata.batchId).toBe('batch-1');
    expect(endAudit?.metadata.roomId).toBe('room-1');
    expect(metrics.classSessionLifecycleTransitions.labels).toHaveBeenCalledWith('ended', 'completed');
  });

  it('snapshots attendance rows when a live session is manually ended', async () => {
    const { service, classSessions, attendanceSnapshots, rooms } = createService();
    const startedAt = new Date('2026-06-22T10:01:00.000Z');
    const completedAt = new Date('2026-06-22T11:01:00.000Z');
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt
      })
    );
    classSessions.findOneAndUpdate.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt,
        completedAt
      })
    );
    rooms.classSessionAttendanceRows.mockResolvedValue(attendanceRows());

    await service.endSession(sessionId, teacher);

    expect(attendanceSnapshots.exists).toHaveBeenCalledWith({ sessionId });
    expect(rooms.classSessionAttendanceRows).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      completedAt
    });
    const operations = attendanceSnapshots.bulkWrite.mock.calls[0]?.[0];
    expect(operations?.length).toBe(3);
    expect(operations[0]?.updateOne?.filter).toEqual({ sessionId, studentId: 'student-1' });
    const firstSnapshot = operations[0]?.updateOne?.update?.$setOnInsert;
    expect(firstSnapshot?.sessionId).toBe(sessionId);
    expect(firstSnapshot?.batchId).toBe('batch-1');
    expect(firstSnapshot?.roomId).toBe('room-1');
    expect(firstSnapshot?.studentId).toBe('student-1');
    expect(firstSnapshot?.studentName).toBe('Ava Present');
    expect(firstSnapshot?.studentEmail).toBe('ava@example.test');
    expect(firstSnapshot?.rosterSource).toBe('roster');
    expect(firstSnapshot?.totalDurationSeconds).toBe(1800);
    expect(firstSnapshot?.reconnectCount).toBe(1);
    expect(firstSnapshot?.status).toBe('present');
    expect(firstSnapshot?.snapshotSource).toBe('session_end');
  });

  it('does not close the room when the DB completion update fails', async () => {
    const { service, classSessions, rooms } = createService();
    const live = persistedSession({
      status: 'live',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:01:00.000Z')
    });
    classSessions.findById.mockResolvedValueOnce(live).mockResolvedValueOnce(live).mockResolvedValueOnce(live);
    classSessions.findOneAndUpdate.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.endSession(sessionId, teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(rooms.closeClassSessionRoom).not.toHaveBeenCalled();
    expect(rooms.emitClassSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it('returns completed and emits ended when media room close fails after DB completion', async () => {
    const { service, classSessions, rooms } = createService();
    const startedAt = new Date('2026-06-22T10:01:00.000Z');
    const completedAt = new Date('2026-06-22T11:01:00.000Z');
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt
      })
    );
    classSessions.findOneAndUpdate.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt,
        completedAt
      })
    );
    rooms.closeClassSessionRoom.mockRejectedValue(new Error('media close failed'));

    const payload = await service.endSession(sessionId, teacher);

    expect(payload.status).toBe('completed');
    expect(classSessions.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: sessionId, status: 'live' },
      {
        $set: {
          status: 'completed',
          completedAt: classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.completedAt
        },
        $unset: {
          teacherDisconnectedAt: '',
          teacherReconnectDeadlineAt: ''
        }
      },
      { new: true }
    );
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.completedAt).toBeInstanceOf(Date);
    expect(rooms.closeClassSessionRoom).toHaveBeenCalledWith({
      roomId: 'room-1',
      actorUserId: 'teacher-1',
      actorLabel: 'teacher@example.test'
    });
    expect(rooms.emitClassSessionLifecycleEvent).toHaveBeenCalledWith('session:ended', {
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      status: 'completed',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString()
    });
    const updateOrder = classSessions.findOneAndUpdate.mock.invocationCallOrder[0];
    const closeOrder = rooms.closeClassSessionRoom.mock.invocationCallOrder[0];
    const emitOrder = rooms.emitClassSessionLifecycleEvent.mock.invocationCallOrder[0];
    expect(updateOrder as number).toBeLessThan(closeOrder as number);
    expect(updateOrder as number).toBeLessThan(emitOrder as number);
  });

  it('returns completed payload and retries room closure idempotently when ending an already completed session', async () => {
    const { service, classSessions, attendanceSnapshots, rooms } = createService();
    const startedAt = new Date('2026-06-22T10:01:00.000Z');
    const completedAt = new Date('2026-06-22T11:01:00.000Z');
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt,
        completedAt
      })
    );

    const payload = await service.endSession(sessionId, teacher);

    expect(payload.status).toBe('completed');
    expect(payload.completedAt).toBe(completedAt.toISOString());
    expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
    expect(attendanceSnapshots.bulkWrite).not.toHaveBeenCalled();
    expect(rooms.closeClassSessionRoom).toHaveBeenCalledWith({
      roomId: 'room-1',
      actorUserId: 'teacher-1',
      actorLabel: 'teacher@example.test'
    });
    expect(rooms.emitClassSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it('returns current session metadata for an enrolled student', async () => {
    const { service, batches, classSessions, studentEnrollments } = createService();
    batches.findOne.mockReturnValue(
      execResult({
        ...batch,
        startDate: new Date('2026-08-03T00:00:00.000Z'),
        endDate: new Date('2026-08-03T23:59:59.000Z')
      })
    );
    classSessions.find.mockReturnValue({ sort: jest.fn(() => ({ exec: jest.fn(async () => []) })) });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);

    const payload = await service.getCurrentForBatch('batch-1', student());

    expect(payload.batchId).toBe('batch-1');
    expect(payload.role).toBe('student');
    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
  });

  it('includes enrolled offline students in teacher classroom payloads', async () => {
    const { service, classSessions, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.listBatchRoster.mockResolvedValue([
      {
        id: 'student-1',
        userId: 'student-1',
        enrollmentId: 'enrollment-1',
        displayName: 'Student One',
        email: 'student.one@example.test',
        status: 'active',
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ]);

    const payload = await service.getSession(sessionId, undefined, teacher);

    expect(payload.participants.find((participant) => participant.userId === 'student-1')).toEqual({
      id: 'student-1',
      userId: 'student-1',
      displayName: 'Student One',
      role: 'student'
    });
  });

  it('blocks non-enrolled students from session metadata', async () => {
    const { service, classSessions, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.getSession(sessionId, 'batch-1', student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('loads a full class-session activity timeline for the owning teacher', async () => {
    const { service, classSessions, activity } = createService();
    const expected = {
      sessionId,
      batchId: 'batch-1',
      visibility: 'full' as const,
      items: [],
      limit: 25,
      hasMore: false
    };
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z'),
        completedAt: new Date('2026-06-22T11:01:00.000Z')
      })
    );
    activity.listTimeline.mockResolvedValue(expected);

    const response = await service.getTimeline(sessionId, 'batch-1', teacher, { limit: 25, category: 'moderation' });
    expect(response).toBe(expected);
    const call = activity.listTimeline.mock.calls[0]?.[0];
    expect(call.sessionId).toBe(sessionId);
    expect(call.batchId).toBe('batch-1');
    expect(call.limit).toBe(25);
    expect(call.category).toBe('moderation');
    expect(call.visibility).toBe('full');
    expect(call.audienceIds).toEqual(['teacher-1']);
  });

  it('loads only student-safe timeline events for enrolled students', async () => {
    const { service, classSessions, studentEnrollments, activity } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);

    await service.getTimeline(sessionId, undefined, student(), { limit: 10 });

    const call = activity.listTimeline.mock.calls[0]?.[0];
    expect(call.sessionId).toBe(sessionId);
    expect(call.batchId).toBe('batch-1');
    expect(call.limit).toBe(10);
    expect(call.visibility).toBe('student_safe');
    expect(call.audienceIds).toEqual(['student-1']);
  });

  it('blocks non-enrolled students from class-session activity timeline', async () => {
    const { service, classSessions, studentEnrollments, activity } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.getTimeline(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(activity.listTimeline).not.toHaveBeenCalled();
  });

  it('blocks joining before a session is live', async () => {
    const { service, classSessions, auditLogs, metrics } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'scheduled',
        roomId: `classroom:${sessionId}`
      })
    );

    let thrown: unknown;
    try {
      await service.joinSession(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    const deniedAudit = auditLogs.record.mock.calls.find(([input]) => input.action === 'class_sessions.join.denied')?.[0];
    expect(deniedAudit?.metadata.sessionId).toBe(sessionId);
    expect(deniedAudit?.metadata.batchId).toBe('batch-1');
    expect(deniedAudit?.metadata.result).toBe('denied');
    expect(deniedAudit?.metadata.reason).toBe('scheduled');
    expect(metrics.classSessionJoinAttempts.labels).toHaveBeenCalledWith('denied', 'scheduled', 'student');
  });

  it('blocks joining after a session is completed', async () => {
    const { service, classSessions } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z'),
        completedAt: new Date('2026-06-22T11:01:00.000Z')
      })
    );

    let thrown: unknown;
    try {
      await service.joinSession(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
  });

  it('lets an enrolled student join a live session', async () => {
    const { service, classSessions, studentEnrollments, rooms, auditLogs, metrics } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);

    const payload = await service.joinSession(sessionId, undefined, student());

    expect(payload.status).toBe('live');
    expect(payload.canJoin).toBe(true);
    expect(payload.role).toBe('student');
    expect(rooms.assertClassSessionRoomJoinAllowed).toHaveBeenCalledWith('room-1', 'teacher-1', {
      id: 'student-1',
      roles: ['STUDENT']
    });
    const admittedAudit = auditLogs.record.mock.calls.find(([input]) => input.action === 'class_sessions.join.admitted')?.[0];
    expect(admittedAudit?.metadata.sessionId).toBe(sessionId);
    expect(admittedAudit?.metadata.batchId).toBe('batch-1');
    expect(admittedAudit?.metadata.roomId).toBe('room-1');
    expect(admittedAudit?.metadata.result).toBe('admitted');
    expect(admittedAudit?.metadata.reason).toBe('live');
    expect(metrics.classSessionJoinAttempts.labels).toHaveBeenCalledWith('admitted', 'live', 'student');
  });

  it('blocks new student joins when the live class room is locked', async () => {
    const { service, classSessions, studentEnrollments, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);
    rooms.assertClassSessionRoomJoinAllowed.mockRejectedValue(new ForbiddenException('Class is locked. Ask the teacher to unlock it before joining.'));

    let thrown: unknown;
    try {
      await service.joinSession(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(rooms.assertClassSessionRoomJoinAllowed).toHaveBeenCalledWith('room-1', 'teacher-1', {
      id: 'student-1',
      roles: ['STUDENT']
    });
  });

  it('blocks non-enrolled students from joining a live session', async () => {
    const { service, classSessions, studentEnrollments, auditLogs, metrics } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.joinSession(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    const deniedAudit = auditLogs.record.mock.calls.find(([input]) => input.action === 'class_sessions.join.denied')?.[0];
    expect(deniedAudit?.metadata.sessionId).toBe(sessionId);
    expect(deniedAudit?.metadata.batchId).toBe('batch-1');
    expect(deniedAudit?.metadata.result).toBe('denied');
    expect(deniedAudit?.metadata.reason).toBe('forbidden');
    expect(metrics.classSessionJoinAttempts.labels).toHaveBeenCalledWith('denied', 'forbidden', 'student');
  });

  it('blocks non-enrolled students from chat history', async () => {
    const { service, classSessions, studentEnrollments, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.getChatHistory(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(rooms.getClassSessionChatHistory).not.toHaveBeenCalled();
  });

  it('loads chat history using the resolved room and chat channel', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    rooms.getClassSessionChatHistory.mockResolvedValue({ messages: [] });

    const history = await service.getChatHistory(sessionId, undefined, teacher, {
      scope: 'broadcast',
      before: '2026-06-22T10:30:00.000Z',
      limit: 25
    });

    expect(history).toEqual({ messages: [] });
    expect(rooms.getClassSessionChatHistory).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: `classroom:${sessionId}:chat`,
      teacherId: 'teacher-1',
      requesterUserId: teacher.sub,
      requesterRole: 'teacher',
      participantId: undefined,
      scope: 'broadcast',
      before: '2026-06-22T10:30:00.000Z',
      limit: 25
    });
  });

  it('loads chat summaries using the resolved room and requester role', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    rooms.getClassSessionChatSummary.mockResolvedValue({ sessionId, roomId: 'room-1', threads: [] });

    const summary = await service.getChatSummary(sessionId, undefined, teacher);

    expect(summary).toEqual({ sessionId, roomId: 'room-1', threads: [] });
    expect(rooms.getClassSessionChatSummary).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: `classroom:${sessionId}:chat`,
      teacherId: 'teacher-1',
      requesterUserId: teacher.sub,
      requesterRole: 'teacher'
    });
  });

  it('marks chat read using the resolved class session channel context', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );
    rooms.markClassSessionChatRead.mockResolvedValue({
      id: 'read-1',
      sessionId,
      roomId: 'room-1',
      userId: teacher.sub,
      participantId: 'student-one',
      scope: 'private',
      threadKey: 'session-1:teacher:teacher-1:student:student-1',
      lastReadAt: '2026-06-22T10:20:00.000Z',
      updatedAt: '2026-06-22T10:20:00.000Z'
    });

    const readState = await service.markChatRead(sessionId, undefined, teacher, {
      participantId: 'student-one',
      scope: 'private',
      readAt: '2026-06-22T10:20:00.000Z'
    });

    expect(readState.id).toBe('read-1');
    expect(rooms.markClassSessionChatRead).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: `classroom:${sessionId}:chat`,
      teacherId: 'teacher-1',
      requesterUserId: teacher.sub,
      requesterRole: 'teacher',
      participantId: 'student-one',
      scope: 'private',
      readAt: '2026-06-22T10:20:00.000Z'
    });
  });

  it('rejects chat read when the supplied room does not match the class session', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z')
      })
    );

    let thrown: unknown;
    try {
      await service.markChatRead(sessionId, undefined, teacher, {
        roomId: 'other-room',
        participantId: 'student-one',
        scope: 'private'
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(rooms.markClassSessionChatRead).not.toHaveBeenCalled();
  });

  it('lists completed class history only from the student historical batches', async () => {
    const { service, classSessions, studentEnrollments, rooms, recordings, materials, whiteboardStates } = createService();
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt: new Date('2026-06-22T11:00:00.000Z')
    });
    const latestRecording = {
      id: 'recording-1',
      roomId: 'room-1',
      scope: 'screen',
      status: 'stopped',
      storageDriver: 'local',
      publishedAt: '2026-06-22T11:05:00.000Z',
      startedAt: '2026-06-22T10:00:00.000Z'
    };
    studentEnrollments.listStudentClassHistoryBatchIds.mockResolvedValue(['batch-1']);
    classSessions.find.mockReturnValueOnce(sessionFindResult([completed]));
    classSessions.countDocuments.mockReturnValue(execResult(1));
    recordings.getClassSessionRecordingSummary.mockResolvedValue({ latest: latestRecording });
    materials.find.mockReturnValue({
      sort: jest.fn(() => execResult([materialDoc({ shared: true })]))
    });
    whiteboardStates.findOne.mockResolvedValue(whiteboardStateDoc({ publishedAt: new Date('2026-06-22T11:05:00.000Z') }));
    rooms.getClassSessionPostClassStudentChatSummary.mockResolvedValue({
      sessionId,
      roomId: 'room-1',
      threads: [],
      studentThread: { id: 'private:student-1', scope: 'private', unreadCount: 2, lastMessageAt: '2026-06-22T11:05:00.000Z' }
    });
    rooms.classSessionAttendanceRows.mockResolvedValue(attendanceRows());

    const response = await service.listStudentCompletedSessions(student(), { limit: 10 });

    expect(response.total).toBe(1);
    const row = response.items[0];
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.batchId).toBe('batch-1');
    expect(row?.batchName).toBe('Native SFU');
    expect(row?.teacherName).toBe('Ada Teacher');
    expect(row?.recordingAvailable).toBe(true);
    expect(row?.materialCount).toBe(1);
    expect(row?.notesAvailable).toBe(true);
    expect(row?.notesPageCount).toBe(1);
    expect(row?.qnaUnreadCount).toBe(2);
    expect(row?.attendance.status).toBe('present');
    expect(row?.attendance.source).toBe('inferred');
    expect(classSessions.find.mock.calls[0]?.[0]).toEqual({
      batchId: { $in: ['batch-1'] },
      status: 'completed'
    });
  });

  it('blocks non-enrolled students from guessed completed class details', async () => {
    const { service, classSessions, studentEnrollments, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    studentEnrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.getStudentCompletedSessionDetail(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(rooms.getClassSessionPostClassStudentChatHistory).not.toHaveBeenCalled();
  });

  it('loads student-safe completed class details with only own private chat context', async () => {
    const { service, classSessions, rooms, recordings, materials, whiteboardStates } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    recordings.listAuthorizedClassSessionRecordings.mockResolvedValue([
      { id: 'recording-1', roomId: 'room-1', scope: 'screen', status: 'stopped', publishedAt: '2026-06-22T11:05:00.000Z' }
    ]);
    materials.find.mockReturnValue({
      sort: jest.fn(() => execResult([materialDoc({ shared: true })]))
    });
    whiteboardStates.findOne.mockResolvedValue(whiteboardStateDoc({ publishedAt: new Date('2026-06-22T11:05:00.000Z') }));
    rooms.getClassSessionPostClassStudentChatHistory
      .mockResolvedValueOnce({ messages: [{ id: 'broadcast-1', message: 'Review page 2', scope: 'broadcast' }] })
      .mockResolvedValueOnce({ messages: [{ id: 'private-1', message: 'My question', scope: 'private' }] });
    rooms.getClassSessionPostClassStudentChatSummary.mockResolvedValue({
      sessionId,
      roomId: 'room-1',
      threads: [],
      studentThread: { id: 'private:student-1', scope: 'private', unreadCount: 0 }
    });
    rooms.classSessionAttendanceRows.mockResolvedValue(attendanceRows());

    const detail = await service.getStudentCompletedSessionDetail(sessionId, undefined, student());

    expect(detail.materials.length).toBe(1);
    expect(detail.whiteboard.available).toBe(true);
    expect(detail.announcements[0]?.id).toBe('broadcast-1');
    expect(detail.announcements[0]?.message).toBe('Review page 2');
    expect(detail.privateThread.messages[0]?.id).toBe('private-1');
    expect(detail.privateThread.messages[0]?.message).toBe('My question');
    const privateHistoryCall = rooms.getClassSessionPostClassStudentChatHistory.mock.calls[1]?.[0];
    expect(privateHistoryCall.studentId).toBe('student-1');
    expect(privateHistoryCall.scope).toBe('private');
  });

  it('sends post-class questions as private teacher-student chat and rejects spoofed student recipients', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    rooms.sendClassSessionPostClassPrivateMessage.mockResolvedValue({ id: 'chat-1', message: 'Can you review problem 3?' });

    const sent = await service.sendPostClassQuestion(sessionId, undefined, student(), { message: 'Can you review problem 3?' });

    expect(sent.id).toBe('chat-1');
    const sendCall = rooms.sendClassSessionPostClassPrivateMessage.mock.calls[0]?.[0];
    expect(sendCall.sessionId).toBe(sessionId);
    expect(sendCall.batchId).toBe('batch-1');
    expect(sendCall.roomId).toBe('room-1');
    expect(sendCall.channelId).toBe(`classroom:${sessionId}:chat`);
    expect(sendCall.teacherId).toBe('teacher-1');
    expect(sendCall.senderId).toBe('student-1');
    expect(sendCall.senderName).toBe('Student One');
    expect(sendCall.senderRole).toBe('student');
    expect(sendCall.studentId).toBe('student-1');
    expect(sendCall.message).toBe('Can you review problem 3?');

    let thrown: unknown;
    try {
      await service.sendPostClassQuestion(sessionId, undefined, student(), { recipientId: 'student-2', message: 'Leak this' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('lets the batch teacher review and reply to private post-class Q&A threads', async () => {
    const { service, classSessions, rooms, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    studentEnrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(true);
    rooms.getClassSessionPostClassTeacherChatSummary.mockResolvedValue({
      sessionId,
      roomId: 'room-1',
      threads: [
        {
          id: 'private:student-1',
          scope: 'private',
          participantId: 'student-1',
          participantName: 'Student One',
          unreadCount: 1,
          lastMessagePreview: 'Can you review problem 3?'
        }
      ]
    });
    rooms.getClassSessionPostClassTeacherChatHistory.mockResolvedValue({
      messages: [{ id: 'question-1', message: 'Can you review problem 3?', scope: 'private' }]
    });
    rooms.sendClassSessionPostClassPrivateMessage.mockResolvedValue({ id: 'reply-1', message: 'Yes, check the second step.' });

    const summary = await service.getPostClassChatSummary(sessionId, undefined, teacher);
    const thread = summary.threads[0];
    expect(thread?.participantId).toBe('student-1');
    expect(thread?.unreadCount).toBe(1);

    const history = await service.getPostClassChatHistory(sessionId, undefined, teacher, { participantId: 'student-1' });
    expect(history.messages[0]?.id).toBe('question-1');
    const historyCall = rooms.getClassSessionPostClassTeacherChatHistory.mock.calls[0]?.[0];
    expect(historyCall.sessionId).toBe(sessionId);
    expect(historyCall.batchId).toBe('batch-1');
    expect(historyCall.teacherId).toBe('teacher-1');
    expect(historyCall.participantId).toBe('student-1');

    const reply = await service.sendPostClassQuestion(sessionId, undefined, teacher, {
      recipientId: 'student-1',
      message: 'Yes, check the second step.'
    });
    expect(reply.id).toBe('reply-1');
    const sendCall = rooms.sendClassSessionPostClassPrivateMessage.mock.calls[0]?.[0];
    expect(sendCall.senderId).toBe('teacher-1');
    expect(sendCall.senderRole).toBe('teacher');
    expect(sendCall.studentId).toBe('student-1');
    expect(sendCall.message).toBe('Yes, check the second step.');
  });

  it('returns a completed-session report for the owning teacher without private Q&A bodies', async () => {
    const {
      service,
      classSessions,
      attendanceSnapshots,
      rooms,
      recordings,
      materials,
      whiteboardStates,
      assignments,
      assignmentSubmissions,
      activity
    } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:01:00.000Z'),
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    attendanceSnapshots.find.mockReturnValue({
      sort: jest.fn(() =>
        execResult([
          {
            studentId: 'student-1',
            studentName: 'Student One',
            studentEmail: 'student@example.test',
            firstJoinAt: new Date('2026-06-22T10:04:00.000Z'),
            lastLeaveAt: new Date('2026-06-22T10:58:00.000Z'),
            totalDurationSeconds: 3240,
            reconnectCount: 1,
            status: 'present',
            rosterSource: 'roster'
          },
          {
            studentId: 'student-2',
            studentName: 'Student Two',
            studentEmail: 'student2@example.test',
            totalDurationSeconds: 0,
            reconnectCount: 0,
            status: 'absent',
            rosterSource: 'roster'
          }
        ])
      )
    });
    rooms.getClassSessionChatHistory.mockResolvedValue({
      messages: [
        {
          id: 'broadcast-1',
          sessionId,
          senderId: 'teacher-1',
          senderName: 'Ada Teacher',
          senderRole: 'teacher',
          roomId: 'room-1',
          scope: 'broadcast',
          message: 'Review the whiteboard notes before homework.',
          shadowMuted: false,
          createdAt: '2026-06-22T10:40:00.000Z'
        }
      ]
    });
    rooms.getClassSessionPostClassTeacherChatSummary.mockResolvedValue({
      sessionId,
      roomId: 'room-1',
      threads: [
        {
          id: 'private:student-1',
          scope: 'private',
          participantId: 'student-1',
          participantName: 'Student One',
          unreadCount: 1,
          lastMessageAt: '2026-06-22T11:20:00.000Z',
          lastMessagePreview: 'Can you review problem 3?',
          lastMessage: {
            id: 'question-1',
            senderId: 'student-1',
            senderName: 'Student One',
            senderRole: 'student',
            roomId: 'room-1',
            scope: 'private',
            message: 'Can you review problem 3?',
            shadowMuted: false,
            createdAt: '2026-06-22T11:20:00.000Z'
          }
        }
      ]
    });
    recordings.listAuthorizedClassSessionRecordings.mockResolvedValue([{ id: 'recording-1', roomId: 'room-1', scope: 'screen', status: 'stopped' }]);
    materials.find.mockReturnValue({
      sort: jest.fn(() => execResult([materialDoc({ shared: true })]))
    });
    whiteboardStates.findOne.mockResolvedValue({
      snapshotVersion: 3,
      updatedAt: new Date('2026-06-22T10:55:00.000Z'),
      pageCount: 1,
      elementCount: 4,
      pages: [{ pageId: 'page-1', title: 'Main', order: 0, elementCount: 4 }]
    });
    assignments.find.mockReturnValue(
      execResult([
        {
          assignmentId: 'assignment-1',
          status: 'published'
        }
      ])
    );
    assignmentSubmissions.find.mockReturnValue(execResult([{ assignmentId: 'assignment-1', status: 'submitted' }]));
    activity.listTimeline.mockResolvedValue({
      sessionId,
      batchId: 'batch-1',
      visibility: 'full',
      limit: 200,
      hasMore: false,
      items: [
        {
          id: 'join-1',
          sessionId,
          batchId: 'batch-1',
          eventType: 'participant.joined',
          category: 'attendance',
          summary: 'Student One joined',
          visibility: 'full',
          createdAt: '2026-06-22T10:04:00.000Z'
        },
        {
          id: 'hand-1',
          sessionId,
          batchId: 'batch-1',
          eventType: 'hand.raised',
          category: 'moderation',
          summary: 'Student One raised hand',
          visibility: 'full',
          createdAt: '2026-06-22T10:20:00.000Z'
        },
        {
          id: 'media-1',
          sessionId,
          batchId: 'batch-1',
          eventType: 'recording.failed',
          category: 'support',
          summary: 'Recording failed to start',
          visibility: 'full',
          createdAt: '2026-06-22T10:30:00.000Z'
        }
      ]
    });

    const report = await service.getClassSessionReport(sessionId, undefined, teacher);

    expect(report.audience).toBe('teacher');
    expect(report.session.sessionId).toBe(sessionId);
    expect(report.attendance.source).toBe('snapshot');
    expect(report.attendance.present).toBe(1);
    expect(report.attendance.absent).toBe(1);
    expect(report.participation.joins).toBe(1);
    expect(report.participation.handRaises).toBe(1);
    expect(report.broadcasts.count).toBe(1);
    expect(report.artifacts.recordings.length).toBe(1);
    expect(report.artifacts.materials.length).toBe(1);
    expect(report.artifacts.whiteboard.available).toBe(true);
    expect(report.assignments.total).toBe(1);
    expect(report.assignments.submissions.submitted).toBe(1);
    expect(report.qna.unanswered).toBe(1);
    expect(report.incidents.total).toBe(1);
    expect(JSON.stringify(report)).not.toContain('Can you review problem 3?');

    const csv = await service.exportClassSessionReportCsv(sessionId, undefined, teacher);
    expect(csv).toContain('Section,Field,Value,Notes');
    expect(csv).toContain('Attendance,Present students,1,');
    expect(csv).toContain('Post-class Q&A,Unanswered,1,');
    expect(csv).toContain('Incident,recording.failed,Recording failed to start,support; 2026-06-22T10:30:00.000Z');
    expect(csv).not.toContain('Can you review problem 3?');
  });

  it('allows admins to open completed-session reports and blocks non-owner teachers', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    rooms.getClassSessionChatHistory.mockResolvedValue({ messages: [] });

    const adminReport = await service.getClassSessionReport(sessionId, undefined, admin());
    expect(adminReport.audience).toBe('admin');
    const adminCsv = await service.exportClassSessionReportCsv(sessionId, undefined, admin());
    expect(adminCsv).toContain('Report,Audience,admin,');

    let thrown: unknown;
    try {
      await service.getClassSessionReport(sessionId, undefined, {
        sub: 'teacher-2',
        email: 'teacher2@example.test',
        roles: ['TEACHER'],
        permissions: [],
        tokenId: 'token-4'
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);

    thrown = undefined;
    try {
      await service.exportClassSessionReportCsv(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('builds a teacher post-class workspace with Q&A workflow state and assignments', async () => {
    const {
      service,
      classSessions,
      rooms,
      materials,
      recordings,
      whiteboardStates,
      assignments,
      assignmentSubmissions,
      postClassThreadStates
    } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    rooms.getClassSessionChatHistory.mockResolvedValue({ messages: [] });
    rooms.getClassSessionPostClassTeacherChatSummary.mockResolvedValue({
      sessionId,
      roomId: 'room-1',
      threads: [
        {
          id: 'private:student-1',
          participantId: 'student-1',
          participantName: 'Student One',
          scope: 'private',
          unreadCount: 1,
          lastMessagePreview: 'Can you review problem 3?',
          lastMessageAt: '2026-06-22T11:05:00.000Z',
          lastMessage: { senderRole: 'student' }
        }
      ]
    });
    materials.find.mockReturnValue({ sort: jest.fn(() => execResult([materialDoc({ shared: true })])) });
    recordings.listAuthorizedClassSessionRecordings.mockResolvedValue([{ id: 'recording-1', roomId: 'room-1', scope: 'screen', status: 'stopped' }]);
    whiteboardStates.findOne.mockResolvedValue(whiteboardStateDoc());
    const assignmentRows = [
      {
        id: 'assignment-1',
        assignmentId: 'assignment-1',
        batchId: 'batch-1',
        sessionId,
        teacherId: 'teacher-1',
        title: 'Follow-up limits',
        instructions: 'Review worksheet 2.',
        attachments: [],
        allowedSubmissionTypes: ['text'],
        status: 'published',
        createdAt: new Date('2026-06-22T11:10:00.000Z'),
        updatedAt: new Date('2026-06-22T11:10:00.000Z')
      }
    ];
    assignments.find.mockReturnValue({
      exec: jest.fn(async () => assignmentRows),
      sort: jest.fn(() => execResult(assignmentRows))
    });
    assignmentSubmissions.find.mockReturnValue(execResult([{ assignmentId: 'assignment-1', status: 'submitted' }]));
    postClassThreadStates.find.mockReturnValue(
      execResult([
        {
          sessionId,
          batchId: 'batch-1',
          teacherId: 'teacher-1',
          studentId: 'student-1',
          threadKey: `${sessionId}:teacher:teacher-1:student:student-1`,
          important: true,
          answered: false,
          followUp: true,
          updatedAt: new Date('2026-06-22T11:15:00.000Z'),
          updatedByUserId: 'teacher-1'
        }
      ])
    );

    const workspace = await service.getPostClassWorkspace(sessionId, undefined, teacher);

    expect(workspace.report.session.sessionId).toBe(sessionId);
    expect(workspace.qna.threads[0]?.workflow.important).toBe(true);
    expect(workspace.qna.threads[0]?.workflow.followUp).toBe(true);
    expect(workspace.assignments[0]?.title).toBe('Follow-up limits');
    expect(workspace.assignments[0]?.submissionSummary?.submitted).toBe(1);
    expect(JSON.stringify(workspace.report)).not.toContain('Can you review problem 3?');
  });

  it('updates post-class Q&A workflow state for an enrolled student', async () => {
    const { service, classSessions, studentEnrollments, postClassThreadStates } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    studentEnrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(true);
    postClassThreadStates.findOneAndUpdate.mockResolvedValue({
      sessionId,
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      studentId: 'student-1',
      threadKey: `${sessionId}:teacher:teacher-1:student:student-1`,
      important: true,
      answered: true,
      followUp: false,
      updatedAt: new Date('2026-06-22T11:20:00.000Z'),
      updatedByUserId: 'teacher-1'
    });

    const workflow = await service.updatePostClassQuestionState(sessionId, undefined, teacher, {
      participantId: 'student-1',
      important: true,
      answered: true
    });

    expect(workflow.important).toBe(true);
    expect(workflow.answered).toBe(true);
    expect(studentEnrollments.isStudentHistoricallyEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
    const [query, update, options] = postClassThreadStates.findOneAndUpdate.mock.calls[0];
    expect(query).toEqual({ sessionId, batchId: 'batch-1', studentId: 'student-1' });
    expect(update.$set.important).toBe(true);
    expect(update.$set.answered).toBe(true);
    expect(update.$set.updatedByUserId).toBe('teacher-1');
    expect(update.$setOnInsert.threadKey).toBe(`${sessionId}:teacher:teacher-1:student:student-1`);
    expect(options).toEqual({ new: true, upsert: true });
  });

  it('publishes post-class materials, recordings, and whiteboard notes for students', async () => {
    const { service, classSessions, materials, recordings, whiteboardStates } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    materials.findOneAndUpdate.mockResolvedValue(materialDoc({ shared: true, publishedAt: new Date('2026-06-22T11:20:00.000Z') }));
    recordings.updateClassSessionRecordingPublication.mockResolvedValue({
      id: 'recording-1',
      recordingId: 'recording-1',
      roomId: 'room-1',
      scope: 'screen',
      status: 'stopped',
      publishedAt: '2026-06-22T11:20:00.000Z'
    });
    whiteboardStates.findOneAndUpdate.mockResolvedValue(whiteboardStateDoc({ publishedAt: new Date('2026-06-22T11:20:00.000Z') }));
    whiteboardStates.findOne.mockResolvedValue(whiteboardStateDoc({ publishedAt: new Date('2026-06-22T11:20:00.000Z') }));

    const material = await service.publishPostClassMaterial(sessionId, 'material-1', undefined, teacher);
    const recording = await service.publishPostClassRecording(sessionId, 'recording-1', undefined, teacher);
    const whiteboard = await service.publishPostClassWhiteboard(sessionId, undefined, teacher);

    expect(material.publishedAt).toBe('2026-06-22T11:20:00.000Z');
    expect(recording.publishedAt).toBe('2026-06-22T11:20:00.000Z');
    expect(whiteboard.available).toBe(true);
    expect(recordings.updateClassSessionRecordingPublication).toHaveBeenCalledWith(sessionId, 'recording-1', 'teacher-1', true);
  });

  it('attaches link materials for the batch teacher', async () => {
    const { service, classSessions, materials } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'scheduled',
        roomId: `classroom:${sessionId}`
      })
    );

    const material = await service.attachMaterialLink(sessionId, undefined, teacher, {
      title: 'Lesson deck',
      url: 'https://example.test/deck',
      description: 'Intro slides'
    });

    expect(material.title).toBe('Lesson deck');
    expect(material.source).toBe('link');
    expect(material.url).toBe('https://example.test/deck');
    expect(material.shared).toBe(false);
    const createPayload = materials.create.mock.calls[0]?.[0];
    expect(createPayload).toEqual({
      materialId: createPayload.materialId,
      sessionId,
      batchId: 'batch-1',
      roomId: `classroom:${sessionId}`,
      title: 'Lesson deck',
      description: 'Intro slides',
      kind: 'link',
      source: 'link',
      url: 'https://example.test/deck',
      uploadedByUserId: 'teacher-1',
      shared: false
    });
  });

  it('blocks non-enrolled students from listing materials', async () => {
    const { service, classSessions, studentEnrollments, materials } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:00:00.000Z'),
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.listMaterials(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(materials.find).not.toHaveBeenCalled();
  });

  it('allows historically enrolled students to download completed-session materials', async () => {
    const { service, classSessions, studentEnrollments, materials } = createService();
    const tempDir = await mkdtemp(join(tmpdir(), 'native-sfu-material-download-'));
    const materialPath = join(tempDir, 'lesson.pdf');
    await writeFile(materialPath, 'lesson');
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:00:00.000Z'),
        completedAt: new Date('2026-06-22T11:00:00.000Z')
      })
    );
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);
    studentEnrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(true);
    materials.findOne.mockResolvedValue(
      materialDoc({
        kind: 'pdf',
        source: 'upload',
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
        path: materialPath,
        size: 6,
        shared: false,
        publishedAt: new Date('2026-06-22T11:05:00.000Z')
      })
    );

    try {
      const download = await service.downloadMaterial(sessionId, 'material-1', undefined, student());
      download.stream.destroy();

      expect(studentEnrollments.isStudentHistoricallyEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
      expect(materials.findOne).toHaveBeenCalledWith({
        materialId: 'material-1',
        sessionId,
        batchId: 'batch-1',
        deletedAt: { $exists: false }
      });
      expect(download.fileName).toBe('lesson.pdf');
      expect(download.mimeType).toBe('application/pdf');
      expect(download.size).toBe(6);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('shares one live material and emits a targeted session material event', async () => {
    const { service, classSessions, materials, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:00:00.000Z')
      })
    );
    materials.findOneAndUpdate.mockResolvedValue(
      materialDoc({
        materialId: 'material-1',
        roomId: 'room-1',
        shared: true,
        sharedAt: new Date('2026-06-22T10:30:00.000Z'),
        sharedByUserId: 'teacher-1'
      })
    );

    const material = await service.shareMaterial(sessionId, 'material-1', undefined, teacher);

    expect(material.shared).toBe(true);
    expect(materials.updateMany).toHaveBeenCalledWith(
      {
        sessionId,
        batchId: 'batch-1',
        shared: true,
        deletedAt: { $exists: false },
        materialId: { $ne: 'material-1' }
      },
      {
        $set: { shared: false },
        $unset: { sharedAt: '', sharedByUserId: '' }
      }
    );
    const [eventName, eventPayload] = rooms.emitClassSessionMaterialEvent.mock.calls[0] ?? [];
    expect(eventName).toBe('material:shared');
    expect(eventPayload.sessionId).toBe(sessionId);
    expect(eventPayload.batchId).toBe('batch-1');
    expect(eventPayload.roomId).toBe('room-1');
    expect(eventPayload.materialId).toBe('material-1');
    expect(eventPayload.shared).toBe(true);
    expect(eventPayload.actorUserId).toBe('teacher-1');
  });

  it('rejects material sharing before the class is live', async () => {
    const { service, classSessions, materials, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'scheduled',
        roomId: `classroom:${sessionId}`
      })
    );

    let thrown: unknown;
    try {
      await service.shareMaterial(sessionId, 'material-1', undefined, teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(materials.findOneAndUpdate).not.toHaveBeenCalled();
    expect(rooms.emitClassSessionMaterialEvent).not.toHaveBeenCalled();
  });

  it('exports attendance for the batch teacher only through the class-session context', async () => {
    const { service, classSessions, rooms } = createService();
    const completedAt = new Date('2026-06-22T11:00:00.000Z');
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'completed',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:00:00.000Z'),
        completedAt
      })
    );
    rooms.exportClassSessionAttendanceCsv.mockResolvedValue('Student Name\n');

    const csv = await service.exportAttendanceCsv(sessionId, undefined, teacher);

    expect(csv).toBe('Student Name\n');
    expect(rooms.exportClassSessionAttendanceCsv).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      completedAt,
      sessionDurationMinutes: 60,
      presentThresholdMinutes: 10,
      presentThresholdPercentage: 50,
      countReconnects: true,
      anonymizeStudentExports: false
    });
  });

  it('rejects attendance export for enrolled students', async () => {
    const { service, classSessions, rooms } = createService();
    classSessions.findById.mockResolvedValue(
      persistedSession({
        status: 'live',
        roomId: 'room-1',
        startedAt: new Date('2026-06-22T10:00:00.000Z')
      })
    );

    let thrown: unknown;
    try {
      await service.exportAttendanceCsv(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(rooms.exportClassSessionAttendanceCsv).not.toHaveBeenCalled();
  });

  it('saves and reloads teacher whiteboard memory for a class session', async () => {
    const { service, classSessions, whiteboardStates, whiteboardVersions } = createService();
    classSessions.findById.mockResolvedValue(persistedSession({ status: 'live', roomId: 'room-1' }));
    let savedState: ReturnType<typeof whiteboardStateDoc> | null = null;
    whiteboardStates.findOne.mockImplementation(async () => savedState);
    whiteboardStates.findOneAndUpdate.mockImplementation(async (_query, update) => {
      savedState = whiteboardStateDoc({
        roomId: update.$set.roomId,
        whiteboardChannelId: update.$set.whiteboardChannelId,
        snapshotVersion: update.$set.snapshotVersion,
        currentSnapshot: update.$set.currentSnapshot,
        pages: update.$set.pages,
        pageCount: update.$set.pageCount,
        elementCount: update.$set.elementCount,
        updatedByUserId: update.$set.updatedByUserId
      });
      return savedState;
    });

    const state = await service.saveWhiteboardMemory(sessionId, 'batch-1', teacher, {
      batchId: 'batch-1',
      snapshot: whiteboardSnapshot(),
      reason: 'autosave'
    });
    const loaded = await service.getWhiteboardMemory(sessionId, 'batch-1', teacher);

    expect(state.snapshotVersion).toBe(1);
    expect(state.summary.pageCount).toBe(1);
    expect(state.summary.elementCount).toBe(1);
    expect(loaded?.snapshot.pages[0]?.title).toBe('Limits warmup');
    expect(whiteboardVersions.create).not.toHaveBeenCalled();
  });

  it('lets a historically enrolled student load completed-session whiteboard memory read-only', async () => {
    const { service, classSessions, studentEnrollments, whiteboardStates } = createService();
    classSessions.findById.mockResolvedValue(persistedSession({ status: 'completed', roomId: 'room-1', completedAt: new Date('2026-06-22T11:00:00.000Z') }));
    studentEnrollments.isStudentHistoricallyEnrolledInBatch.mockResolvedValue(true);
    whiteboardStates.findOne.mockResolvedValue(whiteboardStateDoc({ publishedAt: new Date('2026-06-22T11:05:00.000Z') }));

    const state = await service.getWhiteboardMemory(sessionId, 'batch-1', student());

    expect(studentEnrollments.isStudentHistoricallyEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
    expect(state?.snapshot.pages[0]?.title).toBe('Limits warmup');
  });

  it('creates a bounded whiteboard checkpoint version for the batch teacher', async () => {
    const { service, classSessions, whiteboardStates, whiteboardVersions } = createService();
    classSessions.findById.mockResolvedValue(persistedSession({ status: 'live', roomId: 'room-1' }));
    const stateDoc = whiteboardStateDoc();
    const versionDoc = whiteboardVersionDoc();
    whiteboardStates.findOne.mockResolvedValue(null);
    whiteboardStates.findOneAndUpdate.mockResolvedValue(stateDoc);
    whiteboardVersions.create.mockResolvedValue(versionDoc);
    whiteboardVersions.findOne.mockResolvedValue(versionDoc);

    const version = await service.createWhiteboardCheckpoint(sessionId, 'batch-1', teacher, {
      batchId: 'batch-1',
      snapshot: whiteboardSnapshot(),
      reason: 'manual-save'
    });

    expect(version.reason).toBe('manual-save');
    expect(version.summary.pageCount).toBe(1);
    expect(stateDoc.save).toHaveBeenCalled();
    expect(whiteboardVersions.find).toHaveBeenCalledWith({ sessionId });
  });

  it('lists admin class session reports with attendance and teacher enrichment', async () => {
    const { service, classSessions, rooms } = createService();
    const completedAt = new Date('2026-06-22T11:00:00.000Z');
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt
    });
    classSessions.find
      .mockReturnValueOnce(sessionFindResult([completed]))
      .mockReturnValueOnce(execResult([completed]));
    classSessions.countDocuments.mockReturnValue(execResult(1));
    rooms.summarizeClassSessionAttendance.mockResolvedValue({
      enrolled: 3,
      present: 2,
      absent: 1,
      reconnects: 1,
      averageDurationSeconds: 1800
    });

    const report = await service.listAdminClassSessionReports({ status: 'completed' }, admin());

    expect(report.total).toBe(1);
    expect(report.summary).toEqual({
      totalSessions: 1,
      liveSessions: 0,
      completedSessions: 1,
      averageAttendancePercent: 67
    });
    const [row] = report.items;
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.batchId).toBe('batch-1');
    expect(row?.batchName).toBe('Native SFU');
    expect(row?.teacherId).toBe('teacher-1');
    expect(row?.teacherName).toBe('Ada Teacher');
    expect(row?.teacherEmail).toBe('teacher@example.test');
    expect(row?.status).toBe('completed');
    expect(row?.attendance).toEqual({
      enrolled: 3,
      present: 2,
      absent: 1,
      reconnects: 1,
      averageDurationSeconds: 1800
    });
    expect(classSessions.find.mock.calls[0]?.[0]).toEqual({ status: 'completed' });
    expect(rooms.summarizeClassSessionAttendance).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      completedAt
    });
  });

  it('rejects admin reports for non-admin users', async () => {
    const { service, classSessions } = createService();

    let thrown: unknown;
    try {
      await service.listAdminClassSessionReports({}, teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(classSessions.find).not.toHaveBeenCalled();
  });

  it('summarizes admin attendance analytics from roster-backed room attendance rows', async () => {
    const { service, classSessions, rooms } = createService();
    const completedAt = new Date('2026-06-22T11:00:00.000Z');
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt
    });
    classSessions.find.mockReturnValueOnce(sessionFindResult([completed]));
    rooms.classSessionAttendanceRows.mockResolvedValue(attendanceRows());

    const summary = await service.getAdminAttendanceSummary({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, admin());

    expect(summary).toEqual({
      totalSessions: 1,
      completedSessions: 1,
      totalEnrolledStudents: 3,
      averageAttendanceRate: 67,
      averageDurationSeconds: 1200,
      absentCount: 1,
      lateJoinCount: 1,
      earlyLeaveCount: 1,
      reconnectCount: 1
    });
    expect(rooms.classSessionAttendanceRows).toHaveBeenCalledWith({
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      completedAt
    });
  });

  it('prefers persisted attendance snapshots over inferred room attendance for completed analytics', async () => {
    const { service, classSessions, attendanceSnapshots, rooms } = createService();
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt: new Date('2026-06-22T11:00:00.000Z')
    });
    classSessions.find.mockReturnValueOnce(sessionFindResult([completed]));
    attendanceSnapshots.find.mockReturnValueOnce({
      sort: jest.fn(() => execResult(attendanceSnapshotDocs()))
    });
    rooms.classSessionAttendanceRows.mockResolvedValue([
      ...attendanceRows(),
      {
        studentId: 'late-enrollment',
        displayName: 'Late Enrollment',
        email: 'late@example.test',
        totalDurationSeconds: 0,
        reconnectCount: 0,
        status: 'absent'
      }
    ]);

    const summary = await service.getAdminAttendanceSummary({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, admin());

    expect(summary.totalEnrolledStudents).toBe(2);
    expect(summary.averageAttendanceRate).toBe(50);
    expect(rooms.classSessionAttendanceRows).not.toHaveBeenCalled();
  });

  it('returns per-session student attendance rows with source metadata', async () => {
    const { service, classSessions, attendanceSnapshots } = createService();
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt: new Date('2026-06-22T11:00:00.000Z')
    });
    classSessions.findById.mockResolvedValue(completed);
    classSessions.find.mockReturnValueOnce(sessionFindResult([completed]));
    attendanceSnapshots.find
      .mockReturnValueOnce({
        sort: jest.fn(() => execResult(attendanceSnapshotDocs()))
      })
      .mockReturnValueOnce({
        sort: jest.fn(() => execResult(attendanceSnapshotDocs()))
      });

    const response = await service.listAdminAttendanceSessionStudents(sessionId, admin());

    expect(response.source).toBe('snapshot');
    expect(response.total).toBe(2);
    expect(response.session.attendanceSource).toBe('snapshot');
    expect(response.items[0]?.studentId).toBe('student-1');
    expect(response.items[0]?.attendanceSource).toBe('snapshot');
    expect(response.items[0]?.rosterSource).toBe('roster');
    expect(response.items[0]?.firstJoinAt).toBe('2026-06-22T10:12:00.000Z');
  });

  it('lists admin student attendance rows with per-student rates', async () => {
    const { service, classSessions, rooms } = createService();
    const completedAt = new Date('2026-06-22T11:00:00.000Z');
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt
    });
    classSessions.find.mockReturnValueOnce(sessionFindResult([completed])).mockReturnValueOnce(sessionFindResult([completed]));
    rooms.classSessionAttendanceRows.mockResolvedValue(attendanceRows());

    const response = await service.listAdminAttendanceStudents({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, admin());

    expect(response.total).toBe(3);
    expect(response.summary.averageAttendanceRate).toBe(67);
    expect(response.items.map((row) => row.studentId)).toEqual(['student-1', 'student-2', 'student-3']);
    expect(response.items[0]?.sessionsEnrolled).toBe(1);
    expect(response.items[0]?.sessionsAttended).toBe(1);
    expect(response.items[0]?.attendanceRate).toBe(100);
    expect(response.items[0]?.averageDurationSeconds).toBe(1800);
    expect(response.items[0]?.reconnects).toBe(1);
    expect(response.items[1]?.sessionsEnrolled).toBe(1);
    expect(response.items[1]?.sessionsAttended).toBe(1);
    expect(response.items[1]?.attendanceRate).toBe(100);
    expect(response.items[1]?.averageDurationSeconds).toBe(600);
    expect(response.items[2]?.sessionsEnrolled).toBe(1);
    expect(response.items[2]?.sessionsAttended).toBe(0);
    expect(response.items[2]?.absentCount).toBe(1);
    expect(response.items[2]?.attendanceRate).toBe(0);
  });

  it('exports filtered admin attendance analytics as CSV', async () => {
    const { service, classSessions, rooms } = createService();
    const completed = persistedSession({
      status: 'completed',
      roomId: 'room-1',
      startedAt: new Date('2026-06-22T10:00:00.000Z'),
      completedAt: new Date('2026-06-22T11:00:00.000Z')
    });
    classSessions.find.mockReturnValueOnce(sessionFindResult([completed]));
    rooms.classSessionAttendanceRows.mockResolvedValue(attendanceRows());

    const csv = await service.exportAdminAttendanceCsv({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, admin());

    expect(csv).toContain('Session,Session ID,Course,Batch,Teacher ID,Status');
    expect(csv).toContain('Native SFU - Session 1');
    expect(csv).toContain(',3,2,1,67,1200,1,1,1');
  });

  it('rejects admin attendance analytics for non-admin users', async () => {
    const { service, classSessions } = createService();

    let thrown: unknown;
    try {
      await service.getAdminAttendanceSummary({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(classSessions.find).not.toHaveBeenCalled();
  });

  it('rejects attendance analytics ranges over the configured limit', async () => {
    const { service, classSessions } = createService();

    let thrown: unknown;
    try {
      await service.getAdminAttendanceSummary({ dateFrom: '2025-01-01', dateTo: '2026-06-30' }, admin());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(classSessions.find).not.toHaveBeenCalled();
  });

  function createService(): {
    service: ClassSessionsService;
    batches: {
      findOne: jest.Mock;
      find: jest.Mock;
    };
    classSessions: {
      findById: jest.Mock;
      exists: jest.Mock;
      findOneAndUpdate: jest.Mock;
      findByIdAndUpdate: jest.Mock;
      find: jest.Mock;
      countDocuments: jest.Mock;
    };
    attendanceSnapshots: {
      exists: jest.Mock;
      find: jest.Mock;
      bulkWrite: jest.Mock;
    };
    materials: {
      find: jest.Mock;
      create: jest.Mock;
      findOne: jest.Mock;
      findOneAndUpdate: jest.Mock;
      updateMany: jest.Mock;
    };
    postClassThreadStates: {
      find: jest.Mock;
      findOneAndUpdate: jest.Mock;
    };
    whiteboardStates: {
      findOne: jest.Mock;
      findOneAndUpdate: jest.Mock;
      find: jest.Mock;
    };
    whiteboardVersions: {
      findOne: jest.Mock;
      create: jest.Mock;
      find: jest.Mock;
      deleteMany: jest.Mock;
    };
    assignments: {
      find: jest.Mock;
    };
    assignmentSubmissions: {
      find: jest.Mock;
    };
    studentEnrollments: {
      isStudentEnrolledInBatch: jest.Mock;
      isStudentHistoricallyEnrolledInBatch: jest.Mock;
      listStudentClassHistoryBatchIds: jest.Mock;
      listBatchRoster: jest.Mock;
    };
    rooms: {
      ensureClassSessionRoom: jest.Mock;
      closeClassSessionRoom: jest.Mock;
      assertClassSessionRoomJoinAllowed: jest.Mock;
      emitClassSessionLifecycleEvent: jest.Mock;
      emitClassSessionMaterialEvent: jest.Mock;
      getClassSessionChatHistory: jest.Mock;
      getClassSessionPostClassStudentChatHistory: jest.Mock;
      getClassSessionPostClassTeacherChatHistory: jest.Mock;
      getClassSessionChatSummary: jest.Mock;
      getClassSessionPostClassStudentChatSummary: jest.Mock;
      getClassSessionPostClassTeacherChatSummary: jest.Mock;
      sendClassSessionPostClassPrivateMessage: jest.Mock;
      sendClassSessionPostClassBroadcastMessage: jest.Mock;
      markClassSessionChatRead: jest.Mock;
      exportClassSessionAttendanceCsv: jest.Mock;
      classSessionAttendanceRows: jest.Mock;
      summarizeClassSessionAttendance: jest.Mock;
    };
    recordings: {
      getClassSessionRecordingSummary: jest.Mock;
      stopActiveClassSessionRecording: jest.Mock;
      startClassSessionRecording: jest.Mock;
      stopClassSessionRecording: jest.Mock;
      listClassSessionRecordings: jest.Mock;
      listAuthorizedClassSessionRecordings: jest.Mock;
      readClassSessionRecordingDownload: jest.Mock;
      readAuthorizedClassSessionRecordingDownload: jest.Mock;
      updateClassSessionRecordingPublication: jest.Mock;
    };
    auditLogs: {
      record: jest.Mock;
    };
    activity: {
      record: jest.Mock;
      listTimeline: jest.Mock;
    };
    metrics: {
      classSessionLifecycleTransitions: { labels: jest.Mock };
      classSessionJoinAttempts: { labels: jest.Mock };
      classSessionChatFailures: { labels: jest.Mock };
      classSessionMaterialActions: { labels: jest.Mock };
    };
  } {
    const batches = {
      findOne: jest.fn(() => execResult(batch)),
      find: jest.fn(() => ({
        select: jest.fn(() => execResult([batch])),
        exec: jest.fn(async () => [batch])
      }))
    };
    const batchSchedules = {
      find: jest.fn(() => ({
        sort: jest.fn(() => execResult(schedules))
      }))
    };
    const classSessions = {
      findById: jest.fn(async () => null),
      exists: jest.fn(async () => null),
      findOneAndUpdate: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          exec: jest.fn(async () => [])
        }))
      })),
      countDocuments: jest.fn(() => execResult(0))
    };
    const attendanceSnapshots = {
      exists: jest.fn(async () => null),
      find: jest.fn(() => ({
        sort: jest.fn(() => execResult([]))
      })),
      bulkWrite: jest.fn(async () => ({ insertedCount: 0 }))
    };
    const materials = {
      find: jest.fn(() => ({
        sort: jest.fn(() => execResult([]))
      })),
      create: jest.fn(async (payload: Record<string, unknown>) => ({
        id: payload.materialId,
        ...payload,
        createdAt: new Date('2026-06-22T10:00:00.000Z'),
        updatedAt: new Date('2026-06-22T10:00:00.000Z')
      })),
      findOne: jest.fn(async () => null),
      findOneAndUpdate: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ modifiedCount: 0 }))
    };
    const postClassThreadStates = {
      find: jest.fn(() => execResult([])),
      findOneAndUpdate: jest.fn(async () => null)
    };
    const whiteboardStates = {
      findOne: jest.fn(async () => null),
      findOneAndUpdate: jest.fn(async () => null),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          limit: jest.fn(() => execResult([]))
        }))
      }))
    };
    const whiteboardVersions = {
      findOne: jest.fn(async () => null),
      create: jest.fn(async (payload: Record<string, unknown>) => ({
        id: payload.versionId,
        ...payload,
        createdAt: new Date('2026-06-22T10:00:00.000Z'),
        updatedAt: new Date('2026-06-22T10:00:00.000Z')
      })),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          limit: jest.fn(() => execResult([])),
          skip: jest.fn(() => ({
            select: jest.fn(() => ({
              lean: jest.fn(() => execResult([]))
            }))
          }))
        }))
      })),
      deleteMany: jest.fn(async () => ({ deletedCount: 0 }))
    };
    const assignments = {
      find: jest.fn(() => execResult([]))
    };
    const assignmentSubmissions = {
      find: jest.fn(() => execResult([]))
    };
    const studentEnrollments = {
      isStudentEnrolledInBatch: jest.fn(async () => true),
      isStudentHistoricallyEnrolledInBatch: jest.fn(async () => true),
      listStudentClassHistoryBatchIds: jest.fn(async () => ['batch-1']),
      listBatchRoster: jest.fn(async () => [])
    };
    const rooms = {
      ensureClassSessionRoom: jest.fn(),
      closeClassSessionRoom: jest.fn(async () => true),
      assertClassSessionRoomJoinAllowed: jest.fn(async () => undefined),
      emitClassSessionLifecycleEvent: jest.fn(),
      emitClassSessionMaterialEvent: jest.fn(),
      getClassSessionChatHistory: jest.fn(),
      getClassSessionPostClassStudentChatHistory: jest.fn(async () => ({ messages: [] })),
      getClassSessionPostClassTeacherChatHistory: jest.fn(async () => ({ messages: [] })),
      getClassSessionChatSummary: jest.fn(),
      getClassSessionPostClassStudentChatSummary: jest.fn(async () => ({ sessionId, roomId: 'room-1', threads: [] })),
      getClassSessionPostClassTeacherChatSummary: jest.fn(async () => ({ sessionId, roomId: 'room-1', threads: [] })),
      sendClassSessionPostClassPrivateMessage: jest.fn(),
      sendClassSessionPostClassBroadcastMessage: jest.fn(),
      markClassSessionChatRead: jest.fn(),
      exportClassSessionAttendanceCsv: jest.fn(),
      classSessionAttendanceRows: jest.fn(async () => []),
      summarizeClassSessionAttendance: jest.fn(async () => ({
        enrolled: 0,
        present: 0,
        absent: 0,
        reconnects: 0,
        averageDurationSeconds: 0
      }))
    };
    const recordings = {
      getClassSessionRecordingSummary: jest.fn(async () => ({})),
      stopActiveClassSessionRecording: jest.fn(async () => null),
      startClassSessionRecording: jest.fn(),
      stopClassSessionRecording: jest.fn(),
      listClassSessionRecordings: jest.fn(async () => []),
      listAuthorizedClassSessionRecordings: jest.fn(async () => []),
      readClassSessionRecordingDownload: jest.fn(),
      readAuthorizedClassSessionRecordingDownload: jest.fn(),
      updateClassSessionRecordingPublication: jest.fn()
    };
    const liveSettings = {
      media: {
        studentsJoinMuted: true,
        studentsJoinCameraOff: true,
        requirePrejoinDeviceCheck: true,
        allowStudentsToUnmuteSelf: true,
        allowStudentsToStartCameraSelf: true
      },
      chat: {
        privateTeacherStudentChatEnabled: true,
        teacherBroadcastEnabled: true,
        chatAttachmentsEnabled: true,
        messageLengthLimit: 2000
      },
      whiteboard: {
        whiteboardSharingEnabled: true,
        studentWhiteboardControlEnabled: true,
        maxActiveWhiteboardControllers: 1
      },
      speaking: {
        handRaiseEnabled: true,
        maxActiveSpeakers: 3,
        autoLowerHandAfterSpeakPermissionEnds: true
      },
      recording: {
        recordingEnabled: true,
        autoRecordOnStart: false,
        teacherManualRecordingControlEnabled: true,
        visibility: 'enrolled_students'
      },
      attendance: {
        presentThresholdMinutes: 10,
        presentThresholdPercentage: 50,
        lateJoinThresholdMinutes: 10,
        countReconnects: true,
        teacherAttendanceExportEnabled: true
      },
      access: {
        waitingRoomEnabled: false,
        lockClassAfterTeacherStarts: false,
        allowEnrolledStudentReconnectAfterLock: true,
        teacherReconnectGraceMessagingEnabled: true
      }
    };
    const profiles = {
      resolveBatchLiveSettings: jest.fn(async () => ({
        batchId: 'batch-1',
        teacherId: 'teacher-1',
        systemDefaults: liveSettings,
        teacherDefaults: liveSettings,
        overrides: {},
        resolved: liveSettings
      })),
      resolveLiveSettings: jest.fn((settings) => settings ?? liveSettings)
    };
    const users = {
      find: jest.fn(() =>
        execResult([
          {
            id: 'teacher-1',
            displayName: 'Ada Teacher',
            email: 'teacher@example.test'
          }
        ])
      ),
      findById: jest.fn(() =>
        execResult({
          id: 'student-1',
          displayName: 'Student One',
          name: 'Student One',
          email: 'student@example.test'
        })
      )
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => fallback)
    };
    const classSessionMetric = { inc: jest.fn() };
    const metrics = {
      classSessionLifecycleTransitions: {
        labels: jest.fn(() => classSessionMetric)
      },
      classSessionJoinAttempts: {
        labels: jest.fn(() => classSessionMetric)
      },
      classSessionChatFailures: {
        labels: jest.fn(() => classSessionMetric)
      },
      classSessionMaterialActions: {
        labels: jest.fn(() => classSessionMetric)
      }
    };
    const auditLogs = {
      record: jest.fn(async () => undefined)
    };
    const activity = {
      record: jest.fn(async () => undefined),
      listTimeline: jest.fn(async () => ({
        sessionId,
        batchId: 'batch-1',
        visibility: 'full',
        items: [],
        limit: 50,
        hasMore: false
      }))
    };

    return {
      service: new ClassSessionsService(
        batches as never,
        batchSchedules as never,
        classSessions as never,
        attendanceSnapshots as never,
        materials as never,
        postClassThreadStates as never,
        whiteboardStates as never,
        whiteboardVersions as never,
        assignments as never,
        assignmentSubmissions as never,
        studentEnrollments as never,
        rooms as never,
        recordings as never,
        profiles as never,
        config as never,
        users as never,
        auditLogs as never,
        activity as never,
        metrics as never
      ),
      batches,
      classSessions,
      attendanceSnapshots,
      materials,
      postClassThreadStates,
      whiteboardStates,
      whiteboardVersions,
      assignments,
      assignmentSubmissions,
      studentEnrollments,
      rooms,
      recordings,
      auditLogs,
      activity,
      metrics
    };
  }

  function persistedSession(overrides: {
    status: 'scheduled' | 'live' | 'completed' | 'cancelled';
    roomId: string;
    startedAt?: Date;
    completedAt?: Date;
  }): Record<string, unknown> {
    return {
      id: sessionId,
      _id: sessionId,
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      title: 'Native SFU - Session 1',
      sessionNumber: 1,
      scheduledAt: new Date('2026-06-22T10:00:00.000Z'),
      durationMinutes: 60,
      chatChannelId: `classroom:${sessionId}:chat`,
      whiteboardChannelId: `classroom:${sessionId}:whiteboard`,
      ...overrides
    };
  }

  function materialDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: 'material-1',
      materialId: 'material-1',
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      title: 'Lesson deck',
      kind: 'link',
      source: 'link',
      url: 'https://example.test/deck',
      uploadedByUserId: 'teacher-1',
      shared: false,
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      updatedAt: new Date('2026-06-22T10:00:00.000Z'),
      ...overrides
    };
  }

  function whiteboardSnapshot(): WhiteboardMemorySnapshot {
    return {
      schemaVersion: 1,
      activePageId: 'page-1',
      pages: [
        {
          id: 'page-1',
          title: 'Limits warmup',
          tags: ['calculus', 'limits'],
          order: 0,
          template: 'graph',
          view: { zoom: 1, panX: 0, panY: 0 },
          background: null,
          elements: [
            {
              id: 'element-1',
              type: 'text',
              text: 'lim x -> 0',
              position: { x: 100, y: 120 },
              color: '#111827',
              fontSize: 22
            }
          ]
        }
      ]
    };
  }

  function whiteboardStateDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> & { save: jest.Mock } {
    return {
      id: 'whiteboard-state-1',
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      whiteboardChannelId: `classroom:${sessionId}:whiteboard`,
      schemaVersion: 1,
      snapshotVersion: 1,
      currentSnapshot: whiteboardSnapshot(),
      pages: [
        {
          pageId: 'page-1',
          title: 'Limits warmup',
          tags: ['calculus', 'limits'],
          order: 0,
          elementCount: 1
        }
      ],
      pageCount: 1,
      elementCount: 1,
      createdByUserId: 'teacher-1',
      updatedByUserId: 'teacher-1',
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      updatedAt: new Date('2026-06-22T10:05:00.000Z'),
      save: jest.fn(async () => undefined),
      ...overrides
    };
  }

  function whiteboardVersionDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: 'whiteboard-version-1',
      versionId: 'whiteboard-version-1',
      sessionId,
      batchId: 'batch-1',
      roomId: 'room-1',
      whiteboardChannelId: `classroom:${sessionId}:whiteboard`,
      reason: 'manual-save',
      schemaVersion: 1,
      snapshotVersion: 1,
      snapshot: whiteboardSnapshot(),
      pages: [
        {
          pageId: 'page-1',
          title: 'Limits warmup',
          tags: ['calculus', 'limits'],
          order: 0,
          elementCount: 1
        }
      ],
      pageCount: 1,
      elementCount: 1,
      createdByUserId: 'teacher-1',
      createdAt: new Date('2026-06-22T10:06:00.000Z'),
      updatedAt: new Date('2026-06-22T10:06:00.000Z'),
      ...overrides
    };
  }

  function attendanceRows(): Array<{
    studentId: string;
    displayName: string;
    email: string;
    firstJoinAt?: Date;
    lastLeaveAt?: Date;
    totalDurationSeconds: number;
    reconnectCount: number;
    status: 'present' | 'absent';
  }> {
    return [
      {
        studentId: 'student-1',
        displayName: 'Ava Present',
        email: 'ava@example.test',
        firstJoinAt: new Date('2026-06-22T10:12:00.000Z'),
        lastLeaveAt: new Date('2026-06-22T10:45:00.000Z'),
        totalDurationSeconds: 1800,
        reconnectCount: 1,
        status: 'present'
      },
      {
        studentId: 'student-2',
        displayName: 'Ben Present',
        email: 'ben@example.test',
        firstJoinAt: new Date('2026-06-22T10:00:00.000Z'),
        lastLeaveAt: new Date('2026-06-22T11:00:00.000Z'),
        totalDurationSeconds: 600,
        reconnectCount: 0,
        status: 'present'
      },
      {
        studentId: 'student-3',
        displayName: 'Cora Absent',
        email: 'cora@example.test',
        totalDurationSeconds: 0,
        reconnectCount: 0,
        status: 'absent'
      }
    ];
  }

  function attendanceSnapshotDocs(): Array<{
    studentId: string;
    studentName: string;
    studentEmail?: string;
    enrolledAt?: Date;
    rosterSource: 'roster' | 'participant';
    firstJoinAt?: Date;
    lastLeaveAt?: Date;
    totalDurationSeconds: number;
    reconnectCount: number;
    status: 'present' | 'absent';
  }> {
    return [
      {
        studentId: 'student-1',
        studentName: 'Ava Present',
        studentEmail: 'ava@example.test',
        enrolledAt: new Date('2026-06-20T10:00:00.000Z'),
        rosterSource: 'roster',
        firstJoinAt: new Date('2026-06-22T10:12:00.000Z'),
        lastLeaveAt: new Date('2026-06-22T10:45:00.000Z'),
        totalDurationSeconds: 1800,
        reconnectCount: 1,
        status: 'present'
      },
      {
        studentId: 'student-2',
        studentName: 'Ben Absent',
        studentEmail: 'ben@example.test',
        enrolledAt: new Date('2026-06-20T10:00:00.000Z'),
        rosterSource: 'roster',
        totalDurationSeconds: 0,
        reconnectCount: 0,
        status: 'absent'
      }
    ];
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

  function admin(): AuthenticatedUser {
    return {
      sub: 'admin-1',
      email: 'admin@example.test',
      roles: ['ADMIN'],
      permissions: [],
      tokenId: 'token-3'
    };
  }

  function execResult<T>(value: T): { exec: jest.Mock<Promise<T>, []> } {
    return { exec: jest.fn(async () => value) };
  }

  function sessionFindResult<T>(value: T): unknown {
    return {
      sort: jest.fn(() => ({
        skip: jest.fn(() => ({
          limit: jest.fn(() => execResult(value))
        })),
        exec: jest.fn(async () => value)
      }))
    };
  }
});
