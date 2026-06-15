import type { Consumer } from './consumers.js';
import type { Participant } from './participants.js';
import type { Producer } from './producers.js';

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
  participants: Participant[];
  producers: Producer[];
  consumers: Consumer[];
  createdAt: string;
  closedAt?: string;
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
}
