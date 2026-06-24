import { randomUUID } from 'node:crypto';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  Ack as WsAck,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import type {
  Ack as SocketAck,
  ClassStudentSpeakEvent,
  ClassStudentMediaModerationResponse,
  ChatMessage,
  ChatReadState,
  ClientToServerEvents,
  Consumer,
  ConsumerLayerState,
  CreateConsumerRequest,
  CreateProducerRequest,
  CreateRoomRequest,
  JoinRoomRequest,
  JoinRoomResponse,
  ParticipantPatch,
  Producer,
  ProducerDynacastEvent,
  ProducerLayerState,
  Room,
  RoomFailureEvent,
  RoomIncidentState,
  RoomIncidentTimelineState,
  RoomOwnerLookupResponse,
  RoomRecoveryActionResult,
  RoomSnapshotHistoryState,
  ServerToClientEvents,
  SetConsumerPreferredLayersRequest,
  SetConsumerPreferredSvcLayersRequest,
  StudentMediaModerationAction,
  StudentMediaModerationEvent,
  TransportOptions,
  UpdateRoomMediaProfileRequest,
  WhiteboardCommandEvent,
  WhiteboardControlEvent,
  WhiteboardCursorEvent
} from '@native-sfu/contracts';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { socketAck } from '../common/utils/ack';
import { RecordingsService } from '../recordings/recordings.service';
import { RoomSignalService, type RoomSignalEnvelope, type RoomSignalTarget } from './room-signal.service';
import { RoomsService, SocketUser, type SocketDeliveryTarget, type StudentMediaModerationResult } from './rooms.service';

type SfuSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: {
    user?: SocketUser;
    participantId?: string;
    roomId?: string;
    requestId?: string;
  };
};

function layerEventName(type: 'changed' | 'switching' | 'unavailable' | 'switch-failed'): keyof Pick<
  ServerToClientEvents,
  'consumer:layers-changed' | 'consumer:layers-switching' | 'consumer:layers-unavailable' | 'consumer:layers-switch-failed'
> {
  switch (type) {
    case 'changed':
      return 'consumer:layers-changed';
    case 'switching':
      return 'consumer:layers-switching';
    case 'unavailable':
      return 'consumer:layers-unavailable';
    case 'switch-failed':
      return 'consumer:layers-switch-failed';
  }
}

function svcLayerEventName(type: 'changed' | 'switching' | 'unavailable' | 'switch-failed'): keyof Pick<
  ServerToClientEvents,
  'consumer:svc-layers-changed' | 'consumer:svc-layers-switching' | 'consumer:svc-layers-unavailable' | 'consumer:svc-layers-switch-failed'
> {
  switch (type) {
    case 'changed':
      return 'consumer:svc-layers-changed';
    case 'switching':
      return 'consumer:svc-layers-switching';
    case 'unavailable':
      return 'consumer:svc-layers-unavailable';
    case 'switch-failed':
      return 'consumer:svc-layers-switch-failed';
  }
}

function producerDynacastEventName(type: ProducerDynacastEvent['type']): keyof Pick<
  ServerToClientEvents,
  'producer:layers-needed' | 'producer:layers-unneeded' | 'producer:dynacast-updated'
> {
  switch (type) {
    case 'layers-needed':
      return 'producer:layers-needed';
    case 'layers-unneeded':
      return 'producer:layers-unneeded';
    case 'updated':
      return 'producer:dynacast-updated';
  }
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

const socketAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? process.env.FRONTEND_URL ?? 'http://localhost:4200')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

@WebSocketGateway({
  namespace: '/sfu',
  cors: {
    origin: socketAllowedOrigins,
    credentials: true
  }
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RoomsGateway.name);
  private readonly connectionAttempts = new Map<string, { count: number; resetAt: number }>();

  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;

  constructor(
    private readonly rooms: RoomsService,
    private readonly auth: AuthService,
    private readonly signals: RoomSignalService,
    private readonly recordings: RecordingsService
  ) {
    this.signals.onSignal((signal) => {
      if (signal.target) {
        this.emitTargetedSignal(signal);
        return;
      }
      (this.server.to(signal.roomId) as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit(signal.event, ...signal.payload);
    });
    this.rooms.onRoomClosed((roomId) => {
      void this.emitRoomEvent(roomId, 'room:closed', roomId);
    });
    this.rooms.onChatReadReceipt((delivery) => {
      void this.emitTargetedRoomEvent(
        delivery.state.roomId,
        delivery.targets ?? this.socketIdsToDeliveryTargets(delivery.state.roomId, delivery.targetSocketIds),
        'chat:read',
        delivery.receipt
      );
    });
    this.rooms.onClassSessionLifecycleEvent((event, payload) => {
      void this.emitRoomEvent(this.classSessionLifecycleRoomId(payload.sessionId), event, payload);
    });
    this.rooms.onClassSessionMaterialEvent((event, payload) => {
      void this.emitRoomEvent(this.classSessionLifecycleRoomId(payload.sessionId), event, payload);
    });
    this.recordings.onClassSessionRecordingEvent((event, payload) => {
      void this.emitRoomEvent(this.classSessionLifecycleRoomId(payload.sessionId), event, payload);
    });
    this.rooms.onConsumerLayerEvent((event) => {
      const eventName = event.currentSvcLayers || event.targetSvcLayers || event.preferredSvcLayers ? svcLayerEventName(event.type) : layerEventName(event.type);
      this.server.to(event.roomId).emit(eventName, event);
    });
    this.rooms.onProducerDynacastEvent((event) => {
      void this.emitProducerDynacastEvent(event);
    });
    this.rooms.onConsumerScoreUpdated((state) => {
      void this.emitRoomEvent(state.roomId, 'consumer:score-updated', state);
      void this.emitRoomEvent(state.roomId, 'network:quality', {
        participantId: state.participantId,
        score: Math.max(1, Math.min(5, Math.ceil(state.score.score / 20))),
        packetLoss: state.network.packetLoss,
        rtt: state.network.rtt,
        jitter: state.network.jitter
      });
    });
    this.rooms.onProducerScoreUpdated((state) => {
      void this.emitRoomEvent(state.roomId, 'producer:score-updated', state);
    });
    this.rooms.onTransportQualityUpdated((state) => {
      void this.emitRoomEvent(state.roomId, 'transport:quality-updated', state);
    });
    this.rooms.onRoomQualityUpdated((state) => {
      void this.emitRoomEvent(state.roomId, 'room:quality-updated', state);
    });
    this.rooms.onRoomQualitySummaryUpdated((state) => {
      void this.emitRoomEvent(state.roomId, 'room:quality-summary-updated', state);
    });
    this.rooms.onRoomIncidentStateUpdated((state) => {
      void this.emitRoomEvent(state.roomId, 'room:incident-updated', state);
    });
    this.rooms.onRoomIncidentTimelineEvent((event) => {
      void this.emitRoomEvent(event.roomId, 'room:incident-event', event);
    });
    this.rooms.onRoomSnapshotGenerated((summary) => {
      void this.emitRoomEvent(summary.roomId, 'room:snapshot-generated', summary);
    });
    this.rooms.onRoomFailed((event: RoomFailureEvent) => {
      this.emitRoomEvent(event.roomId, 'room:failed', event).catch(() => undefined);
    });
  }

  async handleConnection(socket: SfuSocket): Promise<void> {
    socket.data.requestId = randomUUID();
    if (this.isConnectionThrottled(socket)) {
      this.logger.warn(`Socket connection throttled requestId=${socket.data.requestId}`);
      socket.disconnect(true);
      return;
    }
    const token = this.extractToken(socket);
    if (!token) {
      this.logger.warn(`Socket missing bearer token requestId=${socket.data.requestId}`);
      socket.disconnect(true);
      return;
    }
    try {
      const payload = await this.auth.verifyAccessToken(token);
      socket.data.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles
      };
    } catch (error) {
      this.logger.warn(`Socket auth failed requestId=${socket.data.requestId}: ${error instanceof Error ? error.message : String(error)}`);
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: SfuSocket): Promise<void> {
    if (socket.data.roomId && socket.data.participantId) {
      const result = await this.rooms.leaveRoomForSocket(socket.data.roomId, socket.data.participantId, socket.id);
      await this.emitRoomLeaveResult(socket.data.roomId, socket.data.participantId, result);
    }
  }

  @SubscribeMessage('room:create')
  createRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateRoomRequest, @WsAck() ack: SocketAck<Room>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.createRoom(this.requireUser(socket), socket.id, request);
      socket.data.roomId = room.id;
      socket.data.participantId = room.hostId;
      await socket.join(room.id);
      return room;
    });
  }

  @SubscribeMessage('session:watch')
  watchSession(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['session:watch']>[0],
    @WsAck() ack: SocketAck<void>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const sessionId = this.normalizeClassSessionId(request?.sessionId);
      const batchId = this.normalizeOptionalClassSessionBatchId(request?.batchId);
      await this.rooms.assertCanWatchClassSession(sessionId, this.requireUser(socket), batchId);
      await socket.join(this.classSessionLifecycleRoomId(sessionId));
    });
  }

  @SubscribeMessage('session:unwatch')
  unwatchSession(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['session:unwatch']>[0],
    @WsAck() ack: SocketAck<void>
  ): Promise<void> {
    return socketAck(ack, async () => {
      this.requireUser(socket);
      await socket.leave(this.classSessionLifecycleRoomId(request.sessionId));
    });
  }

  @SubscribeMessage('room:get-owner')
  getRoomOwner(@MessageBody() request: { roomId: string }, @WsAck() ack: SocketAck<RoomOwnerLookupResponse>): Promise<void> {
    return socketAck(ack, () => this.rooms.lookupRoomOwner(request.roomId));
  }

  @SubscribeMessage('room:join')
  joinRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: JoinRoomRequest, @WsAck() ack: SocketAck<JoinRoomResponse>): Promise<void> {
    return socketAck(ack, async () => {
      const response = await this.rooms.joinRoom(this.requireUser(socket), socket.id, request);
      socket.data.roomId = request.roomId;
      socket.data.participantId = response.participantId;
      if (response.admitted) {
        await socket.join(request.roomId);
        const participant = response.room.participants.find((item) => item.id === response.participantId);
        if (participant && !response.rejoined) {
          await this.emitRoomEvent(request.roomId, 'participant:joined', participant);
        } else if (participant) {
          await this.emitRoomEvent(request.roomId, 'participant:updated', participant.id, { connected: true, socketId: participant.socketId });
        }
        await this.emitRoomEvent(request.roomId, 'room:updated', response.room);
        const whiteboardControl = await this.rooms.whiteboardControlForParticipant(request.roomId, response.participantId);
        if (whiteboardControl) {
          await this.emitTargetedRoomEvent(
            request.roomId,
            whiteboardControl.targets,
            'whiteboard:control-granted',
            whiteboardControl.event
          );
        }
      } else {
        await this.emitRoomEvent(request.roomId, 'waiting-room:pending', response.room.participants.find((item) => item.id === response.participantId)!);
      }
      return response;
    });
  }

  @SubscribeMessage('room:leave')
  leaveRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const participantId = this.requireParticipant(socket);
      const result = await this.rooms.leaveRoomForSocket(request.roomId, participantId, socket.id);
      await socket.leave(request.roomId);
      await this.emitRoomLeaveResult(request.roomId, participantId, result);
    });
  }

  @SubscribeMessage('room:close')
  closeRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.closeRoom(request.roomId, this.requireParticipant(socket));
      await this.emitRoomEvent(request.roomId, 'room:closed', request.roomId);
    });
  }

  @SubscribeMessage('room:lock')
  lockRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.toggleLock(socket, request.roomId, true, ack);
  }

  @SubscribeMessage('room:unlock')
  unlockRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.toggleLock(socket, request.roomId, false, ack);
  }

  @SubscribeMessage('room:admit')
  admit(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; participantId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.admit(request.roomId, this.requireParticipant(socket), request.participantId);
      const participant = room.participants.find((item) => item.id === request.participantId);
      await this.joinParticipantSocket(request.roomId, participant?.socketId);
      if (participant) {
        await this.emitRoomEvent(request.roomId, 'participant:joined', participant);
      }
      await this.emitRoomEvent(request.roomId, 'room:updated', room);
    });
  }

  @SubscribeMessage('room:reject')
  reject(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; participantId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.reject(request.roomId, this.requireParticipant(socket), request.participantId);
      await this.emitRoomEvent(request.roomId, 'participant:left', request.participantId);
    });
  }

  @SubscribeMessage('transport:create')
  createTransport(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, @WsAck() ack: SocketAck<TransportOptions>): Promise<void> {
    return socketAck(ack, () => this.rooms.createTransport(request.roomId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('transport:ice-candidate')
  iceCandidate(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['transport:ice-candidate']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.addIceCandidate(request.transportId, this.requireParticipant(socket), request.candidate));
  }

  @SubscribeMessage('transport:ice-parameters')
  iceParameters(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['transport:ice-parameters']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.setRemoteIceParameters(request.transportId, this.requireParticipant(socket), request.iceParameters));
  }

  @SubscribeMessage('transport:ice-restart')
  iceRestart(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { transportId: string }, @WsAck() ack: SocketAck<TransportOptions>): Promise<void> {
    return socketAck(ack, () => this.rooms.restartIce(request.transportId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('transport:dtls-parameters')
  dtlsParameters(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['transport:dtls-parameters']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.setRemoteDtlsParameters(request.transportId, this.requireParticipant(socket), request.dtlsParameters));
  }

  @SubscribeMessage('producer:create')
  createProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateProducerRequest, @WsAck() ack: SocketAck<Producer>): Promise<void> {
    return socketAck(ack, async () => {
      const producerWithCleanup = await this.rooms.createProducer(request, this.requireParticipant(socket));
      const { closedProducerIds = [], ...producer } = producerWithCleanup;
      for (const producerId of closedProducerIds) {
        await this.emitRoomEvent(producer.roomId, 'producer:closed', producerId);
      }
      await this.emitRoomEvent(request.roomId, 'producer:created', producer);
      return producer;
    });
  }

  @SubscribeMessage('producer:pause')
  pauseProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.setProducerStatus(socket, request.producerId, 'paused', ack);
  }

  @SubscribeMessage('producer:resume')
  resumeProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.setProducerStatus(socket, request.producerId, 'live', ack);
  }

  @SubscribeMessage('producer:close')
  closeProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.closeProducer(request.producerId, this.requireParticipant(socket));
      await this.emitRoomEvent(producer.roomId, 'producer:closed', request.producerId);
    });
  }

  @SubscribeMessage('producer:set-priority')
  setProducerPriority(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['producer:set-priority']>[0],
    @WsAck() ack: SocketAck<Producer>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.setProducerPriority(request.producerId, this.requireParticipant(socket), request.priority);
      await this.emitRoomEvent(producer.roomId, 'producer:updated', producer);
      return producer;
    });
  }

  @SubscribeMessage('producer:dynacast-control-failed')
  producerDynacastControlFailed(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['producer:dynacast-control-failed']>[0],
    @WsAck() ack: SocketAck<void>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.recordProducerDynacastControlFailure(request, this.requireParticipant(socket)));
  }

  @SubscribeMessage('consumer:create')
  createConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateConsumerRequest, @WsAck() ack: SocketAck<Consumer>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.createConsumer(request, this.requireParticipant(socket));
      socket.emit('consumer:created', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:pause')
  pauseConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.setConsumerStatus(socket, request.consumerId, 'paused', ack);
  }

  @SubscribeMessage('consumer:resume')
  resumeConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.setConsumerStatus(socket, request.consumerId, 'live', ack);
  }

  @SubscribeMessage('consumer:set-preferred-layers')
  setConsumerPreferredLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: SetConsumerPreferredLayersRequest, @WsAck() ack: SocketAck<Consumer>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerPreferredLayers(request.consumerId, this.requireParticipant(socket), request.preferredLayers);
      socket.emit('consumer:updated', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:set-preferred-svc-layers')
  setConsumerPreferredSvcLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: SetConsumerPreferredSvcLayersRequest, @WsAck() ack: SocketAck<Consumer>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerPreferredSvcLayers(request.consumerId, this.requireParticipant(socket), request.preferredSvcLayers);
      socket.emit('consumer:updated', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:set-priority')
  setConsumerPriority(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['consumer:set-priority']>[0],
    @WsAck() ack: SocketAck<Consumer>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerPriority(request.consumerId, this.requireParticipant(socket), request.priority);
      socket.emit('consumer:updated', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:get-layers')
  getConsumerLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, @WsAck() ack: SocketAck<ConsumerLayerState>): Promise<void> {
    return socketAck(ack, () => this.rooms.getConsumerLayerState(request.consumerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('producer:get-layers')
  getProducerLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, @WsAck() ack: SocketAck<ProducerLayerState>): Promise<void> {
    return socketAck(ack, () => this.rooms.getProducerLayerState(request.producerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('consumer:get-quality')
  getConsumerQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['consumer:get-quality']>[0],
    @WsAck() ack: SocketAck<Parameters<ServerToClientEvents['consumer:score-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getConsumerQualityState(request.consumerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('producer:get-quality')
  getProducerQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['producer:get-quality']>[0],
    @WsAck() ack: SocketAck<Parameters<ServerToClientEvents['producer:score-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getProducerQualityState(request.producerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:get-quality')
  getRoomQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:get-quality']>[0],
    @WsAck() ack: SocketAck<Parameters<ServerToClientEvents['room:quality-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getRoomQualityState(request.roomId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:get-quality-summary')
  getRoomQualitySummary(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:get-quality-summary']>[0],
    @WsAck() ack: SocketAck<Parameters<ServerToClientEvents['room:quality-summary-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getRoomQualitySummaryState(request.roomId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:get-incident-state')
  getRoomIncidentState(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:get-incident-state']>[0],
    @WsAck() ack: SocketAck<RoomIncidentState>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getRoomIncidentState(request.roomId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:get-incident-timeline')
  getRoomIncidentTimeline(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:get-incident-timeline']>[0],
    @WsAck() ack: SocketAck<RoomIncidentTimelineState>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getRoomIncidentTimeline(request, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:get-snapshot-history')
  getRoomSnapshotHistory(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:get-snapshot-history']>[0],
    @WsAck() ack: SocketAck<RoomSnapshotHistoryState>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getRoomSnapshotHistory(request, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:run-recovery-action')
  runRoomRecoveryAction(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:run-recovery-action']>[0],
    @WsAck() ack: SocketAck<RoomRecoveryActionResult>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const result = await this.rooms.runRoomRecoveryAction(request, this.requireParticipant(socket));
      await this.emitRoomEvent(result.room.id, 'room:updated', result.room);
      return result;
    });
  }

  @SubscribeMessage('room:update-media-profile')
  updateRoomMediaProfile(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: UpdateRoomMediaProfileRequest,
    @WsAck() ack: SocketAck<Room>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.updateRoomMediaProfile(request, this.requireParticipant(socket));
      await this.emitRoomEvent(room.id, 'room:updated', room);
      return room;
    });
  }

  @SubscribeMessage('transport:get-quality')
  getTransportQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['transport:get-quality']>[0],
    @WsAck() ack: SocketAck<Parameters<ServerToClientEvents['transport:quality-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getTransportQualityState(request.transportId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('consumer:close')
  closeConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.closeConsumer(request.consumerId, this.requireParticipant(socket));
      socket.emit('consumer:closed', request.consumerId);
    });
  }

  @SubscribeMessage('permission:update')
  updatePermission(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['permission:update']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const permissions = await this.rooms.updatePermissions(request.roomId, this.requireParticipant(socket), request.participantId, request.permissions);
      await this.emitRoomEvent(request.roomId, 'permissions:updated', request.participantId, permissions);
    });
  }

  @SubscribeMessage('participant:kick')
  kick(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:kick']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.kick(request.roomId, this.requireParticipant(socket), request.participantId, request.reason);
      await this.emitRoomEvent(request.roomId, 'participant:kicked', request.reason);
      await this.emitRoomEvent(request.roomId, 'participant:left', request.participantId);
    });
  }

  @SubscribeMessage('participant:ban')
  ban(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:ban']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.ban(request.roomId, this.requireParticipant(socket), request.participantId, request.reason);
      await this.emitRoomEvent(request.roomId, 'participant:banned', request.reason);
    });
  }

  @SubscribeMessage('participant:unban')
  unban(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:unban']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.unban(request.roomId, this.requireParticipant(socket), request.participantId));
  }

  @SubscribeMessage('participant:mute')
  mute(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:mute']>[0], @WsAck() ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.mute(request.roomId, this.requireParticipant(socket), request.participantId, request.force);
      await this.emitRoomEvent(request.roomId, 'participant:updated', request.participantId, { audioEnabled: false });
    });
  }

  @SubscribeMessage('class:mute-all-students')
  muteAllStudents(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['class:mute-all-students']>[0],
    @WsAck() ack: SocketAck<ClassStudentMediaModerationResponse>
  ): Promise<void> {
    return this.moderateClassStudentMedia(socket, request, 'mute-mic', ack);
  }

  @SubscribeMessage('class:stop-all-cameras')
  stopAllStudentCameras(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['class:stop-all-cameras']>[0],
    @WsAck() ack: SocketAck<ClassStudentMediaModerationResponse>
  ): Promise<void> {
    return this.moderateClassStudentMedia(socket, request, 'stop-camera', ack);
  }

  @SubscribeMessage('class:allow-speak')
  allowStudentToSpeak(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['class:allow-speak']>[0],
    @WsAck() ack: SocketAck<ClassStudentSpeakEvent>
  ): Promise<void> {
    return this.setStudentSpeakingPermission(socket, request, true, ack);
  }

  @SubscribeMessage('class:revoke-speak')
  revokeStudentSpeak(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['class:revoke-speak']>[0],
    @WsAck() ack: SocketAck<ClassStudentSpeakEvent>
  ): Promise<void> {
    return this.setStudentSpeakingPermission(socket, request, false, ack);
  }

  @SubscribeMessage('class:lower-hand')
  lowerStudentHand(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['class:lower-hand']>[0],
    @WsAck() ack: SocketAck<ParticipantPatch>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const patch = await this.rooms.lowerStudentHand(request.roomId, this.requireParticipant(socket), request.participantId);
      await this.emitRoomEvent(request.roomId, 'participant:updated', request.participantId, patch);
      return patch;
    });
  }

  @SubscribeMessage('whiteboard:grant-control')
  grantWhiteboardControl(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['whiteboard:grant-control']>[0],
    @WsAck() ack: SocketAck<WhiteboardControlEvent>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const delivery = await this.rooms.grantWhiteboardControl(
        request.roomId,
        this.requireParticipant(socket),
        request.participantId,
        request.permissionLevel,
        request.pageId
      );
      if (delivery.revoked) {
        await this.emitTargetedRoomEvent(
          request.roomId,
          delivery.revoked.targets,
          'whiteboard:control-revoked',
          delivery.revoked.event
        );
      }
      await this.emitTargetedRoomEvent(request.roomId, delivery.targets, 'whiteboard:control-granted', delivery.event);
      return delivery.event;
    });
  }

  @SubscribeMessage('whiteboard:revoke-control')
  revokeWhiteboardControl(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['whiteboard:revoke-control']>[0],
    @WsAck() ack: SocketAck<WhiteboardControlEvent>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const delivery = await this.rooms.revokeWhiteboardControl(request.roomId, this.requireParticipant(socket), request.participantId);
      await this.emitTargetedRoomEvent(request.roomId, delivery.targets, 'whiteboard:control-revoked', delivery.event);
      return delivery.event;
    });
  }

  @SubscribeMessage('whiteboard:command')
  sendWhiteboardCommand(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['whiteboard:command']>[0],
    @WsAck() ack: SocketAck<WhiteboardCommandEvent>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const delivery = await this.rooms.sendWhiteboardCommand(request.roomId, this.requireParticipant(socket), request.command);
      await this.emitTargetedRoomEvent(request.roomId, delivery.targets, 'whiteboard:command', delivery.event);
      return delivery.event;
    });
  }

  @SubscribeMessage('whiteboard:cursor')
  sendWhiteboardCursor(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['whiteboard:cursor']>[0],
    @WsAck() ack: SocketAck<WhiteboardCursorEvent>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const delivery = await this.rooms.sendWhiteboardCursor(request.roomId, this.requireParticipant(socket), request.cursor);
      await this.emitTargetedRoomEvent(request.roomId, delivery.targets, 'whiteboard:cursor', delivery.event);
      return delivery.event;
    });
  }

  @SubscribeMessage('student:mute-mic')
  muteStudentMicrophone(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['student:mute-mic']>[0],
    @WsAck() ack: SocketAck<StudentMediaModerationEvent>
  ): Promise<void> {
    return this.moderateStudentMedia(socket, request, 'mute-mic', ack);
  }

  @SubscribeMessage('student:unmute-mic')
  unmuteStudentMicrophone(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['student:unmute-mic']>[0],
    @WsAck() ack: SocketAck<StudentMediaModerationEvent>
  ): Promise<void> {
    return this.moderateStudentMedia(socket, request, 'unmute-mic', ack);
  }

  @SubscribeMessage('student:stop-camera')
  stopStudentCamera(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['student:stop-camera']>[0],
    @WsAck() ack: SocketAck<StudentMediaModerationEvent>
  ): Promise<void> {
    return this.moderateStudentMedia(socket, request, 'stop-camera', ack);
  }

  @SubscribeMessage('student:restore-camera')
  restoreStudentCamera(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['student:restore-camera']>[0],
    @WsAck() ack: SocketAck<StudentMediaModerationEvent>
  ): Promise<void> {
    return this.moderateStudentMedia(socket, request, 'restore-camera', ack);
  }

  @SubscribeMessage('screen:start')
  startScreen(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateProducerRequest, @WsAck() ack: SocketAck<Producer>): Promise<void> {
    return this.createProducer(socket, { ...request, kind: 'screen' }, ack);
  }

  @SubscribeMessage('screen:stop')
  stopScreen(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, @WsAck() ack: SocketAck<void>): Promise<void> {
    return this.closeProducer(socket, request, ack);
  }

  @SubscribeMessage('chat:send')
  sendChat(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['chat:send']>[0], @WsAck() ack: SocketAck<ChatMessage>): Promise<void> {
    return socketAck(ack, async () => {
      const delivery = await this.rooms.sendChat(request, this.requireParticipant(socket));
      if (delivery.broadcastRoomId) {
        await this.emitRoomEvent(delivery.broadcastRoomId, 'chat:message', delivery.message);
      } else {
        await this.emitTargetedRoomEvent(
          request.roomId,
          delivery.targets ?? this.socketIdsToDeliveryTargets(request.roomId, delivery.targetSocketIds),
          'chat:message',
          delivery.message
        );
      }
      return delivery.message;
    });
  }

  @SubscribeMessage('chat:mark-read')
  markChatRead(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['chat:mark-read']>[0], @WsAck() ack: SocketAck<ChatReadState>): Promise<void> {
    return socketAck(ack, async () => {
      const delivery = await this.rooms.markChatRead(request, this.requireUser(socket), socket.data.participantId);
      await this.emitTargetedRoomEvent(
        request.roomId,
        delivery.targets ?? this.socketIdsToDeliveryTargets(request.roomId, delivery.targetSocketIds),
        'chat:read',
        delivery.receipt
      );
      return delivery.state;
    });
  }

  @SubscribeMessage('hand:raise')
  raiseHand(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; raised: boolean }, @WsAck() ack: SocketAck<ParticipantPatch>): Promise<void> {
    return socketAck(ack, async () => {
      const participantId = this.requireParticipant(socket);
      const patch = await this.rooms.raiseHand(request.roomId, participantId, request.raised);
      await this.emitRoomEvent(request.roomId, 'participant:updated', participantId, patch);
      return patch;
    });
  }

  @SubscribeMessage('class:activity')
  updateClassActivity(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['class:activity']>[0],
    @WsAck() ack: SocketAck<ParticipantPatch>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const participantId = this.requireParticipant(socket);
      const patch = await this.rooms.updateClassSessionParticipantActivity(request.roomId, participantId, socket.id, this.requireUser(socket), request);
      await this.emitRoomEvent(request.roomId, 'participant:updated', participantId, patch);
      return patch;
    });
  }

  private toggleLock(socket: SfuSocket, roomId: string, locked: boolean, ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.setLocked(roomId, this.requireParticipant(socket), locked);
      await this.emitRoomEvent(roomId, 'room:updated', room);
    });
  }

  private setProducerStatus(socket: SfuSocket, producerId: string, status: 'live' | 'paused', ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.setProducerStatus(producerId, this.requireParticipant(socket), status);
      await this.emitRoomEvent(producer.roomId, 'producer:updated', producer);
    });
  }

  private setConsumerStatus(socket: SfuSocket, consumerId: string, status: 'live' | 'paused', ack: SocketAck<void>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerStatus(consumerId, this.requireParticipant(socket), status);
      socket.emit('consumer:updated', consumer);
    });
  }

  private moderateStudentMedia(
    socket: SfuSocket,
    request: Parameters<ClientToServerEvents['student:mute-mic']>[0],
    action: StudentMediaModerationAction,
    ack: SocketAck<StudentMediaModerationEvent>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const result = await this.rooms.moderateStudentMedia(request.roomId, this.requireParticipant(socket), request.participantId, action);
      await this.emitStudentMediaModerationResult(request.roomId, result);
      return result.event;
    });
  }

  private moderateClassStudentMedia(
    socket: SfuSocket,
    request: Parameters<ClientToServerEvents['class:mute-all-students']>[0],
    action: Extract<StudentMediaModerationAction, 'mute-mic' | 'stop-camera'>,
    ack: SocketAck<ClassStudentMediaModerationResponse>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const results = await this.rooms.moderateAllStudentMedia(request.roomId, this.requireParticipant(socket), action);
      for (const result of results) {
        await this.emitStudentMediaModerationResult(request.roomId, result);
      }
      return {
        roomId: request.roomId,
        action,
        moderatedCount: results.length,
        events: results.map((result) => result.event)
      };
    });
  }

  private setStudentSpeakingPermission(
    socket: SfuSocket,
    request: Parameters<ClientToServerEvents['class:allow-speak']>[0],
    allowedToSpeak: boolean,
    ack: SocketAck<ClassStudentSpeakEvent>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const result = await this.rooms.setStudentSpeakingPermission(request.roomId, this.requireParticipant(socket), request.participantId, allowedToSpeak);
      await this.emitStudentMediaModerationResult(request.roomId, result.moderation);
      await this.emitRoomEvent(request.roomId, 'participant:updated', request.participantId, result.participantPatch);
      return result.event;
    });
  }

  private async emitStudentMediaModerationResult(roomId: string, result: StudentMediaModerationResult): Promise<void> {
    if (result.producer) {
      await this.emitRoomEvent(roomId, 'producer:updated', result.producer);
    }
    const participantPatch =
      result.event.action === 'mute-mic' ? { audioEnabled: false } : result.event.action === 'stop-camera' ? { videoEnabled: false } : null;
    if (participantPatch) {
      await this.emitRoomEvent(roomId, 'participant:updated', result.event.participantId, participantPatch);
    }
    await this.emitRoomEvent(roomId, 'permissions:updated', result.event.participantId, result.permissions);
    await this.emitTargetedRoomEvent(
      roomId,
      result.targets ?? this.socketIdsToDeliveryTargets(roomId, result.targetSocketIds ?? (result.targetSocketId ? [result.targetSocketId] : undefined)),
      'student:media-moderated',
      result.event
    );
  }

  private async emitProducerDynacastEvent(event: ProducerDynacastEvent): Promise<void> {
    const eventName = producerDynacastEventName(event.type);
    try {
      const sockets = await this.server.in(event.roomId).fetchSockets();
      const target = await this.rooms.producerDynacastSignalTarget(event, sockets.length);
      if (!target) {
        this.rooms.recordDynacastSignalFailure(event, 'publisher_socket_missing');
        return;
      }
      this.server.to(target.socketId).emit(eventName, event);
      this.rooms.recordDynacastSignalDelivery(event, target.suppressedSubscribers);
    } catch (error) {
      this.rooms.recordDynacastSignalFailure(event, error instanceof Error ? error.name || 'emit_failed' : 'emit_failed');
    }
  }

  private extractToken(socket: SfuSocket): string | null {
    const authToken = socket.handshake.auth?.token;
    if (typeof authToken === 'string') {
      return authToken;
    }
    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return null;
  }

  private requireUser(socket: SfuSocket): SocketUser {
    if (!socket.data.user) {
      throw new Error('Unauthenticated socket');
    }
    return socket.data.user;
  }

  private requireParticipant(socket: SfuSocket): string {
    if (!socket.data.participantId) {
      throw new Error('Socket has not joined a room');
    }
    return socket.data.participantId;
  }

  private async emitRoomEvent(roomId: string, event: keyof ServerToClientEvents, ...payload: unknown[]): Promise<void> {
    (this.server.to(roomId) as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit(event, ...payload);
    await this.signals.publish(roomId, event, ...payload);
  }

  private async emitRoomLeaveResult(
    roomId: string,
    participantId: string,
    result: Awaited<ReturnType<RoomsService['leaveRoomForSocket']>>
  ): Promise<void> {
    if (!result.left) {
      return;
    }
    if (result.reconnecting) {
      await this.emitRoomEvent(roomId, 'participant:updated', participantId, result.participantPatch ?? {});
      if (result.room) {
        await this.emitRoomEvent(roomId, 'room:updated', result.room);
      }
      return;
    }
    await this.emitRoomEvent(roomId, 'participant:left', participantId);
    if (result.closed) {
      await this.emitRoomEvent(roomId, 'room:closed', roomId);
    }
  }

  private async emitTargetedRoomEvent(
    roomId: string,
    targets: readonly SocketDeliveryTarget[] | undefined,
    event: keyof ServerToClientEvents,
    ...payload: unknown[]
  ): Promise<void> {
    const signalTarget = this.deliveryTargetsToSignalTarget(targets);
    if (!signalTarget) {
      return;
    }
    this.emitLocalTargetedEvent(roomId, signalTarget, event, ...payload);
    await this.signals.publishTargeted(roomId, signalTarget, event, ...payload);
  }

  private emitTargetedSignal(signal: RoomSignalEnvelope): void {
    this.emitLocalTargetedEvent(signal.roomId, signal.target, signal.event, ...signal.payload);
  }

  private emitLocalTargetedEvent(
    roomId: string,
    target: RoomSignalTarget | undefined,
    event: keyof ServerToClientEvents,
    ...payload: unknown[]
  ): void {
    for (const socketId of this.localTargetSocketIds(roomId, target)) {
      this.emitParticipantEvent(socketId, event, ...payload);
    }
  }

  private deliveryTargetsToSignalTarget(targets: readonly SocketDeliveryTarget[] | undefined): RoomSignalTarget | undefined {
    if (!targets?.length) {
      return undefined;
    }
    const socketIds = uniqueNonEmpty(targets.map((target) => target.socketId));
    const participantIds = uniqueNonEmpty(targets.map((target) => target.participantId));
    const userIds = uniqueNonEmpty(targets.map((target) => target.userId));
    const nodeIds = uniqueNonEmpty(targets.map((target) => target.nodeId));
    if (!socketIds.length && !participantIds.length && !userIds.length) {
      return undefined;
    }
    return {
      ...(socketIds.length ? { socketIds } : {}),
      ...(participantIds.length ? { participantIds } : {}),
      ...(userIds.length ? { userIds } : {}),
      ...(nodeIds.length ? { nodeIds } : {})
    };
  }

  private socketIdsToDeliveryTargets(roomId: string, socketIds: readonly string[] | undefined): SocketDeliveryTarget[] {
    return uniqueNonEmpty(socketIds ?? []).map((socketId) => ({
      roomId,
      participantId: '',
      socketId
    }));
  }

  private localTargetSocketIds(roomId: string, target: RoomSignalTarget | undefined): string[] {
    if (!target) {
      return [];
    }
    const socketIdSet = new Set(uniqueNonEmpty(target.socketIds ?? []));
    const participantIdSet = new Set(uniqueNonEmpty(target.participantIds ?? []));
    const userIdSet = new Set(uniqueNonEmpty(target.userIds ?? []));
    const sockets = this.server.sockets.sockets as Map<string, SfuSocket> | undefined;
    if (!sockets?.size) {
      return [...socketIdSet];
    }

    const socketIds = new Set<string>();
    for (const socketId of socketIdSet) {
      if (sockets.has(socketId)) {
        socketIds.add(socketId);
      }
    }
    if (!participantIdSet.size && !userIdSet.size) {
      return [...socketIds];
    }
    for (const [socketId, socket] of sockets) {
      const data = socket.data ?? {};
      if (data.roomId && data.roomId !== roomId && !socketIdSet.has(socketId)) {
        continue;
      }
      if ((data.participantId && participantIdSet.has(data.participantId)) || (data.user?.id && userIdSet.has(data.user.id))) {
        socketIds.add(socketId);
      }
    }
    return [...socketIds];
  }

  private classSessionLifecycleRoomId(sessionId: string): string {
    return `class-session:${this.normalizeClassSessionId(sessionId)}:lifecycle`;
  }

  private normalizeClassSessionId(sessionId: string | undefined): string {
    const normalized = sessionId?.trim();
    if (!normalized) {
      throw new BadRequestException('Class session id is required.');
    }
    if (normalized.length > 200 || /[\s\x00-\x1F\x7F]/.test(normalized)) {
      throw new BadRequestException('Invalid class session id.');
    }
    return normalized;
  }

  private normalizeOptionalClassSessionBatchId(batchId: string | undefined): string | undefined {
    const normalized = batchId?.trim();
    if (!normalized) {
      return undefined;
    }
    if (normalized.length > 120 || /[\s\x00-\x1F\x7F]/.test(normalized)) {
      throw new BadRequestException('Invalid batch id.');
    }
    return normalized;
  }

  private async joinParticipantSocket(roomId: string, socketId: string | undefined): Promise<void> {
    if (!socketId) {
      return;
    }
    const target = (this.server.sockets.sockets as Map<string, Socket<ClientToServerEvents, ServerToClientEvents>> | undefined)?.get(socketId);
    if (target) {
      await target.join(roomId);
    }
  }

  private emitParticipantEvent(socketId: string | undefined, event: keyof ServerToClientEvents, ...payload: unknown[]): void {
    if (!socketId) {
      return;
    }
    (this.server.to(socketId) as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit(event, ...payload);
  }

  private isConnectionThrottled(socket: SfuSocket): boolean {
    const address = socket.handshake.address ?? 'unknown';
    const now = Date.now();
    const current = this.connectionAttempts.get(address);
    if (!current || current.resetAt <= now) {
      this.connectionAttempts.set(address, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    current.count += 1;
    return current.count > 60;
  }
}
