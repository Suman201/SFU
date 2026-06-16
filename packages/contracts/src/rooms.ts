import type { Consumer } from './consumers.js';
import type { Participant } from './participants.js';
import type { Producer } from './producers.js';
import type { RoomOwnerInfo, RoomOwnerRedirect } from './cluster.js';

export type RoomVisibility = 'public' | 'private' | 'invite-only';

export interface RoomSettings {
  locked: boolean;
  waitingRoomEnabled: boolean;
  joinApprovalRequired: boolean;
  visibility: RoomVisibility;
  maxParticipants: number;
  recordingEnabled: boolean;
  chatEnabled: boolean;
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  settings: RoomSettings;
  mediaState?: RoomMediaState;
  owner?: RoomOwnerInfo;
  participants: Participant[];
  producers: Producer[];
  consumers: Consumer[];
  createdAt: string;
  closedAt?: string;
}

export interface RoomMediaState {
  status: 'active' | 'failed';
  failedAt?: string;
  failureReason?: string;
  failureMessage?: string;
  workerId?: string;
}

export interface RoomFailureEvent {
  roomId: string;
  reason: 'worker_crashed' | 'worker_drained_forced' | 'worker_unhealthy' | 'worker_overloaded';
  message: string;
  failedAt: string;
  recoverable: boolean;
  affectedParticipants?: string[];
  affectedTransports?: string[];
  affectedProducers?: string[];
  affectedConsumers?: string[];
  workerId?: string;
}

export interface CreateRoomRequest {
  name: string;
  visibility?: RoomVisibility;
  waitingRoomEnabled?: boolean;
  joinApprovalRequired?: boolean;
  maxParticipants?: number;
}

export interface JoinRoomRequest {
  roomId: string;
  displayName: string;
  inviteCode?: string;
  asViewer?: boolean;
}

export interface JoinRoomResponse {
  room: Room;
  participantId: string;
  admitted: boolean;
  redirect?: RoomOwnerRedirect;
}
