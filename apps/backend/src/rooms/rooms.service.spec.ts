import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DEFAULT_PARTICIPANT_PERMISSIONS, Role, type ConsumerLayerEvent, type RoomQualityState, type RoomQualitySummaryState } from '@native-sfu/contracts';
import { CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS, RoomsService, type SocketUser } from './rooms.service';
import { defaultConsumerLayers, defaultConsumerPriority, defaultProducerPriority, resolveRoomMediaProfile } from './room-policy';

describe('RoomsService', () => {
  it('requires the host role to create a room', async () => {
    const { service, nodeRegistry } = createService();

    let thrown: unknown;
    try {
      await service.createRoom(
        {
          id: 'student-1',
          email: 'student@example.com',
          roles: [Role.PARTICIPANT]
        },
        'socket-1',
        { name: 'Student Room' }
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(nodeRegistry.assertLocalCanOwnNewRoom).not.toHaveBeenCalled();
  });

  it('preallocates the host participant id before persisting a room', async () => {
    const { service, nodeRegistry, rooms, redis, metrics } = createService();
    const roomsModel = rooms as any;
    const nodeRegistryService = nodeRegistry as any;
    const redisService = redis as any;
    const metricsService = metrics as any;
    const createdRoom = {
      id: 'room-1',
      hostId: '',
      save: jest.fn(async () => undefined)
    };
    let persistedHostId = '';

    roomsModel.create = jest.fn(async (payload: { hostId: string }) => {
      persistedHostId = payload.hostId;
      createdRoom.hostId = payload.hostId;
      return createdRoom;
    });
    nodeRegistryService.claimRoom = jest.fn(async () => undefined);
    redisService.markPresence = jest.fn(async () => undefined);
    metricsService.activeRooms.inc = jest.fn();
    jest.spyOn(service as any, 'createParticipant').mockImplementation(async () => ({ id: persistedHostId }));
    jest.spyOn(service as any, 'getRoom').mockImplementation(async () => ({ id: 'room-1', hostId: persistedHostId, participants: [] }));

    const room = await service.createRoom(
      {
        id: 'host-1',
        email: 'teacher.one@example.com',
        roles: [Role.HOST]
      },
      'socket-1',
      { name: 'Teacher Room', maxParticipants: 8 }
    );

    expect(typeof persistedHostId).toBe('string');
    expect(persistedHostId.length).toBe(24);
    expect(createdRoom.hostId).toBe(persistedHostId);
    expect((service as any).createParticipant).toHaveBeenCalledWith(
      'room-1',
      {
        id: 'host-1',
        email: 'teacher.one@example.com',
        roles: [Role.HOST]
      },
      'socket-1',
      Role.HOST,
      DEFAULT_PARTICIPANT_PERMISSIONS,
      true,
      undefined,
      persistedHostId
    );
    expect(redisService.markPresence).toHaveBeenCalledWith('room-1', persistedHostId, 'socket-1', { userId: undefined, nodeId: 'node-a' });
    expect(metricsService.activeRooms.inc).toHaveBeenCalled();
    expect(room.hostId).toBe(persistedHostId);
  });

  it('creates and claims a real classroom-profile room for a class session', async () => {
    const { service, rooms, classSessions, nodeRegistry, metrics } = createService();
    const roomDoc = {
      id: 'room-1',
      hostId: 'placeholder-host',
      mediaProfile: { id: 'classroom' },
      save: jest.fn(async () => undefined)
    };

    classSessions.findById.mockResolvedValue(null);
    rooms.create.mockResolvedValue(roomDoc);
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({
      id: 'room-1',
      hostId: 'placeholder-host',
      mediaProfile: { id: 'classroom' },
      participants: []
    });

    const room = await service.ensureClassSessionRoom({
      sessionId: 'session-1',
      batchId: 'batch-1',
      title: 'Classroom Session',
      teacherId: 'teacher-1'
    });

    const createdPayload = rooms.create.mock.calls[0]?.[0];
    expect(createdPayload.name).toBe('Classroom Session');
    expect(createdPayload.settings.visibility).toBe('private');
    expect(createdPayload.settings.waitingRoomEnabled).toBe(false);
    expect(createdPayload.settings.joinApprovalRequired).toBe(false);
    expect(createdPayload.mediaProfile.id).toBe('classroom');
    expect(nodeRegistry.claimRoom).toHaveBeenCalledWith('room-1');
    expect(metrics.activeRooms.inc).toHaveBeenCalled();
    expect(metrics.roomProfileDistribution.labels).toHaveBeenCalledWith('classroom');
    expect(room.id).toBe('room-1');
  });

  const nonLiveClassSessionJoinCases: Array<{ status: 'scheduled' | 'completed'; message: string }> = [
    { status: 'scheduled', message: 'The teacher has not started this class session yet.' },
    { status: 'completed', message: 'This class session has ended.' }
  ];
  for (const { status, message } of nonLiveClassSessionJoinCases) {
    it(`rejects socket joins for ${status} class-session rooms`, async () => {
      const { service, rooms, classSessions } = createService();
      classSessions.findOne.mockResolvedValue({
        id: 'session-1',
        roomId: 'room-1',
        teacherId: 'teacher-1',
        status
      });

      let thrown: unknown;
      try {
        await service.joinRoom(
          {
            id: 'student-1',
            email: 'student@example.test',
            roles: ['STUDENT']
          },
          'socket-1',
          { roomId: 'room-1', displayName: 'Student One' }
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as Error | undefined)?.message).toBe(message);
      expect(rooms.findById).not.toHaveBeenCalled();
    });
  }

  it('joins students to live class-session rooms with audio/video publish permissions only', async () => {
    const { service, rooms, classSessions, participants, redis } = createService();
    const room = {
      id: 'room-1',
      hostId: 'host-placeholder',
      closedAt: undefined,
      invitedUserIds: [],
      settings: {
        locked: false,
        waitingRoomEnabled: false,
        joinApprovalRequired: false,
        visibility: 'private',
        maxParticipants: 8
      },
      mediaProfile: { id: 'classroom' }
    };
    const participant = { id: 'participant-1', admitted: true };

    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      teacherId: 'teacher-1',
      status: 'live'
    });
    rooms.findById.mockResolvedValue(room);
    participants.findOne.mockResolvedValue(null);
    participants.countDocuments.mockResolvedValue(0);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertNotBanned').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getRoomPolicyContext').mockResolvedValue({ room, summary: summaryState() });
    jest.spyOn(service as any, 'createParticipant').mockResolvedValue(participant);
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({
      id: 'room-1',
      participants: [{ id: 'participant-1', admitted: true }]
    });

    const response = await service.joinRoom(
      {
        id: 'student-1',
        email: 'student@example.test',
        roles: ['STUDENT']
      },
      'socket-1',
      { roomId: 'room-1', displayName: 'Student One' }
    );

    expect((service as any).createParticipant).toHaveBeenCalledWith(
      'room-1',
      {
        id: 'student-1',
        email: 'student@example.test',
        roles: ['STUDENT']
      },
      'socket-1',
      Role.PARTICIPANT,
      {
        canPublishAudio: true,
        canPublishVideo: true,
        canShareScreen: false,
        canChat: true
      },
      true,
      'Student One'
    );
    expect(redis.markPresence).toHaveBeenCalledWith('room-1', 'participant-1', 'socket-1', { userId: undefined, nodeId: 'node-a' });
    expect(response.admitted).toBe(true);
  });

  it('rejects socket joins for non-enrolled students in live class-session rooms', async () => {
    const { service, rooms, classSessions, studentEnrollments } = createService();
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      teacherId: 'teacher-1',
      status: 'live'
    });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);
    const createParticipant = jest.spyOn(service as any, 'createParticipant');

    let thrown: unknown;
    try {
      await service.joinRoom(
        {
          id: 'student-2',
          email: 'student.two@example.test',
          roles: ['STUDENT']
        },
        'socket-2',
        { roomId: 'room-1', displayName: 'Student Two' }
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-2', 'batch-1');
    expect(rooms.findById).not.toHaveBeenCalled();
    expect(createParticipant).not.toHaveBeenCalled();
  });

  it('lets the batch teacher watch class-session lifecycle events', async () => {
    const { service, classSessions, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1'
    });

    await service.assertCanWatchClassSession('session-1', {
      id: 'teacher-1',
      email: 'teacher@example.test',
      roles: ['TEACHER']
    });

    expect(studentEnrollments.isStudentEnrolledInBatch).not.toHaveBeenCalled();
  });

  it('lets admins watch class-session lifecycle events', async () => {
    const { service, classSessions, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1'
    });

    await service.assertCanWatchClassSession('session-1', {
      id: 'admin-1',
      email: 'admin@example.test',
      roles: ['ADMIN']
    });
    await service.assertCanWatchClassSession('session-1', {
      id: 'super-admin-1',
      email: 'super.admin@example.test',
      roles: ['SUPER_ADMIN']
    });

    expect(studentEnrollments.isStudentEnrolledInBatch).not.toHaveBeenCalled();
  });

  it('lets active enrolled students watch class-session lifecycle events', async () => {
    const { service, classSessions, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1'
    });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);

    await service.assertCanWatchClassSession('session-1', {
      id: 'student-1',
      email: 'student@example.test',
      roles: ['STUDENT']
    });

    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
  });

  it('lets the batch teacher watch planned lifecycle events with a targeted batch lookup', async () => {
    const { service, classSessions, batches, batchSchedules, studentEnrollments } = createService();
    const sessionId = 'batch-1-MONDAY-2026-06-21';
    classSessions.findById.mockResolvedValue(null);
    batches.findOne.mockResolvedValue(plannedBatchDoc());
    batchSchedules.find.mockReturnValueOnce({
      sort: jest.fn(async () => [plannedScheduleDoc()])
    });

    await service.assertCanWatchClassSession(
      sessionId,
      {
        id: 'teacher-1',
        email: 'teacher@example.test',
        roles: ['TEACHER']
      },
      'batch-1'
    );

    expect(batches.findOne).toHaveBeenCalledWith({ _id: 'batch-1', deletedAt: { $exists: false } });
    expect(batchSchedules.find).toHaveBeenCalledWith({ batchId: 'batch-1' });
    expect(batches.find).not.toHaveBeenCalled();
    expect(studentEnrollments.isStudentEnrolledInBatch).not.toHaveBeenCalled();
  });

  it('lets admins watch planned lifecycle events with a targeted batch lookup', async () => {
    const { service, classSessions, batches, batchSchedules, studentEnrollments } = createService();
    const sessionId = 'batch-1-MONDAY-2026-06-21';
    classSessions.findById.mockResolvedValue(null);
    batches.findOne.mockResolvedValue(plannedBatchDoc());
    batchSchedules.find.mockReturnValueOnce({
      sort: jest.fn(async () => [plannedScheduleDoc()])
    });

    await service.assertCanWatchClassSession(
      sessionId,
      {
        id: 'admin-1',
        email: 'admin@example.test',
        roles: ['ADMIN']
      },
      'batch-1'
    );

    expect(studentEnrollments.isStudentEnrolledInBatch).not.toHaveBeenCalled();
    expect(batches.find).not.toHaveBeenCalled();
  });

  it('lets active enrolled students watch planned lifecycle events with the correct batch id', async () => {
    const { service, classSessions, batches, batchSchedules, studentEnrollments } = createService();
    const sessionId = 'batch-1-MONDAY-2026-06-21';
    classSessions.findById.mockResolvedValue(null);
    batches.findOne.mockResolvedValue(plannedBatchDoc());
    batchSchedules.find.mockReturnValueOnce({
      sort: jest.fn(async () => [plannedScheduleDoc()])
    });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);

    await service.assertCanWatchClassSession(
      sessionId,
      {
        id: 'student-1',
        email: 'student@example.test',
        roles: ['STUDENT']
      },
      'batch-1'
    );

    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-1', 'batch-1');
    expect(batches.find).not.toHaveBeenCalled();
  });

  it('blocks non-enrolled students from watching planned lifecycle events', async () => {
    const { service, classSessions, batches, batchSchedules, studentEnrollments } = createService();
    const sessionId = 'batch-1-MONDAY-2026-06-21';
    classSessions.findById.mockResolvedValue(null);
    batches.findOne.mockResolvedValue(plannedBatchDoc());
    batchSchedules.find.mockReturnValueOnce({
      sort: jest.fn(async () => [plannedScheduleDoc()])
    });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.assertCanWatchClassSession(
        sessionId,
        {
          id: 'student-2',
          email: 'student.two@example.test',
          roles: ['STUDENT']
        },
        'batch-1'
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-2', 'batch-1');
    expect(batches.find).not.toHaveBeenCalled();
  });

  it('rejects planned lifecycle watches without a batch id', async () => {
    const { service, classSessions, batches, batchSchedules } = createService();
    classSessions.findById.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.assertCanWatchClassSession('batch-1-MONDAY-2026-06-22', {
        id: 'student-1',
        email: 'student@example.test',
        roles: ['STUDENT']
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(batches.findOne).not.toHaveBeenCalled();
    expect(batchSchedules.find).not.toHaveBeenCalled();
    expect(batches.find).not.toHaveBeenCalled();
  });

  it('rejects planned lifecycle watches when the supplied batch id does not own the session id', async () => {
    const { service, classSessions, batches, batchSchedules, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue(null);
    batches.findOne.mockResolvedValue(plannedBatchDoc({ id: 'batch-2', teacherId: 'teacher-2' }));
    batchSchedules.find.mockReturnValueOnce({
      sort: jest.fn(async () => [plannedScheduleDoc()])
    });

    let thrown: unknown;
    try {
      await service.assertCanWatchClassSession(
        'batch-1-MONDAY-2026-06-22',
        {
          id: 'student-1',
          email: 'student@example.test',
          roles: ['STUDENT']
        },
        'batch-2'
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(studentEnrollments.isStudentEnrolledInBatch).not.toHaveBeenCalled();
    expect(batches.find).not.toHaveBeenCalled();
  });

  it('blocks non-enrolled students from watching class-session lifecycle events', async () => {
    const { service, classSessions, studentEnrollments } = createService();
    classSessions.findById.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1'
    });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.assertCanWatchClassSession('session-1', {
        id: 'student-2',
        email: 'student.two@example.test',
        roles: ['STUDENT']
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-2', 'batch-1');
  });

  for (const status of ['pending', 'suspended', 'cancelled', 'completed', 'deleted']) {
    it(`blocks ${status} student enrollments from watching class-session lifecycle events`, async () => {
      const { service, classSessions, studentEnrollments } = createService();
      classSessions.findById.mockResolvedValue({
        id: 'session-1',
        batchId: 'batch-1',
        teacherId: 'teacher-1'
      });
      studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

      let thrown: unknown;
      try {
        await service.assertCanWatchClassSession('session-1', {
          id: `student-${status}`,
          email: `${status}.student@example.test`,
          roles: ['STUDENT']
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ForbiddenException);
    });
  }

  it('rejects lifecycle watch for unknown class sessions', async () => {
    const { service, classSessions, batches } = createService();
    classSessions.findById.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.assertCanWatchClassSession('missing-session', {
        id: 'student-1',
        email: 'student@example.test',
        roles: ['STUDENT']
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(batches.find).not.toHaveBeenCalled();
  });

  const classSessionModeratorJoinCases: Array<{
    label: string;
    user: SocketUser;
    expectedRole: Role;
    shouldClaimHost: boolean;
  }> = [
    { label: 'teacher', user: { id: 'teacher-1', email: 'teacher@example.test', roles: ['TEACHER'] }, expectedRole: Role.HOST, shouldClaimHost: true },
    { label: 'admin', user: { id: 'admin-1', email: 'admin@example.test', roles: ['ADMIN'] }, expectedRole: Role.CO_HOST, shouldClaimHost: false }
  ];
  for (const { label, user, expectedRole, shouldClaimHost } of classSessionModeratorJoinCases) {
    it(`joins class-session ${label} with moderator entitlement intact`, async () => {
      const { service, rooms, classSessions, participants } = createService();
      const room = {
        id: 'room-1',
        hostId: 'host-placeholder',
        closedAt: undefined,
        invitedUserIds: [],
        settings: {
          locked: false,
          waitingRoomEnabled: false,
          joinApprovalRequired: false,
          visibility: 'private',
          maxParticipants: 8
        },
        mediaProfile: { id: 'classroom' }
      };
      const participant = { id: `${user.id}-participant`, admitted: true };

      classSessions.findOne.mockResolvedValue({
        id: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        teacherId: 'teacher-1',
        status: 'live'
      });
      rooms.findById.mockResolvedValue(room);
      participants.findOne.mockResolvedValue(null);
      participants.countDocuments.mockResolvedValue(0);
      jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
      jest.spyOn(service as any, 'assertNotBanned').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'getRoomPolicyContext').mockResolvedValue({ room, summary: summaryState() });
      jest.spyOn(service as any, 'createParticipant').mockResolvedValue(participant);
      jest.spyOn(service as any, 'getRoom').mockResolvedValue({
        id: 'room-1',
        hostId: shouldClaimHost ? participant.id : room.hostId,
        participants: [{ id: participant.id, admitted: true, role: expectedRole }]
      });

      await service.joinRoom(user, 'socket-1', { roomId: 'room-1', displayName: user.email });

      expect((service as any).createParticipant).toHaveBeenCalledWith(
        'room-1',
        user,
        'socket-1',
        expectedRole,
        DEFAULT_PARTICIPANT_PERMISSIONS,
        true,
        user.email
      );
      if (shouldClaimHost) {
        expect(rooms.updateOne).toHaveBeenCalledWith({ _id: 'room-1' }, { $set: { hostId: participant.id } });
      } else {
        expect(rooms.updateOne).not.toHaveBeenCalled();
      }
    });
  }

  it('keeps a live class-session room open when the teacher socket disconnects', async () => {
    jest.useFakeTimers();
    try {
      const { service, rooms, classSessions, participants, producers, consumers, redis, media } = createService();
      const teacher = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: 'teacher-socket',
        role: Role.HOST,
        displayName: 'Teacher One',
        screenSharing: true
      });
      classSessions.findOne.mockResolvedValue(fakeClassSessionDoc());
      rooms.findById.mockResolvedValue(fakeRoomDoc());
      participants.findOne.mockResolvedValue(teacher);
      participants.find.mockResolvedValue([teacher]);
      producers.find.mockResolvedValueOnce([fakeProducerDoc({ id: 'teacher-video', participantId: 'teacher-participant' })]).mockResolvedValue([]);
      consumers.find.mockResolvedValue([]);

      const result = await service.leaveRoomForSocket('room-1', 'teacher-participant', 'teacher-socket');

      expect(result.closed).toBe(false);
      expect(result.left).toBe(true);
      expect(result.reconnecting).toBe(true);
      expect(result.participantPatch).toEqual({
        connected: false,
        screenSharing: false
      });
      const closeRoomCall = rooms.updateOne.mock.calls.find(([, update]) => Boolean(update?.closedAt));
      expect(closeRoomCall).toBeUndefined();
      expect(media.closeRoom).not.toHaveBeenCalled();
      expect(redis.removePresence).toHaveBeenCalledWith('room-1', 'teacher-participant');
      expect(media.closeParticipantTransports).toHaveBeenCalledWith('teacher-participant');
      const durableGraceUpdate = classSessions.updateOne.mock.calls.find(([filter]) => filter?._id === 'session-1' && filter?.status === 'live')?.[1];
      expect(durableGraceUpdate?.$set?.teacherDisconnectedAt).toBeInstanceOf(Date);
      expect(durableGraceUpdate?.$set?.teacherReconnectDeadlineAt).toBeInstanceOf(Date);
      expect(producers.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', participantId: 'teacher-participant', status: { $ne: 'closed' } });
      expect(producers.updateMany.mock.calls[0]?.[1]?.status).toBe('closed');
      expect(producers.updateMany.mock.calls[0]?.[1]?.closedAt).toBeInstanceOf(Date);
      expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
      service.cancelClassSessionTeacherReconnectGrace('session-1');
    } finally {
      jest.useRealTimers();
    }
  });

  it('auto-completes a live class session when the teacher does not reconnect before grace expires', async () => {
    jest.useFakeTimers();
    try {
      const { service, rooms, classSessions, participants, producers, consumers, media, platformEvents } = createService();
      const lifecycleEvents: Array<{ event: string; payload: unknown }> = [];
      const teacherConnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: 'teacher-socket',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      const teacherDisconnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: '',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      const liveSession = fakeClassSessionDoc({
        teacherDisconnectedAt: new Date(),
        teacherReconnectDeadlineAt: new Date(Date.now() + CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS)
      });
      const completedSession = fakeClassSessionDoc({
        status: 'completed',
        completedAt: new Date('2026-06-22T10:05:00.000Z')
      });
      classSessions.findOne.mockResolvedValue(liveSession);
      classSessions.findById.mockResolvedValue(liveSession);
      classSessions.findOneAndUpdate.mockResolvedValue(completedSession);
      rooms.findById.mockResolvedValue(fakeRoomDoc());
      participants.findOne.mockResolvedValueOnce(teacherConnected).mockResolvedValueOnce(teacherDisconnected);
      participants.find.mockResolvedValue([teacherDisconnected]);
      producers.find.mockResolvedValueOnce([fakeProducerDoc({ id: 'teacher-video', participantId: 'teacher-participant' })]).mockResolvedValue([]);
      consumers.find.mockResolvedValue([]);
      media.closeRoom.mockResolvedValue({
        participantIds: ['teacher-participant'],
        transportCount: 1,
        consumerCount: 0,
        producerCounts: { video: 1 },
        pipeTransportCount: 0
      });
      service.onClassSessionLifecycleEvent((event, payload) => lifecycleEvents.push({ event, payload }));

      await service.leaveRoomForSocket('room-1', 'teacher-participant', 'teacher-socket');
      await jest.advanceTimersByTimeAsync(CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS);

      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?._id).toBe('session-1');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.status).toBe('live');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.teacherReconnectDeadlineAt?.$lte).toBeInstanceOf(Date);
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.status).toBe('completed');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.completedAt).toBeInstanceOf(Date);
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$unset).toEqual({
        teacherDisconnectedAt: '',
        teacherReconnectDeadlineAt: ''
      });
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[2]).toEqual({ new: true });
      expect(media.closeRoom).toHaveBeenCalledWith('room-1');
      const closeOrder = media.closeRoom.mock.invocationCallOrder[0];
      const updateOrder = classSessions.findOneAndUpdate.mock.invocationCallOrder[0];
      expect(closeOrder).toBeDefined();
      expect(updateOrder).toBeDefined();
      expect(updateOrder as number).toBeLessThan(closeOrder as number);
      expect(platformEvents.appendEvent.mock.calls.some(([event]) => event.type === 'room.closed')).toBe(true);
      expect(lifecycleEvents).toEqual([
        {
          event: 'session:ended',
          payload: {
            sessionId: 'session-1',
            batchId: 'batch-1',
            roomId: 'room-1',
            status: 'completed',
            startedAt: '2026-06-22T10:00:00.000Z',
            completedAt: '2026-06-22T10:05:00.000Z'
          }
        }
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores a pending durable teacher reconnect deadline on startup', async () => {
    jest.useFakeTimers();
    try {
      const { service, rooms, classSessions, participants, media } = createService();
      const lifecycleEvents: Array<{ event: string; payload: unknown }> = [];
      const teacherDisconnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: '',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      const liveSession = fakeClassSessionDoc({
        teacherDisconnectedAt: new Date(),
        teacherReconnectDeadlineAt: new Date(Date.now() + 1_000)
      });
      const completedSession = fakeClassSessionDoc({
        status: 'completed',
        completedAt: new Date('2026-06-22T10:05:00.000Z')
      });
      classSessions.find.mockResolvedValue([liveSession]);
      classSessions.findOne.mockResolvedValue(liveSession);
      classSessions.findById.mockResolvedValue(liveSession);
      classSessions.findOneAndUpdate.mockResolvedValue(completedSession);
      rooms.findById.mockResolvedValue(fakeRoomDoc());
      participants.findOne.mockResolvedValue(teacherDisconnected);
      participants.find.mockResolvedValue([teacherDisconnected]);
      media.closeRoom.mockResolvedValue({
        participantIds: ['teacher-participant'],
        transportCount: 1,
        consumerCount: 0,
        producerCounts: { video: 1 },
        pipeTransportCount: 0
      });
      service.onClassSessionLifecycleEvent((event, payload) => lifecycleEvents.push({ event, payload }));

      await service.onModuleInit();
      await jest.advanceTimersByTimeAsync(1_000);

      expect(classSessions.find).toHaveBeenCalledWith({
        status: 'live',
        teacherReconnectDeadlineAt: { $exists: true }
      });
      const completionUpdate = classSessions.findOneAndUpdate.mock.calls[0]?.[1];
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?._id).toBe('session-1');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.status).toBe('live');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.teacherReconnectDeadlineAt?.$lte).toBeInstanceOf(Date);
      expect(completionUpdate?.$set?.status).toBe('completed');
      expect(completionUpdate?.$set?.completedAt).toBeInstanceOf(Date);
      expect(completionUpdate?.$unset).toEqual({
        teacherDisconnectedAt: '',
        teacherReconnectDeadlineAt: ''
      });
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[2]).toEqual({ new: true });
      expect(lifecycleEvents).toEqual([
        {
          event: 'session:ended',
          payload: {
            sessionId: 'session-1',
            batchId: 'batch-1',
            roomId: 'room-1',
            status: 'completed',
            startedAt: '2026-06-22T10:00:00.000Z',
            completedAt: '2026-06-22T10:05:00.000Z'
          }
        }
      ]);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('processes an expired durable teacher reconnect deadline on startup', async () => {
    const { service, rooms, classSessions, participants, media } = createService();
    const teacherDisconnected = fakeParticipantDoc({
      id: 'teacher-participant',
      userId: 'teacher-1',
      socketId: '',
      role: Role.HOST,
      displayName: 'Teacher One'
    });
    const liveSession = fakeClassSessionDoc({
      teacherDisconnectedAt: new Date('2026-06-22T10:00:00.000Z'),
      teacherReconnectDeadlineAt: new Date('2026-06-22T10:05:00.000Z')
    });
    classSessions.find.mockResolvedValue([liveSession]);
    classSessions.findOne.mockResolvedValue(liveSession);
    classSessions.findById.mockResolvedValue(liveSession);
    classSessions.findOneAndUpdate.mockResolvedValue(fakeClassSessionDoc({ status: 'completed', completedAt: new Date() }));
    rooms.findById.mockResolvedValue(fakeRoomDoc());
    participants.findOne.mockResolvedValue(teacherDisconnected);
    participants.find.mockResolvedValue([teacherDisconnected]);
    media.closeRoom.mockResolvedValue({
      participantIds: ['teacher-participant'],
      transportCount: 1,
      consumerCount: 0,
      producerCounts: { video: 1 },
      pipeTransportCount: 0
    });

    await service.onModuleInit();

    expect(media.closeRoom).toHaveBeenCalledWith('room-1');
    const completionUpdate = classSessions.findOneAndUpdate.mock.calls[0]?.[1];
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?._id).toBe('session-1');
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.status).toBe('live');
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.teacherReconnectDeadlineAt?.$lte).toBeInstanceOf(Date);
    expect(completionUpdate?.$set?.status).toBe('completed');
    expect(completionUpdate?.$unset).toEqual({
      teacherDisconnectedAt: '',
      teacherReconnectDeadlineAt: ''
    });
    expect(classSessions.findOneAndUpdate.mock.calls[0]?.[2]).toEqual({ new: true });
    service.onModuleDestroy();
  });

  it('clears an expired durable deadline when the teacher is already connected', async () => {
    const { service, classSessions, participants, redis } = createService();
    const teacherConnected = fakeParticipantDoc({
      id: 'teacher-participant',
      userId: 'teacher-1',
      socketId: 'teacher-socket',
      role: Role.HOST,
      displayName: 'Teacher One'
    });
    const liveSession = fakeClassSessionDoc({
      teacherDisconnectedAt: new Date('2026-06-22T10:00:00.000Z'),
      teacherReconnectDeadlineAt: new Date('2026-06-22T10:05:00.000Z')
    });
    classSessions.find.mockResolvedValue([liveSession]);
    classSessions.findById.mockResolvedValue(liveSession);
    participants.findOne.mockResolvedValue(teacherConnected);
    redis.participantPresence.mockResolvedValue([
      {
        roomId: 'room-1',
        participantId: 'teacher-participant',
        socketId: 'teacher-socket',
        userId: 'teacher-1',
        nodeId: 'node-a',
        lastSeenAt: '2026-06-22T10:04:59.000Z'
      }
    ]);

    await service.onModuleInit();

    expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
    expect(classSessions.updateOne).toHaveBeenCalledWith(
      { _id: 'session-1' },
      {
        $unset: {
          teacherDisconnectedAt: '',
          teacherReconnectDeadlineAt: ''
        }
      }
    );
    service.onModuleDestroy();
  });

  it('cancels pending class-session auto-end when the teacher rejoins during grace', async () => {
    jest.useFakeTimers();
    try {
      const { service, rooms, classSessions, participants, producers, consumers } = createService();
      const teacherConnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: 'teacher-socket',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      const teacherDisconnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: '',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      classSessions.findOne.mockResolvedValue(fakeClassSessionDoc());
      rooms.findById.mockResolvedValue(fakeRoomDoc());
      participants.findOne.mockResolvedValueOnce(teacherConnected).mockResolvedValue(teacherDisconnected);
      participants.find.mockResolvedValue([teacherDisconnected]);
      producers.find.mockResolvedValueOnce([fakeProducerDoc({ id: 'teacher-video', participantId: 'teacher-participant' })]).mockResolvedValue([]);
      consumers.find.mockResolvedValue([]);
      jest.spyOn(service, 'replaceParticipantSocket').mockResolvedValue(undefined);

      await service.leaveRoomForSocket('room-1', 'teacher-participant', 'teacher-socket');
      await service.joinRoom(
        { id: 'teacher-1', email: 'teacher@example.test', roles: ['TEACHER'] },
        'teacher-new-socket',
        { roomId: 'room-1', displayName: 'Teacher One' }
      );
      await jest.advanceTimersByTimeAsync(CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS);

      expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
      const lastUpdateOneCall = classSessions.updateOne.mock.calls[classSessions.updateOne.mock.calls.length - 1];
      expect(lastUpdateOneCall).toEqual([
        { _id: 'session-1' },
        {
          $unset: {
            teacherDisconnectedAt: '',
            teacherReconnectDeadlineAt: ''
          }
        }
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a teacher reconnect timeout completed when room close fails', async () => {
    jest.useFakeTimers();
    try {
      const { service, rooms, classSessions, participants, producers, consumers, media } = createService();
      const lifecycleEvents: Array<{ event: string; payload: unknown }> = [];
      const teacherConnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: 'teacher-socket',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      const teacherDisconnected = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: '',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      const liveSession = fakeClassSessionDoc({
        teacherDisconnectedAt: new Date(),
        teacherReconnectDeadlineAt: new Date(Date.now() + CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS)
      });
      const completedSession = fakeClassSessionDoc({
        status: 'completed',
        completedAt: new Date('2026-06-22T10:05:00.000Z')
      });
      classSessions.findOne.mockResolvedValue(liveSession);
      classSessions.findById.mockResolvedValue(liveSession);
      classSessions.findOneAndUpdate.mockResolvedValue(completedSession);
      rooms.findById.mockResolvedValue(fakeRoomDoc());
      participants.findOne.mockResolvedValueOnce(teacherConnected).mockResolvedValueOnce(teacherDisconnected);
      participants.find.mockResolvedValue([teacherDisconnected]);
      producers.find.mockResolvedValueOnce([fakeProducerDoc({ id: 'teacher-video', participantId: 'teacher-participant' })]).mockResolvedValue([]);
      consumers.find.mockResolvedValue([]);
      media.closeRoom.mockRejectedValue(new Error('media close failed'));
      service.onClassSessionLifecycleEvent((event, payload) => lifecycleEvents.push({ event, payload }));

      await service.leaveRoomForSocket('room-1', 'teacher-participant', 'teacher-socket');
      await jest.advanceTimersByTimeAsync(CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS);

      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?._id).toBe('session-1');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[0]?.status).toBe('live');
      expect(classSessions.findOneAndUpdate.mock.calls[0]?.[1]?.$set.status).toBe('completed');
      expect(media.closeRoom).toHaveBeenCalledWith('room-1');
      expect(lifecycleEvents).toEqual([
        {
          event: 'session:ended',
          payload: {
            sessionId: 'session-1',
            batchId: 'batch-1',
            roomId: 'room-1',
            status: 'completed',
            startedAt: '2026-06-22T10:00:00.000Z',
            completedAt: '2026-06-22T10:05:00.000Z'
          }
        }
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('manual class-session room close cancels a pending teacher disconnect grace timer', async () => {
    jest.useFakeTimers();
    try {
      const { service, rooms, classSessions, participants, producers, consumers, media } = createService();
      const teacher = fakeParticipantDoc({
        id: 'teacher-participant',
        userId: 'teacher-1',
        socketId: 'teacher-socket',
        role: Role.HOST,
        displayName: 'Teacher One'
      });
      classSessions.findOne.mockResolvedValue(fakeClassSessionDoc());
      rooms.findById.mockResolvedValue(fakeRoomDoc());
      participants.findOne.mockResolvedValue(teacher);
      participants.find.mockResolvedValue([teacher]);
      producers.find.mockResolvedValueOnce([fakeProducerDoc({ id: 'teacher-video', participantId: 'teacher-participant' })]).mockResolvedValue([]);
      consumers.find.mockResolvedValue([]);
      media.closeRoom.mockResolvedValue({
        participantIds: ['teacher-participant'],
        transportCount: 1,
        consumerCount: 0,
        producerCounts: { video: 1 },
        pipeTransportCount: 0
      });

      await service.leaveRoomForSocket('room-1', 'teacher-participant', 'teacher-socket');
      await service.closeClassSessionRoom({
        roomId: 'room-1',
        actorUserId: 'teacher-1',
        actorLabel: 'teacher@example.test'
      });
      await jest.advanceTimersByTimeAsync(CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS);

      expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
      expect(media.closeRoom).toHaveBeenCalledTimes(1);
      const lastUpdateOneCall = classSessions.updateOne.mock.calls[classSessions.updateOne.mock.calls.length - 1];
      expect(lastUpdateOneCall).toEqual([
        { _id: 'session-1' },
        {
          $unset: {
            teacherDisconnectedAt: '',
            teacherReconnectDeadlineAt: ''
          }
        }
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not start teacher reconnect grace for non-teacher class-session disconnects', async () => {
    jest.useFakeTimers();
    try {
      const { service, classSessions, participants } = createService();
      const student = fakeParticipantDoc({
        id: 'student-participant',
        userId: 'student-1',
        socketId: 'student-socket',
        role: Role.PARTICIPANT,
        displayName: 'Student One'
      });
      classSessions.findOne.mockResolvedValue(fakeClassSessionDoc());
      participants.findOne.mockResolvedValue(student);
      const leaveRoom = jest.spyOn(service, 'leaveRoom').mockResolvedValue({ closed: false });

      const result = await service.leaveRoomForSocket('room-1', 'student-participant', 'student-socket');
      await jest.advanceTimersByTimeAsync(CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS);

      expect(result).toEqual({ closed: false, left: true });
      expect(leaveRoom).toHaveBeenCalledWith('room-1', 'student-participant');
      expect(classSessions.updateOne).not.toHaveBeenCalled();
      expect(classSessions.findOneAndUpdate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a participant active when only one of multiple sockets disconnects', async () => {
    const { service, participants, redis, classSessions } = createService();
    const participant = fakeParticipantDoc({
      id: 'participant-1',
      userId: 'user-1',
      socketId: 'socket-old',
      nodeId: 'node-a',
      role: Role.PARTICIPANT
    });
    participants.findOne.mockResolvedValue(participant);
    redis.participantPresence.mockResolvedValue([
      {
        roomId: 'room-1',
        participantId: 'participant-1',
        socketId: 'socket-new',
        userId: 'user-1',
        nodeId: 'node-b',
        lastSeenAt: '2026-06-22T10:02:00.000Z'
      }
    ]);

    const result = await service.leaveRoomForSocket('room-1', 'participant-1', 'socket-old');
    const participantUpdate = participants.updateOne.mock.calls[0]?.[1] as { $set?: { lastSeenAt?: unknown } };

    expect(redis.removePresence).toHaveBeenCalledWith('room-1', 'participant-1', 'socket-old');
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'participant-1', roomId: 'room-1' },
      {
        $set: {
          socketId: 'socket-new',
          nodeId: 'node-b',
          lastSeenAt: participantUpdate.$set?.lastSeenAt
        }
      }
    );
    expect(participantUpdate.$set?.lastSeenAt).toBeInstanceOf(Date);
    expect(classSessions.findOne).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: false, left: false });
  });

  it('keeps normal non-class host disconnect close behavior', async () => {
    const { service, classSessions, participants } = createService();
    classSessions.findOne.mockResolvedValue(null);
    participants.findOne.mockResolvedValue(
      fakeParticipantDoc({
        id: 'host-participant',
        userId: 'host-1',
        socketId: 'host-socket',
        role: Role.HOST
      })
    );
    const leaveRoom = jest.spyOn(service, 'leaveRoom').mockResolvedValue({ closed: true });

    const result = await service.leaveRoomForSocket('room-1', 'host-participant', 'host-socket');

    expect(result).toEqual({ closed: true, left: true });
    expect(leaveRoom).toHaveBeenCalledWith('room-1', 'host-participant');
  });

  it('keeps profile-soft-throttled joins pending even without an explicit waiting room', async () => {
    const { service, rooms, participants, redis, metrics } = createService();
    const room = {
      id: 'room-1',
      closedAt: undefined,
      invitedUserIds: [],
      settings: {
        locked: false,
        waitingRoomEnabled: false,
        joinApprovalRequired: false,
        visibility: 'public',
        maxParticipants: 8
      },
      mediaProfile: { id: 'support' }
    };
    const summary = summaryState();
    const joinDecision = {
      ...summary.protections.join,
      health: 'degraded' as const,
      action: 'soft-throttle' as const,
      code: 'profile_policy',
      message: 'New room joins should be slowed or manually admitted until the room stabilizes.'
    };
    const participant = { id: 'participant-1', admitted: false };

    rooms.findById.mockResolvedValue(room);
    participants.findOne.mockResolvedValue(null);
    participants.countDocuments.mockResolvedValue(0);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertNotBanned').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getRoomPolicyContext').mockResolvedValue({
      room,
      summary: {
        ...summary,
        protections: {
          ...summary.protections,
          join: joinDecision
        }
      }
    });
    jest.spyOn(service as any, 'createParticipant').mockResolvedValue(participant);
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({
      id: 'room-1',
      participants: [{ id: 'participant-1', admitted: false }]
    });

    const response = await service.joinRoom(
      {
        id: 'participant-user-1',
        email: 'student@example.test',
        roles: [Role.PARTICIPANT]
      },
      'socket-1',
      { roomId: 'room-1', displayName: 'Student One' }
    );

    expect((service as any).createParticipant).toHaveBeenCalledWith(
      'room-1',
      {
        id: 'participant-user-1',
        email: 'student@example.test',
        roles: [Role.PARTICIPANT]
      },
      'socket-1',
      Role.PARTICIPANT,
      DEFAULT_PARTICIPANT_PERMISSIONS,
      false,
      'Student One'
    );
    expect(redis.markPresence).toHaveBeenCalledWith('room-1', 'participant-1', 'socket-1', { userId: undefined, nodeId: 'node-a' });
    expect(metrics.roomJoinDuration.observe).toHaveBeenCalled();
    expect(response.admitted).toBe(false);
    expect(response.admissionDecision?.action).toBe(joinDecision.action);
    expect(String(response.admissionDecision?.code)).toBe(String(joinDecision.code));
    expect(response.admissionDecision?.message).toBe(joinDecision.message);
  });

  it('re-evaluates waiting-room admissions against the current policy before admitting a participant', async () => {
    const { service, rooms, participants, metrics } = createService();
    const room = {
      id: 'room-1',
      settings: {
        maxParticipants: 8
      },
      mediaProfile: { id: 'support' }
    };
    const summary = summaryState();
    const joinDecision = {
      ...summary.protections.join,
      health: 'critical' as const,
      action: 'reject' as const,
      code: 'profile_policy',
      message: 'Support profile is rejecting new joins while the room is critical.'
    };

    rooms.findById.mockResolvedValue(room);
    participants.countDocuments.mockResolvedValue(0);
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getRoomPolicyContext').mockResolvedValue({
      room,
      summary: {
        ...summary,
        protections: {
          ...summary.protections,
          join: joinDecision
        }
      }
    });

    let thrown: unknown;
    try {
      await service.admit('room-1', 'host-1', 'participant-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as Error | undefined)?.message).toBe(joinDecision.message);
    expect(participants.updateOne).not.toHaveBeenCalled();
    expect(metrics.roomAdmissionRejections.labels).toHaveBeenCalledWith('policy_profile_policy');
  });

  it('applies a new media profile immediately to live producers and consumers', async () => {
    const { service, rooms, producers, consumers, media, metrics } = createService();
    const roomDoc = {
      id: 'room-1',
      mediaProfile: {
        id: 'meeting',
        updatedAt: new Date('2026-06-19T09:00:00.000Z'),
        updatedByParticipantId: 'host-1'
      },
      save: jest.fn(async () => undefined)
    };
    const updatedProfile = resolveRoomMediaProfile('webinar', {
      updatedAt: roomDoc.mediaProfile.updatedAt.toISOString(),
      updatedByParticipantId: 'host-1'
    });
    const updatedRoom = {
      id: 'room-1',
      mediaProfile: updatedProfile,
      participants: [
        { id: 'participant-1', role: Role.PARTICIPANT },
        { id: 'viewer-1', role: Role.VIEWER }
      ]
    };
    const videoProducer = fakeProducerDoc({ id: 'producer-video', kind: 'video', priority: 0.5 });
    const screenProducer = fakeProducerDoc({ id: 'producer-screen', kind: 'screen', priority: 0.5 });
    const participantConsumer = fakeConsumerDoc({
      id: 'consumer-video',
      participantId: 'participant-1',
      producerId: 'producer-video',
      priority: 0.5,
      preferredLayers: { spatialLayer: 0, temporalLayer: 0 }
    });
    const viewerConsumer = fakeConsumerDoc({
      id: 'consumer-screen',
      participantId: 'viewer-1',
      producerId: 'producer-screen',
      priority: 0.5,
      preferredLayers: { spatialLayer: 0, temporalLayer: 0 }
    });

    rooms.findById.mockResolvedValue(roomDoc);
    producers.find.mockResolvedValue([videoProducer, screenProducer]);
    consumers.find.mockResolvedValue([participantConsumer, viewerConsumer]);
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'getRoom').mockResolvedValue(updatedRoom);
    jest.spyOn(service as any, 'emitRoomQualitySummaryUpdate').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncDistributedConsumerDemandByProducer').mockResolvedValue(undefined);

    const result = await service.updateRoomMediaProfile({ roomId: 'room-1', profileId: 'webinar' }, 'host-1');

    expect(roomDoc.mediaProfile.id).toBe('webinar');
    expect(roomDoc.mediaProfile.updatedByParticipantId).toBe('host-1');
    expect(roomDoc.mediaProfile.updatedAt).toBeInstanceOf(Date);
    expect(roomDoc.save).toHaveBeenCalled();
    expect(media.setProducerPriority).toHaveBeenCalledWith('producer-video', defaultProducerPriority(updatedProfile, 'video'));
    expect(media.setProducerPriority).toHaveBeenCalledWith('producer-screen', defaultProducerPriority(updatedProfile, 'screen'));
    expect(media.setConsumerPriority).toHaveBeenCalledWith('consumer-video', defaultConsumerPriority(updatedProfile, 'video'));
    expect(media.setConsumerPriority).toHaveBeenCalledWith('consumer-screen', defaultConsumerPriority(updatedProfile, 'screen'));
    expect(media.setConsumerPreferredLayers).toHaveBeenCalledWith('consumer-video', defaultConsumerLayers(updatedProfile, 'video'));
    expect(media.setConsumerPreferredLayers).toHaveBeenCalledWith(
      'consumer-screen',
      defaultConsumerLayers(updatedProfile, 'screen', { viewer: true })
    );
    expect(metrics.roomProfileDistribution.labels).toHaveBeenCalledWith('meeting');
    expect(metrics.roomProfileDistribution.labels).toHaveBeenCalledWith('webinar');
    expect(metrics.roomProfileChanges.labels).toHaveBeenCalledWith('meeting', 'webinar');
    expect(result).toBe(updatedRoom as any);
  });

  it('exports a room incident snapshot with policy, entity, and transport summaries', async () => {
    const { service, metrics } = createService();
    const room = {
      id: 'room-1',
      owner: { nodeId: 'node-a', publicUrl: 'https://node-a.example.test' },
      mediaState: { workerId: 'worker-1' },
      mediaProfile: resolveRoomMediaProfile('classroom'),
      participants: [
        { id: 'host-1', role: Role.HOST, admitted: true, screenSharing: false, handRaised: false },
        { id: 'viewer-1', role: Role.VIEWER, admitted: false, screenSharing: false, handRaised: true }
      ],
      producers: [
        {
          id: 'producer-1',
          participantId: 'host-1',
          transportId: 'transport-1',
          kind: 'screen',
          priority: 3,
          status: 'live',
          currentLayers: { spatialLayer: 2, temporalLayer: 1 }
        }
      ],
      consumers: [
        {
          id: 'consumer-1',
          participantId: 'viewer-1',
          producerId: 'producer-1',
          transportId: 'transport-2',
          priority: 2,
          status: 'live',
          preferredLayers: { spatialLayer: 1, temporalLayer: 1 },
          targetLayers: { spatialLayer: 1, temporalLayer: 1 }
        }
      ]
    } as any;
    const summary = summaryState();
    jest.spyOn(service as any, 'getRoomPolicyContext').mockResolvedValue({ room, summary });
    jest.spyOn(service as any, 'transportIncidentSummary').mockImplementation((transportId: unknown) => ({
      transportId,
      participantId: transportId === 'transport-1' ? 'host-1' : 'viewer-1',
      producerCount: transportId === 'transport-1' ? 1 : 0,
      consumerCount: transportId === 'transport-2' ? 1 : 0,
      score: 80,
      level: 'good'
    }));

    const snapshot = await service.exportRoomIncidentSnapshot('room-1');

    expect(snapshot.scope).toBe('room');
    expect(snapshot.roomProfile.id).toBe('classroom');
    expect(snapshot.participantSummary).toEqual({
      total: 2,
      admitted: 1,
      pending: 1,
      viewers: 1,
      hosts: 1,
      coHosts: 0,
      screenSharing: 0,
      handRaised: 1
    });
    expect(snapshot.transports.length).toBe(2);
    expect(snapshot.pipeContext).toEqual({
      crossNode: false,
      localNodeId: 'node-a'
    });
    expect(metrics.incidentSnapshotsGenerated.labels).toHaveBeenCalledWith('room');
  });

  it('exports a transport incident snapshot tied back to the room policy context', async () => {
    const { service, media, metrics } = createService();
    const room = {
      id: 'room-1',
      owner: { nodeId: 'node-a', publicUrl: 'https://node-a.example.test' },
      mediaState: { workerId: 'worker-1' },
      mediaProfile: resolveRoomMediaProfile('support'),
      participants: [],
      producers: [
        {
          id: 'producer-1',
          participantId: 'host-1',
          transportId: 'transport-1',
          kind: 'video',
          priority: 2,
          status: 'live'
        }
      ],
      consumers: [
        {
          id: 'consumer-1',
          participantId: 'viewer-1',
          producerId: 'producer-1',
          transportId: 'transport-1',
          priority: 1,
          status: 'live',
          preferredLayers: { spatialLayer: 0, temporalLayer: 0 }
        }
      ]
    } as any;
    const summary = summaryState();
    media.transportQualityState.mockReturnValue(transportQualityState({ transportId: 'transport-1', participantId: 'viewer-1' }));
    jest.spyOn(service as any, 'getRoomPolicyContext').mockResolvedValue({ room, summary });
    jest.spyOn(service as any, 'transportIncidentSummary').mockReturnValue({
      transportId: 'transport-1',
      participantId: 'viewer-1',
      producerCount: 1,
      consumerCount: 1,
      score: 76,
      level: 'good'
    });

    const snapshot = await service.exportTransportIncidentSnapshot('transport-1');

    expect(snapshot.scope).toBe('transport');
    expect(snapshot.roomProfile.id).toBe('support');
    expect(snapshot.transport.transportId).toBe('transport-1');
    expect(snapshot.relatedProducers.length).toBe(1);
    expect(snapshot.relatedConsumers.length).toBe(1);
    expect(metrics.incidentSnapshotsGenerated.labels).toHaveBeenCalledWith('transport');
  });

  it('propagates owner-side remote producer status changes to the origin while updating the local proxy', async () => {
    const { service, producers, media, pipeCoordinator } = createService();
    const producer = fakeProducerDoc({ nodeId: 'node-b' });
    producers.findById.mockResolvedValue(producer);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    const result = await service.setProducerStatus('producer-1', 'publisher-1', 'paused');

    expect(media.setProducerPaused).toHaveBeenCalledWith('producer-1', true);
    expect(pipeCoordinator.syncOriginProducerState).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      status: 'paused'
    });
    expect(pipeCoordinator.syncRemoteProducerState).not.toHaveBeenCalled();
    expect(result.status).toBe('paused');
  });

  it('propagates owner-side remote producer priority changes to the origin', async () => {
    const { service, producers, media, pipeCoordinator, metrics } = createService();
    const producer = fakeProducerDoc({ nodeId: 'node-b', participantId: 'publisher-2' });
    producers.findById.mockResolvedValue(producer);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    const result = await service.setProducerPriority('producer-1', 'host-1', 7);

    expect(media.setProducerPriority).toHaveBeenCalledWith('producer-1', 7);
    expect(pipeCoordinator.syncOriginProducerState).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      priority: 7
    });
    expect(metrics.producerPriorityUpdates.labels).toHaveBeenCalledWith('video');
    expect(result.priority).toBe(7);
  });

  it('releases a locally hosted remote publication when the origin producer closes', async () => {
    const { service, producers, media, pipeCoordinator } = createService();
    const producer = fakeProducerDoc({ nodeId: 'node-a' });
    producers.findById.mockResolvedValue(producer);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    const result = await service.closeProducer('producer-1', 'publisher-1');

    expect(media.unregisterProducer).toHaveBeenCalledWith('producer-1');
    expect(pipeCoordinator.releaseRemoteProducerPublication).toHaveBeenCalledWith('producer-1', 'producer_closed');
    expect(pipeCoordinator.closeOriginProducer).not.toHaveBeenCalled();
    expect(result.status).toBe('closed');
  });

  it('coordinates remote-origin teardown when the owner closes a remotely hosted producer', async () => {
    const { service, producers, media, pipeCoordinator } = createService();
    const producer = fakeProducerDoc({ nodeId: 'node-b' });
    producers.findById.mockResolvedValue(producer);
    pipeCoordinator.closeOriginProducer.mockResolvedValue(true);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    const result = await service.closeProducer('producer-1', 'host-1');

    expect(pipeCoordinator.closeOriginProducer).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      reason: 'producer_closed'
    });
    expect(media.unregisterProducer).not.toHaveBeenCalled();
    expect(result.status).toBe('closed');
  });

  it('asserts local room ownership before mutating a producer hosted on another node from a non-owner node', async () => {
    const { service, producers, media, nodeRegistry } = createService();
    const producer = fakeProducerDoc({ nodeId: 'node-b' });
    const callOrder: string[] = [];
    producers.findById.mockResolvedValue(producer);
    nodeRegistry.assertLocalRoomOwner.mockImplementation(async () => {
      callOrder.push('owner');
    });
    media.setProducerPaused.mockImplementation(async () => {
      callOrder.push('media');
    });
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    await service.setProducerStatus('producer-1', 'publisher-1', 'paused');

    expect(nodeRegistry.assertLocalRoomOwner).toHaveBeenCalledWith('room-1');
    expect(callOrder).toEqual(['owner', 'media']);
  });

  it('rejects non-moderators trying to control another participant producer', async () => {
    const { service, producers, media } = createService();
    producers.findById.mockResolvedValue(fakeProducerDoc({ participantId: 'publisher-2' }));
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertCanControlProducer').mockRejectedValue(new ForbiddenException('Moderator role required'));

    let thrown: unknown;
    try {
      await service.setProducerPriority('producer-1', 'viewer-1', 3);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(media.setProducerPriority).not.toHaveBeenCalled();
  });

  it('persists class-session chat with server-derived sender and session metadata', async () => {
    const { service, classSessions, participants, chat } = createService();
    const createdAt = new Date('2026-06-22T10:05:00.000Z');
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-participant') {
        return {
          id: 'student-participant',
          userId: 'student-1',
          socketId: 'student-socket',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      if (filter['userId'] === 'teacher-1') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    chat.create.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: 'chat-1',
      createdAt,
      updatedAt: createdAt,
      ...payload
    }));

    const result = await service.sendChat({ roomId: 'room-1', message: '  Hello class  ' }, 'student-participant');

    expect(chat.create.mock.calls[0]?.[0]).toEqual({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      chatChannelId: 'classroom:session-1:chat',
      senderId: 'student-participant',
      senderName: 'Student One',
      senderRole: 'student',
      recipientId: 'teacher-participant',
      scope: 'private',
      threadKey: 'session-1:teacher:teacher-1:student:student-1',
      message: 'Hello class',
      shadowMuted: false
    });
    const message = result.message;
    expect(result.targetSocketIds).toEqual(['student-socket', 'teacher-socket']);
    expect(result.broadcastRoomId).toBeUndefined();
    expect(message.id).toBe('chat-1');
    expect(message.sessionId).toBe('session-1');
    expect(message.batchId).toBe('batch-1');
    expect(message.roomId).toBe('room-1');
    expect(message.senderId).toBe('student-participant');
    expect(message.senderName).toBe('Student One');
    expect(message.senderRole).toBe('student');
    expect(message.recipientId).toBe('teacher-participant');
    expect(message.scope).toBe('private');
    expect(message.message).toBe('Hello class');
    expect(message.deliveryState).toBe('delivered');
    expect(result.deliveryState).toBe('delivered');
    expect(message.deliveredAt).toBeDefined();
    expect(message.createdAt).toBe(createdAt.toISOString());
  });

  it('rejects student attempts to spoof class-session broadcast chat', async () => {
    const { service, classSessions, participants, chat } = createService();
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-participant') {
        return {
          id: 'student-participant',
          userId: 'student-1',
          socketId: 'student-socket',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      return null;
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: '  Hello class  ', scope: 'broadcast', recipientId: 'student-two' }, 'student-participant');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('allows attachment-only private class-session chat with uploaded PDF metadata', async () => {
    const { service, classSessions, participants, chatAttachments, chat } = createService();
    const createdAt = new Date('2026-06-22T10:05:15.000Z');
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-participant') {
        return {
          id: 'student-participant',
          userId: 'student-1',
          socketId: 'student-socket',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      if (filter['userId'] === 'teacher-1') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    chatAttachments.findOne.mockResolvedValue({
      _id: 'attachment-doc-1',
      attachmentId: 'attachment-1',
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      chatChannelId: 'classroom:session-1:chat',
      uploadedByUserId: 'student-1',
      uploadedByParticipantId: 'student-participant',
      scope: 'pending',
      type: 'pdf',
      fileName: 'lesson.pdf',
      title: 'lesson.pdf',
      mimeType: 'application/pdf',
      size: 5,
      storageProvider: 'local',
      storageKey: 'class-sessions/session-1/attachment-1/lesson.pdf',
      path: '/tmp/attachment-1-lesson.pdf',
      createdAt
    });
    chat.create.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: 'chat-attachment-1',
      createdAt,
      updatedAt: createdAt,
      ...payload
    }));

    const result = await service.sendChat(
      {
        roomId: 'room-1',
        message: '',
        attachments: [
          {
            type: 'pdf',
            id: 'attachment-1',
            attachmentId: 'attachment-1',
            fileName: 'lesson.pdf',
            mimeType: 'application/pdf',
            size: 5
          }
        ]
      },
      'student-participant'
    );

    const payload = chat.create.mock.calls[0]?.[0] as { attachments?: Array<Record<string, unknown>> };
    expect(payload.attachments?.[0]?.type).toBe('pdf');
    expect(payload.attachments?.[0]?.fileName).toBe('lesson.pdf');
    expect(payload.attachments?.[0]?.mimeType).toBe('application/pdf');
    expect(payload.attachments?.[0]?.size).toBe(5);
    expect(payload.attachments?.[0]?.attachmentId).toBe('attachment-1');
    expect(payload.attachments?.[0]?.storageProvider).toBe('local');
    expect(payload.attachments?.[0]?.downloadUrl).toBe('/api/v1/class-sessions/session-1/chat/attachments/attachment-1');
    expect(payload.attachments?.[0]?.dataUrl).toBeUndefined();
    expect(chatAttachments.updateOne).toHaveBeenCalledWith(
      {
        _id: 'attachment-doc-1',
        sessionId: 'session-1',
        roomId: 'room-1',
        scope: 'pending',
        messageId: { $exists: false }
      },
      {
        $set: {
          scope: 'private',
          messageId: 'chat-attachment-1',
          recipientId: 'teacher-participant',
          threadKey: 'session-1:teacher:teacher-1:student:student-1'
        }
      }
    );
    expect(result.message.message).toBe('');
    expect(result.message.attachments?.[0]?.type).toBe('pdf');
    expect(result.message.attachments?.[0]?.fileName).toBe('lesson.pdf');
    expect(result.message.attachments?.[0]?.mimeType).toBe('application/pdf');
    expect(result.message.attachments?.[0]?.size).toBe(5);
    expect(result.message.attachments?.[0]?.attachmentId).toBe('attachment-1');
    expect(result.message.attachments?.[0]?.downloadUrl).toBe('/api/v1/class-sessions/session-1/chat/attachments/attachment-1');
    expect(result.message.attachments?.[0]?.dataUrl).toBeUndefined();
    expect(result.targetSocketIds).toEqual(['student-socket', 'teacher-socket']);
  });

  it('rejects inline file data URLs for class-session chat attachments', async () => {
    const { service, classSessions, participants, chat } = createService();
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-participant') {
        return {
          id: 'student-participant',
          userId: 'student-1',
          socketId: 'student-socket',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      if (filter['userId'] === 'teacher-1') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });

    let thrown: unknown;
    try {
      await service.sendChat(
        {
          roomId: 'room-1',
          message: '',
          attachments: [
            {
              type: 'pdf',
              fileName: 'lesson.pdf',
              mimeType: 'application/pdf',
              size: 5,
              dataUrl: 'data:application/pdf;base64,SGVsbG8='
            }
          ]
        },
        'student-participant'
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toBe('Upload file attachments before sending chat messages.');
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('limits private class-session attachment downloads to the matching teacher-student thread', async () => {
    const { service, chatAttachments } = createService();
    chatAttachments.findOne.mockResolvedValue({
      attachmentId: 'attachment-1',
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      chatChannelId: 'classroom:session-1:chat',
      uploadedByUserId: 'student-1',
      uploadedByParticipantId: 'student-participant',
      scope: 'private',
      recipientId: 'teacher-participant',
      threadKey: 'session-1:teacher:teacher-1:student:student-1',
      messageId: 'message-1',
      type: 'pdf',
      fileName: 'lesson.pdf',
      title: 'lesson.pdf',
      mimeType: 'application/pdf',
      size: 5,
      storageProvider: 'local',
      storageKey: 'class-sessions/session-1/attachment-1/lesson.pdf',
      path: __filename
    });

    const allowed = await service.readClassSessionChatAttachment({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      teacherId: 'teacher-1',
      requesterUserId: 'student-1',
      requesterRole: 'student',
      attachmentId: 'attachment-1'
    });
    allowed.stream.destroy();
    expect(allowed.fileName).toBe('lesson.pdf');
    expect(allowed.mimeType).toBe('application/pdf');
    expect(allowed.size).toBe(5);

    let thrown: unknown;
    try {
      await service.readClassSessionChatAttachment({
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        teacherId: 'teacher-1',
        requesterUserId: 'student-2',
        requesterRole: 'student',
        attachmentId: 'attachment-1'
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('rejects unsafe class-session chat attachment URLs before persistence', async () => {
    const { service, participants, chat } = createService();
    participants.findOne.mockResolvedValue({
      id: 'student-participant',
      userId: 'student-1',
      socketId: 'student-socket',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      displayName: 'Student One',
      admitted: true
    });

    let thrown: unknown;
    try {
      await service.sendChat(
        {
          roomId: 'room-1',
          message: '',
          attachments: [{ type: 'link', url: 'javascript:alert(1)' }]
        },
        'student-participant'
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('targets all active sender and teacher sockets for private class-session chat', async () => {
    const { service, classSessions, participants, chat, redis } = createService();
    const createdAt = new Date('2026-06-22T10:05:30.000Z');
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-participant') {
        return {
          id: 'student-participant',
          userId: 'student-1',
          socketId: 'student-socket-a',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      if (filter['userId'] === 'teacher-1') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket-a',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    redis.participantsPresence.mockResolvedValue([
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket-a',
        userId: 'student-1',
        nodeId: 'node-a',
        lastSeenAt: '2026-06-22T10:04:00.000Z'
      },
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket-b',
        userId: 'student-1',
        nodeId: 'node-b',
        lastSeenAt: '2026-06-22T10:04:01.000Z'
      },
      {
        roomId: 'room-1',
        participantId: 'teacher-participant',
        socketId: 'teacher-socket-a',
        userId: 'teacher-1',
        nodeId: 'node-a',
        lastSeenAt: '2026-06-22T10:04:02.000Z'
      },
      {
        roomId: 'room-1',
        participantId: 'teacher-participant',
        socketId: 'teacher-socket-b',
        userId: 'teacher-1',
        nodeId: 'node-b',
        lastSeenAt: '2026-06-22T10:04:03.000Z'
      }
    ]);
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    chat.create.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: 'chat-1',
      createdAt,
      updatedAt: createdAt,
      ...payload
    }));

    const result = await service.sendChat({ roomId: 'room-1', message: 'I need help' }, 'student-participant');

    expect(result.targetSocketIds).toEqual(['student-socket-a', 'student-socket-b', 'teacher-socket-a', 'teacher-socket-b']);
    expect(result.deliveryState).toBe('delivered');
    expect(result.message.deliveryState).toBe('delivered');
    expect(result.targets).toEqual([
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket-a',
        userId: 'student-1',
        nodeId: 'node-a'
      },
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket-b',
        userId: 'student-1',
        nodeId: 'node-b'
      },
      {
        roomId: 'room-1',
        participantId: 'teacher-participant',
        socketId: 'teacher-socket-a',
        userId: 'teacher-1',
        nodeId: 'node-a'
      },
      {
        roomId: 'room-1',
        participantId: 'teacher-participant',
        socketId: 'teacher-socket-b',
        userId: 'teacher-1',
        nodeId: 'node-b'
      }
    ]);
    expect(result.targetSocketIds).not.toContain('student-two-socket');
  });

  it('rejects class-session chat from non-enrolled students before persistence', async () => {
    const { service, classSessions, participants, studentEnrollments, chat } = createService();
    participants.findOne.mockResolvedValue({
      id: 'student-two-participant',
      userId: 'student-2',
      socketId: 'student-two-socket',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      displayName: 'Student Two',
      admitted: true
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: 'I should not enter chat' }, 'student-two-participant');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(studentEnrollments.isStudentEnrolledInBatch).toHaveBeenCalledWith('student-2', 'batch-1');
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('persists teacher private replies only for the selected student thread', async () => {
    const { service, classSessions, participants, chat } = createService();
    const createdAt = new Date('2026-06-22T10:06:00.000Z');
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'teacher-participant') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      const studentOneMatches =
        filter['_id'] === 'student-one' ||
        ((filter['$or'] as Array<Record<string, string>> | undefined) ?? []).some((condition) => condition['_id'] === 'student-one' || condition['userId'] === 'student-one');
      if (studentOneMatches) {
        return {
          id: 'student-one',
          userId: 'student-1',
          socketId: 'student-one-socket',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      return null;
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    chat.create.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: 'chat-2',
      createdAt,
      updatedAt: createdAt,
      ...payload
    }));

    const result = await service.sendChat({ roomId: 'room-1', message: 'Stay with this problem', scope: 'private', recipientId: 'student-one' }, 'teacher-participant');

    const payload = chat.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['senderId']).toBe('teacher-participant');
    expect(payload['recipientId']).toBe('student-one');
    expect(payload['scope']).toBe('private');
    expect(payload['threadKey']).toBe('session-1:teacher:teacher-1:student:student-1');
    expect(payload['message']).toBe('Stay with this problem');
    expect(result.targetSocketIds).toEqual(['teacher-socket', 'student-one-socket']);
    expect(result.deliveryState).toBe('delivered');
    expect(result.message.deliveryState).toBe('delivered');
    expect(result.broadcastRoomId).toBeUndefined();
    expect(result.message.recipientId).toBe('student-one');
    expect(result.message.scope).toBe('private');
  });

  it('persists teacher private messages for enrolled offline roster students', async () => {
    const { service, classSessions, participants, chat, studentEnrollments } = createService();
    const createdAt = new Date('2026-06-22T10:06:30.000Z');
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'teacher-participant') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    studentEnrollments.listBatchRoster.mockResolvedValue([
      {
        id: 'student-2',
        userId: 'student-2',
        enrollmentId: 'enrollment-2',
        displayName: 'Student Two',
        email: 'student.two@example.test',
        status: 'active',
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    chat.create.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: 'chat-offline',
      createdAt,
      updatedAt: createdAt,
      ...payload
    }));

    const result = await service.sendChat({ roomId: 'room-1', message: 'Review the homework note', scope: 'private', recipientId: 'student-2' }, 'teacher-participant');

    const payload = chat.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['sessionId']).toBe('session-1');
    expect(payload['batchId']).toBe('batch-1');
    expect(payload['roomId']).toBe('room-1');
    expect(payload['senderId']).toBe('teacher-participant');
    expect(payload['recipientId']).toBe('student-2');
    expect(payload['scope']).toBe('private');
    expect(payload['threadKey']).toBe('session-1:teacher:teacher-1:student:student-2');
    expect(payload['message']).toBe('Review the homework note');
    expect(result.targetSocketIds).toEqual(['teacher-socket']);
    expect(result.deliveryState).toBe('sent');
    expect(result.message.deliveryState).toBe('sent');
    expect(result.message.deliveredAt).toBeUndefined();
    expect(result.broadcastRoomId).toBeUndefined();
    expect(result.message.recipientId).toBe('student-2');
    expect(result.message.threadKey).toBe('session-1:teacher:teacher-1:student:student-2');
  });

  it('rejects teacher private messages to non-enrolled offline students', async () => {
    const { service, classSessions, participants, chat, studentEnrollments } = createService();
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'teacher-participant') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    studentEnrollments.listBatchRoster.mockResolvedValue([]);
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: 'This should not persist', scope: 'private', recipientId: 'student-99' }, 'teacher-participant');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error | undefined)?.message).toBe('Target student is not enrolled in this class session.');
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('allows teacher broadcasts as explicit class-session room messages', async () => {
    const { service, classSessions, participants, chat } = createService();
    const createdAt = new Date('2026-06-22T10:07:00.000Z');
    participants.findOne.mockResolvedValue({
      id: 'teacher-participant',
      userId: 'teacher-1',
      socketId: 'teacher-socket',
      roomId: 'room-1',
      role: Role.HOST,
      displayName: 'Teacher One',
      admitted: true
    });
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    chat.create.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: 'chat-3',
      createdAt,
      updatedAt: createdAt,
      ...payload
    }));

    const result = await service.sendChat({ roomId: 'room-1', message: 'Wrap up in five minutes', scope: 'broadcast' }, 'teacher-participant');

    const payload = chat.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['senderId']).toBe('teacher-participant');
    expect(payload['recipientId']).toBeUndefined();
    expect(payload['scope']).toBe('broadcast');
    expect(payload['message']).toBe('Wrap up in five minutes');
    expect(result.broadcastRoomId).toBe('room-1');
    expect(result.deliveryState).toBe('delivered');
    expect(result.message.deliveryState).toBe('delivered');
    expect(result.targetSocketIds).toBeUndefined();
    expect(result.message.scope).toBe('broadcast');
  });

  it('rejects teacher private replies without a student recipient', async () => {
    const { service, classSessions, participants, chat } = createService();
    participants.findOne.mockResolvedValue({
      id: 'teacher-participant',
      userId: 'teacher-1',
      roomId: 'room-1',
      role: Role.HOST,
      displayName: 'Teacher One',
      admitted: true
    });
    classSessions.findOne.mockResolvedValue({ id: 'session-1', batchId: 'batch-1', teacherId: 'teacher-1', roomId: 'room-1', status: 'live' });

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: 'Private note', scope: 'private' }, 'teacher-participant');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('rejects class-session chat sends when the session is not live', async () => {
    const { service, classSessions, participants, chat } = createService();
    participants.findOne.mockResolvedValue({
      id: 'student-participant',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      displayName: 'Student One',
      admitted: true
    });
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'completed' });

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: 'After class' }, 'student-participant');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('rejects class-session chat sends when the session ends before persistence', async () => {
    const { service, classSessions, participants, chat } = createService();
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-participant') {
        return {
          id: 'student-participant',
          userId: 'student-1',
          socketId: 'student-socket',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      if (filter['userId'] === 'teacher-1') {
        return {
          id: 'teacher-participant',
          userId: 'teacher-1',
          socketId: 'teacher-socket',
          roomId: 'room-1',
          role: Role.HOST,
          displayName: 'Teacher One',
          admitted: true
        };
      }
      return null;
    });
    classSessions.findOne
      .mockResolvedValueOnce(fakeClassSessionDoc({ status: 'live' }))
      .mockResolvedValueOnce(fakeClassSessionDoc({ status: 'completed', completedAt: new Date('2026-06-22T11:00:00.000Z') }));

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: 'Race message' }, 'student-participant');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('rejects chat sends when participant chat permission is disabled', async () => {
    const { service, participants, permissions, chat } = createService();
    participants.findOne.mockResolvedValue({
      id: 'participant-1',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      displayName: 'Muted Student',
      admitted: true
    });
    permissions.findOne.mockResolvedValue({
      canPublishAudio: true,
      canPublishVideo: true,
      canShareScreen: false,
      canChat: false
    });

    let thrown: unknown;
    try {
      await service.sendChat({ roomId: 'room-1', message: 'Blocked' }, 'participant-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(chat.create).not.toHaveBeenCalled();
  });

  it('returns chat history oldest-to-newest with cursor pagination metadata', async () => {
    const { service, chat } = createService();
    const newest = fakeChatDoc({
      id: 'chat-new',
      message: 'Newer',
      createdAt: new Date('2026-06-22T10:10:00.000Z')
    });
    const older = fakeChatDoc({
      id: 'chat-old',
      message: 'Older',
      createdAt: new Date('2026-06-22T10:05:00.000Z')
    });
    const extra = fakeChatDoc({
      id: 'chat-extra',
      message: 'Extra',
      createdAt: new Date('2026-06-22T10:00:00.000Z')
    });
    const exec = jest.fn(async () => [newest, older, extra]);
    const limit = jest.fn((_limit: number) => ({ exec }));
    const sort = jest.fn((_sort: Record<string, number>) => ({ limit }));
    chat.find.mockReturnValue({ sort });

    const history = await service.getChatHistory({
      sessionId: 'session-1',
      before: '2026-06-22T10:15:00.000Z',
      limit: 2
    });

    expect(chat.find).toHaveBeenCalledWith({
      deletedAt: { $exists: false },
      sessionId: 'session-1',
      createdAt: { $lt: new Date('2026-06-22T10:15:00.000Z') }
    });
    expect(sort.mock.calls[0]?.[0]).toEqual({ createdAt: -1 });
    expect(limit.mock.calls[0]?.[0]).toBe(3);
    expect(history.messages.map((message) => message.id)).toEqual(['chat-old', 'chat-new']);
    expect(history.nextBefore).toBe('2026-06-22T10:05:00.000Z');
  });

  it('loads student class-session history with only broadcasts and their teacher thread', async () => {
    const { service, participants, chat } = createService();
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['userId'] === 'student-1') {
        return {
          id: 'student-one',
          userId: 'student-1',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      return null;
    });
    const exec = jest.fn(async () => [
      fakeChatDoc({ id: 'broadcast-1', scope: 'broadcast', message: 'Announcement', createdAt: new Date('2026-06-22T10:10:00.000Z') }),
      fakeChatDoc({
        id: 'private-1',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-1:student:student-1',
        message: 'Private',
        createdAt: new Date('2026-06-22T10:05:00.000Z')
      })
    ]);
    const limit = jest.fn((_limit: number) => ({ exec }));
    const sort = jest.fn((_sort: Record<string, number>) => ({ limit }));
    chat.find.mockReturnValue({ sort });

    const history = await service.getClassSessionChatHistory({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      teacherId: 'teacher-1',
      requesterUserId: 'student-1',
      requesterRole: 'student',
      limit: 20
    });

    expect(chat.find).toHaveBeenCalledWith({
      deletedAt: { $exists: false },
      sessionId: 'session-1',
      $or: [{ scope: 'broadcast' }, { scope: 'private', threadKey: 'session-1:teacher:teacher-1:student:student-1' }]
    });
    expect(history.messages.map((message) => message.id)).toEqual(['private-1', 'broadcast-1']);
  });

  it('loads teacher history for a selected student private thread', async () => {
    const { service, participants, chat } = createService();
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      const idMatches =
        filter['_id'] === 'student-one' ||
        ((filter['$or'] as Array<Record<string, string>> | undefined) ?? []).some((condition) => condition['_id'] === 'student-one' || condition['userId'] === 'student-one');
      if (idMatches) {
        return {
          id: 'student-one',
          userId: 'student-1',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      return null;
    });
    const exec = jest.fn(async () => [
      fakeChatDoc({
        id: 'private-1',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-1:student:student-1',
        message: 'Private',
        createdAt: new Date('2026-06-22T10:05:00.000Z')
      })
    ]);
    const limit = jest.fn((_limit: number) => ({ exec }));
    const sort = jest.fn((_sort: Record<string, number>) => ({ limit }));
    chat.find.mockReturnValue({ sort });

    const history = await service.getClassSessionChatHistory({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      teacherId: 'teacher-1',
      requesterUserId: 'teacher-1',
      requesterRole: 'teacher',
      participantId: 'student-one',
      scope: 'private'
    });

    expect(chat.find).toHaveBeenCalledWith({
      deletedAt: { $exists: false },
      sessionId: 'session-1',
      threadKey: 'session-1:teacher:teacher-1:student:student-1',
      scope: 'private'
    });
    expect(history.messages.map((message) => message.id)).toEqual(['private-1']);
  });

  it('loads teacher history for an offline enrolled roster student private thread', async () => {
    const { service, participants, chat, studentEnrollments } = createService();
    participants.findOne.mockResolvedValue(null);
    studentEnrollments.listBatchRoster.mockResolvedValue([
      {
        id: 'student-2',
        userId: 'student-2',
        enrollmentId: 'enrollment-2',
        displayName: 'Student Two',
        email: 'student.two@example.test',
        status: 'active',
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    const exec = jest.fn(async () => [
      fakeChatDoc({
        id: 'private-offline-1',
        recipientId: 'student-2',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-1:student:student-2',
        message: 'Offline private note',
        createdAt: new Date('2026-06-22T10:05:00.000Z')
      })
    ]);
    const limit = jest.fn((_limit: number) => ({ exec }));
    const sort = jest.fn((_sort: Record<string, number>) => ({ limit }));
    chat.find.mockReturnValue({ sort });

    const history = await service.getClassSessionChatHistory({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      teacherId: 'teacher-1',
      requesterUserId: 'teacher-1',
      requesterRole: 'teacher',
      participantId: 'student-2',
      scope: 'private'
    });

    expect(chat.find).toHaveBeenCalledWith({
      deletedAt: { $exists: false },
      sessionId: 'session-1',
      threadKey: 'session-1:teacher:teacher-1:student:student-2',
      scope: 'private'
    });
    expect(history.messages.map((message) => message.id)).toEqual(['private-offline-1']);
  });

  it('marks student read state for their own private teacher thread', async () => {
    const { service, participants, chatReadStates } = createService();
    const readAt = new Date('2026-06-22T10:12:00.000Z');
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['userId'] === 'student-1') {
        return {
          id: 'student-one',
          userId: 'student-1',
          roomId: 'room-1',
          role: Role.PARTICIPANT,
          displayName: 'Student One',
          admitted: true
        };
      }
      return null;
    });
    chatReadStates.findOneAndUpdate.mockImplementation(async (_filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => ({
      id: 'read-1',
      ...update.$set,
      updatedAt: readAt
    }));

    const state = await service.markClassSessionChatRead({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      teacherId: 'teacher-1',
      requesterUserId: 'student-1',
      requesterRole: 'student',
      participantId: 'student-two',
      scope: 'private',
      readAt: readAt.toISOString()
    });

    const update = chatReadStates.findOneAndUpdate.mock.calls[0]?.[1] as { $set: Record<string, unknown> };
    expect(update.$set['batchId']).toBe('batch-1');
    expect(update.$set['channelId']).toBe('classroom:session-1:chat');
    expect(update.$set['chatChannelId']).toBe('classroom:session-1:chat');
    expect(update.$set['participantId']).toBe('student-one');
    expect(update.$set['threadKey']).toBe('session-1:teacher:teacher-1:student:student-1');
    expect(state.batchId).toBe('batch-1');
    expect(state.channelId).toBe('classroom:session-1:chat');
    expect(state.chatChannelId).toBe('classroom:session-1:chat');
    expect(state.participantId).toBe('student-one');
    expect(state.threadKey).toBe('session-1:teacher:teacher-1:student:student-1');
    expect(state.lastReadAt).toBe(readAt.toISOString());
  });

  it('targets private read receipts only to the reader and teacher sockets', async () => {
    const { service, classSessions, participants, chatReadStates, redis } = createService();
    const readAt = new Date('2026-06-22T10:12:00.000Z');
    const student = {
      id: 'student-one',
      userId: 'student-1',
      roomId: 'room-1',
      socketId: 'student-socket-a',
      nodeId: 'node-a',
      role: Role.PARTICIPANT,
      displayName: 'Student One',
      admitted: true
    };
    const teacher = {
      id: 'teacher-participant',
      userId: 'teacher-1',
      roomId: 'room-1',
      socketId: 'teacher-socket',
      nodeId: 'node-a',
      role: Role.HOST,
      displayName: 'Teacher One',
      admitted: true
    };
    classSessions.findOne.mockResolvedValue({
      id: 'session-1',
      batchId: 'batch-1',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      status: 'live',
      chatChannelId: 'classroom:session-1:chat'
    });
    participants.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter['_id'] === 'student-one' || filter['userId'] === 'student-1') {
        return student;
      }
      if (filter['userId'] === 'teacher-1') {
        return teacher;
      }
      return null;
    });
    chatReadStates.findOneAndUpdate.mockImplementation(async (_filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => ({
      id: 'read-1',
      ...update.$set,
      updatedAt: readAt
    }));
    redis.participantsPresence.mockResolvedValue([
      {
        roomId: 'room-1',
        participantId: 'student-one',
        socketId: 'student-socket-a',
        userId: 'student-1',
        nodeId: 'node-a',
        lastSeenAt: '2026-06-22T10:12:01.000Z'
      },
      {
        roomId: 'room-1',
        participantId: 'student-one',
        socketId: 'student-socket-b',
        userId: 'student-1',
        nodeId: 'node-b',
        lastSeenAt: '2026-06-22T10:12:02.000Z'
      },
      {
        roomId: 'room-1',
        participantId: 'teacher-participant',
        socketId: 'teacher-socket',
        userId: 'teacher-1',
        nodeId: 'node-a',
        lastSeenAt: '2026-06-22T10:12:03.000Z'
      }
    ]);

    const result = await service.markChatRead(
      { sessionId: 'session-1', roomId: 'room-1', scope: 'private', readAt: readAt.toISOString() },
      { id: 'student-1', email: 'student@example.test', roles: ['STUDENT'] },
      'student-one'
    );

    expect(result.receipt).toEqual({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      chatChannelId: 'classroom:session-1:chat',
      scope: 'private',
      threadKey: 'session-1:teacher:teacher-1:student:student-1',
      participantId: 'student-one',
      userId: 'student-1',
      lastReadAt: readAt.toISOString()
    });
    expect(result.targetSocketIds).toEqual(['student-socket-a', 'student-socket-b', 'teacher-socket']);
    expect(result.targetSocketIds).not.toContain('student-two-socket');
    expect(redis.participantsPresence).toHaveBeenCalledWith('room-1', ['student-one', 'teacher-participant']);
  });

  it('clamps future chat read timestamps to server time', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-22T10:12:00.000Z'));
    try {
      const { service, participants, chatReadStates } = createService();
      participants.findOne.mockResolvedValue({
        id: 'student-one',
        userId: 'student-1',
        roomId: 'room-1',
        role: Role.PARTICIPANT,
        displayName: 'Student One',
        admitted: true
      });
      chatReadStates.findOneAndUpdate.mockImplementation(async (_filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => ({
        id: 'read-1',
        ...update.$set,
        updatedAt: update.$set['lastReadAt']
      }));

      const state = await service.markClassSessionChatRead({
        sessionId: 'session-1',
        batchId: 'batch-1',
        roomId: 'room-1',
        channelId: 'classroom:session-1:chat',
        teacherId: 'teacher-1',
        requesterUserId: 'student-1',
        requesterRole: 'student',
        scope: 'private',
        readAt: '2026-06-23T10:12:00.000Z'
      });

      expect(state.lastReadAt).toBe('2026-06-22T10:12:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('builds teacher private thread summaries with unread counts per student', async () => {
    const { service, participants, chat, chatReadStates, studentEnrollments } = createService();
    const studentOne = {
      id: 'student-one',
      userId: 'student-1',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      displayName: 'Student One',
      admitted: true
    };
    const studentTwo = {
      id: 'student-two',
      userId: 'student-2',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      displayName: 'Student Two',
      admitted: true
    };
    participants.find.mockResolvedValue([studentOne, studentTwo]);
    studentEnrollments.listBatchRoster.mockResolvedValue([
      {
        id: 'student-1',
        userId: 'student-1',
        enrollmentId: 'enrollment-1',
        displayName: 'Student One',
        email: 'student.one@example.test',
        status: 'active',
        joinedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'student-2',
        userId: 'student-2',
        enrollmentId: 'enrollment-2',
        displayName: 'Student Two',
        email: 'student.two@example.test',
        status: 'active',
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    chatReadStates.find.mockResolvedValue([
      fakeChatReadStateDoc({
        threadKey: 'session-1:teacher:teacher-1:student:student-1',
        lastReadAt: new Date('2026-06-22T10:04:00.000Z')
      })
    ]);
    chat.find.mockImplementation((filter: Record<string, unknown>) => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({
          exec: jest.fn(async () =>
            filter['threadKey'] === 'session-1:teacher:teacher-1:student:student-1'
              ? [
                  fakeChatDoc({
                    id: 'chat-student-one',
                    senderId: 'student-one',
                    scope: 'private',
                    threadKey: 'session-1:teacher:teacher-1:student:student-1',
                    message: 'I need help',
                    createdAt: new Date('2026-06-22T10:10:00.000Z')
                  })
                ]
              : []
          )
        }))
      }))
    }));
    chat.countDocuments.mockImplementation(async (filter: Record<string, unknown>) =>
      filter['threadKey'] === 'session-1:teacher:teacher-1:student:student-1' && filter['senderRole'] === 'student' ? 2 : 0
    );

    const summary = await service.getClassSessionChatSummary({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      channelId: 'classroom:session-1:chat',
      teacherId: 'teacher-1',
      requesterUserId: 'teacher-1',
      requesterRole: 'teacher'
    });

    const studentOneThread = summary.threads.find((thread) => thread.participantId === 'student-one');
    const studentTwoThread = summary.threads.find((thread) => thread.participantId === 'student-two');
    expect(studentOneThread?.unreadCount).toBe(2);
    expect(studentOneThread?.lastMessagePreview).toBe('I need help');
    expect(studentTwoThread?.unreadCount).toBe(0);
    expect(summary.broadcast?.scope).toBe('broadcast');
  });

  it('moderates a live class-session student microphone by pausing the audio producer', async () => {
    const { service, classSessions, participants, permissions, producers, media, redis } = createService();
    const actor = { id: 'teacher-participant', roomId: 'room-1', role: Role.HOST };
    const target = { id: 'student-participant', roomId: 'room-1', role: Role.PARTICIPANT, socketId: 'student-socket' };
    const producer = fakeProducerDoc({
      id: 'producer-audio',
      participantId: 'student-participant',
      kind: 'audio'
    });
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(actor);
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue(target);
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(actor);
    jest.spyOn(service as any, 'addModeration').mockResolvedValue({ actor, participant: target });
    producers.findOne.mockReturnValue({ sort: jest.fn(async () => producer) });
    producers.findById.mockResolvedValue(producer);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    redis.participantsPresence.mockResolvedValue([
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket',
        userId: 'student-1',
        nodeId: 'node-a',
        lastSeenAt: '2026-06-22T10:04:00.000Z'
      },
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket-tab-2',
        userId: 'student-1',
        nodeId: 'node-b',
        lastSeenAt: '2026-06-22T10:04:01.000Z'
      }
    ]);

    const result = await service.moderateStudentMedia('room-1', 'teacher-participant', 'student-participant', 'mute-mic');

    expect(media.setProducerPaused).toHaveBeenCalledWith('producer-audio', true);
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'student-participant', roomId: 'room-1' },
      { audioEnabled: false }
    );
    expect(permissions.updateOne).toHaveBeenCalledWith(
      { roomId: 'room-1', participantId: 'student-participant' },
      {
        $set: {
          canPublishAudio: false,
          canPublishVideo: true,
          canShareScreen: true,
          canChat: true
        }
      },
      { upsert: true }
    );
    expect((service as any).addModeration).toHaveBeenCalledWith('room-1', 'teacher-participant', 'student-participant', 'force-mute');
    expect(result.event).toEqual({
      roomId: 'room-1',
      participantId: 'student-participant',
      producerId: 'producer-audio',
      kind: 'audio',
      action: 'mute-mic',
      moderatedByParticipantId: 'teacher-participant',
      permissions: {
        canPublishAudio: false,
        canPublishVideo: true,
        canShareScreen: true,
        canChat: true
      },
      message: 'Teacher muted your microphone.'
    });
    expect(result.producer?.id).toBe('producer-audio');
    expect(result.producer?.status).toBe('paused');
    expect(result.producer?.kind).toBe('audio');
    expect(result.permissions).toEqual({
      canPublishAudio: false,
      canPublishVideo: true,
      canShareScreen: true,
      canChat: true
    });
    expect(result.targetSocketId).toBe('student-socket');
    expect(result.targetSocketIds).toEqual(['student-socket', 'student-socket-tab-2']);
    expect(result.targets).toEqual([
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket',
        userId: 'student-1',
        nodeId: 'node-a'
      },
      {
        roomId: 'room-1',
        participantId: 'student-participant',
        socketId: 'student-socket-tab-2',
        userId: 'student-1',
        nodeId: 'node-b'
      }
    ]);
  });

  it('allows a teacher to unmute a class-session student microphone without resuming media', async () => {
    const { service, classSessions, participants, permissions, producers, moderation } = createService();
    const actor = { id: 'teacher-participant', roomId: 'room-1', role: Role.HOST };
    const target = { id: 'student-participant', roomId: 'room-1', role: Role.PARTICIPANT, socketId: 'student-socket' };
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(actor);
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue(target);
    permissions.findOne.mockResolvedValue({
      roomId: 'room-1',
      participantId: 'student-participant',
      canPublishAudio: false,
      canPublishVideo: true,
      canShareScreen: true,
      canChat: true
    });

    const result = await service.moderateStudentMedia('room-1', 'teacher-participant', 'student-participant', 'unmute-mic');

    expect(producers.findOne).not.toHaveBeenCalled();
    expect(participants.updateOne).not.toHaveBeenCalled();
    expect(permissions.updateOne).toHaveBeenCalledWith(
      { roomId: 'room-1', participantId: 'student-participant' },
      {
        $set: {
          canPublishAudio: true,
          canPublishVideo: true,
          canShareScreen: true,
          canChat: true
        }
      },
      { upsert: true }
    );
    expect(moderation.updateMany).toHaveBeenCalledWith(
      { roomId: 'room-1', participantId: 'student-participant', action: 'force-mute', active: true },
      { active: false }
    );
    expect(result.event.action).toBe('unmute-mic');
    expect(result.event.kind).toBe('audio');
    expect(result.event.permissions?.canPublishAudio).toBe(true);
    expect(result.producer).toBeUndefined();
  });

  it('moderates a live class-session student camera by pausing the video producer', async () => {
    const { service, classSessions, participants, permissions, producers, media } = createService();
    const actor = { id: 'teacher-participant', roomId: 'room-1', role: Role.HOST };
    const target = { id: 'student-participant', roomId: 'room-1', role: Role.PARTICIPANT, socketId: 'student-socket' };
    const producer = fakeProducerDoc({
      id: 'producer-video',
      participantId: 'student-participant',
      kind: 'video'
    });
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(actor);
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue(target);
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(actor);
    jest.spyOn(service as any, 'addModeration').mockResolvedValue({ actor, participant: target });
    producers.findOne.mockReturnValue({ sort: jest.fn(async () => producer) });
    producers.findById.mockResolvedValue(producer);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));

    const result = await service.moderateStudentMedia('room-1', 'teacher-participant', 'student-participant', 'stop-camera');

    expect(media.setProducerPaused).toHaveBeenCalledWith('producer-video', true);
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'student-participant', roomId: 'room-1' },
      { videoEnabled: false }
    );
    expect(permissions.updateOne).toHaveBeenCalledWith(
      { roomId: 'room-1', participantId: 'student-participant' },
      {
        $set: {
          canPublishAudio: true,
          canPublishVideo: false,
          canShareScreen: true,
          canChat: true
        }
      },
      { upsert: true }
    );
    expect((service as any).addModeration).toHaveBeenCalledWith('room-1', 'teacher-participant', 'student-participant', 'disable-camera');
    expect(result.event.action).toBe('stop-camera');
    expect(result.event.kind).toBe('video');
    expect(result.producer?.status).toBe('paused');
  });

  it('allows a teacher to restore a class-session student camera without resuming media', async () => {
    const { service, classSessions, participants, permissions, producers, moderation } = createService();
    const actor = { id: 'teacher-participant', roomId: 'room-1', role: Role.HOST };
    const target = { id: 'student-participant', roomId: 'room-1', role: Role.PARTICIPANT, socketId: 'student-socket' };
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(actor);
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue(target);
    permissions.findOne.mockResolvedValue({
      roomId: 'room-1',
      participantId: 'student-participant',
      canPublishAudio: true,
      canPublishVideo: false,
      canShareScreen: true,
      canChat: true
    });

    const result = await service.moderateStudentMedia('room-1', 'teacher-participant', 'student-participant', 'restore-camera');

    expect(producers.findOne).not.toHaveBeenCalled();
    expect(participants.updateOne).not.toHaveBeenCalled();
    expect(permissions.updateOne).toHaveBeenCalledWith(
      { roomId: 'room-1', participantId: 'student-participant' },
      {
        $set: {
          canPublishAudio: true,
          canPublishVideo: true,
          canShareScreen: true,
          canChat: true
        }
      },
      { upsert: true }
    );
    expect(moderation.updateMany).toHaveBeenCalledWith(
      { roomId: 'room-1', participantId: 'student-participant', action: 'disable-camera', active: true },
      { active: false }
    );
    expect(result.event.action).toBe('restore-camera');
    expect(result.event.kind).toBe('video');
    expect(result.event.permissions?.canPublishVideo).toBe(true);
    expect(result.producer).toBeUndefined();
  });

  it('bulk moderates only active admitted class-session student participants', async () => {
    const { service, classSessions, participants } = createService();
    const actor = { id: 'teacher-participant', roomId: 'room-1', role: Role.HOST };
    const students = [
      { id: 'student-one', roomId: 'room-1', role: Role.PARTICIPANT, socketId: 'student-one-socket' },
      { id: 'student-two', roomId: 'room-1', role: Role.PARTICIPANT, socketId: 'student-two-socket' }
    ];
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(actor);
    participants.find.mockResolvedValue(students);
    const moderateSpy = jest
      .spyOn(service, 'moderateStudentMedia')
      .mockResolvedValueOnce({
        event: {
          roomId: 'room-1',
          participantId: 'student-one',
          kind: 'audio',
          action: 'mute-mic',
          moderatedByParticipantId: 'teacher-participant'
        },
        permissions: DEFAULT_PARTICIPANT_PERMISSIONS
      })
      .mockResolvedValueOnce({
        event: {
          roomId: 'room-1',
          participantId: 'student-two',
          kind: 'audio',
          action: 'mute-mic',
          moderatedByParticipantId: 'teacher-participant'
        },
        permissions: DEFAULT_PARTICIPANT_PERMISSIONS
      });

    const results = await service.moderateAllStudentMedia('room-1', 'teacher-participant', 'mute-mic');

    expect(participants.find).toHaveBeenCalledWith({
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      admitted: true,
      leftAt: { $exists: false }
    });
    expect(moderateSpy.mock.calls[0]).toEqual(['room-1', 'teacher-participant', 'student-one', 'mute-mic']);
    expect(moderateSpy.mock.calls[1]).toEqual(['room-1', 'teacher-participant', 'student-two', 'mute-mic']);
    expect(results.length).toBe(2);
  });

  it('allows a student to raise their own hand during a live class session', async () => {
    const { service, classSessions, participants } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    participants.findOne.mockResolvedValue({
      id: 'student-participant',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      admitted: true
    });

    const patch = await service.raiseHand('room-1', 'student-participant', true);
    const handRaiseUpdate = participants.updateOne.mock.calls[0]?.[1] as { $set: { handRaisedAt: Date } };

    expect(patch.handRaised).toBe(true);
    expect(typeof patch.handRaisedAt).toBe('string');
    expect(handRaiseUpdate.$set.handRaisedAt instanceof Date).toBe(true);
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'student-participant', roomId: 'room-1' },
      { $set: { handRaised: true, handRaisedAt: handRaiseUpdate.$set.handRaisedAt } }
    );
  });

  it('rejects hand raise from non-student participants', async () => {
    const { service, classSessions, participants } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    participants.findOne.mockResolvedValue({
      id: 'teacher-participant',
      roomId: 'room-1',
      role: Role.HOST,
      admitted: true
    });

    let thrown: unknown;
    try {
      await service.raiseHand('room-1', 'teacher-participant', true);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as Error | undefined)?.message).toBe('Only students can raise their hand.');
    expect(participants.updateOne).not.toHaveBeenCalled();
  });

  it('lets a teacher clear a student raised hand', async () => {
    const { service, classSessions, participants } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    participants.findOne
      .mockResolvedValueOnce({ id: 'teacher-participant', roomId: 'room-1', role: Role.HOST, admitted: true })
      .mockResolvedValueOnce({ id: 'student-participant', roomId: 'room-1', role: Role.PARTICIPANT, admitted: true });

    const patch = await service.lowerStudentHand('room-1', 'teacher-participant', 'student-participant');

    expect(patch).toEqual({ handRaised: false, handRaisedAt: null });
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'student-participant', roomId: 'room-1' },
      { $set: { handRaised: false }, $unset: { handRaisedAt: '' } }
    );
  });

  it('allows a raised student to speak by restoring mic permission and clearing their hand', async () => {
    const { service, participants } = createService();
    const permissions = {
      canPublishAudio: true,
      canPublishVideo: true,
      canShareScreen: false,
      canChat: true
    };
    const moderateSpy = jest.spyOn(service, 'moderateStudentMedia').mockResolvedValue({
      event: {
        roomId: 'room-1',
        participantId: 'student-participant',
        kind: 'audio',
        action: 'unmute-mic',
        moderatedByParticipantId: 'teacher-participant',
        permissions
      },
      permissions
    });

    const result = await service.setStudentSpeakingPermission('room-1', 'teacher-participant', 'student-participant', true);
    const speakingUpdate = participants.updateOne.mock.calls[0]?.[1] as { $set: { allowedToSpeakAt: Date } };

    expect(moderateSpy).toHaveBeenCalledWith('room-1', 'teacher-participant', 'student-participant', 'unmute-mic');
    expect(result.participantPatch.handRaised).toBe(false);
    expect(result.participantPatch.allowedToSpeak).toBe(true);
    expect(result.event.allowedToSpeak).toBe(true);
    expect(result.event.permissions).toEqual(permissions);
    expect(speakingUpdate.$set.allowedToSpeakAt instanceof Date).toBe(true);
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'student-participant', roomId: 'room-1' },
      {
        $set: {
          handRaised: false,
          allowedToSpeak: true,
          allowedToSpeakAt: speakingUpdate.$set.allowedToSpeakAt,
          allowedToSpeakBy: 'teacher-participant'
        },
        $unset: { handRaisedAt: '' }
      }
    );
  });

  it('revokes student speaking permission through the existing mute flow', async () => {
    const { service, participants } = createService();
    const permissions = {
      canPublishAudio: false,
      canPublishVideo: true,
      canShareScreen: false,
      canChat: true
    };
    const moderateSpy = jest.spyOn(service, 'moderateStudentMedia').mockResolvedValue({
      event: {
        roomId: 'room-1',
        participantId: 'student-participant',
        kind: 'audio',
        action: 'mute-mic',
        moderatedByParticipantId: 'teacher-participant',
        permissions
      },
      permissions
    });

    const result = await service.setStudentSpeakingPermission('room-1', 'teacher-participant', 'student-participant', false);

    expect(moderateSpy).toHaveBeenCalledWith('room-1', 'teacher-participant', 'student-participant', 'mute-mic');
    expect(result.participantPatch.allowedToSpeak).toBe(false);
    expect(result.event.allowedToSpeak).toBe(false);
    expect(participants.updateOne).toHaveBeenCalledWith(
      { _id: 'student-participant', roomId: 'room-1' },
      { $set: { allowedToSpeak: false }, $unset: { allowedToSpeakAt: '', allowedToSpeakBy: '' } }
    );
  });

  it('blocks a new student from joining a locked class-session room', async () => {
    const { service, rooms, participants } = createService();
    rooms.findById.mockResolvedValue({ id: 'room-1', settings: { locked: true } });
    participants.findOne.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.assertClassSessionRoomJoinAllowed('room-1', 'teacher-1', {
        id: 'student-1',
        roles: ['STUDENT']
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as Error | undefined)?.message).toBe('Class is locked. Ask the teacher to unlock it before joining.');
    expect(participants.findOne).toHaveBeenCalledWith({
      roomId: 'room-1',
      userId: 'student-1',
      admitted: true,
      leftAt: { $exists: false }
    });
  });

  it('allows an already admitted student to reconnect to a locked class-session room', async () => {
    const { service, rooms, participants } = createService();
    rooms.findById.mockResolvedValue({ id: 'room-1', settings: { locked: true } });
    participants.findOne.mockResolvedValue({
      id: 'student-participant',
      roomId: 'room-1',
      userId: 'student-1',
      admitted: true,
      role: Role.PARTICIPANT
    });

    await service.assertClassSessionRoomJoinAllowed('room-1', 'teacher-1', {
      id: 'student-1',
      roles: ['STUDENT']
    });

    expect(participants.findOne).toHaveBeenCalledWith({
      roomId: 'room-1',
      userId: 'student-1',
      admitted: true,
      leftAt: { $exists: false }
    });
  });

  it('exports class-session attendance from roster and participant records', async () => {
    const { service, participants, studentEnrollments } = createService();
    studentEnrollments.listBatchRoster.mockResolvedValue([
      {
        id: 'enrollment-1',
        enrollmentId: 'enrollment-1',
        userId: 'student-1',
        displayName: 'Ada Lovelace',
        email: 'ada@example.test',
        status: 'active',
        joinedAt: '2026-06-20T00:00:00.000Z'
      }
    ]);
    participants.find.mockReturnValueOnce({
      sort: jest.fn(() => ({
        exec: jest.fn(async () => [
          {
            id: 'participant-one',
            roomId: 'room-1',
            userId: 'student-1',
            displayName: 'Ada Lovelace',
            role: Role.PARTICIPANT,
            socketId: 'student-socket-one',
            admitted: true,
            joinedAt: new Date('2026-06-22T10:00:00.000Z'),
            leftAt: new Date('2026-06-22T10:30:00.000Z')
          },
          {
            id: 'participant-two',
            roomId: 'room-1',
            userId: 'student-1',
            displayName: 'Ada Lovelace',
            role: Role.PARTICIPANT,
            socketId: 'student-socket-two',
            admitted: true,
            joinedAt: new Date('2026-06-22T10:35:00.000Z')
          }
        ])
      }))
    });

    const csv = await service.exportClassSessionAttendanceCsv({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      completedAt: new Date('2026-06-22T11:00:00.000Z')
    });

    expect(csv).toContain('Student Name,Email,Student ID,First Join Time,Last Leave Time,Total Duration,Reconnect Count,Status');
    expect(csv).toContain(
      'Ada Lovelace,ada@example.test,student-1,2026-06-22T10:00:00.000Z,2026-06-22T10:30:00.000Z,00:55:00,1,present'
    );
  });

  it('rejects student media moderation outside a class-session room', async () => {
    const { service, classSessions, producers } = createService();
    classSessions.findOne.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.moderateStudentMedia('room-1', 'teacher-participant', 'student-participant', 'mute-mic');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(producers.findOne).not.toHaveBeenCalled();
  });

  it('rejects student media moderation after a class session has ended', async () => {
    const { service, classSessions, producers } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'completed' });

    let thrown: unknown;
    try {
      await service.moderateStudentMedia('room-1', 'teacher-participant', 'student-participant', 'stop-camera');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as Error | undefined)?.message).toBe('This class session has ended.');
    expect(producers.findOne).not.toHaveBeenCalled();
  });

  it('rejects student media moderation from non-moderators', async () => {
    const { service, classSessions, participants, producers } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    participants.findOne.mockResolvedValue({
      id: 'student-actor',
      roomId: 'room-1',
      role: Role.PARTICIPANT,
      admitted: true
    });

    let thrown: unknown;
    try {
      await service.moderateStudentMedia('room-1', 'student-actor', 'student-participant', 'mute-mic');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(producers.findOne).not.toHaveBeenCalled();
  });

  it('rejects student media moderation for targets outside the room', async () => {
    const { service, classSessions, participants, producers } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    participants.findOne
      .mockResolvedValueOnce({ id: 'teacher-participant', roomId: 'room-1', role: Role.HOST, admitted: true })
      .mockResolvedValueOnce(null);

    let thrown: unknown;
    try {
      await service.moderateStudentMedia('room-1', 'teacher-participant', 'missing-participant', 'mute-mic');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(producers.findOne).not.toHaveBeenCalled();
  });

  for (const [label, targetRole] of [
    ['host', Role.HOST],
    ['co-host', Role.CO_HOST],
    ['viewer', Role.VIEWER]
  ] as Array<[string, Role]>) {
    it(`rejects student media moderation for ${label} targets`, async () => {
      const { service, classSessions, producers, permissions, participants } = createService();
      const actor = { id: 'teacher-participant', roomId: 'room-1', role: Role.HOST };
      const target = { id: 'target-participant', roomId: 'room-1', role: targetRole, socketId: 'target-socket' };
      classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
      jest.spyOn(service as any, 'assertModerator').mockResolvedValue(actor);
      jest.spyOn(service as any, 'assertParticipant').mockResolvedValue(target);

      let thrown: unknown;
      try {
        await service.moderateStudentMedia('room-1', 'teacher-participant', 'target-participant', 'mute-mic');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as Error | undefined)?.message).toBe('Only student participant media can be moderated.');
      expect(producers.findOne).not.toHaveBeenCalled();
      expect(permissions.updateOne).not.toHaveBeenCalled();
      expect(participants.updateOne).not.toHaveBeenCalled();
    });
  }

  it('backfills a legacy producer nodeId from the local media registry before saving status changes', async () => {
    const { service, producers, media, metrics } = createService();
    const producer = fakeProducerDoc({ nodeId: undefined });
    producers.findById.mockResolvedValue(producer);
    media.getProducer.mockReturnValue({ id: 'producer-1', transportId: 'transport-1' });
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    await service.setProducerStatus('producer-1', 'publisher-1', 'paused');

    expect(producer.nodeId).toBe('node-a');
    expect(producers.updateOne).toHaveBeenCalledWith(
      {
        _id: 'producer-1',
        $or: [{ nodeId: { $exists: false } }, { nodeId: null }, { nodeId: '' }]
      },
      { $set: { nodeId: 'node-a' } }
    );
    expect(metrics.producerNodeIdFallbacks.labels).toHaveBeenCalledWith('local_media_registry');
    expect(metrics.producerNodeIdBackfills.labels).toHaveBeenCalledWith('local_media_registry');
  });

  it('treats a legacy producer without nodeId as remote on the owner when it is not registered locally', async () => {
    const { service, producers, media, pipeCoordinator, metrics } = createService();
    const producer = fakeProducerDoc({ nodeId: undefined });
    producers.findById.mockResolvedValue(producer);
    media.getProducer.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));
    jest.spyOn(service as any, 'assertCanControlProducer').mockResolvedValue(undefined);

    await service.setProducerStatus('producer-1', 'publisher-1', 'paused');

    expect(pipeCoordinator.syncOriginProducerState).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      status: 'paused'
    });
    expect(metrics.producerNodeIdFallbacks.labels).toHaveBeenCalledWith('assumed_remote_owner');
  });

  it('releases a legacy local producer publication during leaveRoom after resolving host ownership first', async () => {
    const { service, rooms, participants, producers, consumers, media, pipeCoordinator } = createService();
    const producer = fakeProducerDoc({ nodeId: undefined });
    participants.findById.mockResolvedValue({ id: 'publisher-1', roomId: 'room-1' });
    producers.find.mockResolvedValue([producer]);
    consumers.find.mockResolvedValue([]);
    rooms.findById.mockResolvedValue({ hostId: 'host-1' });
    media.getProducer.mockReturnValue({ id: 'producer-1', transportId: 'transport-1' });
    media.closeParticipantTransports.mockImplementation(async () => {
      media.getProducer.mockReturnValue(undefined);
    });
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));

    const result = await service.leaveRoom('room-1', 'publisher-1');

    expect(result).toEqual({ closed: false });
    expect(pipeCoordinator.releaseRemoteProducerPublication).toHaveBeenCalledWith('producer-1', 'participant_left');
  });

  it('records pipe cleanup failures when consumer feed release fails during closeConsumer', async () => {
    const { service, consumers, pipeCoordinator, metrics } = createService();
    consumers.findById.mockResolvedValue(fakeConsumerDoc());
    pipeCoordinator.releaseRemoteConsumerFeed.mockRejectedValue(new Error('cleanup failed'));
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));

    await service.closeConsumer('consumer-1', 'subscriber-1');

    expect(metrics.pipeCleanupFailures.labels).toHaveBeenCalledWith('close_consumer');
  });

  it('allows remote-node consumer layer updates locally and syncs demand back to the owner', async () => {
    const { service, consumers, producers, media, pipeCoordinator, nodeRegistry } = createService();
    const consumer = fakeConsumerDoc({ priority: 2, preferredLayer: 'medium', preferredLayers: { spatialLayer: 1 } });
    consumers.findById.mockResolvedValue(consumer);
    consumers.find.mockResolvedValue([consumer]);
    producers.findById.mockResolvedValue(fakeProducerDoc({ nodeId: 'node-b' }));
    media.setConsumerPreferredLayers.mockResolvedValue({
      currentLayers: { spatialLayer: 1, temporalLayer: 0 },
      targetLayers: { spatialLayer: 2, temporalLayer: 1 },
      switchReason: 'preferred',
      switchedAt: '2026-06-16T00:00:10.000Z'
    });
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));

    const result = await service.setConsumerPreferredLayers('consumer-1', 'subscriber-1', { spatialLayer: 2, temporalLayer: 1 });

    expect(nodeRegistry.assertLocalRoomOwner).not.toHaveBeenCalled();
    expect(media.setConsumerPreferredLayers).toHaveBeenCalledWith('consumer-1', { spatialLayer: 2, temporalLayer: 1 });
    expect(pipeCoordinator.syncRemoteConsumerState).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      status: 'live',
      priority: 2,
      preferredLayers: { spatialLayer: 2, temporalLayer: 1 },
      preferredSvcLayers: undefined
    });
    expect(result.preferredLayers).toEqual({ spatialLayer: 2, temporalLayer: 1 });
  });

  it('syncs owner-side consumer demand back to a remote origin producer', async () => {
    const { service, consumers, producers, media, pipeCoordinator } = createService();
    const consumer = fakeConsumerDoc({ priority: 3, status: 'live' });
    consumers.findById.mockResolvedValue(consumer);
    consumers.find.mockResolvedValue([consumer]);
    producers.findById.mockResolvedValue(fakeProducerDoc({ nodeId: 'node-b' }));
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(true));

    const result = await service.setConsumerStatus('consumer-1', 'subscriber-1', 'paused');

    expect(media.setConsumerPaused).toHaveBeenCalledWith('consumer-1', true);
    expect(pipeCoordinator.syncOriginConsumerState).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      status: 'paused',
      priority: 3,
      preferredLayers: { spatialLayer: 2, temporalLayer: undefined },
      preferredSvcLayers: undefined
    });
    expect(result.status).toBe('paused');
  });

  it('returns cached owner-published room quality on a non-owner node when pipe signaling is enabled', async () => {
    const { service, nodeRegistry, emitSignal } = createService();
    const state: RoomQualityState = {
      roomId: 'room-1',
      score: {
        score: 78,
        level: 'good',
        reasons: ['stable'],
        breakdown: {
          packetLossScore: 82,
          rttScore: 80,
          jitterScore: 77,
          congestionScore: 74,
          retransmissionScore: 76,
          allocationScore: 83
        },
        updatedAt: '2026-06-17T00:00:00.000Z'
      },
      consumers: [],
      producers: [],
      transports: [],
      targetBitrate: 1_400_000,
      allocatedBitrate: 1_200_000,
      actualBitrate: 1_050_000,
      congestionState: 'normal',
      updatedAt: '2026-06-17T00:00:00.000Z'
    };
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'subscriber-1', roomId: 'room-1' });

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:quality-updated',
      payload: [state]
    });

    const qualityState = await service.getRoomQualityState('room-1', 'subscriber-1');

    expect(qualityState).toEqual(state);
    expect(nodeRegistry.assertLocalRoomOwner).not.toHaveBeenCalled();
  });

  it('recomputes remote consumer demand before releasing the final remote feed', async () => {
    const { service, consumers, producers, media, pipeCoordinator } = createService();
    const consumer = fakeConsumerDoc({ priority: 4, preferredLayers: { spatialLayer: 1, temporalLayer: 0 }, status: 'live' });
    consumers.findById.mockResolvedValue(consumer);
    consumers.find.mockResolvedValue([]);
    producers.findById.mockResolvedValue(fakeProducerDoc({ nodeId: 'node-b' }));
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));

    await service.closeConsumer('consumer-1', 'subscriber-1');

    expect(pipeCoordinator.syncRemoteConsumerState).toHaveBeenCalledWith({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      status: 'paused'
    });
    expect(media.unregisterConsumer).toHaveBeenCalledWith('consumer-1');
    expect(pipeCoordinator.releaseRemoteConsumerFeed).toHaveBeenCalledWith('consumer-1', 'consumer_closed');
  });

  it('surfaces owner-authoritative room diagnostics from distributed quality cache on non-owner nodes', async () => {
    const { service, participants, emitSignal, media } = createService();
    const state: RoomQualityState = {
      roomId: 'room-1',
      score: {
        score: 84,
        level: 'good',
        reasons: ['stable'],
        breakdown: {
          packetLossScore: 85,
          rttScore: 82,
          jitterScore: 79,
          congestionScore: 81,
          retransmissionScore: 83,
          allocationScore: 86
        },
        updatedAt: '2026-06-17T00:00:00.000Z'
      },
      consumers: [],
      producers: [],
      transports: [],
      targetBitrate: 1_500_000,
      allocatedBitrate: 1_300_000,
      actualBitrate: 1_100_000,
      congestionState: 'normal',
      updatedAt: '2026-06-17T00:00:00.000Z'
    };
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.roomQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({
      id: 'room-1',
      name: 'Diagnostics Room',
      settings: {
        locked: false,
        waitingRoomEnabled: false,
        joinApprovalRequired: false,
        visibility: 'public',
        maxParticipants: 12,
        recordingEnabled: false,
        chatEnabled: true
      },
      mediaProfile: resolveRoomMediaProfile('meeting'),
      participants: [],
      producers: [],
      consumers: []
    });

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:quality-updated',
      payload: [state]
    });

    const diagnostics = await service.getRoomDiagnosticsForUser('room-1', 'user-1');

    expect(diagnostics.ownerAuthoritativeQuality).toBe(true);
    expect(diagnostics.qualitySource).toBe('remote-signal-cache');
    expect(diagnostics.quality).toEqual(state);
    expect(diagnostics.warnings).toEqual([]);
  });

  it('warns when a non-owner node falls back to local room quality without an owner signal', async () => {
    const { service, participants, media } = createService();
    const localState: RoomQualityState = {
      roomId: 'room-1',
      score: {
        score: 61,
        level: 'fair',
        reasons: ['bandwidth_limited'],
        breakdown: {
          packetLossScore: 68,
          rttScore: 62,
          jitterScore: 58,
          congestionScore: 55,
          retransmissionScore: 63,
          allocationScore: 59
        },
        updatedAt: '2026-06-17T00:00:00.000Z'
      },
      consumers: [],
      producers: [],
      transports: [],
      targetBitrate: 900_000,
      allocatedBitrate: 700_000,
      actualBitrate: 640_000,
      congestionState: 'overuse',
      updatedAt: '2026-06-17T00:00:00.000Z'
    };
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.roomQualityState.mockReturnValue(localState);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({
      id: 'room-1',
      name: 'Fallback Room',
      settings: {
        locked: false,
        waitingRoomEnabled: false,
        joinApprovalRequired: false,
        visibility: 'public',
        maxParticipants: 12,
        recordingEnabled: false,
        chatEnabled: true
      },
      mediaProfile: resolveRoomMediaProfile('meeting'),
      participants: [],
      producers: [],
      consumers: []
    });

    const diagnostics = await service.getRoomDiagnosticsForUser('room-1', 'user-1');

    expect(diagnostics.ownerAuthoritativeQuality).toBe(false);
    expect(diagnostics.qualitySource).toBe('local-fallback');
    expect(diagnostics.warnings).toContain('owner_quality_signal_unavailable');
  });

  it('serves cached remote consumer, producer, and transport quality on non-owner nodes', async () => {
    const { service, participants, producers, consumers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.consumerQualityState.mockReturnValue(undefined);
    media.producerQualityState.mockReturnValue(undefined);
    media.transportQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState({ consumerId: 'consumer-1', updatedAt: '2026-06-17T00:00:10.000Z' })]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'producer:score-updated',
      payload: [producerQualityState({ producerId: 'producer-1', updatedAt: '2026-06-17T00:00:10.000Z' })]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'transport:quality-updated',
      payload: [transportQualityState({ transportId: 'transport-1', updatedAt: '2026-06-17T00:00:10.000Z' })]
    });
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    producers.findById.mockResolvedValue(fakeProducerDoc());
    consumers.findById.mockResolvedValue(fakeConsumerDoc());

    const consumerState = await service.getConsumerQualityState('consumer-1', 'participant-1');
    const producerState = await service.getProducerQualityState('producer-1', 'participant-1');
    const transportState = await service.getTransportQualityStateForUser('transport-1', 'user-1');

    expect(consumerState.consumerId).toBe('consumer-1');
    expect(producerState.producerId).toBe('producer-1');
    expect(transportState.transportId).toBe('transport-1');
  });

  it('serves cached remote room quality summaries on non-owner nodes without rebuilding local worker context', async () => {
    const { service, emitSignal } = createService();
    const summary = summaryState();
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({ id: 'room-1', mediaProfile: summary.profile });

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:quality-summary-updated',
      payload: [summary]
    });

    const result = await service.getRoomQualitySummaryState('room-1', 'participant-1');

    expect(result).toEqual(summary);
  });

  it('applies distributed room profile updates once per profile version on non-owner nodes', async () => {
    const { service, producers, consumers, media, emitSignal } = createService();
    const updatedProfile = resolveRoomMediaProfile('webinar', {
      updatedAt: '2026-06-19T12:00:00.000Z',
      updatedByParticipantId: 'host-1'
    });
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({
      id: 'room-1',
      mediaProfile: updatedProfile,
      participants: [{ id: 'viewer-1', role: Role.VIEWER }]
    });
    producers.find.mockResolvedValue([fakeProducerDoc({ id: 'producer-video', kind: 'video', nodeId: 'node-b' })]);
    consumers.find.mockResolvedValue([
      fakeConsumerDoc({
        id: 'consumer-video',
        participantId: 'viewer-1',
        producerId: 'producer-video',
        priority: 0.5,
        preferredLayers: { spatialLayer: 0, temporalLayer: 0 }
      })
    ]);
    media.assertTransportOwner.mockImplementation(() => undefined);

    const roomUpdate = {
      id: 'room-1',
      mediaProfile: updatedProfile
    };

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:updated',
      payload: [roomUpdate]
    });
    await new Promise((resolve) => setImmediate(resolve));
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:updated',
      payload: [roomUpdate]
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(media.setConsumerPriority).toHaveBeenCalledTimes(1);
    expect(media.setConsumerPreferredLayers).toHaveBeenCalledTimes(1);
    expect(media.setConsumerPriority).toHaveBeenCalledWith('consumer-video', defaultConsumerPriority(updatedProfile, 'video'));
    expect(media.setConsumerPreferredLayers).toHaveBeenCalledWith(
      'consumer-video',
      defaultConsumerLayers(updatedProfile, 'video', { viewer: true })
    );
  });

  it('rejects stale distributed quality updates and keeps the newer cached state', async () => {
    const { service, participants, consumers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.consumerQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    consumers.findById.mockResolvedValue(fakeConsumerDoc());

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState({ consumerId: 'consumer-1', updatedAt: '2026-06-17T00:00:20.000Z', score: { score: 88 } })]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState({ consumerId: 'consumer-1', updatedAt: '2026-06-17T00:00:10.000Z', score: { score: 42 } })]
    });

    const state = await service.getConsumerQualityState('consumer-1', 'participant-1');

    expect(state.score.score).toBe(88);
  });

  it('expires stale distributed consumer quality cache entries on read', async () => {
    const { service, participants, consumers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.consumerQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    consumers.findById.mockResolvedValue(fakeConsumerDoc());
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState()]
    });

    nowSpy.mockReturnValue(1_000 + 16_000);
    let thrown: unknown;
    try {
      await service.getConsumerQualityState('consumer-1', 'participant-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    nowSpy.mockRestore();
  });

  it('clears distributed quality caches when a remote room closes', async () => {
    const { service, participants, consumers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.roomQualityState.mockReturnValue(undefined);
    media.consumerQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({ id: 'room-1', name: 'Closed Room', participants: [] });
    consumers.findById.mockResolvedValue(fakeConsumerDoc());

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:quality-updated',
      payload: [roomQualityState()]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState()]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:closed',
      payload: ['room-1']
    });

    let thrown: unknown;
    try {
      await service.getConsumerQualityState('consumer-1', 'participant-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('ignores late room-quality signals that arrive after remote room cleanup', async () => {
    const { service, emitSignal, media } = createService();
    media.roomQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:quality-updated',
      payload: [roomQualityState({ updatedAt: '2026-06-17T00:00:10.000Z' })]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:closed',
      payload: ['room-1']
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'room:quality-updated',
      payload: [roomQualityState({ updatedAt: '2026-06-17T00:00:09.000Z' })]
    });

    let thrown: unknown;
    try {
      await (service as any).resolveRoomQualityState('room-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('evicts participant-scoped distributed quality caches on participant left signals', async () => {
    const { service, participants, consumers, producers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.consumerQualityState.mockReturnValue(undefined);
    media.producerQualityState.mockReturnValue(undefined);
    media.transportQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    consumers.findById.mockResolvedValue(fakeConsumerDoc());
    producers.findById.mockResolvedValue(fakeProducerDoc());

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState()]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'producer:score-updated',
      payload: [producerQualityState({ participantId: 'participant-1' })]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'transport:quality-updated',
      payload: [transportQualityState()]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'participant:left',
      payload: ['participant-1']
    });

    let consumerError: unknown;
    let producerError: unknown;
    let transportError: unknown;
    try {
      await service.getConsumerQualityState('consumer-1', 'participant-1');
    } catch (error) {
      consumerError = error;
    }
    try {
      await service.getProducerQualityState('producer-1', 'participant-1');
    } catch (error) {
      producerError = error;
    }
    try {
      await service.getTransportQualityState('transport-1', 'participant-1');
    } catch (error) {
      transportError = error;
    }

    expect(consumerError).toBeInstanceOf(NotFoundException);
    expect(producerError).toBeInstanceOf(NotFoundException);
    expect(transportError).toBeInstanceOf(NotFoundException);
  });

  it('ignores late consumer-quality signals that arrive after consumer cleanup', async () => {
    const { service, participants, consumers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.consumerQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    consumers.findById.mockResolvedValue(fakeConsumerDoc());

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState({ updatedAt: '2026-06-17T00:00:20.000Z' })]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:closed',
      payload: ['consumer-1']
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState({ updatedAt: '2026-06-17T00:00:19.000Z' })]
    });

    let thrown: unknown;
    try {
      await service.getConsumerQualityState('consumer-1', 'participant-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('survives repeated distributed quality hydrate and cleanup cycles without leaking stale state', async () => {
      const { service, participants, consumers, emitSignal, media } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    media.consumerQualityState.mockReturnValue(undefined);
    jest.spyOn(service as any, 'requireRoomOwnerLookup').mockResolvedValue(ownerLookup(false));
    jest.spyOn(service as any, 'assertParticipant').mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    consumers.findById.mockResolvedValue(fakeConsumerDoc());

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const updatedAt = new Date(Date.now() + cycle + 1).toISOString();
      emitSignal({
        sourceNodeId: 'node-b',
        roomId: 'room-1',
        event: 'consumer:score-updated',
        payload: [consumerQualityState({ updatedAt, score: { score: 70 + cycle } })]
      });
      const state = await service.getConsumerQualityState('consumer-1', 'participant-1');
      expect(state.score.score).toBe(70 + cycle);

      emitSignal({
        sourceNodeId: 'node-b',
        roomId: 'room-1',
        event: 'room:closed',
        payload: ['room-1']
      });
      let cycleError: unknown;
      try {
        await service.getConsumerQualityState('consumer-1', 'participant-1');
      } catch (error) {
        cycleError = error;
      }
      expect(cycleError).toBeInstanceOf(NotFoundException);
    }
  });

  it('builds room-scoped adaptive diagnostics from owner-authoritative room quality state', async () => {
    const { service, participants } = createService();
    participants.findOne.mockResolvedValue({ id: 'participant-1', roomId: 'room-1' });
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({ id: 'room-1', participants: [{ id: 'participant-1' }, { id: 'participant-2' }] });
    jest.spyOn(service as any, 'resolveRoomQualityState').mockResolvedValue({
      owner: ownerLookup(true),
      quality: roomQualityState({
        consumers: [
          consumerQualityState({
            consumerId: 'consumer-1',
            score: { score: 55, reasons: ['bandwidth_limited'] },
            currentLayers: { spatialLayer: 0, temporalLayer: 0 },
            targetLayers: { spatialLayer: 1, temporalLayer: 1 }
          }),
          consumerQualityState({
            consumerId: 'consumer-2',
            score: { score: 92 }
          })
        ],
        transports: [transportQualityState()],
        producers: [producerQualityState({ dynacastEnabled: true, activeLayers: [{ spatialLayer: 0, temporalLayer: 0 }], suspendedLayers: [{ spatialLayer: 2, temporalLayer: 1 }] })],
        congestionState: 'overuse'
      }),
      qualitySource: 'local-owner',
      ownerAuthoritativeQuality: true,
      distributedSignalAgeMs: undefined,
      warnings: []
    });

    const diagnostics = await service.getRoomAdaptiveDiagnosticsForUser('room-1', 'user-1');

    expect(diagnostics.consumers.degraded).toBe(1);
    expect(diagnostics.consumers.withPendingLayerSwitch).toBe(1);
    expect(diagnostics.producers.suspendedLayerCount).toBe(1);
    expect(diagnostics.adaptiveDecisions.length).toBe(1);
    expect(diagnostics.congestionState).toBe('overuse');
  });

  it('uses fresh distributed quality fallbacks when building room producer and consumer snapshots', () => {
    const { service, emitSignal, media } = createService();
    media.producerQualityState.mockReturnValue(undefined);
    media.consumerQualityState.mockReturnValue(undefined);

    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'producer:score-updated',
      payload: [producerQualityState()]
    });
    emitSignal({
      sourceNodeId: 'node-b',
      roomId: 'room-1',
      event: 'consumer:score-updated',
      payload: [consumerQualityState()]
    });

    const producer = (service as any).toProducer(fakeProducerDoc());
    const consumer = (service as any).toConsumer(fakeConsumerDoc());

    expect(producer.quality?.producerId).toBe('producer-1');
    expect(consumer.quality?.consumerId).toBe('consumer-1');
  });

  it('falls back to persisted remote producer state when no local worker mapping exists', () => {
    const { service, media } = createService();
    media.producerLayerState.mockImplementation(() => {
      throw new Error('Media producer producer-1 is not assigned to a worker');
    });
    media.producerQualityState.mockImplementation(() => {
      throw new Error('Media producer producer-1 is not assigned to a worker');
    });

    const producer = (service as any).toProducer(
      fakeProducerDoc({
        nodeId: 'node-b',
        dynacastState: { desiredLayers: [{ spatialLayer: 1 }] },
        svcState: { activeLayers: [{ spatialLayerId: 0, temporalLayerId: 0, qualityLayerId: 0 }] }
      })
    );

    expect(producer.dynacast?.desiredLayers?.[0]?.spatialLayer).toBe(1);
    expect(producer.svc?.activeLayers?.[0]?.qualityLayerId).toBe(0);
    expect(media.producerLayerState).not.toHaveBeenCalled();
    expect(media.producerQualityState).not.toHaveBeenCalled();
  });

  it('falls back to persisted consumer state while a worker mapping is not available yet', () => {
    const { service, media } = createService();
    media.consumerLayerState.mockImplementation(() => {
      throw new Error('Media consumer consumer-1 is not assigned to a worker');
    });
    media.consumerQualityState.mockImplementation(() => {
      throw new Error('Media consumer consumer-1 is not assigned to a worker');
    });

    const consumer = (service as any).toConsumer(
      fakeConsumerDoc({
        preferredLayers: { spatialLayer: 2, temporalLayer: 1 },
        currentLayers: { spatialLayer: 1, temporalLayer: 0 },
        targetLayers: { spatialLayer: 2, temporalLayer: 1 },
        preferredSvcLayers: { spatialLayerId: 0, temporalLayerId: 1, qualityLayerId: 0 }
      })
    );

    expect(consumer.layerState.currentLayers?.spatialLayer).toBe(1);
    expect(consumer.layerState.targetLayers?.spatialLayer).toBe(2);
    expect(consumer.quality).toBeUndefined();
  });

  it('skips Mongo consumer-layer persistence for internal pipe consumers', async () => {
    const { consumers, media } = createService();
    const listener = media.onConsumerLayerEvent.mock.calls[0]?.[0] as ((event: ConsumerLayerEvent) => Promise<void>) | undefined;

    expect(listener).toBeDefined();
    await listener?.({
      type: 'switching',
      roomId: 'room-1',
      consumerId: 'pipe-consumer:producer-1:node-b',
      participantId: 'pipe:node-b',
      producerId: 'producer-1',
      reason: 'bandwidth',
      timestamp: '2026-06-18T06:20:00.000Z',
      currentLayers: { spatialLayer: 1, temporalLayer: 0 },
      targetLayers: { spatialLayer: 2, temporalLayer: 0 },
      preferredLayers: { spatialLayer: 2, temporalLayer: 0 }
    });

    expect(consumers.updateOne).not.toHaveBeenCalled();
  });

  it('cleans up distributed local room state when a room is closed on another node', async () => {
    const { media, pipeCoordinator, metrics, emitSignal } = createService();
    media.closeRoom.mockResolvedValue({
      participantIds: ['participant-local-1'],
      transportCount: 1,
      consumerCount: 1,
      producerCounts: { video: 1 },
      pipeTransportCount: 1
    });

    emitSignal({
      sourceNodeId: 'node-a',
      roomId: 'room-1',
      event: 'room:closed',
      payload: ['room-1']
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pipeCoordinator.closeRoomBindings).toHaveBeenCalledWith('room-1');
    expect(media.closeRoom).toHaveBeenCalledWith('room-1');
    expect(metrics.activeParticipants.labels).toHaveBeenCalledWith('room-1');
    expect(metrics.activeTransports.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeConsumers.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeProducers.labels).toHaveBeenCalledWith('video');
  });

  it('decrements active room entity gauges when a room is explicitly closed', async () => {
    const { service, participants, producers, consumers, media, nodeRegistry, metrics, pipeCoordinator } = createService();
    const summary = summaryState();
    (service as any).roomQualitySummaryStates.set('room-1', summary);
    const room = {
      id: 'room-1',
      mediaProfile: { id: 'meeting' }
    };
    (service as any).rooms.findById.mockResolvedValue(room);
    participants.find.mockResolvedValue([{ id: 'participant-1', nodeId: 'node-a' }, { id: 'participant-remote', nodeId: 'node-b' }]);
    media.closeRoom.mockResolvedValue({
      participantIds: ['participant-1'],
      transportCount: 1,
      consumerCount: 2,
      producerCounts: { video: 1, audio: 1 },
      pipeTransportCount: 1
    });
    nodeRegistry.assertLocalRoomOwner.mockResolvedValue(undefined);
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(undefined);

    await service.closeRoom('room-1', 'host-1');

    expect(participants.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', leftAt: { $exists: false } });
    expect(participants.updateMany.mock.calls[0]?.[1]?.leftAt).toBeInstanceOf(Date);
    expect(producers.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', status: { $ne: 'closed' } });
    expect(producers.updateMany.mock.calls[0]?.[1]?.status).toBe('closed');
    expect(producers.updateMany.mock.calls[0]?.[1]?.closedAt).toBeInstanceOf(Date);
    expect(consumers.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', status: { $ne: 'closed' } });
    expect(consumers.updateMany.mock.calls[0]?.[1]?.status).toBe('closed');
    expect(consumers.updateMany.mock.calls[0]?.[1]?.closedAt).toBeInstanceOf(Date);
    expect(pipeCoordinator.closeRoomBindings).toHaveBeenCalledWith('room-1');
    expect(media.closeRoom).toHaveBeenCalledWith('room-1');
    expect(metrics.clearRoomAutopilotSummary).toHaveBeenCalledWith(summary);
    expect(metrics.roomProfileDistribution.labels).toHaveBeenCalledWith('meeting');
    expect(metrics.activeTransports.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeParticipants.labels).toHaveBeenCalledWith('room-1');
    expect(metrics.activeParticipants.labels.mock.results[0]?.value.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeConsumers.dec).toHaveBeenCalledTimes(2);
    expect(metrics.activeRooms.dec).toHaveBeenCalledTimes(1);
  });

  it('blocks generic room close for live class-session rooms', async () => {
    const { service, classSessions, nodeRegistry, media } = createService();
    classSessions.findOne.mockResolvedValue({ id: 'session-1', roomId: 'room-1', status: 'live' });
    nodeRegistry.assertLocalRoomOwner.mockResolvedValue(undefined);
    jest.spyOn(service as any, 'assertModerator').mockResolvedValue(undefined);

    let thrown: unknown;
    try {
      await service.closeRoom('room-1', 'host-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(media.closeRoom).not.toHaveBeenCalled();
  });

  it('closes and notifies class-session media rooms when a live class is ended', async () => {
    const { service, rooms, participants, producers, consumers, media, nodeRegistry, pipeCoordinator, platformEvents } = createService();
    const closedRoomIds: string[] = [];
    const room = {
      id: 'room-1',
      name: 'Class Session',
      mediaProfile: { id: 'classroom' },
      closedAt: undefined
    };
    rooms.findById.mockResolvedValue(room);
    participants.find.mockResolvedValue([{ id: 'teacher-participant', nodeId: 'node-a' }, { id: 'student-participant', nodeId: 'node-a' }]);
    media.closeRoom.mockResolvedValue({
      participantIds: ['teacher-participant', 'student-participant'],
      transportCount: 2,
      consumerCount: 1,
      producerCounts: { video: 1, audio: 1 },
      pipeTransportCount: 0
    });
    service.onRoomClosed((roomId) => {
      closedRoomIds.push(roomId);
    });

    const closed = await service.closeClassSessionRoom({
      roomId: 'room-1',
      actorUserId: 'teacher-1',
      actorLabel: 'teacher@example.test'
    });

    expect(closed).toBe(true);
    expect(nodeRegistry.assertLocalRoomOwner).toHaveBeenCalledWith('room-1');
    expect(rooms.updateOne.mock.calls[0]?.[0]).toEqual({ _id: 'room-1' });
    expect(rooms.updateOne.mock.calls[0]?.[1]?.closedAt).toBeInstanceOf(Date);
    expect(participants.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', leftAt: { $exists: false } });
    expect(participants.updateMany.mock.calls[0]?.[1]?.leftAt).toBeInstanceOf(Date);
    expect(producers.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', status: { $ne: 'closed' } });
    expect(producers.updateMany.mock.calls[0]?.[1]?.status).toBe('closed');
    expect(producers.updateMany.mock.calls[0]?.[1]?.closedAt).toBeInstanceOf(Date);
    expect(consumers.updateMany.mock.calls[0]?.[0]).toEqual({ roomId: 'room-1', status: { $ne: 'closed' } });
    expect(consumers.updateMany.mock.calls[0]?.[1]?.status).toBe('closed');
    expect(consumers.updateMany.mock.calls[0]?.[1]?.closedAt).toBeInstanceOf(Date);
    expect(pipeCoordinator.closeRoomBindings).toHaveBeenCalledWith('room-1');
    expect(media.closeRoom).toHaveBeenCalledWith('room-1');
    const roomClosedEvent = platformEvents.appendEvent.mock.calls.find(([event]) => event.type === 'room.closed')?.[0];
    expect(roomClosedEvent?.type).toBe('room.closed');
    expect(roomClosedEvent?.roomId).toBe('room-1');
    expect(roomClosedEvent?.actor).toEqual({
      type: 'operator',
      userId: 'teacher-1',
      label: 'teacher@example.test'
    });
    expect(closedRoomIds).toEqual(['room-1']);
  });

  it('clears worker-room quarantine after room failure cleanup completes', async () => {
    const { service, rooms, participants, producers, consumers, redis, media, nodeRegistry, pipeCoordinator, metrics } = createService();
    const summary = summaryState();
    (service as any).roomQualitySummaryStates.set('room-1', summary);
    const room = {
      id: 'room-1',
      mediaProfile: { id: 'meeting' },
      mediaState: { status: 'active' },
      closedAt: undefined,
      set: jest.fn(),
      save: jest.fn(async () => undefined)
    };
    rooms.findById.mockResolvedValue(room);
    participants.find.mockResolvedValue([{ id: 'participant-1' }, { id: 'participant-remote', nodeId: 'node-b' }]);
    producers.find.mockResolvedValue([
      { id: 'producer-1', kind: 'video', nodeId: 'node-a', participantId: 'participant-1' },
      { id: 'producer-remote', kind: 'video', nodeId: 'node-b', participantId: 'participant-remote' }
    ]);
    consumers.find.mockResolvedValue([{ id: 'consumer-1', participantId: 'participant-1' }, { id: 'consumer-2', participantId: 'participant-remote' }]);
    media.workerPoolSnapshot = jest.fn(() => ({ failedRooms: [], workers: [], workerCount: 1, readyWorkers: 1, healthyWorkers: 1, drainingWorkers: 0, overloadedWorkers: 0, activeRooms: 0, failures: [], mode: 'worker' }));

    await service.handleMediaRoomFailure({
      roomId: 'room-1',
      workerId: 'media-worker-1',
      reason: 'worker_crashed',
      message: 'Media worker media-worker-1 crashed',
      failedAt: '2026-06-18T08:52:17.149Z',
      affectedTransports: ['transport-1'],
      affectedProducers: ['producer-1'],
      affectedConsumers: ['consumer-1'],
      recoverable: false
    });

    expect(pipeCoordinator.closeRoomBindings).toHaveBeenCalledWith('room-1');
    expect(media.acknowledgeRoomFailure).toHaveBeenCalledWith('room-1');
    expect(nodeRegistry.releaseRoom).toHaveBeenCalledWith('room-1');
    expect(redis.removePresence).toHaveBeenCalledWith('room-1', 'participant-1');
    expect(metrics.clearRoomAutopilotSummary).toHaveBeenCalledWith(summary);
    expect(metrics.roomProfileDistribution.labels).toHaveBeenCalledWith('meeting');
    expect(metrics.activeProducers.labels).toHaveBeenCalledWith('video');
    expect(metrics.activeProducers.labels.mock.results[0]?.value.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeParticipants.labels.mock.results[0]?.value.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeConsumers.dec).toHaveBeenCalledTimes(1);
    expect(metrics.activeTransports.dec).toHaveBeenCalledTimes(1);
    expect(metrics.mediaWorkerFailedRooms.set).toHaveBeenCalledWith(0);
  });
});

function createService(): {
  service: RoomsService;
  rooms: { create: jest.Mock; findById: jest.Mock; updateOne: jest.Mock };
  batches: { find: jest.Mock; findOne: jest.Mock };
  studentEnrollments: { isStudentEnrolledInBatch: jest.Mock; listBatchRoster: jest.Mock };
  batchSchedules: { find: jest.Mock };
  classSessions: { findById: jest.Mock; findOne: jest.Mock; find: jest.Mock; findOneAndUpdate: jest.Mock; updateOne: jest.Mock };
  participants: { create: jest.Mock; findById: jest.Mock; findOne: jest.Mock; find: jest.Mock; countDocuments: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  permissions: { create: jest.Mock; find: jest.Mock; findOne: jest.Mock; updateOne: jest.Mock };
  producers: { findById: jest.Mock; findOne: jest.Mock; find: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  consumers: { findById: jest.Mock; find: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  moderation: { create: jest.Mock; exists: jest.Mock; updateMany: jest.Mock };
  chatAttachments: { create: jest.Mock; findOne: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  chat: { create: jest.Mock; find: jest.Mock; countDocuments: jest.Mock };
  chatReadStates: { find: jest.Mock; findOneAndUpdate: jest.Mock };
  redis: { markPresence: jest.Mock; removePresence: jest.Mock; participantPresence: jest.Mock; participantsPresence: jest.Mock };
  media: {
    onConsumerLayerEvent: jest.Mock;
    onProducerDynacastEvent: jest.Mock;
    onConsumerScoreUpdated: jest.Mock;
    onProducerScoreUpdated: jest.Mock;
    onTransportQualityUpdated: jest.Mock;
    onRoomQualityUpdated: jest.Mock;
    onMediaWorkerRoomFailed: jest.Mock;
    acknowledgeRoomFailure: jest.Mock;
    workerPoolSnapshot: jest.Mock;
    getProducer: jest.Mock;
    producerLayerState: jest.Mock;
    producerQualityState: jest.Mock;
    consumerLayerState: jest.Mock;
    consumerQualityState: jest.Mock;
    roomQualityState: jest.Mock;
    roomWorkerId: jest.Mock;
    transportQualityState: jest.Mock;
    assertTransportOwner: jest.Mock;
    registerConsumer: jest.Mock;
    closeRoom: jest.Mock;
    closeParticipantTransports: jest.Mock;
    unregisterConsumer: jest.Mock;
    setConsumerPaused: jest.Mock;
    setConsumerPriority: jest.Mock;
    setConsumerPreferredLayers: jest.Mock;
    setConsumerPreferredSvcLayers: jest.Mock;
    setProducerPaused: jest.Mock;
    setProducerPriority: jest.Mock;
    unregisterProducer: jest.Mock;
  };
  nodeRegistry: {
    localNodeId: jest.Mock;
    assertLocalCanOwnNewRoom: jest.Mock;
    assertLocalRoomOwner: jest.Mock;
    claimRoom: jest.Mock;
    getRoomOwner: jest.Mock;
    releaseRoom: jest.Mock;
  };
  pipeCoordinator: {
    isEnabled: jest.Mock;
    ensureRemoteConsumerFeed: jest.Mock;
    syncRemoteProducerState: jest.Mock;
    syncOriginProducerState: jest.Mock;
    syncRemoteConsumerState: jest.Mock;
    syncOriginConsumerState: jest.Mock;
    releaseRemoteConsumerFeed: jest.Mock;
    releaseRemoteProducerPublication: jest.Mock;
    closeOriginProducer: jest.Mock;
    closeRoomBindings: jest.Mock;
  };
  emitSignal: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void;
  signals: { onSignal: jest.Mock; publish: jest.Mock };
  platformEvents: { appendEvent: jest.Mock; listEvents: jest.Mock };
  recordings: { stopActiveClassSessionRecording: jest.Mock };
  config: { get: jest.Mock };
  metrics: {
    activeRooms: { inc: jest.Mock; dec: jest.Mock };
    activeParticipants: { labels: jest.Mock };
    activeTransports: { inc: jest.Mock; dec: jest.Mock };
    activeProducers: { labels: jest.Mock };
    activeConsumers: { inc: jest.Mock; dec: jest.Mock };
    roomAdmissionRejections: { labels: jest.Mock };
    classSessionLifecycleTransitions: { labels: jest.Mock };
    classSessionJoinAttempts: { labels: jest.Mock };
    classSessionReconnectGraceEvents: { labels: jest.Mock };
    activeClassSessionReconnectGraceTimers: { set: jest.Mock };
    classSessionMediaFailures: { labels: jest.Mock };
    classSessionChatFailures: { labels: jest.Mock };
    classSessionModerationActions: { labels: jest.Mock };
    classSessionWhiteboardControlActions: { labels: jest.Mock };
    classSessionMaterialActions: { labels: jest.Mock };
    roomJoinDuration: { observe: jest.Mock };
    roomProfileDistribution: { labels: jest.Mock };
    roomProfileChanges: { labels: jest.Mock };
    roomProtectionDecisions: { labels: jest.Mock };
    producerPriorityUpdates: { labels: jest.Mock };
    producerNodeIdFallbacks: { labels: jest.Mock };
    producerNodeIdBackfills: { labels: jest.Mock };
    pipeCleanupFailures: { labels: jest.Mock };
    incidentSnapshotsGenerated: { labels: jest.Mock };
    snapshotBundlesGenerated: { labels: jest.Mock };
    roomRecoveryActions: { labels: jest.Mock };
    reopenedRooms: { inc: jest.Mock };
    roomsUnderRecovery: { inc: jest.Mock; dec: jest.Mock };
    roomRecoveryDuration: { observe: jest.Mock };
    roomAlertEvents: { labels: jest.Mock };
    roomIncidentTimelineEvents: { labels: jest.Mock };
    mediaWorkerFailedRooms: { set: jest.Mock };
    mediaWorkerRoomFailures: { labels: jest.Mock };
    updateRoomAutopilotSummary: jest.Mock;
    clearRoomAutopilotSummary: jest.Mock;
  };
} {
  const rooms = {
    create: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn()
  };
  const batches = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null)
  };
  const studentEnrollments = {
    isStudentEnrolledInBatch: jest.fn(async () => true),
    listBatchRoster: jest.fn(async () => [])
  };
  const batchSchedules = {
    find: jest.fn(() => ({ sort: jest.fn(async () => []) }))
  };
  const classSessions = {
    findById: jest.fn(async () => null),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 }))
  };
  const roomIncidentEvents = {
    find: jest.fn(() => ({ sort: jest.fn(() => ({ limit: jest.fn(async () => []) })) })),
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(async (payload: Record<string, unknown>) => ({
      id: 'incident-event-1',
      ...payload
    }))
  };
  const roomSnapshotBundles = {
    find: jest.fn(() => ({ sort: jest.fn(() => ({ limit: jest.fn(async () => []) })) })),
    findById: jest.fn(),
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(async (payload: Record<string, unknown>) => ({
      id: 'snapshot-bundle-1',
      ...payload,
      save: jest.fn(async () => undefined)
    }))
  };
  const participants = {
    create: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(async () => []),
    countDocuments: jest.fn(async () => 0),
    updateOne: jest.fn(),
    updateMany: jest.fn()
  };
  const permissions = {
    create: jest.fn(),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 }))
  };
  const producers = {
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(async () => []),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    updateMany: jest.fn()
  };
  const consumers = {
    findById: jest.fn(),
    find: jest.fn(async () => []),
    updateOne: jest.fn(async () => ({ modifiedCount: 0 })),
    updateMany: jest.fn()
  };
  const moderation = {
    create: jest.fn(async (payload: Record<string, unknown>) => ({ id: 'moderation-1', ...payload })),
    exists: jest.fn(async () => null),
    updateMany: jest.fn(async () => ({ modifiedCount: 0 }))
  };
  const chatAttachments = {
    create: jest.fn(async (payload: Record<string, unknown>) => ({
      id: payload.attachmentId,
      ...payload,
      createdAt: new Date('2026-06-22T10:00:00.000Z')
    })),
    findOne: jest.fn(async () => null),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    updateMany: jest.fn(async () => ({ modifiedCount: 0 }))
  };
  const chat = {
    create: jest.fn(),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({
          exec: jest.fn(async () => [])
        }))
      }))
    })),
    countDocuments: jest.fn(async () => 0)
  };
  const chatReadStates = {
    find: jest.fn(async () => []),
    findOneAndUpdate: jest.fn()
  };
  const redis = {
    markPresence: jest.fn(async () => undefined),
    removePresence: jest.fn(),
    participantPresence: jest.fn(async () => []),
    participantsPresence: jest.fn(async () => [])
  };
  let signalListener: ((signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void) | undefined;
  const media = {
    onConsumerLayerEvent: jest.fn(),
    onProducerDynacastEvent: jest.fn(),
    onConsumerScoreUpdated: jest.fn(),
    onProducerScoreUpdated: jest.fn(),
    onTransportQualityUpdated: jest.fn(),
    onRoomQualityUpdated: jest.fn(),
    onMediaWorkerRoomFailed: jest.fn(),
    acknowledgeRoomFailure: jest.fn(),
    workerPoolSnapshot: jest.fn(() => ({ failedRooms: [], workers: [], workerCount: 1, readyWorkers: 1, healthyWorkers: 1, drainingWorkers: 0, overloadedWorkers: 0, activeRooms: 0, failures: [], mode: 'worker' })),
    getProducer: jest.fn(() => undefined),
    producerLayerState: jest.fn(() => undefined),
    producerQualityState: jest.fn(() => undefined),
    consumerLayerState: jest.fn(() => undefined),
    consumerQualityState: jest.fn(() => undefined),
    roomQualityState: jest.fn(() => undefined),
    roomWorkerId: jest.fn(() => undefined),
    transportQualityState: jest.fn(() => undefined),
    assertTransportOwner: jest.fn(),
    registerConsumer: jest.fn(),
    closeRoom: jest.fn(async () => ({
      participantIds: [],
      transportCount: 0,
      consumerCount: 0,
      producerCounts: {},
      pipeTransportCount: 0
    })),
    closeParticipantTransports: jest.fn(),
    unregisterConsumer: jest.fn(),
    setConsumerPaused: jest.fn(),
    setConsumerPriority: jest.fn(),
    setConsumerPreferredLayers: jest.fn(async () => undefined),
    setConsumerPreferredSvcLayers: jest.fn(async () => undefined),
    setProducerPaused: jest.fn(),
    setProducerPriority: jest.fn(),
    unregisterProducer: jest.fn()
  };
  const nodeRegistry = {
    localNodeId: jest.fn(() => 'node-a'),
    assertLocalCanOwnNewRoom: jest.fn(),
    assertLocalRoomOwner: jest.fn(),
    claimRoom: jest.fn(async () => ownerLookup(true).owner),
    getRoomOwner: jest.fn(async () => ownerLookup(true).owner),
    lookupRoomOwner: jest.fn(async () => ownerLookup(true)),
    snapshot: jest.fn(async () => ({
      localNode: { nodeId: 'node-a', region: 'test', zone: 'test-a', health: 'healthy', draining: false, capacity: { capacityScore: 0.1 } },
      nodes: [{ nodeId: 'node-a', region: 'test', zone: 'test-a', health: 'healthy', draining: false, capacity: { capacityScore: 0.1 } }],
      ownedRoomCount: 1
    })),
    releaseRoom: jest.fn()
  };
  const pipeCoordinator = {
    isEnabled: jest.fn(() => true),
    ensureRemoteConsumerFeed: jest.fn(async () => ({ pipeTransportId: 'pipe-1', proxyProducerId: 'producer-1' })),
    syncRemoteProducerState: jest.fn(async () => undefined),
    syncOriginProducerState: jest.fn(async () => true),
    syncRemoteConsumerState: jest.fn(async () => undefined),
    syncOriginConsumerState: jest.fn(async () => true),
    releaseRemoteConsumerFeed: jest.fn(async () => undefined),
    releaseRemoteProducerPublication: jest.fn(async () => undefined),
    closeOriginProducer: jest.fn(async () => true),
    closeRoomBindings: jest.fn(async () => undefined)
  };
  const signals = {
    onSignal: jest.fn((listener: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void) => {
      signalListener = listener;
      return jest.fn();
    }),
    publish: jest.fn(async () => undefined)
  };
  const platformEvents = {
    appendEvent: jest.fn(async () => ({ id: 'platform-event-1' })),
    listEvents: jest.fn(async () => ({ events: [] }))
  };
  const activeParticipantsMetric = { inc: jest.fn(), dec: jest.fn() };
  const activeTransports = { inc: jest.fn(), dec: jest.fn() };
  const activeProducersMetric = { inc: jest.fn(), dec: jest.fn() };
  const activeConsumers = { inc: jest.fn(), dec: jest.fn() };
  const activeRooms = { inc: jest.fn(), dec: jest.fn() };
  const roomAdmissionRejectionMetric = { inc: jest.fn() };
  const classSessionMetric = { inc: jest.fn() };
  const activeClassSessionReconnectGraceTimers = { set: jest.fn() };
  const roomProfileDistributionMetric = { inc: jest.fn(), dec: jest.fn() };
  const roomProfileChangesMetric = { inc: jest.fn() };
  const roomProtectionDecisionMetric = { inc: jest.fn() };
  const producerPriorityMetric = { inc: jest.fn() };
  const producerNodeIdFallbackMetric = { inc: jest.fn() };
  const producerNodeIdBackfillMetric = { inc: jest.fn() };
  const pipeCleanupFailureMetric = { inc: jest.fn() };
  const incidentSnapshotMetric = { inc: jest.fn() };
  const snapshotBundleMetric = { inc: jest.fn() };
  const roomRecoveryActionMetric = { inc: jest.fn() };
  const reopenedRooms = { inc: jest.fn() };
  const roomsUnderRecovery = { inc: jest.fn(), dec: jest.fn() };
  const roomRecoveryDuration = { observe: jest.fn() };
  const roomAlertEventMetric = { inc: jest.fn() };
  const roomIncidentTimelineMetric = { inc: jest.fn() };
  const mediaWorkerRoomFailureMetric = { inc: jest.fn() };
  const mediaWorkerFailedRooms = { set: jest.fn() };
  const metrics = {
    activeRooms,
    activeParticipants: {
      labels: jest.fn(() => activeParticipantsMetric)
    },
    activeTransports,
    activeProducers: {
      labels: jest.fn(() => activeProducersMetric)
    },
    activeConsumers,
    roomAdmissionRejections: {
      labels: jest.fn(() => roomAdmissionRejectionMetric)
    },
    classSessionLifecycleTransitions: {
      labels: jest.fn(() => classSessionMetric)
    },
    classSessionJoinAttempts: {
      labels: jest.fn(() => classSessionMetric)
    },
    classSessionReconnectGraceEvents: {
      labels: jest.fn(() => classSessionMetric)
    },
    activeClassSessionReconnectGraceTimers,
    classSessionMediaFailures: {
      labels: jest.fn(() => classSessionMetric)
    },
    classSessionChatFailures: {
      labels: jest.fn(() => classSessionMetric)
    },
    classSessionModerationActions: {
      labels: jest.fn(() => classSessionMetric)
    },
    classSessionWhiteboardControlActions: {
      labels: jest.fn(() => classSessionMetric)
    },
    classSessionMaterialActions: {
      labels: jest.fn(() => classSessionMetric)
    },
    roomJoinDuration: {
      observe: jest.fn()
    },
    roomProfileDistribution: {
      labels: jest.fn(() => roomProfileDistributionMetric)
    },
    roomProfileChanges: {
      labels: jest.fn(() => roomProfileChangesMetric)
    },
    roomProtectionDecisions: {
      labels: jest.fn(() => roomProtectionDecisionMetric)
    },
    producerPriorityUpdates: {
      labels: jest.fn(() => producerPriorityMetric)
    },
    producerNodeIdFallbacks: {
      labels: jest.fn(() => producerNodeIdFallbackMetric)
    },
    producerNodeIdBackfills: {
      labels: jest.fn(() => producerNodeIdBackfillMetric)
    },
    pipeCleanupFailures: {
      labels: jest.fn(() => pipeCleanupFailureMetric)
    },
    incidentSnapshotsGenerated: {
      labels: jest.fn(() => incidentSnapshotMetric)
    },
    snapshotBundlesGenerated: {
      labels: jest.fn(() => snapshotBundleMetric)
    },
    roomRecoveryActions: {
      labels: jest.fn(() => roomRecoveryActionMetric)
    },
    reopenedRooms,
    roomsUnderRecovery,
    roomRecoveryDuration,
    roomAlertEvents: {
      labels: jest.fn(() => roomAlertEventMetric)
    },
    roomIncidentTimelineEvents: {
      labels: jest.fn(() => roomIncidentTimelineMetric)
    },
    mediaWorkerFailedRooms,
    mediaWorkerRoomFailures: {
      labels: jest.fn(() => mediaWorkerRoomFailureMetric)
    },
    updateRoomAutopilotSummary: jest.fn(),
    clearRoomAutopilotSummary: jest.fn()
  };
  const recordings = {
    stopActiveClassSessionRecording: jest.fn(async () => null)
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => fallback)
  };

  return {
    service: new RoomsService(
      rooms as never,
      batches as never,
      batchSchedules as never,
      classSessions as never,
      roomIncidentEvents as never,
      roomSnapshotBundles as never,
      participants as never,
      permissions as never,
      producers as never,
      consumers as never,
      moderation as never,
      chatAttachments as never,
      chat as never,
      chatReadStates as never,
      redis as never,
      media as never,
      nodeRegistry as never,
      pipeCoordinator as never,
      metrics as never,
      signals as never,
      platformEvents as never,
      studentEnrollments as never,
      recordings as never,
      config as never
    ),
    rooms,
    batches,
    studentEnrollments,
    batchSchedules,
    classSessions,
    participants,
    permissions,
    producers,
    consumers,
    moderation,
    chatAttachments,
    chat,
    chatReadStates,
    redis,
    media,
    nodeRegistry,
    pipeCoordinator,
    emitSignal: (signal) => {
      signalListener?.(signal);
    },
    signals,
    platformEvents,
    metrics,
    recordings,
    config
  };
}

function ownerLookup(local: boolean) {
  return {
    local,
    available: true,
    owner: {
      roomId: 'room-1',
      nodeId: local ? 'node-a' : 'node-b',
      claimedAt: '2026-06-16T00:00:00.000Z'
    }
  };
}

function fakeRoomDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'room-1',
    name: 'Class Session',
    hostId: 'teacher-participant',
    settings: {
      locked: false,
      waitingRoomEnabled: false,
      joinApprovalRequired: false,
      visibility: 'private',
      maxParticipants: 100,
      recordingEnabled: false,
      chatEnabled: true
    },
    mediaProfile: { id: 'classroom', updatedAt: new Date('2026-06-22T10:00:00.000Z') },
    mediaState: { status: 'active' },
    createdAt: new Date('2026-06-22T10:00:00.000Z'),
    closedAt: undefined,
    ...overrides
  };
}

function fakeClassSessionDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'session-1',
    _id: 'session-1',
    batchId: 'batch-1',
    teacherId: 'teacher-1',
    roomId: 'room-1',
    status: 'live',
    startedAt: new Date('2026-06-22T10:00:00.000Z'),
    chatChannelId: 'classroom:session-1:chat',
    whiteboardChannelId: 'classroom:session-1:whiteboard',
    ...overrides
  };
}

function plannedBatchDoc(overrides: Partial<Record<string, unknown>> = {}) {
  const id = String(overrides['id'] ?? overrides['_id'] ?? 'batch-1');
  return {
    id,
    _id: id,
    name: 'Planned Batch',
    teacherId: 'teacher-1',
    startDate: new Date('2026-06-22T00:00:00.000Z'),
    endDate: new Date('2026-06-22T23:59:59.000Z'),
    ...overrides
  };
}

function plannedScheduleDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'schedule-1',
    _id: 'schedule-1',
    batchId: 'batch-1',
    dayOfWeek: 'MONDAY',
    startTime: '10:00',
    ...overrides
  };
}

function fakeParticipantDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'participant-1',
    _id: 'participant-1',
    userId: 'user-1',
    displayName: 'Participant One',
    socketId: 'socket-1',
    roomId: 'room-1',
    role: Role.PARTICIPANT,
    audioEnabled: true,
    videoEnabled: true,
    screenSharing: false,
    handRaised: false,
    admitted: true,
    joinedAt: new Date('2026-06-22T10:00:00.000Z'),
    lastSeenAt: new Date('2026-06-22T10:00:00.000Z'),
    ...overrides
  };
}

function fakeProducerDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'producer-1',
    roomId: 'room-1',
    participantId: 'publisher-1',
    kind: 'video',
    transportId: 'transport-1',
    nodeId: 'node-a',
    status: 'live',
    priority: 1,
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90_000, rtcpFeedback: ['nack pli'] }],
      encodings: [{ ssrc: 1111 }],
      rtcp: { cname: 'rooms-service', reducedSize: true }
    },
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    closedAt: undefined,
    preferredLayers: undefined,
    preferredSvcLayers: undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function fakeChatDoc(overrides: Partial<Record<string, unknown>> = {}) {
  const createdAt = new Date('2026-06-22T10:00:00.000Z');
  return {
    id: 'chat-1',
    sessionId: 'session-1',
    batchId: 'batch-1',
    roomId: 'room-1',
    channelId: 'classroom:session-1:chat',
    chatChannelId: 'classroom:session-1:chat',
    senderId: 'participant-1',
    senderName: 'Student One',
    senderRole: 'student',
    scope: 'private',
    message: 'Hello',
    shadowMuted: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

function fakeChatReadStateDoc(overrides: Partial<Record<string, unknown>> = {}) {
  const updatedAt = new Date('2026-06-22T10:00:00.000Z');
  return {
    id: 'read-1',
    readStateKey: 'session-1:teacher-1:private:session-1:teacher:teacher-1:student:student-1',
    sessionId: 'session-1',
    batchId: 'batch-1',
    roomId: 'room-1',
    channelId: 'classroom:session-1:chat',
    chatChannelId: 'classroom:session-1:chat',
    userId: 'teacher-1',
    participantId: 'student-one',
    scope: 'private',
    threadKey: 'session-1:teacher:teacher-1:student:student-1',
    lastReadAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
    ...overrides
  };
}

function fakeConsumerDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'consumer-1',
    roomId: 'room-1',
    participantId: 'subscriber-1',
    producerId: 'producer-1',
    transportId: 'transport-2',
    priority: 1,
    preferredLayer: 'high',
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90_000, rtcpFeedback: ['nack pli'] }],
      encodings: [{ ssrc: 2222 }],
      rtcp: { cname: 'rooms-service-consumer', reducedSize: true }
    },
    status: 'live',
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function consumerQualityState(overrides: Partial<Record<string, unknown>> = {}) {
  const { score: scoreOverrides, ...restOverrides } = overrides;
  const base = {
    roomId: 'room-1',
    participantId: 'participant-1',
    consumerId: 'consumer-1',
    producerId: 'producer-1',
    transportId: 'transport-1',
    priority: 1,
    score: {
      score: 74,
      level: 'fair',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 75,
        rttScore: 73,
        jitterScore: 72,
        congestionScore: 74,
        retransmissionScore: 76,
        allocationScore: 71
      },
      updatedAt: '2026-06-17T00:00:00.000Z'
    },
    allocation: {
      priority: 1,
      desiredBitrate: 800_000,
      allocatedBitrate: 700_000,
      minBitrate: 200_000,
      maxBitrate: 1_200_000,
      fairShareBitrate: 650_000,
      starvationPrevented: false,
      reason: 'preferred',
      updatedAt: '2026-06-17T00:00:00.000Z'
    },
    network: {
      packetLoss: 0.01,
      rtt: 32,
      jitter: 8
    },
    bitrate: {
      targetBitrate: 850_000,
      allocatedBitrate: 700_000,
      actualBitrate: 640_000,
      availableBitrate: 900_000,
      recommendedBitrate: 820_000
    },
    layerScores: [],
    svcLayerScores: [],
    pacingQueueDepth: 0,
    retransmissions: {
      requestedPackets: 0,
      retransmittedPackets: 0,
      missingPackets: 0,
      successRate: 1,
      failureRate: 0
    },
    updatedAt: '2026-06-17T00:00:00.000Z'
  };
  return {
    ...base,
    ...restOverrides,
    score: {
      ...base.score,
      ...(typeof scoreOverrides === 'object' && scoreOverrides !== null ? (scoreOverrides as object) : {})
    }
  };
}

function producerQualityState(overrides: Partial<Record<string, unknown>> = {}) {
  const { score: scoreOverrides, ...restOverrides } = overrides;
  const base = {
    roomId: 'room-1',
    participantId: 'publisher-1',
    producerId: 'producer-1',
    transportId: 'transport-1',
    kind: 'video',
    priority: 1,
    score: {
      score: 81,
      level: 'good',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 82,
        rttScore: 80,
        jitterScore: 79,
        congestionScore: 81,
        retransmissionScore: 83,
        allocationScore: 80
      },
      updatedAt: '2026-06-17T00:00:00.000Z'
    },
    network: {
      packetLoss: 0.005,
      rtt: 24,
      jitter: 5
    },
    bitrate: {
      targetBitrate: 1_200_000,
      allocatedBitrate: 1_050_000,
      actualBitrate: 980_000,
      availableBitrate: 1_250_000,
      recommendedBitrate: 1_150_000
    },
    layerScores: [],
    svcLayerScores: [],
    dynacastEnabled: false,
    activeLayers: [],
    suspendedLayers: [],
    updatedAt: '2026-06-17T00:00:00.000Z'
  };
  return {
    ...base,
    ...restOverrides,
    score: {
      ...base.score,
      ...(typeof scoreOverrides === 'object' && scoreOverrides !== null ? (scoreOverrides as object) : {})
    }
  };
}

function transportQualityState(overrides: Partial<Record<string, unknown>> = {}) {
  const { score: scoreOverrides, ...restOverrides } = overrides;
  const base = {
    roomId: 'room-1',
    participantId: 'participant-1',
    transportId: 'transport-1',
    score: {
      score: 78,
      level: 'good',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 79,
        rttScore: 77,
        jitterScore: 76,
        congestionScore: 78,
        retransmissionScore: 80,
        allocationScore: 77
      },
      updatedAt: '2026-06-17T00:00:00.000Z'
    },
    consumers: [consumerQualityState()],
    producers: [producerQualityState()],
    targetBitrate: 1_400_000,
    allocatedBitrate: 1_200_000,
    actualBitrate: 1_050_000,
    pacingQueueDepth: 16_000,
    updatedAt: '2026-06-17T00:00:00.000Z'
  };
  return {
    ...base,
    ...restOverrides,
    score: {
      ...base.score,
      ...(typeof scoreOverrides === 'object' && scoreOverrides !== null ? (scoreOverrides as object) : {})
    }
  };
}

function roomQualityState(overrides: Partial<Record<string, unknown>> = {}): RoomQualityState {
  return {
    roomId: 'room-1',
    score: {
      score: 78,
      level: 'good',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 82,
        rttScore: 80,
        jitterScore: 77,
        congestionScore: 74,
        retransmissionScore: 76,
        allocationScore: 83
      },
      updatedAt: '2026-06-17T00:00:00.000Z'
    },
    consumers: [consumerQualityState()],
    producers: [producerQualityState()],
    transports: [transportQualityState()],
    targetBitrate: 1_400_000,
    allocatedBitrate: 1_200_000,
    actualBitrate: 1_050_000,
    congestionState: 'normal',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides
  } as RoomQualityState;
}

function summaryState(): RoomQualitySummaryState {
  return {
    roomId: 'room-1',
    health: 'stable',
    profile: {
      id: 'meeting',
      label: 'Meeting',
      description: 'Balanced collaboration.',
      policy: {
        consumerPriorityWeights: { audio: 1, video: 1, screen: 1 },
        producerPriorityWeights: { audio: 1, video: 1, screen: 1 },
        bitrateFloorBps: { audio: 48_000, video: 300_000, screen: 500_000 },
        bitrateCeilingBps: { audio: 128_000, video: 2_500_000, screen: 3_200_000 },
        defaultLayerPreferences: {},
        screenSharePreference: 'balanced',
        congestionResponse: 'balanced',
        dynacastEnabled: true,
        admissionProtection: {
          join: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
          publish: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
          screenShare: { stable: 'allow', degraded: 'warn', critical: 'reject' }
        }
      }
    },
    qualitySource: 'local-owner',
    ownerAuthoritativeQuality: true,
    score: roomQualityState().score,
    congestionState: 'normal',
    bitrate: {
      target: 1_400_000,
      allocated: 1_200_000,
      actual: 1_050_000,
      maxAvailable: 1_300_000,
      avgAvailable: 1_250_000,
      maxRecommended: 1_200_000,
      avgRecommended: 1_150_000
    },
    participantCount: 2,
    admittedParticipantCount: 2,
    pendingParticipantCount: 0,
    activeProducerCount: 1,
    activeScreenShareCount: 0,
    degradedConsumers: 0,
    degradedProducers: 0,
    degradedTransports: 0,
    degradedEntityIds: {
      consumers: [],
      producers: [],
      transports: []
    },
    protections: {
      join: {
        scope: 'join',
        health: 'stable',
        action: 'allow',
        code: 'stable',
        message: 'Stable joins',
        triggeredBy: ['room'],
        updatedAt: '2026-06-17T00:00:00.000Z'
      },
      publish: {
        scope: 'publish',
        health: 'stable',
        action: 'allow',
        code: 'stable',
        message: 'Stable publishing',
        triggeredBy: ['room'],
        updatedAt: '2026-06-17T00:00:00.000Z'
      },
      screenShare: {
        scope: 'screen-share',
        health: 'stable',
        action: 'allow',
        code: 'stable',
        message: 'Stable screen sharing',
        triggeredBy: ['room'],
        updatedAt: '2026-06-17T00:00:00.000Z'
      }
    },
    recommendations: [
      {
        code: 'monitor_room_stability',
        severity: 'info',
        title: 'Room is stable',
        detail: 'No action required.'
      }
    ],
    warnings: [],
    updatedAt: '2026-06-17T00:00:00.000Z'
  };
}
