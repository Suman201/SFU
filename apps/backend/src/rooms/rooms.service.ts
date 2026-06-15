import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { performance } from 'node:perf_hooks';
import { Model } from 'mongoose';
import {
  ChatMessage,
  Consumer,
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
  Role,
  Room,
  TransportOptions,
  VIEWER_PERMISSIONS
} from '@native-sfu/contracts';
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
import { MediaService } from '@native-sfu/nest-sfu';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';

export interface SocketUser {
  id: string;
  email: string;
  roles: Role[];
}

@Injectable()
export class RoomsService {
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
    private readonly metrics: MetricsService
  ) {}

  async createRoom(user: SocketUser, socketId: string, request: CreateRoomRequest): Promise<Room> {
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
      }
    });
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
    await this.assertNotBanned(room.id, user.id);
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

  async leaveRoom(roomId: string, participantId: string): Promise<{ closed: boolean }> {
    const participant = await this.participants.findById(participantId);
    if (!participant || participant.roomId !== roomId) {
      return { closed: false };
    }
    await this.participants.updateOne({ _id: participantId }, { leftAt: new Date(), lastSeenAt: new Date() });
    await this.producers.updateMany({ roomId, participantId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.consumers.updateMany({ roomId, participantId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.redis.removePresence(roomId, participantId);
    await this.media.closeParticipantTransports(participantId);
    this.metrics.activeParticipants.labels(roomId).dec();
    const room = await this.rooms.findById(roomId);
    if (room?.hostId === participantId) {
      await this.rooms.updateOne({ _id: roomId }, { closedAt: new Date() });
      this.metrics.activeRooms.dec();
      return { closed: true };
    }
    return { closed: false };
  }

  async closeRoom(roomId: string, actorParticipantId: string): Promise<void> {
    await this.assertModerator(roomId, actorParticipantId, true);
    await this.rooms.updateOne({ _id: roomId }, { closedAt: new Date() });
    await this.participants.updateMany({ roomId, leftAt: { $exists: false } }, { leftAt: new Date() });
    await this.producers.updateMany({ roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.consumers.updateMany({ roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.media.closeRoom(roomId);
    this.metrics.activeRooms.dec();
  }

  async setLocked(roomId: string, actorParticipantId: string, locked: boolean): Promise<Room> {
    await this.assertModerator(roomId, actorParticipantId, true);
    await this.rooms.updateOne({ _id: roomId }, { 'settings.locked': locked });
    return this.getRoom(roomId);
  }

  async admit(roomId: string, actorParticipantId: string, participantId: string): Promise<Room> {
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.participants.updateOne({ _id: participantId, roomId }, { admitted: true, $unset: { leftAt: '' } });
    return this.getRoom(roomId);
  }

  async reject(roomId: string, actorParticipantId: string, participantId: string): Promise<void> {
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.participants.updateOne({ _id: participantId, roomId }, { leftAt: new Date() });
  }

  async createTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    await this.assertParticipant(roomId, participantId);
    const options = await this.media.createWebRtcTransport(roomId, participantId);
    this.metrics.activeTransports.inc();
    return options;
  }

  async addIceCandidate(transportId: string, participantId: string, candidate: IceCandidate): Promise<void> {
    await this.media.addRemoteCandidate(transportId, participantId, candidate);
  }

  async setRemoteIceParameters(transportId: string, participantId: string, parameters: TransportOptions['iceParameters']): Promise<void> {
    await this.media.setRemoteIceParameters(transportId, participantId, parameters);
  }

  async restartIce(transportId: string, participantId: string): Promise<TransportOptions> {
    return this.media.restartIce(transportId, participantId);
  }

  async createProducer(request: CreateProducerRequest, participantId: string): Promise<Producer> {
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
    const producerDoc = await this.producers.create({
      roomId: request.roomId,
      participantId,
      kind: request.kind,
      transportId: request.transportId,
      rtpParameters: request.rtpParameters,
      status: 'live'
    });
    await this.media.registerProducer(this.toProducer(producerDoc));
    if (request.kind === 'screen') {
      participant.screenSharing = true;
      await participant.save();
    }
    this.metrics.activeProducers.labels(request.kind).inc();
    return this.toProducer(producerDoc);
  }

  async setProducerStatus(producerId: string, participantId: string, status: 'live' | 'paused'): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    await this.assertCanControlProducer(producer, participantId);
    producer.status = status;
    await producer.save();
    await this.media.setProducerPaused(producerId, status === 'paused');
    return this.toProducer(producer);
  }

  async closeProducer(producerId: string, participantId: string): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    await this.assertCanControlProducer(producer, participantId);
    producer.status = 'closed';
    producer.closedAt = new Date();
    await producer.save();
    await this.media.unregisterProducer(producerId);
    this.metrics.activeProducers.labels(producer.kind).dec();
    return this.toProducer(producer);
  }

  async createConsumer(request: CreateConsumerRequest, participantId: string): Promise<Consumer> {
    const producer = await this.producers.findById(request.producerId);
    if (!producer || producer.status === 'closed') {
      throw new NotFoundException('Producer not found');
    }
    await this.assertParticipant(request.roomId, participantId);
    const consumerDoc = await this.consumers.create({
      roomId: request.roomId,
      producerId: producer.id,
      participantId,
      preferredLayer: request.preferredLayer ?? 'high',
      rtpParameters: producer.rtpParameters,
      status: 'live'
    });
    await this.media.registerConsumer(this.toConsumer(consumerDoc));
    this.metrics.activeConsumers.inc();
    return this.toConsumer(consumerDoc);
  }

  async setConsumerStatus(consumerId: string, participantId: string, status: 'live' | 'paused'): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    consumer.status = status;
    await consumer.save();
    await this.media.setConsumerPaused(consumerId, status === 'paused');
    return this.toConsumer(consumer);
  }

  async closeConsumer(consumerId: string, participantId: string): Promise<void> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    consumer.status = 'closed';
    consumer.closedAt = new Date();
    await consumer.save();
    await this.media.unregisterConsumer(consumerId);
    this.metrics.activeConsumers.dec();
  }

  async updatePermissions(roomId: string, actorParticipantId: string, participantId: string, patch: Partial<Permissions>): Promise<Permissions> {
    await this.assertModerator(roomId, actorParticipantId, false);
    const current = await this.getPermissions(roomId, participantId);
    const next = { ...current, ...patch };
    await this.permissions.updateOne({ roomId, participantId }, { $set: next }, { upsert: true });
    return next;
  }

  async kick(roomId: string, actorParticipantId: string, participantId: string, reason?: string): Promise<void> {
    await this.addModeration(roomId, actorParticipantId, participantId, 'kick', reason);
    await this.leaveRoom(roomId, participantId);
  }

  async ban(roomId: string, actorParticipantId: string, participantId: string, reason?: string): Promise<void> {
    await this.addModeration(roomId, actorParticipantId, participantId, 'ban', reason);
    await this.leaveRoom(roomId, participantId);
  }

  async unban(roomId: string, actorParticipantId: string, participantId: string): Promise<void> {
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.moderation.updateMany({ roomId, participantId, action: 'ban', active: true }, { active: false });
  }

  async mute(roomId: string, actorParticipantId: string, participantId: string, force = false): Promise<void> {
    await this.assertModerator(roomId, actorParticipantId, false);
    await this.participants.updateOne({ _id: participantId, roomId }, { audioEnabled: false });
    if (force) {
      await this.addModeration(roomId, actorParticipantId, participantId, 'force-mute');
    }
  }

  async sendChat(request: { roomId: string; message: string; recipientId?: string }, senderId: string): Promise<ChatMessage> {
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
    await this.participants.updateOne({ _id: participantId, roomId }, { handRaised: raised });
  }

  async getRoomForUser(roomId: string, userId: string): Promise<Room> {
    const participant = await this.participants.exists({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoom(roomId);
  }

  private async getRoom(roomId: string): Promise<Room> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    const [participants, permissionDocs, producerDocs, consumerDocs] = await Promise.all([
      this.participants.find({ roomId, leftAt: { $exists: false } }),
      this.permissions.find({ roomId }),
      this.producers.find({ roomId, status: { $ne: 'closed' } }),
      this.consumers.find({ roomId, status: { $ne: 'closed' } })
    ]);
    const permissionMap = new Map(permissionDocs.map((permission) => [permission.participantId, this.toPermissions(permission)]));
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
      participants: participants.map((participant) => this.toParticipant(participant, permissionMap.get(participant.id) ?? DEFAULT_PARTICIPANT_PERMISSIONS)),
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

  private toParticipant(doc: ParticipantMongoDocument, permissions: Permissions): Participant {
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
    return {
      id: doc.id,
      roomId: doc.roomId,
      participantId: doc.participantId,
      kind: doc.kind,
      transportId: doc.transportId,
      rtpParameters: doc.rtpParameters as unknown as Producer['rtpParameters'],
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
      preferredLayer: doc.preferredLayer,
      rtpParameters: doc.rtpParameters as unknown as Consumer['rtpParameters'],
      status: doc.status,
      createdAt: doc.createdAt.toISOString()
    };
  }
}
