import { Logger, UseGuards } from '@nestjs/common';
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
  CreateConsumerRequest,
  CreateProducerRequest,
  CreateRoomRequest,
  JoinRoomRequest,
  JoinRoomResponse,
  Producer,
  Room,
  ServerToClientEvents,
  SetConsumerPreferredLayersRequest,
  TransportOptions
} from '@native-sfu/contracts';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { socketAck } from '../common/utils/ack';
import { RoomsService, SocketUser } from './rooms.service';

type SfuSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: {
    user?: SocketUser;
    participantId?: string;
    roomId?: string;
  };
};

@WebSocketGateway({
  namespace: '/sfu',
  cors: {
    origin: true,
    credentials: true
  }
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RoomsGateway.name);

  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;

  constructor(
    private readonly rooms: RoomsService,
    private readonly auth: AuthService
  ) {}

  async handleConnection(socket: SfuSocket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) {
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
      this.logger.warn(`Socket auth failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: SfuSocket): Promise<void> {
    if (socket.data.roomId && socket.data.participantId) {
      const result = await this.rooms.leaveRoom(socket.data.roomId, socket.data.participantId);
      socket.to(socket.data.roomId).emit('participant:left', socket.data.participantId);
      if (result.closed) {
        this.server.to(socket.data.roomId).emit('room:closed', socket.data.roomId);
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
          socket.to(request.roomId).emit('participant:joined', participant);
        }
        this.server.to(request.roomId).emit('room:updated', response.room);
      } else {
        this.server.to(request.roomId).emit('waiting-room:pending', response.room.participants.find((item) => item.id === response.participantId)!);
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
      socket.to(request.roomId).emit('participant:left', participantId);
    });
  }

  @SubscribeMessage('room:close')
  closeRoom(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.closeRoom(request.roomId, this.requireParticipant(socket));
      this.server.to(request.roomId).emit('room:closed', request.roomId);
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
      this.server.to(request.roomId).emit('room:updated', room);
    });
  }

  @SubscribeMessage('room:reject')
  reject(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; participantId: string }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.reject(request.roomId, this.requireParticipant(socket), request.participantId);
      this.server.to(request.roomId).emit('participant:left', request.participantId);
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
      this.server.to(request.roomId).emit('producer:created', producer);
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
      this.server.to(producer.roomId).emit('producer:closed', request.producerId);
    });
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
      this.server.to(request.roomId).emit('permissions:updated', request.participantId, permissions);
    });
  }

  @SubscribeMessage('participant:kick')
  kick(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:kick']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.kick(request.roomId, this.requireParticipant(socket), request.participantId, request.reason);
      this.server.to(request.roomId).emit('participant:kicked', request.reason);
      this.server.to(request.roomId).emit('participant:left', request.participantId);
    });
  }

  @SubscribeMessage('participant:ban')
  ban(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: Parameters<ClientToServerEvents['participant:ban']>[0], ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.ban(request.roomId, this.requireParticipant(socket), request.participantId, request.reason);
      this.server.to(request.roomId).emit('participant:banned', request.reason);
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
      this.server.to(request.roomId).emit('participant:updated', request.participantId, { audioEnabled: false });
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
      this.server.to(request.roomId).emit('chat:message', message);
      return message;
    });
  }

  @SubscribeMessage('hand:raise')
  raiseHand(@ConnectedSocket() socket: SfuSocket, @MessageBody() request: { roomId: string; raised: boolean }, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      await this.rooms.raiseHand(request.roomId, this.requireParticipant(socket), request.raised);
      this.server.to(request.roomId).emit('participant:updated', this.requireParticipant(socket), { handRaised: request.raised });
    });
  }

  private toggleLock(socket: SfuSocket, roomId: string, locked: boolean, ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const room = await this.rooms.setLocked(roomId, this.requireParticipant(socket), locked);
      this.server.to(roomId).emit('room:updated', room);
    });
  }

  private setProducerStatus(socket: SfuSocket, producerId: string, status: 'live' | 'paused', ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const producer = await this.rooms.setProducerStatus(producerId, this.requireParticipant(socket), status);
      this.server.to(producer.roomId).emit('producer:updated', producer);
    });
  }

  private setConsumerStatus(socket: SfuSocket, consumerId: string, status: 'live' | 'paused', ack: Ack<void>): Promise<void> {
    return socketAck(ack, async () => {
      const consumer = await this.rooms.setConsumerStatus(consumerId, this.requireParticipant(socket), status);
      socket.emit('consumer:updated', consumer);
    });
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
}
