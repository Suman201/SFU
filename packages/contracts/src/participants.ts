import type { Permissions } from './permissions.js';
import type { Role } from './roles.js';
import type { ConsumerLayerState } from './consumers.js';

export interface Participant {
  id: string;
  userId?: string;
  displayName: string;
  socketId: string;
  connected?: boolean;
  role: Role;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  handRaisedAt?: string;
  allowedToSpeak?: boolean;
  allowedToSpeakAt?: string;
  allowedToSpeakBy?: string;
  admitted: boolean;
  permissions: Permissions;
  consumerLayers?: ConsumerLayerState[];
  joinedAt: string;
  lastSeenAt: string;
  lastActiveAt?: string;
  inactiveSince?: string;
  inactive?: boolean;
}

export interface ParticipantPatch {
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  screenSharing?: boolean;
  handRaised?: boolean;
  handRaisedAt?: string | null;
  allowedToSpeak?: boolean;
  allowedToSpeakAt?: string | null;
  allowedToSpeakBy?: string | null;
  permissions?: Partial<Permissions>;
  role?: Role;
  connected?: boolean;
  lastSeenAt?: string;
  lastActiveAt?: string;
  inactiveSince?: string | null;
  inactive?: boolean;
}
