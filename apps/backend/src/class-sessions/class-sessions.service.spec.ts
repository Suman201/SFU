import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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
    const { service, classSessions, rooms } = createService();
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
    const { service, classSessions, rooms } = createService();
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

  it('keeps the session completed and emits ended when media room close fails after DB completion', async () => {
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

    let thrown: unknown;
    try {
      await service.endSession(sessionId, teacher);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('media close failed');
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

  it('returns completed payload idempotently when ending an already completed session', async () => {
    const { service, classSessions, rooms } = createService();
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
    expect(rooms.closeClassSessionRoom).not.toHaveBeenCalled();
    expect(rooms.emitClassSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it('returns current session metadata for an enrolled student', async () => {
    const { service, classSessions, studentEnrollments } = createService();
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

  it('blocks joining before a session is live', async () => {
    const { service, classSessions } = createService();
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
    const { service, classSessions, studentEnrollments, rooms } = createService();
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
      await service.joinSession(sessionId, undefined, student());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
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
      completedAt
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
    classSessions: {
      findById: jest.Mock;
      exists: jest.Mock;
      findOneAndUpdate: jest.Mock;
      findByIdAndUpdate: jest.Mock;
      find: jest.Mock;
      countDocuments: jest.Mock;
    };
    studentEnrollments: {
      isStudentEnrolledInBatch: jest.Mock;
      listBatchRoster: jest.Mock;
    };
    rooms: {
      ensureClassSessionRoom: jest.Mock;
      closeClassSessionRoom: jest.Mock;
      assertClassSessionRoomJoinAllowed: jest.Mock;
      emitClassSessionLifecycleEvent: jest.Mock;
      getClassSessionChatHistory: jest.Mock;
      getClassSessionChatSummary: jest.Mock;
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
      readClassSessionRecordingDownload: jest.Mock;
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
    const studentEnrollments = {
      isStudentEnrolledInBatch: jest.fn(async () => true),
      listBatchRoster: jest.fn(async () => [])
    };
    const rooms = {
      ensureClassSessionRoom: jest.fn(),
      closeClassSessionRoom: jest.fn(async () => true),
      assertClassSessionRoomJoinAllowed: jest.fn(async () => undefined),
      emitClassSessionLifecycleEvent: jest.fn(),
      getClassSessionChatHistory: jest.fn(),
      getClassSessionChatSummary: jest.fn(),
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
      readClassSessionRecordingDownload: jest.fn()
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
      )
    };

    return {
      service: new ClassSessionsService(
        batches as never,
        batchSchedules as never,
        classSessions as never,
        studentEnrollments as never,
        rooms as never,
        recordings as never,
        users as never
      ),
      classSessions,
      studentEnrollments,
      rooms,
      recordings
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
