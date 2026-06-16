export type NodeHealthState = 'starting' | 'healthy' | 'draining' | 'overloaded' | 'unhealthy';

export interface ClusterNodeCapacity {
  activeRooms: number;
  activeTransports: number;
  activeProducers: number;
  activeConsumers: number;
  workerCount: number;
  readyWorkers: number;
  drainingWorkers: number;
  overloadedWorkers: number;
  averageIpcLatencyMs: number;
  memoryRssBytes?: number;
  cpuUserMicros?: number;
  capacityScore: number;
}

export interface ClusterNodeInfo {
  nodeId: string;
  publicUrl: string;
  region?: string;
  zone?: string;
  health: NodeHealthState;
  draining: boolean;
  capacity: ClusterNodeCapacity;
  registeredAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
}

export interface RoomOwnerInfo {
  roomId: string;
  nodeId: string;
  publicUrl: string;
  region?: string;
  zone?: string;
  claimedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
}

export interface RoomOwnerLookupResponse {
  roomId: string;
  owner?: RoomOwnerInfo;
  local: boolean;
  available: boolean;
  reason?: 'missing' | 'owner_unhealthy' | 'owner_draining' | 'owner_expired';
}

export interface RoomOwnerRedirect {
  roomId?: string;
  ownerNodeId: string;
  ownerUrl: string;
  region?: string;
  zone?: string;
  reason: 'room_owned_by_remote_node' | 'local_node_draining' | 'local_node_overloaded';
}
