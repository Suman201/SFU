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
    studentEnrollments: {
      isStudentEnrolledInBatch: jest.Mock;
      listBatchRoster: jest.Mock;
    };
    rooms: {
      ensureClassSessionRoom: jest.Mock;
      closeClassSessionRoom: jest.Mock;
      assertClassSessionRoomJoinAllowed: jest.Mock;
      emitClassSessionLifecycleEvent: jest.Mock;
      emitClassSessionMaterialEvent: jest.Mock;
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
    const studentEnrollments = {
      isStudentEnrolledInBatch: jest.fn(async () => true),
      listBatchRoster: jest.fn(async () => [])
    };
    const rooms = {
      ensureClassSessionRoom: jest.fn(),
      closeClassSessionRoom: jest.fn(async () => true),
      assertClassSessionRoomJoinAllowed: jest.fn(async () => undefined),
      emitClassSessionLifecycleEvent: jest.fn(),
      emitClassSessionMaterialEvent: jest.fn(),
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
      )
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => fallback)
    };

    return {
      service: new ClassSessionsService(
        batches as never,
        batchSchedules as never,
        classSessions as never,
        attendanceSnapshots as never,
        materials as never,
        studentEnrollments as never,
        rooms as never,
        recordings as never,
        profiles as never,
        config as never,
        users as never
      ),
      classSessions,
      attendanceSnapshots,
      materials,
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
