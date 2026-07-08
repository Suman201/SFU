export const INGEST_SOURCE_TYPES = ['mp4', 'hls', 'rtsp', 'rtmp'] as const;
export type IngestSourceType = (typeof INGEST_SOURCE_TYPES)[number];

export const INGEST_STATUSES = ['idle', 'starting', 'live', 'restarting', 'stopping', 'stopped', 'failed'] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export const INGEST_TRANSPORT_PROTOCOLS = ['trusted-rtp-local'] as const;
export type IngestTransportProtocol = (typeof INGEST_TRANSPORT_PROTOCOLS)[number];

export const INGEST_RESTART_MODES = ['never', 'always', 'on_failure'] as const;
export type IngestRestartMode = (typeof INGEST_RESTART_MODES)[number];

export interface IngestRestartPolicy {
  mode: IngestRestartMode;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface IngestHeaderAuth {
  name: string;
  valueSecretRef: string;
}

export interface IngestAuthConfig {
  basicUsername?: string;
  basicPasswordSecretRef?: string;
  bearerTokenSecretRef?: string;
  headers?: IngestHeaderAuth[];
}

export interface IngestRuntimeState {
  nodeId?: string;
  participantId?: string;
  transportProtocol?: IngestTransportProtocol;
  listenAddress?: string;
  rtpPort?: number;
  rtcpPort?: number;
  processId?: number;
  lastStartedAt?: string;
  lastRestartedAt?: string;
  lastStoppedAt?: string;
  lastExitCode?: number;
  lastError?: string;
  restartCount?: number;
  inputBitrateBps?: number;
  outputBitrateBps?: number;
}

export interface IngestJob {
  id: string;
  name?: string;
  roomId?: string;
  participantId?: string;
  nodeId?: string;
  displayName?: string;
  sourceType: IngestSourceType;
  sourceUrl: string;
  transportProtocol: IngestTransportProtocol;
  status: IngestStatus;
  auth?: IngestAuthConfig;
  restartPolicy?: IngestRestartPolicy;
  runtime?: IngestRuntimeState;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIngestRequest {
  name?: string;
  displayName?: string;
  sourceType: IngestSourceType;
  sourceUrl: string;
  auth?: IngestAuthConfig;
  restartPolicy?: IngestRestartPolicy;
}

export interface UpdateIngestRequest {
  name?: string;
  displayName?: string;
  sourceUrl?: string;
  auth?: IngestAuthConfig;
  restartPolicy?: IngestRestartPolicy;
}

export interface AttachIngestRequest {
  roomId: string;
  displayName?: string;
  startIfStopped?: boolean;
}

export interface IngestListQuery {
  page?: number;
  limit?: number;
  status?: IngestStatus | 'all';
  sourceType?: IngestSourceType | 'all';
  roomId?: string;
  nodeId?: string;
  attached?: 'attached' | 'detached' | 'all';
  search?: string;
}

export interface IngestListSummary {
  idle: number;
  starting: number;
  live: number;
  restarting: number;
  stopping: number;
  stopped: number;
  failed: number;
  attached: number;
  detached: number;
}

export interface IngestListResponse {
  items: IngestJob[];
  page: number;
  limit: number;
  total: number;
  summary: IngestListSummary;
}
