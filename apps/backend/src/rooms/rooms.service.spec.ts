import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DEFAULT_PARTICIPANT_PERMISSIONS, Role, type ConsumerLayerEvent, type RoomQualityState, type RoomQualitySummaryState } from '@native-sfu/contracts';
import { RoomsService } from './rooms.service';
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
    expect(redisService.markPresence).toHaveBeenCalledWith('room-1', persistedHostId, 'socket-1');
    expect(metricsService.activeRooms.inc).toHaveBeenCalled();
    expect(room.hostId).toBe(persistedHostId);
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
    expect(redis.markPresence).toHaveBeenCalledWith('room-1', 'participant-1', 'socket-1');
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
  rooms: { findById: jest.Mock; updateOne: jest.Mock };
  participants: { findById: jest.Mock; findOne: jest.Mock; find: jest.Mock; countDocuments: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  producers: { findById: jest.Mock; find: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  consumers: { findById: jest.Mock; find: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  redis: { markPresence: jest.Mock; removePresence: jest.Mock };
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
  metrics: {
    activeRooms: { inc: jest.Mock; dec: jest.Mock };
    activeParticipants: { labels: jest.Mock };
    activeTransports: { inc: jest.Mock; dec: jest.Mock };
    activeProducers: { labels: jest.Mock };
    activeConsumers: { inc: jest.Mock; dec: jest.Mock };
    roomAdmissionRejections: { labels: jest.Mock };
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
    findById: jest.fn(),
    updateOne: jest.fn()
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
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(async () => []),
    countDocuments: jest.fn(async () => 0),
    updateOne: jest.fn(),
    updateMany: jest.fn()
  };
  const producers = {
    findById: jest.fn(),
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
  const redis = {
    markPresence: jest.fn(async () => undefined),
    removePresence: jest.fn()
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

  return {
    service: new RoomsService(
      rooms as never,
      roomIncidentEvents as never,
      roomSnapshotBundles as never,
      participants as never,
      {} as never,
      producers as never,
      consumers as never,
      {} as never,
      {} as never,
      redis as never,
      media as never,
      nodeRegistry as never,
      pipeCoordinator as never,
      metrics as never,
      signals as never,
      platformEvents as never
    ),
    rooms,
    participants,
    producers,
    consumers,
    redis,
    media,
    nodeRegistry,
    pipeCoordinator,
    emitSignal: (signal) => {
      signalListener?.(signal);
    },
    signals,
    platformEvents,
    metrics
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
