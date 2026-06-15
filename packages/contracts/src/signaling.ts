import type { ChatMessage, SendChatMessageRequest } from './chat.js';
import type { Consumer, CreateConsumerRequest, SetConsumerPreferredLayersRequest } from './consumers.js';
import type { Participant, ParticipantPatch } from './participants.js';
import type { Permissions } from './permissions.js';
import type { CreateProducerRequest, Producer } from './producers.js';
import type { CreateRoomRequest, JoinRoomRequest, JoinRoomResponse, Room } from './rooms.js';
import type { DtlsParameters, IceCandidate, IceParameters, TransportOptions } from './transport.js';

export interface ClientToServerEvents {
  'room:create': (request: CreateRoomRequest, ack: Ack<Room>) => void;
  'room:join': (request: JoinRoomRequest, ack: Ack<JoinRoomResponse>) => void;
  'room:leave': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:close': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:lock': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:unlock': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:admit': (request: { roomId: string; participantId: string }, ack: Ack<void>) => void;
  'room:reject': (request: { roomId: string; participantId: string }, ack: Ack<void>) => void;
  'transport:create': (request: { roomId: string }, ack: Ack<TransportOptions>) => void;
  'transport:ice-parameters': (request: { transportId: string; iceParameters: IceParameters }, ack: Ack<void>) => void;
  'transport:ice-candidate': (request: { transportId: string; candidate: IceCandidate }, ack: Ack<void>) => void;
  'transport:ice-restart': (request: { transportId: string }, ack: Ack<TransportOptions>) => void;
  'transport:dtls-parameters': (request: { transportId: string; dtlsParameters: DtlsParameters }, ack: Ack<void>) => void;
  'producer:create': (request: CreateProducerRequest, ack: Ack<Producer>) => void;
  'producer:pause': (request: { producerId: string }, ack: Ack<void>) => void;
  'producer:resume': (request: { producerId: string }, ack: Ack<void>) => void;
  'producer:close': (request: { producerId: string }, ack: Ack<void>) => void;
  'consumer:create': (request: CreateConsumerRequest, ack: Ack<Consumer>) => void;
  'consumer:pause': (request: { consumerId: string }, ack: Ack<void>) => void;
  'consumer:resume': (request: { consumerId: string }, ack: Ack<void>) => void;
  'consumer:set-preferred-layers': (request: SetConsumerPreferredLayersRequest, ack: Ack<Consumer>) => void;
  'consumer:close': (request: { consumerId: string }, ack: Ack<void>) => void;
  'permission:update': (request: { roomId: string; participantId: string; permissions: Partial<Permissions> }, ack: Ack<void>) => void;
  'participant:kick': (request: { roomId: string; participantId: string; reason?: string }, ack: Ack<void>) => void;
  'participant:ban': (request: { roomId: string; participantId: string; reason?: string }, ack: Ack<void>) => void;
  'participant:unban': (request: { roomId: string; participantId: string }, ack: Ack<void>) => void;
  'participant:mute': (request: { roomId: string; participantId: string; force?: boolean }, ack: Ack<void>) => void;
  'screen:start': (request: CreateProducerRequest, ack: Ack<Producer>) => void;
  'screen:stop': (request: { producerId: string }, ack: Ack<void>) => void;
  'chat:send': (request: SendChatMessageRequest, ack: Ack<ChatMessage>) => void;
  'hand:raise': (request: { roomId: string; raised: boolean }, ack: Ack<void>) => void;
}

export interface ServerToClientEvents {
  'room:updated': (room: Room) => void;
  'room:closed': (roomId: string) => void;
  'participant:joined': (participant: Participant) => void;
  'participant:left': (participantId: string) => void;
  'participant:updated': (participantId: string, patch: ParticipantPatch) => void;
  'participant:kicked': (reason?: string) => void;
  'participant:banned': (reason?: string) => void;
  'permissions:updated': (participantId: string, permissions: Permissions) => void;
  'producer:created': (producer: Producer) => void;
  'producer:updated': (producer: Producer) => void;
  'producer:closed': (producerId: string) => void;
  'consumer:created': (consumer: Consumer) => void;
  'consumer:updated': (consumer: Consumer) => void;
  'consumer:closed': (consumerId: string) => void;
  'chat:message': (message: ChatMessage) => void;
  'network:quality': (quality: { participantId: string; score: number; packetLoss: number; rtt: number; jitter: number }) => void;
  'waiting-room:pending': (participant: Participant) => void;
}

export type Ack<T> = (response: AckResponse<T>) => void;

export type AckResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };
