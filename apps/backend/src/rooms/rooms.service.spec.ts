import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DEFAULT_PARTICIPANT_PERMISSIONS, Role, type RoomQualityState } from '@native-sfu/contracts';
import { RoomsService } from './rooms.service';

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
    const { service, participants, producers: _producers, consumers: _consumers, emitSignal, media } = createService();
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
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({ id: 'room-1', name: 'Diagnostics Room' });

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
    jest.spyOn(service as any, 'getRoom').mockResolvedValue({ id: 'room-1', name: 'Fallback Room' });

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

  it('rejects stale distributed quality updates and keeps the newer cached state', async () => {
    const { service, participants, consumers, producers: _producers, emitSignal, media } = createService();
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
    const { service, participants, consumers, producers: _producers, emitSignal, media } = createService();
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
    const { service, participants, consumers, producers: _producers, emitSignal, media } = createService();
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

  it('decrements active room entity gauges when a room is explicitly closed', async () => {
    const { service, participants, producers, consumers, media, nodeRegistry, metrics } = createService();
    participants.find.mockResolvedValue([{ id: 'participant-1' }, { id: 'participant-2' }]);
    producers.find.mockResolvedValue([
      fakeProducerDoc({ id: 'producer-a', kind: 'video' }),
      fakeProducerDoc({ id: 'producer-b', kind: 'audio' })
    ]);
    consumers.find.mockResolvedValue([fakeConsumerDoc({ id: 'consumer-a' }), fakeConsumerDoc({ id: 'consumer-b' })]);
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
    expect(media.closeRoom).toHaveBeenCalledWith('room-1');
    expect(metrics.activeParticipants.labels).toHaveBeenCalledWith('room-1');
    expect(metrics.activeConsumers.dec).toHaveBeenCalledTimes(2);
    expect(metrics.activeRooms.dec).toHaveBeenCalledTimes(1);
  });
});

function createService(): {
  service: RoomsService;
  rooms: { findById: jest.Mock; updateOne: jest.Mock };
  participants: { findById: jest.Mock; findOne: jest.Mock; find: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  producers: { findById: jest.Mock; find: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
  consumers: { findById: jest.Mock; find: jest.Mock; updateMany: jest.Mock };
  redis: { removePresence: jest.Mock };
  media: {
    onConsumerLayerEvent: jest.Mock;
    onProducerDynacastEvent: jest.Mock;
    onConsumerScoreUpdated: jest.Mock;
    onProducerScoreUpdated: jest.Mock;
    onTransportQualityUpdated: jest.Mock;
    onRoomQualityUpdated: jest.Mock;
    onMediaWorkerRoomFailed: jest.Mock;
    getProducer: jest.Mock;
    producerLayerState: jest.Mock;
    producerQualityState: jest.Mock;
    consumerLayerState: jest.Mock;
    consumerQualityState: jest.Mock;
    roomQualityState: jest.Mock;
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
  };
  emitSignal: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void;
  signals: { onSignal: jest.Mock; publish: jest.Mock };
  metrics: {
    activeRooms: { dec: jest.Mock };
    activeParticipants: { labels: jest.Mock };
    activeProducers: { labels: jest.Mock };
    activeConsumers: { inc: jest.Mock; dec: jest.Mock };
    producerPriorityUpdates: { labels: jest.Mock };
    producerNodeIdFallbacks: { labels: jest.Mock };
    producerNodeIdBackfills: { labels: jest.Mock };
    pipeCleanupFailures: { labels: jest.Mock };
  };
} {
  const rooms = {
    findById: jest.fn(),
    updateOne: jest.fn()
  };
  const participants = {
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(async () => []),
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
    updateMany: jest.fn()
  };
  const redis = {
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
    getProducer: jest.fn(() => undefined),
    producerLayerState: jest.fn(() => undefined),
    producerQualityState: jest.fn(() => undefined),
    consumerLayerState: jest.fn(() => undefined),
    consumerQualityState: jest.fn(() => undefined),
    roomQualityState: jest.fn(() => undefined),
    transportQualityState: jest.fn(() => undefined),
    assertTransportOwner: jest.fn(),
    registerConsumer: jest.fn(),
    closeRoom: jest.fn(),
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
    closeOriginProducer: jest.fn(async () => true)
  };
  const signals = {
    onSignal: jest.fn((listener: (signal: { sourceNodeId: string; roomId: string; event: string; payload: unknown[] }) => void) => {
      signalListener = listener;
      return jest.fn();
    }),
    publish: jest.fn(async () => undefined)
  };
  const activeParticipantsMetric = { inc: jest.fn(), dec: jest.fn() };
  const activeProducersMetric = { inc: jest.fn(), dec: jest.fn() };
  const activeConsumers = { inc: jest.fn(), dec: jest.fn() };
  const activeRooms = { dec: jest.fn() };
  const producerPriorityMetric = { inc: jest.fn() };
  const producerNodeIdFallbackMetric = { inc: jest.fn() };
  const producerNodeIdBackfillMetric = { inc: jest.fn() };
  const pipeCleanupFailureMetric = { inc: jest.fn() };
  const metrics = {
    activeRooms,
    activeParticipants: {
      labels: jest.fn(() => activeParticipantsMetric)
    },
    activeProducers: {
      labels: jest.fn(() => activeProducersMetric)
    },
    activeConsumers,
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
    }
  };

  return {
    service: new RoomsService(
      rooms as never,
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
      signals as never
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
