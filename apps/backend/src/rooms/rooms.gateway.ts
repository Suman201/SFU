import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import type {
  Ack,
  ChatMessage,
  ClientToServerEvents,
  Consumer,
  ConsumerLayerState,
  CreateConsumerRequest,
  CreateProducerRequest,
  CreateRoomRequest,
  JoinRoomRequest,
  JoinRoomResponse,
  Producer,
  ProducerDynacastEvent,
  ProducerLayerState,
  Room,
  RoomFailureEvent,
  RoomOwnerLookupResponse,
  ServerToClientEvents,
  SetConsumerPreferredLayersRequest,
  SetConsumerPreferredSvcLayersRequest,
  TransportOptions
} from '@native-sfu/contracts';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { socketAck } from '../common/utils/ack';
import { RoomSignalService } from './room-signal.service';
import { RoomsService, SocketUser } from './rooms.service';

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
    private readonly signals: RoomSignalService
  ) {
    this.signals.onSignal((signal) => {
      (this.server.to(signal.roomId) as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit(signal.event, ...signal.payload);
    });
    this.rooms.onConsumerLayerEvent((event) => {
      const eventName = event.currentSvcLayers || event.targetSvcLayers || event.preferredSvcLayers ? svcLayerEventName(event.type) : layerEventName(event.type);
      this.server.to(event.roomId).emit(eventName, event);
    });
    this.rooms.onProducerDynacastEvent((event) => {
      void this.emitProducerDynacastEvent(event);
    });
    this.rooms.onConsumerScoreUpdated((state) => {
      this.server.to(state.roomId).emit('consumer:score-updated', state);
      this.server.to(state.roomId).emit('network:quality', {
        participantId: state.participantId,
        score: Math.max(1, Math.min(5, Math.ceil(state.score.score / 20))),
        packetLoss: state.network.packetLoss,
        rtt: state.network.rtt,
        jitter: state.network.jitter
      });
    });
    this.rooms.onProducerScoreUpdated((state) => {
      this.server.to(state.roomId).emit('producer:score-updated', state);
    });
    this.rooms.onTransportQualityUpdated((state) => {
      this.server.to(state.roomId).emit('transport:quality-updated', state);
    });
    this.rooms.onRoomQualityUpdated((state) => {
      this.server.to(state.roomId).emit('room:quality-updated', state);
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
      if (!result.left) {
        return;
      }
      await this.emitRoomEvent(socket.data.roomId, 'participant:left', socket.data.participantId);
      if (result.closed) {
        await this.emitRoomEvent(socket.data.roomId, 'room:closed', socket.data.roomId);
      }
    }
  }

  @SubscribeMessage('room:create')
  createRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateRoomRequest, ack: Ack<Room>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.createRoom(this.requireUser(socket), socket.id, request);
      socket.data.roomId = room.id;
      socket.data.participantId = room.hostId;
      await socket.join(room.id);
      return room;
    });
  }

  @SubscribeMessage('room:get-owner')
  getRoomOwner(@MessageBody() request: { roomId: string }, ack: Ack<RoomOwnerLookupResponse>): Promise<void> {
    return socketAck(ack, () => this.rooms.lookupRoomOwner(request.roomId));
  }

  @SubscribeMessage('room:join')
  joinRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: JoinRoomRequest, ack: Ack<JoinRoomResponse>): Promise<void> {
    return socketAck(ack, async () => {
      const response = await this.rooms.joinRoom(this.requireUser(socket), socket.id, request);
      socket.data.roomId = request.roomId;
      socket.data.participantId = response.participantId;
      await socket.join(request.roomId);
      if (response.admitted) {
        const participant = response.room.participants.find((item) => item.id === response.participantId);
        if (participant) {
          await this.emitRoomEvent(request.roomId, 'participant:joined', participant);
        }
        await this.emitRoomEvent(request.roomId, 'room:updated', response.room);
      } else {
        await this.emitRoomEvent(request.roomId, 'waiting-room:pending', response.room.participants.find((item) => item.id === response.participantId)!);
      }
      return response;
    });
  }

  @SubscribeMessage('room:leave')
  leaveRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const participantId = this.requireParticipant(socket);
      await this.rooms.leaveRoom(request.roomId, participantId);
      await socket.leave(request.roomId);
      await this.emitRoomEvent(request.roomId, 'participant:left', participantId);
    });
  }

  @SubscribeMessage('room:close')
  closeRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.closeRoom(request.roomId, this.requireParticipant(socket));
      await this.emitRoomEvent(request.roomId, 'room:closed', request.roomId);
    });
  }

  @SubscribeMessage('room:lock')
  lockRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, ack: Ack<void>): Promise<void> {
    return this.toggleLock(socket, request.roomId, true, ack);
  }

  @SubscribeMessage('room:unlock')
  unlockRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, ack: Ack<void>): Promise<void> {
    return this.toggleLock(socket, request.roomId, false, ack);
  }

  @SubscribeMessage('room:admit')
  admit(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; participantId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.admit(request.roomId, this.requireParticipant(socket), request.participantId);
      await this.emitRoomEvent(request.roomId, 'room:updated', room);
    });
  }

  @SubscribeMessage('room:reject')
  reject(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; participantId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.reject(request.roomId, this.requireParticipant(socket), request.participantId);
      await this.emitRoomEvent(request.roomId, 'participant:left', request.participantId);
    });
  }

  @SubscribeMessage('transport:create')
  createTransport(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, ack: Ack<TransportOptions>): Promise<void> {
    return socketAck(ack, () => this.rooms.createTransport(request.roomId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('transport:ice-candidate')
  iceCandidate(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['transport:ice-candidate']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.addIceCandidate(request.transportId, this.requireParticipant(socket), request.candidate));
  }

  @SubscribeMessage('transport:ice-parameters')
  iceParameters(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['transport:ice-parameters']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.setRemoteIceParameters(request.transportId, this.requireParticipant(socket), request.iceParameters));
  }

  @SubscribeMessage('transport:ice-restart')
  iceRestart(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { transportId: string }, ack: Ack<TransportOptions>): Promise<void> {
    return socketAck(ack, () => this.rooms.restartIce(request.transportId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('transport:dtls-parameters')
  dtlsParameters(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['transport:dtls-parameters']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.setRemoteDtlsParameters(request.transportId, this.requireParticipant(socket), request.dtlsParameters));
  }

  @SubscribeMessage('producer:create')
  createProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateProducerRequest, ack: Ack<Producer>): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.createProducer(request, this.requireParticipant(socket));
      await this.emitRoomEvent(request.roomId, 'producer:created', producer);
      return producer;
    });
  }

  @SubscribeMessage('producer:pause')
  pauseProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, ack: Ack<void>): Promise<void> {
    return this.setProducerStatus(socket, request.producerId, 'paused', ack);
  }

  @SubscribeMessage('producer:resume')
  resumeProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, ack: Ack<void>): Promise<void> {
    return this.setProducerStatus(socket, request.producerId, 'live', ack);
  }

  @SubscribeMessage('producer:close')
  closeProducer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.closeProducer(request.producerId, this.requireParticipant(socket));
      await this.emitRoomEvent(producer.roomId, 'producer:closed', request.producerId);
    });
  }

  @SubscribeMessage('producer:set-priority')
  setProducerPriority(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['producer:set-priority']>[0],
    ack: Ack<Producer>
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
    ack: Ack<void>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.recordProducerDynacastControlFailure(request, this.requireParticipant(socket)));
  }

  @SubscribeMessage('consumer:create')
  createConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateConsumerRequest, ack: Ack<Consumer>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.createConsumer(request, this.requireParticipant(socket));
      socket.emit('consumer:created', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:pause')
  pauseConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, ack: Ack<void>): Promise<void> {
    return this.setConsumerStatus(socket, request.consumerId, 'paused', ack);
  }

  @SubscribeMessage('consumer:resume')
  resumeConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, ack: Ack<void>): Promise<void> {
    return this.setConsumerStatus(socket, request.consumerId, 'live', ack);
  }

  @SubscribeMessage('consumer:set-preferred-layers')
  setConsumerPreferredLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: SetConsumerPreferredLayersRequest, ack: Ack<Consumer>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerPreferredLayers(request.consumerId, this.requireParticipant(socket), request.preferredLayers);
      socket.emit('consumer:updated', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:set-preferred-svc-layers')
  setConsumerPreferredSvcLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: SetConsumerPreferredSvcLayersRequest, ack: Ack<Consumer>): Promise<void> {
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
    ack: Ack<Consumer>
  ): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerPriority(request.consumerId, this.requireParticipant(socket), request.priority);
      socket.emit('consumer:updated', consumer);
      return consumer;
    });
  }

  @SubscribeMessage('consumer:get-layers')
  getConsumerLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, ack: Ack<ConsumerLayerState>): Promise<void> {
    return socketAck(ack, () => this.rooms.getConsumerLayerState(request.consumerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('producer:get-layers')
  getProducerLayers(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, ack: Ack<ProducerLayerState>): Promise<void> {
    return socketAck(ack, () => this.rooms.getProducerLayerState(request.producerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('consumer:get-quality')
  getConsumerQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['consumer:get-quality']>[0],
    ack: Ack<Parameters<ServerToClientEvents['consumer:score-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getConsumerQualityState(request.consumerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('producer:get-quality')
  getProducerQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['producer:get-quality']>[0],
    ack: Ack<Parameters<ServerToClientEvents['producer:score-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getProducerQualityState(request.producerId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('room:get-quality')
  getRoomQuality(
    @ConnectedSocket() socket: SfuSocket,
    @MessageBody() request: Parameters<ClientToServerEvents['room:get-quality']>[0],
    ack: Ack<Parameters<ServerToClientEvents['room:quality-updated']>[0]>
  ): Promise<void> {
    return socketAck(ack, () => this.rooms.getRoomQualityState(request.roomId, this.requireParticipant(socket)));
  }

  @SubscribeMessage('consumer:close')
  closeConsumer(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { consumerId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.closeConsumer(request.consumerId, this.requireParticipant(socket));
      socket.emit('consumer:closed', request.consumerId);
    });
  }

  @SubscribeMessage('permission:update')
  updatePermission(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['permission:update']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const permissions = await this.rooms.updatePermissions(request.roomId, this.requireParticipant(socket), request.participantId, request.permissions);
      await this.emitRoomEvent(request.roomId, 'permissions:updated', request.participantId, permissions);
    });
  }

  @SubscribeMessage('participant:kick')
  kick(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:kick']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.kick(request.roomId, this.requireParticipant(socket), request.participantId, request.reason);
      await this.emitRoomEvent(request.roomId, 'participant:kicked', request.reason);
      await this.emitRoomEvent(request.roomId, 'participant:left', request.participantId);
    });
  }

  @SubscribeMessage('participant:ban')
  ban(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:ban']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.ban(request.roomId, this.requireParticipant(socket), request.participantId, request.reason);
      await this.emitRoomEvent(request.roomId, 'participant:banned', request.reason);
    });
  }

  @SubscribeMessage('participant:unban')
  unban(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:unban']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, () => this.rooms.unban(request.roomId, this.requireParticipant(socket), request.participantId));
  }

  @SubscribeMessage('participant:mute')
  mute(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:mute']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.mute(request.roomId, this.requireParticipant(socket), request.participantId, request.force);
      await this.emitRoomEvent(request.roomId, 'participant:updated', request.participantId, { audioEnabled: false });
    });
  }

  @SubscribeMessage('screen:start')
  startScreen(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: CreateProducerRequest, ack: Ack<Producer>): Promise<void> {
    return this.createProducer(socket, { ...request, kind: 'screen' }, ack);
  }

  @SubscribeMessage('screen:stop')
  stopScreen(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { producerId: string }, ack: Ack<void>): Promise<void> {
    return this.closeProducer(socket, request, ack);
  }

  @SubscribeMessage('chat:send')
  sendChat(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['chat:send']>[0], ack: Ack<ChatMessage>): Promise<void> {
    return socketAck(ack, async () => {
      const message = await this.rooms.sendChat(request, this.requireParticipant(socket));
      await this.emitRoomEvent(request.roomId, 'chat:message', message);
      return message;
    });
  }

  @SubscribeMessage('hand:raise')
  raiseHand(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; raised: boolean }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.raiseHand(request.roomId, this.requireParticipant(socket), request.raised);
      await this.emitRoomEvent(request.roomId, 'participant:updated', this.requireParticipant(socket), { handRaised: request.raised });
    });
  }

  private toggleLock(socket: SfuSocket, roomId: string, locked: boolean, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.setLocked(roomId, this.requireParticipant(socket), locked);
      await this.emitRoomEvent(roomId, 'room:updated', room);
    });
  }

  private setProducerStatus(socket: SfuSocket, producerId: string, status: 'live' | 'paused', ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.setProducerStatus(producerId, this.requireParticipant(socket), status);
      await this.emitRoomEvent(producer.roomId, 'producer:updated', producer);
    });
  }

  private setConsumerStatus(socket: SfuSocket, consumerId: string, status: 'live' | 'paused', ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerStatus(consumerId, this.requireParticipant(socket), status);
      socket.emit('consumer:updated', consumer);
    });
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
