import type { IceCandidate, IceParameters } from '@native-sfu/contracts';

export type IceRole = 'controlling' | 'controlled';
export type IceAgentState = 'new' | 'gathering' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
export type IceCandidatePairState = 'frozen' | 'waiting' | 'in-progress' | 'succeeded' | 'failed';

export interface LocalIceCandidate extends IceCandidate {
  transportId: string;
  socketId: string;
  foundation: string;
  baseAddress: string;
  basePort: number;
  relay?: TurnRelayAllocation;
}

export interface RemoteIceCandidate extends IceCandidate {
  transportId: string;
}

export interface IceCandidatePair {
  id: string;
  local: LocalIceCandidate;
  remote: RemoteIceCandidate;
  priority: bigint;
  state: IceCandidatePairState;
  nominated: boolean;
  lastRequestAt?: number;
  lastResponseAt?: number;
  failures: number;
}

export interface IceAgentSnapshot {
  transportId: string;
  state: IceAgentState;
  role: IceRole;
  localParameters: IceParameters;
  remoteParameters?: IceParameters;
  localCandidates: LocalIceCandidate[];
  remoteCandidates: RemoteIceCandidate[];
  selectedPair?: IceCandidatePair;
}

export interface IceAgentOptions {
  transportId: string;
  roomId: string;
  participantId: string;
  role?: IceRole;
  tieBreaker?: bigint;
  hostPortRange?: {
    min: number;
    max: number;
  };
  includeLoopbackCandidates?: boolean;
  gatherInterfaces?: string[];
  consentIntervalMs?: number;
  consentTimeoutMs?: number;
  maxConsentFailures?: number;
  transactionTimeoutMs?: number;
  taMs?: number;
  stunServers?: string[];
  turnServers?: TurnServerOptions[];
  announcedAddress?: string;
}

export interface TurnServerOptions {
  url: string;
  username: string;
  credential: string;
  realm?: string;
}

export interface TurnRelayAllocation {
  server: {
    host: string;
    port: number;
  };
  username: string;
  credential: string;
  realm: string;
  nonce: string;
  lifetimeSeconds?: number;
  permissions: Set<string>;
}
