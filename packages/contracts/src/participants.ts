import type { Permissions } from './permissions.js';
import type { Role } from './roles.js';

export interface Participant {
  id: string;
  userId?: string;
  displayName: string;
  socketId: string;
  role: Role;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  admitted: boolean;
  permissions: Permissions;
  joinedAt: string;
  lastSeenAt: string;
}

export interface ParticipantPatch {
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  screenSharing?: boolean;
  handRaised?: boolean;
  permissions?: Partial<Permissions>;
  role?: Role;
}
