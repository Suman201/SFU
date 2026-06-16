import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Model } from 'mongoose';
import {
  ChatMessage,
  Consumer,
  ConsumerQualityState,
  ConsumerLayerEvent,
  ConsumerLayerState,
  ConsumerLayerSwitchReason,
  CreateConsumerRequest,
  CreateProducerRequest,
  CreateRoomRequest,
  DEFAULT_PARTICIPANT_PERMISSIONS,
  IceCandidate,
  JoinRoomRequest,
  JoinRoomResponse,
  Participant,
  Permissions,
  Producer,
  ProducerQualityState,
  ProducerDynacastControlFailureReport,
  ProducerDynacastEvent,
  ProducerDynacastState,
  ProducerSvcState,
  ProducerLayerState,
  RoomQualityState,
  RoomFailureEvent,
  Role,
  RtpLayerSelection,
  RtpParameters,
  SvcLayerSelection,
  TransportQualityState,
  Room,
  TransportOptions,
  VIEWER_PERMISSIONS
} from '@native-sfu/contracts';
import type { RoomOwnerLookupResponse } from '@native-sfu/contracts';
import {
  ChatMessageDocument,
  ChatMessageMongoDocument,
  ConsumerDocument,
  ConsumerMongoDocument,
  ModerationDocument,
  ModerationMongoDocument,
  ParticipantDocument,
  ParticipantMongoDocument,
  PermissionDocument,
  PermissionMongoDocument,
  ProducerDocument,
  ProducerMongoDocument,
  RoomDocument,
  RoomMongoDocument
} from '../database/schemas';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { PipeCoordinatorService } from '../cluster/pipe-coordinator.service';
import { MediaService, type MediaWorkerRoomFailureEvent } from '@native-sfu/nest-sfu';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';

export interface SocketUser {
  id: string;
  email: string;
  roles: Role[];
}

export interface ProducerDynacastSignalTarget {
  socketId: string;
  roomSocketCount: number;
  suppressedSubscribers: number;
}

@Injectable()
export class RoomsService {
  private readonly layerEventListeners = new Set<(event: ConsumerLayerEvent) => void>();
  private readonly producerDynacastEventListeners = new Set<(event: ProducerDynacastEvent) => void>();
  private readonly consumerQualityEventListeners = new Set<(state: ConsumerQualityState) => void>();
  private readonly producerQualityEventListeners = new Set<(state: ProducerQualityState) => void>();
  private readonly transportQualityEventListeners = new Set<(state: TransportQualityState) => void>();
  private readonly roomQualityEventListeners = new Set<(state: RoomQualityState) => void>();
  private readonly roomFailureEventListeners = new Set<(event: RoomFailureEvent) => void>();

  constructor(
    @InjectModel(RoomDocument.name) private readonly rooms: Model<RoomMongoDocument>,
    @InjectModel(ParticipantDocument.name) private readonly participants: Model<ParticipantMongoDocument>,
    @InjectModel(PermissionDocument.name) private readonly permissions: Model<PermissionMongoDocument>,
    @InjectModel(ProducerDocument.name) private readonly producers: Model<ProducerMongoDocument>,
    @InjectModel(ConsumerDocument.name) private readonly consumers: Model<ConsumerMongoDocument>,
    @InjectModel(ModerationDocument.name) private readonly moderation: Model<ModerationMongoDocument>,
    @InjectModel(ChatMessageDocument.name) private readonly chat: Model<ChatMessageMongoDocument>,
    private readonly redis: RedisService,
    private readonly media: MediaService,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly pipeCoordinator: PipeCoordinatorService,
    private readonly metrics: MetricsService
  ) {
    this.media.onConsumerLayerEvent((event) => {
      void this.handleConsumerLayerEvent(event);
    });
    this.media.onProducerDynacastEvent((event) => {
      void this.handleProducerDynacastEvent(event);
    });
    this.media.onConsumerScoreUpdated((state) => this.handleConsumerQualityState(state));
    this.media.onProducerScoreUpdated((state) => this.handleProducerQualityState(state));
    this.media.onTransportQualityUpdated((state) => this.handleTransportQualityState(state));
    this.media.onRoomQualityUpdated((state) => this.handleRoomQualityState(state));
    this.media.onMediaWorkerRoomFailed((event) => {
      void this.handleMediaRoomFailure(event);
    });
  }

  onConsumerLayerEvent(listener: (event: ConsumerLayerEvent) => void): () => void {
    this.layerEventListeners.add(listener);
    return () => this.layerEventListeners.delete(listener);
  }

  onProducerDynacastEvent(listener: (event: ProducerDynacastEvent) => void): () => void {
    this.producerDynacastEventListeners.add(listener);
    return () => this.producerDynacastEventListeners.delete(listener);
  }

  onConsumerScoreUpdated(listener: (state: ConsumerQualityState) => void): () => void {
    this.consumerQualityEventListeners.add(listener);
    return () => this.consumerQualityEventListeners.delete(listener);
  }

  onProducerScoreUpdated(listener: (state: ProducerQualityState) => void): () => void {
    this.producerQualityEventListeners.add(listener);
    return () => this.producerQualityEventListeners.delete(listener);
  }

  onTransportQualityUpdated(listener: (state: TransportQualityState) => void): () => void {
    this.transportQualityEventListeners.add(listener);
    return () => this.transportQualityEventListeners.delete(listener);
  }

  onRoomQualityUpdated(listener: (state: RoomQualityState) => void): () => void {
    this.roomQualityEventListeners.add(listener);
    return () => this.roomQualityEventListeners.delete(listener);
  }

  onRoomFailed(listener: (event: RoomFailureEvent) => void): () => void {
    this.roomFailureEventListeners.add(listener);
    return () => this.roomFailureEventListeners.delete(listener);
  }

  async createRoom(user: SocketUser, socketId: string, request: CreateRoomRequest): Promise<Room> {
    await this.nodeRegistry.assertLocalCanOwnNewRoom();
    const roomDoc = await this.rooms.create({
      name: request.name,
      hostId: '',
      settings: {
        locked: false,
        waitingRoomEnabled: request.waitingRoomEnabled ?? false,
        joinApprovalRequired: request.joinApprovalRequired ?? false,
        visibility: request.visibility ?? 'public',
        maxParticipants: request.maxParticipants ?? 100,
        recordingEnabled: false,
        chatEnabled: true
      },
      mediaState: { status: 'active' }
    });
    try {
      await this.nodeRegistry.claimRoom(roomDoc.id);
    } catch (error) {
      roomDoc.closedAt = new Date();
      await roomDoc.save();
      throw error;
    }
    const participant = await this.createParticipant(roomDoc.id, user, socketId, Role.HOST, DEFAULT_PARTICIPANT_PERMISSIONS, true);
    roomDoc.hostId = participant.id;
    await roomDoc.save();
    await this.redis.markPresence(roomDoc.id, participant.id, socketId);
    this.metrics.activeRooms.inc();
    return this.getRoom(roomDoc.id);
  }

  async joinRoom(user: SocketUser, socketId: string, request: JoinRoomRequest): Promise<JoinRoomResponse> {
    const startedAt = performance.now();
    const room = await this.rooms.findById(request.roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException('Room not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(room.id);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(room.id);
    } else if (!ownerLookup.local) {
      this.metrics.pipeSignalingReroutes.labels('remote_join').inc();
    }
    await this.assertNotBanned(room.id, user.id);
    const existingParticipant = await this.participants.findOne({ roomId: room.id, userId: user.id, leftAt: { $exists: false } });
    if (existingParticipant) {
      await this.replaceParticipantSocket(room.id, existingParticipant.id, socketId);
      this.metrics.roomJoinDuration.observe(performance.now() - startedAt);
      return {
        room: await this.getRoom(room.id),
        participantId: existingParticipant.id,
        admitted: existingParticipant.admitted
      };
    }
    const activeCount = await this.participants.countDocuments({ roomId: room.id, admitted: true, leftAt: { $exists: false } });
    if (room.settings.locked) {
      throw new ForbiddenException('Room is locked');
    }
    if (activeCount >= room.settings.maxParticipants) {
      throw new ForbiddenException('Room is full');
    }
    if (room.settings.visibility === 'invite-only' && !room.invitedUserIds.includes(user.id)) {
      throw new ForbiddenException('Invite required');
    }
    const role = request.asViewer ? Role.VIEWER : Role.PARTICIPANT;
    const basePermissions = role === Role.VIEWER ? VIEWER_PERMISSIONS : DEFAULT_PARTICIPANT_PERMISSIONS;
    const admitted = !(room.settings.waitingRoomEnabled || room.settings.joinApprovalRequired);
    const participant = await this.createParticipant(room.id, user, socketId, role, basePermissions, admitted, request.displayName);
    await this.redis.markPresence(room.id, participant.id, socketId);
    this.metrics.roomJoinDuration.observe(performance.now() - startedAt);
    const updatedRoom = await this.getRoom(room.id);
    return {
      room: updatedRoom,
      participantId: participant.id,
      admitted
    };
  }

  async replaceParticipantSocket(roomId: string, participantId: string, socketId: string): Promise<void> {
    const participant = await this.participants.findOne({ _id: participantId, roomId, leftAt: { $exists: false } });
    if (!participant) {
      throw new NotFoundException('Participant not found');
    }
    participant.socketId = socketId;
    participant.lastSeenAt = new Date();
    await participant.save();
    await this.redis.markPresence(roomId, participant.id, socketId);
  }

  async leaveRoomForSocket(roomId: string, participantId: string, socketId: string): Promise<{ closed: boolean; left: boolean }> {
    const participant = await this.participants.findOne({ _id: participantId, roomId, leftAt: { $exists: false } });
    if (!participant) {
      return { closed: false, left: false };
    }
    if (participant.socketId !== socketId) {
      return { closed: false, left: false };
    }
    const result = await this.leaveRoom(roomId, participantId);
    return { ...result, left: true };
  }

  async leaveRoom(roomId: string, participantId: string): Promise<{ closed: boolean }> {
    const ownerLookup = await this.requireRoomOwnerLookup(roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(roomId);
    }
    const participant = await this.participants.findById(participantId);
    if (!participant || participant.roomId !== roomId) {
      return { closed: false };
    }
    const participantProducers = await this.producers.find({ roomId, participantId, status: { $ne: 'closed' } });
    const participantConsumers = await this.consumers.find({ roomId, participantId, status: { $ne: 'closed' } });
    await this.participants.updateOne({ _id: participantId }, { leftAt: new Date(), lastSeenAt: new Date() });
    await this.producers.updateMany({ roomId, participantId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.consumers.updateMany({ roomId, participantId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.redis.removePresence(roomId, participantId);
    await this.media.closeParticipantTransports(participantId);
    if (this.pipeCoordinator.isEnabled()) {
      for (const consumer of participantConsumers) {
        await this.pipeCoordinator.releaseRemoteConsumerFeed(consumer.id, 'participant_left').catch(() => undefined);
      }
      for (const producer of participantProducers) {
        if (producer.nodeId === this.nodeRegistry.localNodeId()) {
          await this.pipeCoordinator.releaseRemoteProducerPublication(producer.id, 'participant_left').catch(() => undefined);
        }
      }
    }
    this.metrics.activeParticipants.labels(roomId).dec();
    const room = await this.rooms.findById(roomId);
    if (ownerLookup.local && room?.hostId === participantId) {
      await this.rooms.updateOne({ _id: roomId }, { closedAt: new Date() });
      await this.nodeRegistry.releaseRoom(roomId);
      this.metrics.activeRooms.dec();
      return { closed: true };
    }
    return { closed: false };
  }

  async closeRoom(roomId: string, actorParticipantId: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, true);
    await this.rooms.updateOne({ _id: roomId }, { closedAt: new Date() });
    await this.participants.updateMany({ roomId, leftAt: { $exists: false } }, { leftAt: new Date() });
    await this.producers.updateMany({ roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.consumers.updateMany({ roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.media.closeRoom(roomId);
    await this.nodeRegistry.releaseRoom(roomId);
    this.metrics.activeRooms.dec();
  }

  async setLocked(roomId: string, actorParticipantId: string, locked: boolean): Promise<Room> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, true);
    await this.rooms.updateOne({ _id: roomId }, { 'settings.locked': locked });
    return this.getRoom(roomId);
  }

  async admit(roomId: string, actorParticipantId: string, participantId: string): Promise<Room> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.participants.updateOne({ _id: participantId, roomId }, { admitted: true, $unset: { leftAt: '' } });
    return this.getRoom(roomId);
  }

  async reject(roomId: string, actorParticipantId: string, participantId: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.participants.updateOne({ _id: participantId, roomId }, { leftAt: new Date() });
  }

  async createTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    const ownerLookup = await this.requireRoomOwnerLookup(roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(roomId);
    } else if (!ownerLookup.local) {
      this.metrics.pipeSignalingReroutes.labels('remote_transport').inc();
    }
    await this.assertParticipant(roomId, participantId);
    try {
      const options = await this.media.createWebRtcTransport(roomId, participantId);
      this.metrics.activeTransports.inc();
      return options;
    } catch (error) {
      this.metrics.roomAdmissionRejections.labels('media_worker_capacity').inc();
      throw error;
    }
  }

  async addIceCandidate(transportId: string, participantId: string, candidate: IceCandidate): Promise<void> {
    await this.media.addRemoteCandidate(transportId, participantId, candidate);
  }

  async setRemoteIceParameters(transportId: string, participantId: string, parameters: TransportOptions['iceParameters']): Promise<void> {
    await this.media.setRemoteIceParameters(transportId, participantId, parameters);
  }

  async setRemoteDtlsParameters(transportId: string, participantId: string, parameters: TransportOptions['dtlsParameters']): Promise<void> {
    await this.media.setRemoteDtlsParameters(transportId, participantId, parameters);
  }

  async restartIce(transportId: string, participantId: string): Promise<TransportOptions> {
    return this.media.restartIce(transportId, participantId);
  }

  async createProducer(request: CreateProducerRequest, participantId: string): Promise<Producer> {
    const ownerLookup = await this.requireRoomOwnerLookup(request.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    } else if (!ownerLookup.local) {
      this.metrics.pipeSignalingReroutes.labels('remote_publish').inc();
    }
    const participant = await this.assertParticipant(request.roomId, participantId);
    const permission = await this.getPermissions(request.roomId, participantId);
    if (request.kind === 'audio' && !permission.canPublishAudio) {
      throw new ForbiddenException('Audio publishing denied');
    }
    if (request.kind === 'video' && !permission.canPublishVideo) {
      throw new ForbiddenException('Video publishing denied');
    }
    if (request.kind === 'screen' && !permission.canShareScreen) {
      throw new ForbiddenException('Screen sharing denied');
    }
    await this.media.bindProducer(request.transportId, participantId, request.rtpParameters);
    const priority = normalizeConsumerPriority(request.priority);
    const producerDoc = new this.producers({
      roomId: request.roomId,
      participantId,
      kind: request.kind,
      transportId: request.transportId,
      nodeId: this.nodeRegistry.localNodeId(),
      priority,
      rtpParameters: request.rtpParameters,
      status: 'live'
    });
    const producer: Producer = {
      id: producerDoc.id,
      roomId: request.roomId,
      participantId,
      kind: request.kind,
      transportId: request.transportId,
      priority,
      rtpParameters: request.rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    };
    let registered = false;
    try {
      await this.media.registerProducer(producer);
      registered = true;
      if (!ownerLookup.local && this.pipeCoordinator.isEnabled()) {
        await this.pipeCoordinator.ensureRemoteProducerPublication({ roomId: request.roomId, producer });
      }
      if (producer.dynacast) {
        producerDoc.dynacastState = producer.dynacast as unknown as Record<string, unknown>;
      }
      if (producer.svc) {
        producerDoc.svcState = producer.svc as unknown as Record<string, unknown>;
      }
      await producerDoc.save();
      if (request.kind === 'screen') {
        participant.screenSharing = true;
        await participant.save();
      }
      this.metrics.activeProducers.labels(request.kind).inc();
      return this.toProducer(producerDoc);
    } catch (error) {
      if (!ownerLookup.local && this.pipeCoordinator.isEnabled()) {
        await this.pipeCoordinator.releaseRemoteProducerPublication(producer.id, 'error').catch(() => undefined);
      }
      if (registered) {
        await this.media.unregisterProducer(producer.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async setProducerStatus(producerId: string, participantId: string, status: 'live' | 'paused'): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    const producerHostedLocally = producer.nodeId === this.nodeRegistry.localNodeId();
    if (!ownerLookup.local && (!this.pipeCoordinator.isEnabled() || !producerHostedLocally)) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    await this.assertCanControlProducer(producer, participantId);
    producer.status = status;
    await producer.save();
    await this.media.setProducerPaused(producerId, status === 'paused');
    if (!ownerLookup.local && this.pipeCoordinator.isEnabled() && producerHostedLocally) {
      await this.pipeCoordinator.syncRemoteProducerState({ roomId: producer.roomId, producerId, status }).catch(() => undefined);
    }
    return this.toProducer(producer);
  }

  async setProducerPriority(producerId: string, participantId: string, priority: number): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    const producerHostedLocally = producer.nodeId === this.nodeRegistry.localNodeId();
    if (!ownerLookup.local && (!this.pipeCoordinator.isEnabled() || !producerHostedLocally)) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    await this.assertCanControlProducer(producer, participantId);
    producer.priority = normalizeConsumerPriority(priority);
    await producer.save();
    this.media.setProducerPriority(producerId, producer.priority);
    if (!ownerLookup.local && this.pipeCoordinator.isEnabled() && producerHostedLocally) {
      await this.pipeCoordinator.syncRemoteProducerState({ roomId: producer.roomId, producerId, priority: producer.priority }).catch(() => undefined);
    }
    this.metrics.producerPriorityUpdates.labels(producer.kind).inc();
    return this.toProducer(producer);
  }

  async closeProducer(producerId: string, participantId: string): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    const producerHostedLocally = producer.nodeId === this.nodeRegistry.localNodeId();
    if (!ownerLookup.local && (!this.pipeCoordinator.isEnabled() || !producerHostedLocally)) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    await this.assertCanControlProducer(producer, participantId);
    producer.status = 'closed';
    producer.closedAt = new Date();
    await producer.save();
    await this.media.unregisterProducer(producerId);
    if (!ownerLookup.local && this.pipeCoordinator.isEnabled() && producerHostedLocally) {
      await this.pipeCoordinator.releaseRemoteProducerPublication(producerId, 'producer_closed').catch(() => undefined);
    }
    this.metrics.activeProducers.labels(producer.kind).dec();
    return this.toProducer(producer);
  }

  async createConsumer(request: CreateConsumerRequest, participantId: string): Promise<Consumer> {
    const ownerLookup = await this.requireRoomOwnerLookup(request.roomId);
    const producer = await this.producers.findById(request.producerId);
    if (!producer || producer.status === 'closed') {
      throw new NotFoundException('Producer not found');
    }
    await this.assertParticipant(request.roomId, participantId);
    await this.media.assertTransportOwner(request.transportId, participantId);
    const preferredLayers = normalizeLayerSelection(request.preferredLayers ?? preferredLayerNameToSelection(request.preferredLayer ?? 'high'));
    const preferredSvcLayers = normalizeSvcLayerSelection(request.preferredSvcLayers);
    const consumerDoc = new this.consumers({
      roomId: request.roomId,
      producerId: producer.id,
      participantId,
      transportId: request.transportId,
      priority: normalizeConsumerPriority(request.priority),
      preferredLayer: request.preferredLayer ?? 'high',
      preferredLayers,
      preferredSvcLayers,
      rtpParameters: consumerRtpParametersForProducer(producer.rtpParameters as unknown as RtpParameters),
      status: 'live'
    });
    const producerHostedLocally = producer.nodeId === this.nodeRegistry.localNodeId();
    const remoteFeed = !ownerLookup.local && this.pipeCoordinator.isEnabled() && !producerHostedLocally
      ? await this.pipeCoordinator.ensureRemoteConsumerFeed({ roomId: request.roomId, producerId: producer.id, consumerId: consumerDoc.id })
      : undefined;
    try {
      await consumerDoc.save();
      const consumer = this.toConsumer(consumerDoc);
      await this.media.registerConsumer(remoteFeed ? { ...consumer, producerId: remoteFeed.proxyProducerId } : consumer);
    } catch (error) {
      if (remoteFeed) {
        await this.pipeCoordinator.releaseRemoteConsumerFeed(consumerDoc.id, 'error').catch(() => undefined);
      }
      throw error;
    }
    this.metrics.activeConsumers.inc();
    return this.toConsumer(consumerDoc);
  }

  async setConsumerPriority(consumerId: string, participantId: string, priority: number): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    consumer.priority = normalizeConsumerPriority(priority);
    await consumer.save();
    this.media.setConsumerPriority(consumerId, consumer.priority);
    this.metrics.consumerPriorityUpdates.inc();
    return this.toConsumer(consumer);
  }

  async setConsumerStatus(consumerId: string, participantId: string, status: 'live' | 'paused'): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    consumer.status = status;
    await consumer.save();
    await this.media.setConsumerPaused(consumerId, status === 'paused');
    return this.toConsumer(consumer);
  }

  async setConsumerPreferredLayers(consumerId: string, participantId: string, preferredLayers: RtpLayerSelection): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    consumer.preferredLayers = normalizeLayerSelection(preferredLayers) as Record<string, unknown>;
    const snapshot = await this.media.setConsumerPreferredLayers(consumerId, normalizeLayerSelection(preferredLayers) ?? {});
    consumer.currentLayers = snapshot?.currentLayers as Record<string, unknown> | undefined;
    consumer.targetLayers = snapshot?.targetLayers as Record<string, unknown> | undefined;
    consumer.layerSwitchReason = snapshot?.switchReason;
    consumer.layerSwitchedAt = snapshot?.switchedAt ? new Date(snapshot.switchedAt) : consumer.layerSwitchedAt;
    await consumer.save();
    return this.toConsumer(consumer);
  }

  async setConsumerPreferredSvcLayers(consumerId: string, participantId: string, preferredSvcLayers: SvcLayerSelection): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    consumer.preferredSvcLayers = normalizeSvcLayerSelection(preferredSvcLayers) as Record<string, unknown>;
    const snapshot = await this.media.setConsumerPreferredSvcLayers(consumerId, normalizeSvcLayerSelection(preferredSvcLayers) ?? {});
    consumer.currentSvcLayers = snapshot?.currentSvcLayers as Record<string, unknown> | undefined;
    consumer.targetSvcLayers = snapshot?.targetSvcLayers as Record<string, unknown> | undefined;
    consumer.currentLayers = snapshot?.currentLayers as Record<string, unknown> | undefined;
    consumer.targetLayers = snapshot?.targetLayers as Record<string, unknown> | undefined;
    consumer.layerSwitchReason = snapshot?.switchReason;
    consumer.layerSwitchedAt = snapshot?.switchedAt ? new Date(snapshot.switchedAt) : consumer.layerSwitchedAt;
    await consumer.save();
    return this.toConsumer(consumer);
  }

  async getConsumerLayerState(consumerId: string, participantId: string): Promise<ConsumerLayerState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    await this.assertParticipant(consumer.roomId, participantId);
    return this.consumerLayerState(consumer);
  }

  async getProducerLayerState(producerId: string, participantId: string): Promise<ProducerLayerState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    await this.assertParticipant(producer.roomId, participantId);
    const state = this.media.producerLayerState(producerId);
    if (state) {
      return state;
    }
    return {
      producerId,
      roomId: producer.roomId,
      participantId: producer.participantId,
      availableLayers: [],
      svc: producer.svcState as unknown as ProducerSvcState | undefined,
      dynacast: producer.dynacastState as unknown as ProducerDynacastState | undefined,
      updatedAt: new Date().toISOString()
    };
  }

  async getConsumerQualityState(consumerId: string, participantId: string): Promise<ConsumerQualityState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    await this.assertParticipant(consumer.roomId, participantId);
    const state = this.media.consumerQualityState(consumerId);
    if (!state) {
      throw new NotFoundException('Consumer quality state not available');
    }
    return state;
  }

  async getProducerQualityState(producerId: string, participantId: string): Promise<ProducerQualityState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    await this.assertParticipant(producer.roomId, participantId);
    const state = this.media.producerQualityState(producerId);
    if (!state) {
      throw new NotFoundException('Producer quality state not available');
    }
    return state;
  }

  async getRoomQualityState(roomId: string, participantId: string): Promise<RoomQualityState> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertParticipant(roomId, participantId);
    const state = this.media.roomQualityState(roomId);
    if (!state) {
      throw new NotFoundException('Room quality state not available');
    }
    return state;
  }

  async getTransportQualityState(transportId: string, participantId: string): Promise<TransportQualityState> {
    await this.media.assertTransportOwner(transportId, participantId);
    const state = this.media.transportQualityState(transportId);
    if (!state) {
      throw new NotFoundException('Transport quality state not available');
    }
    return state;
  }

  async producerDynacastSignalTarget(event: ProducerDynacastEvent, roomSocketCount = 1): Promise<ProducerDynacastSignalTarget | undefined> {
    const producer = await this.producers.findOne({ _id: event.producerId, status: { $ne: 'closed' } });
    if (!producer) {
      return undefined;
    }
    const participant = await this.participants.findOne({ _id: producer.participantId, roomId: event.roomId, leftAt: { $exists: false } });
    if (!participant?.socketId) {
      return undefined;
    }
    return {
      socketId: participant.socketId,
      roomSocketCount,
      suppressedSubscribers: Math.max(0, roomSocketCount - 1)
    };
  }

  recordDynacastSignalDelivery(event: ProducerDynacastEvent, suppressedSubscribers: number): void {
    this.metrics.dynacastPublisherTargetedEvents.labels(producerDynacastMetricEventName(event)).inc();
    if (suppressedSubscribers > 0) {
      this.metrics.dynacastSubscriberSuppressedEvents.labels(producerDynacastMetricEventName(event)).inc(suppressedSubscribers);
    }
  }

  recordDynacastSignalFailure(event: ProducerDynacastEvent, reason: string): void {
    const label = sanitizeMetricLabel(reason);
    this.metrics.dynacastControlFailures.labels(label).inc();
    this.metrics.dynacastPublisherTargetFailures.labels(producerDynacastMetricEventName(event), label).inc();
  }

  async recordProducerDynacastControlFailure(report: ProducerDynacastControlFailureReport, participantId: string): Promise<void> {
    const producer = await this.producers.findById(report.producerId);
    if (!producer || producer.participantId !== participantId || producer.status === 'closed') {
      throw new NotFoundException('Producer not found');
    }
    this.metrics.dynacastSenderControlApplyFailures.labels(sanitizeMetricLabel(report.reason)).inc();
    this.metrics.dynacastControlFailures.labels('sender_apply_failed').inc();
  }

  async handleMediaRoomFailure(failure: MediaWorkerRoomFailureEvent): Promise<void> {
    const room = await this.rooms.findById(failure.roomId);
    if (!room || room.mediaState?.status === 'failed') {
      return;
    }
    const now = new Date(failure.failedAt);
    const [participants, producers, consumers] = await Promise.all([
      this.participants.find({ roomId: failure.roomId, leftAt: { $exists: false } }),
      this.producers.find({ roomId: failure.roomId, status: { $ne: 'closed' } }),
      this.consumers.find({ roomId: failure.roomId, status: { $ne: 'closed' } })
    ]);
    room.set('mediaState', {
      status: 'failed',
      failedAt: now,
      failureReason: failure.reason,
      failureMessage: failure.message,
      workerId: failure.workerId
    });
    room.closedAt = room.closedAt ?? now;
    await Promise.all([
      room.save(),
      this.participants.updateMany({ roomId: failure.roomId, leftAt: { $exists: false } }, { leftAt: now }),
      this.producers.updateMany({ roomId: failure.roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: now }),
      this.consumers.updateMany({ roomId: failure.roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: now })
    ]);
    for (const participant of participants) {
      await this.redis.removePresence(failure.roomId, participant.id);
    }
    await this.nodeRegistry.releaseRoom(failure.roomId);
    this.metrics.mediaWorkerRoomFailures.labels(failure.reason).inc();
    this.metrics.mediaWorkerFailedRooms.set(this.media.workerPoolSnapshot().failedRooms.length);
    this.metrics.activeRooms.dec();
    for (const participant of participants) {
      this.metrics.activeParticipants.labels(failure.roomId).dec();
    }
    for (const producer of producers) {
      this.metrics.activeProducers.labels(producer.kind).dec();
    }
    for (const _consumer of consumers) {
      this.metrics.activeConsumers.dec();
    }
    const event: RoomFailureEvent = {
      roomId: failure.roomId,
      reason: failure.reason,
      message: failure.message,
      failedAt: failure.failedAt,
      recoverable: failure.recoverable,
      affectedParticipants: participants.map((participant) => participant.id),
      affectedTransports: failure.affectedTransports,
      affectedProducers: failure.affectedProducers,
      affectedConsumers: failure.affectedConsumers,
      workerId: failure.workerId
    };
    for (const listener of this.roomFailureEventListeners) {
      listener(event);
    }
  }

  async closeConsumer(consumerId: string, participantId: string): Promise<void> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    consumer.status = 'closed';
    consumer.closedAt = new Date();
    await consumer.save();
    await this.media.unregisterConsumer(consumerId);
    if (this.pipeCoordinator.isEnabled()) {
      await this.pipeCoordinator.releaseRemoteConsumerFeed(consumerId).catch(() => undefined);
    }
    this.metrics.activeConsumers.dec();
  }

  async updatePermissions(roomId: string, actorParticipantId: string, participantId: string, patch: Partial<Permissions>): Promise<Permissions> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, false);
    const current = await this.getPermissions(roomId, participantId);
    const next = { ...current, ...patch };
    await this.permissions.updateOne({ roomId, participantId }, { $set: next }, { upsert: true });
    return next;
  }

  async kick(roomId: string, actorParticipantId: string, participantId: string, reason?: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.addModeration(roomId, actorParticipantId, participantId, 'kick', reason);
    await this.leaveRoom(roomId, participantId);
  }

  async ban(roomId: string, actorParticipantId: string, participantId: string, reason?: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.addModeration(roomId, actorParticipantId, participantId, 'ban', reason);
    await this.leaveRoom(roomId, participantId);
  }

  async unban(roomId: string, actorParticipantId: string, participantId: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.moderation.updateMany({ roomId, participantId, action: 'ban', active: true }, { active: false });
  }

  async mute(roomId: string, actorParticipantId: string, participantId: string, force = false): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.participants.updateOne({ _id: participantId, roomId }, { audioEnabled: false });
    if (force) {
      await this.addModeration(roomId, actorParticipantId, participantId, 'force-mute');
    }
  }

  async sendChat(request: { roomId: string; message: string; recipientId?: string }, senderId: string): Promise<ChatMessage> {
    await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    const permissions = await this.getPermissions(request.roomId, senderId);
    if (!permissions.canChat) {
      throw new ForbiddenException('Chat permission denied');
    }
    const shadowMuted = await this.moderation.exists({ roomId: request.roomId, participantId: senderId, action: 'shadow-mute', active: true });
    const doc = await this.chat.create({
      roomId: request.roomId,
      senderId,
      recipientId: request.recipientId,
      message: request.message,
      shadowMuted: Boolean(shadowMuted)
    });
    return {
      id: doc.id,
      roomId: doc.roomId,
      senderId: doc.senderId,
      recipientId: doc.recipientId,
      message: doc.message,
      shadowMuted: doc.shadowMuted,
      createdAt: doc.createdAt.toISOString()
    };
  }

  async raiseHand(roomId: string, participantId: string, raised: boolean): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.participants.updateOne({ _id: participantId, roomId }, { handRaised: raised });
  }

  async lookupRoomOwner(roomId: string): Promise<RoomOwnerLookupResponse> {
    const room = await this.rooms.findById(roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException('Room not found');
    }
    return this.nodeRegistry.lookupRoomOwner(roomId);
  }

  async getRoomForUser(roomId: string, userId: string): Promise<Room> {
    const participant = await this.participants.exists({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoom(roomId);
  }

  async getConsumerLayerStateForUser(consumerId: string, userId: string): Promise<ConsumerLayerState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    const participant = await this.participants.findOne({ roomId: consumer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getConsumerLayerState(consumerId, participant.id);
  }

  async getProducerLayerStateForUser(producerId: string, userId: string): Promise<ProducerLayerState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const participant = await this.participants.findOne({ roomId: producer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getProducerLayerState(producerId, participant.id);
  }

  async getConsumerQualityStateForUser(consumerId: string, userId: string): Promise<ConsumerQualityState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    const participant = await this.participants.findOne({ roomId: consumer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getConsumerQualityState(consumerId, participant.id);
  }

  async getProducerQualityStateForUser(producerId: string, userId: string): Promise<ProducerQualityState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const participant = await this.participants.findOne({ roomId: producer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getProducerQualityState(producerId, participant.id);
  }

  async getRoomQualityStateForUser(roomId: string, userId: string): Promise<RoomQualityState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoomQualityState(roomId, participant.id);
  }

  private async getRoom(roomId: string): Promise<Room> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    const [participants, permissionDocs, producerDocs, consumerDocs, owner] = await Promise.all([
      this.participants.find({ roomId, leftAt: { $exists: false } }),
      this.permissions.find({ roomId }),
      this.producers.find({ roomId, status: { $ne: 'closed' } }),
      this.consumers.find({ roomId, status: { $ne: 'closed' } }),
      this.nodeRegistry.getRoomOwner(roomId)
    ]);
    const permissionMap = new Map(permissionDocs.map((permission) => [permission.participantId, this.toPermissions(permission)]));
    const consumerLayerMap = new Map<string, ConsumerLayerState[]>();
    for (const consumer of consumerDocs) {
      const state = this.consumerLayerState(consumer);
      const list = consumerLayerMap.get(consumer.participantId) ?? [];
      list.push(state);
      consumerLayerMap.set(consumer.participantId, list);
    }
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      settings: {
        locked: room.settings.locked,
        waitingRoomEnabled: room.settings.waitingRoomEnabled,
        joinApprovalRequired: room.settings.joinApprovalRequired,
        visibility: room.settings.visibility,
        maxParticipants: room.settings.maxParticipants,
        recordingEnabled: room.settings.recordingEnabled,
        chatEnabled: room.settings.chatEnabled
      },
      mediaState: {
        status: room.mediaState?.status ?? 'active',
        failedAt: room.mediaState?.failedAt?.toISOString(),
        failureReason: room.mediaState?.failureReason,
        failureMessage: room.mediaState?.failureMessage,
        workerId: room.mediaState?.workerId
      },
      owner,
      participants: participants.map((participant) =>
        this.toParticipant(participant, permissionMap.get(participant.id) ?? DEFAULT_PARTICIPANT_PERMISSIONS, consumerLayerMap.get(participant.id))
      ),
      producers: producerDocs.map((producer) => this.toProducer(producer)),
      consumers: consumerDocs.map((consumer) => this.toConsumer(consumer)),
      createdAt: room.createdAt.toISOString(),
      closedAt: room.closedAt?.toISOString()
    };
  }

  private async createParticipant(
    roomId: string,
    user: SocketUser,
    socketId: string,
    role: Role,
    permissions: Permissions,
    admitted: boolean,
    displayName = user.email
  ): Promise<ParticipantMongoDocument> {
    const participant = await this.participants.create({
      roomId,
      userId: user.id,
      displayName,
      socketId,
      role,
      audioEnabled: permissions.canPublishAudio,
      videoEnabled: permissions.canPublishVideo,
      screenSharing: false,
      handRaised: false,
      admitted,
      joinedAt: new Date(),
      lastSeenAt: new Date(),
      leftAt: undefined
    });
    await this.permissions.create({ roomId, participantId: participant.id, ...permissions });
    this.metrics.activeParticipants.labels(roomId).inc();
    return participant;
  }

  private async requireRoomOwnerLookup(roomId: string): Promise<RoomOwnerLookupResponse> {
    const lookup = await this.nodeRegistry.lookupRoomOwner(roomId);
    if (!lookup.owner || !lookup.available) {
      throw new ServiceUnavailableException(`Room owner is unavailable: ${lookup.reason ?? 'missing'}`);
    }
    return lookup;
  }

  private async getPermissions(roomId: string, participantId: string): Promise<Permissions> {
    const doc = await this.permissions.findOne({ roomId, participantId });
    return doc ? this.toPermissions(doc) : DEFAULT_PARTICIPANT_PERMISSIONS;
  }

  private async assertParticipant(roomId: string, participantId: string): Promise<ParticipantMongoDocument> {
    const participant = await this.participants.findOne({ _id: participantId, roomId, admitted: true, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not an active room participant');
    }
    return participant;
  }

  private async assertModerator(roomId: string, actorParticipantId: string, hostOnly: boolean): Promise<ParticipantMongoDocument> {
    const actor = await this.assertParticipant(roomId, actorParticipantId);
    const allowed = hostOnly ? actor.role === Role.HOST : actor.role === Role.HOST || actor.role === Role.CO_HOST;
    if (!allowed) {
      throw new ForbiddenException('Moderator role required');
    }
    return actor;
  }

  private async assertCanControlProducer(producer: ProducerMongoDocument, participantId: string): Promise<void> {
    if (producer.participantId === participantId) {
      return;
    }
    await this.assertModerator(producer.roomId, participantId, false);
  }

  private async assertNotBanned(roomId: string, userId: string): Promise<void> {
    const ban = await this.moderation.exists({ roomId, userId, action: 'ban', active: true });
    if (ban) {
      throw new ForbiddenException('Participant is banned');
    }
  }

  private async addModeration(
    roomId: string,
    actorParticipantId: string,
    participantId: string,
    action: 'kick' | 'ban' | 'shadow-mute' | 'force-mute' | 'disable-camera' | 'stop-screen',
    reason?: string
  ): Promise<void> {
    await this.assertModerator(roomId, actorParticipantId, false);
    const participant = await this.participants.findById(participantId);
    await this.moderation.create({
      roomId,
      participantId,
      userId: participant?.userId,
      actorId: actorParticipantId,
      action,
      reason,
      active: true
    });
  }

  private async handleConsumerLayerEvent(event: ConsumerLayerEvent): Promise<void> {
    await this.consumers.updateOne(
      { _id: event.consumerId },
      {
        $set: {
          currentLayers: event.currentLayers,
          targetLayers: event.targetLayers,
          preferredLayers: event.preferredLayers,
          currentSvcLayers: event.currentSvcLayers,
          targetSvcLayers: event.targetSvcLayers,
          preferredSvcLayers: event.preferredSvcLayers,
          layerSwitchReason: event.reason,
          layerSwitchedAt: new Date(event.timestamp)
        }
      }
    );
    switch (event.type) {
      case 'changed':
        this.metrics.successfulLayerSwitches.labels(event.reason).inc();
        if (event.currentSvcLayers) {
          this.metrics.svcLayerSwitches.labels(event.reason).inc();
        }
        if (event.switchDurationMs !== undefined) {
          this.metrics.layerSwitchDuration.labels(event.reason).observe(event.switchDurationMs);
        }
        break;
      case 'switch-failed':
        this.metrics.failedLayerSwitches.labels(event.reason).inc();
        if (event.targetSvcLayers) {
          this.metrics.svcLayerSwitchFailures.labels(event.reason).inc();
        }
        break;
      case 'unavailable':
        this.metrics.unavailableLayerCount.labels(event.reason).inc();
        if (event.targetSvcLayers) {
          this.metrics.svcUnavailableLayerCount.labels(event.reason).inc();
        }
        break;
      case 'switching':
        break;
    }
    for (const listener of this.layerEventListeners) {
      listener(event);
    }
  }

  private async handleProducerDynacastEvent(event: ProducerDynacastEvent): Promise<void> {
    await this.producers.updateOne(
      { _id: event.producerId },
      {
        $set: {
          dynacastState: event.state
        }
      }
    );
    const producer = await this.producers.findById(event.producerId);
    if (event.type === 'layers-needed' && event.neededLayers.length > 0) {
      this.metrics.dynacastLayerResumes.labels(event.reason).inc(event.neededLayers.length);
    }
    if (event.type === 'layers-unneeded' && event.unneededLayers.length > 0) {
      this.metrics.dynacastLayerSuspends.labels(event.reason).inc(event.unneededLayers.length);
    }
    if (event.type === 'updated' && (event.neededLayers.length > 0 || event.unneededLayers.length > 0)) {
      this.metrics.dynacastLayerDemandChanges.labels(event.reason).inc();
    }
    if (producer) {
      this.metrics.dynacastEstimatedBandwidthSaved.labels(producer.kind).set(event.estimatedBandwidthSavedBps);
    }
    for (const listener of this.producerDynacastEventListeners) {
      listener(event);
    }
  }

  private handleConsumerQualityState(state: ConsumerQualityState): void {
    this.metrics.consumerQualityScore.labels(state.roomId, state.participantId, state.consumerId).set(state.score.score);
    this.metrics.recommendedBitrate.labels(state.roomId, state.participantId, 'consumer').set(state.bitrate.recommendedBitrate);
    this.metrics.availableBitrate.labels(state.roomId, state.participantId, 'consumer').set(state.bitrate.availableBitrate);
    this.metrics.allocatedBitrate.labels(state.roomId, state.participantId, 'consumer').set(state.bitrate.allocatedBitrate);
    this.metrics.pacingQueueBytes.labels(state.roomId, state.participantId, 'consumer').set(state.pacingQueueDepth);
    this.metrics.packetLoss.labels(state.roomId, state.participantId).set(state.network.packetLoss);
    this.metrics.rtt.labels(state.roomId, state.participantId).set(state.network.rtt);
    this.metrics.jitter.labels(state.roomId, state.participantId).set(state.network.jitter);
    for (const reason of state.score.reasons.filter((reason) => reason !== 'stable')) {
      this.metrics.qualityDegradations.labels('consumer', reason).inc();
    }
    if (state.score.reasons.includes('stable') || state.score.reasons.includes('recovered')) {
      this.metrics.qualityRecoveries.labels('consumer').inc();
    }
    for (const listener of this.consumerQualityEventListeners) {
      listener(state);
    }
  }

  private handleProducerQualityState(state: ProducerQualityState): void {
    this.metrics.producerQualityScore.labels(state.roomId, state.participantId, state.producerId, state.kind).set(state.score.score);
    this.metrics.recommendedBitrate.labels(state.roomId, state.participantId, 'producer').set(state.bitrate.recommendedBitrate);
    this.metrics.availableBitrate.labels(state.roomId, state.participantId, 'producer').set(state.bitrate.availableBitrate);
    this.metrics.allocatedBitrate.labels(state.roomId, state.participantId, 'producer').set(state.bitrate.allocatedBitrate);
    for (const layer of state.layerScores.concat(state.svcLayerScores)) {
      this.metrics.layerQualityScore
        .labels(state.roomId, state.producerId, String(layer.layer?.spatialLayer ?? layer.svcLayer?.spatialLayerId ?? 'x'), String(layer.layer?.temporalLayer ?? layer.svcLayer?.temporalLayerId ?? 'x'))
        .set(layer.score.score);
    }
    for (const reason of state.score.reasons.filter((reason) => reason !== 'stable')) {
      this.metrics.qualityDegradations.labels('producer', reason).inc();
    }
    if (state.score.reasons.includes('stable') || state.score.reasons.includes('recovered')) {
      this.metrics.qualityRecoveries.labels('producer').inc();
    }
    for (const listener of this.producerQualityEventListeners) {
      listener(state);
    }
  }

  private handleTransportQualityState(state: TransportQualityState): void {
    this.metrics.transportQualityScore.labels(state.roomId, state.participantId, state.transportId).set(state.score.score);
    this.metrics.pacingQueueBytes.labels(state.roomId, state.participantId, 'transport').set(state.pacingQueueDepth);
    for (const listener of this.transportQualityEventListeners) {
      listener(state);
    }
  }

  private handleRoomQualityState(state: RoomQualityState): void {
    this.metrics.roomQualityScore.labels(state.roomId).set(state.score.score);
    for (const listener of this.roomQualityEventListeners) {
      listener(state);
    }
  }

  private consumerLayerState(doc: ConsumerMongoDocument): ConsumerLayerState {
    return (
      this.media.consumerLayerState(doc.id) ?? {
        roomId: doc.roomId,
        participantId: doc.participantId,
        consumerId: doc.id,
        producerId: doc.producerId,
        preferredLayers: normalizeLayerSelection(doc.preferredLayers as RtpLayerSelection | undefined),
        currentLayers: normalizeLayerSelection(doc.currentLayers as RtpLayerSelection | undefined),
        targetLayers: normalizeLayerSelection(doc.targetLayers as RtpLayerSelection | undefined),
        preferredSvcLayers: normalizeSvcLayerSelection(doc.preferredSvcLayers as SvcLayerSelection | undefined),
        currentSvcLayers: normalizeSvcLayerSelection(doc.currentSvcLayers as SvcLayerSelection | undefined),
        targetSvcLayers: normalizeSvcLayerSelection(doc.targetSvcLayers as SvcLayerSelection | undefined),
        switchedAt: doc.layerSwitchedAt?.toISOString(),
        switchReason: normalizeLayerSwitchReason(doc.layerSwitchReason)
      }
    );
  }

  private toParticipant(doc: ParticipantMongoDocument, permissions: Permissions, consumerLayers?: ConsumerLayerState[]): Participant {
    return {
      id: doc.id,
      userId: doc.userId,
      displayName: doc.displayName,
      socketId: doc.socketId,
      role: doc.role,
      audioEnabled: doc.audioEnabled,
      videoEnabled: doc.videoEnabled,
      screenSharing: doc.screenSharing,
      handRaised: doc.handRaised,
      admitted: doc.admitted,
      permissions,
      consumerLayers,
      joinedAt: doc.joinedAt.toISOString(),
      lastSeenAt: doc.lastSeenAt.toISOString()
    };
  }

  private toPermissions(doc: PermissionMongoDocument): Permissions {
    return {
      canPublishAudio: doc.canPublishAudio,
      canPublishVideo: doc.canPublishVideo,
      canShareScreen: doc.canShareScreen,
      canChat: doc.canChat
    };
  }

  private toProducer(doc: ProducerMongoDocument): Producer {
    const dynacast = this.media.producerLayerState(doc.id)?.dynacast ?? (doc.dynacastState as unknown as ProducerDynacastState | undefined);
    const svc = this.media.producerLayerState(doc.id)?.svc ?? (doc.svcState as unknown as ProducerSvcState | undefined);
    return {
      id: doc.id,
      roomId: doc.roomId,
      participantId: doc.participantId,
      kind: doc.kind,
      transportId: doc.transportId,
      priority: normalizeConsumerPriority(doc.priority),
      rtpParameters: doc.rtpParameters as unknown as Producer['rtpParameters'],
      svc,
      dynacast,
      quality: this.media.producerQualityState(doc.id),
      status: doc.status,
      createdAt: doc.createdAt.toISOString()
    };
  }

  private toConsumer(doc: ConsumerMongoDocument): Consumer {
    return {
      id: doc.id,
      roomId: doc.roomId,
      producerId: doc.producerId,
      participantId: doc.participantId,
      transportId: doc.transportId,
      priority: normalizeConsumerPriority(doc.priority),
      preferredLayer: doc.preferredLayer,
      preferredLayers: normalizeLayerSelection(doc.preferredLayers as RtpLayerSelection | undefined),
      currentLayers: normalizeLayerSelection(doc.currentLayers as RtpLayerSelection | undefined),
      targetLayers: normalizeLayerSelection(doc.targetLayers as RtpLayerSelection | undefined),
      preferredSvcLayers: normalizeSvcLayerSelection(doc.preferredSvcLayers as SvcLayerSelection | undefined),
      currentSvcLayers: normalizeSvcLayerSelection(doc.currentSvcLayers as SvcLayerSelection | undefined),
      targetSvcLayers: normalizeSvcLayerSelection(doc.targetSvcLayers as SvcLayerSelection | undefined),
      layerState: this.consumerLayerState(doc),
      quality: this.media.consumerQualityState(doc.id),
      rtpParameters: doc.rtpParameters as unknown as Consumer['rtpParameters'],
      status: doc.status,
      createdAt: doc.createdAt.toISOString()
    };
  }
}

function consumerRtpParametersForProducer(producerRtp: RtpParameters): RtpParameters {
  const primaryCodec = producerRtp.codecs.find((codec) => !/\/rtx$/i.test(codec.mimeType));
  const rtxCodec = producerRtp.codecs.find((codec) => /\/rtx$/i.test(codec.mimeType) && Number(codec.parameters?.apt) === primaryCodec?.payloadType);
  const ssrc = randomSsrc();
  const rtxSsrc = rtxCodec ? randomSsrc() : undefined;
  return {
    ...producerRtp,
    encodings: [
      {
        ssrc,
        scalabilityMode: producerRtp.encodings[0]?.scalabilityMode,
        rtx: rtxSsrc !== undefined ? { ssrc: rtxSsrc, payloadType: rtxCodec?.payloadType } : undefined
      }
    ],
    simulcast: undefined,
    rtcp: {
      ...producerRtp.rtcp,
      cname: `sfu-${ssrc.toString(16)}`
    }
  };
}

function preferredLayerNameToSelection(layer: 'low' | 'medium' | 'high' | undefined): RtpLayerSelection | undefined {
  switch (layer) {
    case 'low':
      return { spatialLayer: 0 };
    case 'medium':
      return { spatialLayer: 1 };
    case 'high':
      return { spatialLayer: 2 };
    default:
      return undefined;
  }
}

function normalizeLayerSelection(selection: RtpLayerSelection | undefined): RtpLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    spatialLayer: normalizeLayerNumber(selection.spatialLayer),
    temporalLayer: normalizeLayerNumber(selection.temporalLayer)
  };
}

function normalizeSvcLayerSelection(selection: SvcLayerSelection | undefined): SvcLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    spatialLayerId: normalizeLayerNumber(selection.spatialLayerId),
    temporalLayerId: normalizeLayerNumber(selection.temporalLayerId),
    qualityLayerId: normalizeLayerNumber(selection.qualityLayerId ?? selection.spatialLayerId)
  };
}

function normalizeLayerNumber(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeLayerSwitchReason(value: string | undefined): ConsumerLayerSwitchReason | undefined {
  return value === 'initial' || value === 'preferred' || value === 'bandwidth' || value === 'keyframe' || value === 'unavailable' || value === 'manual' || value === 'unknown'
    ? value
    : undefined;
}

function normalizeConsumerPriority(priority: number | undefined): number {
  if (priority === undefined || !Number.isFinite(priority)) {
    return 1;
  }
  return Math.max(0.1, Math.min(10, priority));
}

function producerDynacastMetricEventName(event: ProducerDynacastEvent): string {
  return event.type;
}

function sanitizeMetricLabel(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 80) || 'unknown';
}

function randomSsrc(): number {
  const value = randomBytes(4).readUInt32BE(0);
  return value === 0 ? 1 : value;
}
