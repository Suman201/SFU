export type WhiteboardMemorySaveReason = 'autosave' | 'manual-save' | 'export' | 'restore' | 'session-end';

export interface WhiteboardMemoryPage {
  id: string;
  title: string;
  tags: string[];
  order: number;
  template?: string;
  view?: Record<string, unknown>;
  background?: Record<string, unknown> | null;
  elements: Array<Record<string, unknown>>;
}

export interface WhiteboardMemorySnapshot {
  schemaVersion: 1;
  activePageId?: string;
  pages: WhiteboardMemoryPage[];
}

export interface WhiteboardMemoryPageSummary {
  pageId: string;
  title: string;
  tags: string[];
  order: number;
  elementCount: number;
}

export interface WhiteboardMemorySummary {
  pageCount: number;
  elementCount: number;
  pages: WhiteboardMemoryPageSummary[];
}

export interface WhiteboardMemoryState {
  sessionId: string;
  batchId: string;
  roomId?: string;
  whiteboardChannelId: string;
  schemaVersion: 1;
  snapshotVersion: number;
  snapshot: WhiteboardMemorySnapshot;
  summary: WhiteboardMemorySummary;
  latestVersionId?: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveWhiteboardMemoryRequest {
  batchId?: string;
  snapshot: WhiteboardMemorySnapshot;
  reason?: WhiteboardMemorySaveReason;
  createVersion?: boolean;
}

export interface CreateWhiteboardMemoryCheckpointRequest {
  batchId?: string;
  snapshot: WhiteboardMemorySnapshot;
  reason?: Extract<WhiteboardMemorySaveReason, 'manual-save' | 'export' | 'session-end'>;
}

export interface WhiteboardMemoryVersion {
  versionId: string;
  sessionId: string;
  batchId: string;
  createdAt: string;
  createdByUserId?: string;
  reason: WhiteboardMemorySaveReason;
  snapshotVersion: number;
  summary: WhiteboardMemorySummary;
}

export interface WhiteboardMemoryVersionListResponse {
  versions: WhiteboardMemoryVersion[];
}

export interface RestoreWhiteboardMemoryVersionRequest {
  batchId?: string;
}

export interface RestorePreviousWhiteboardMemoryRequest {
  batchId?: string;
  sourceSessionId: string;
}

export interface PreviousWhiteboardMemorySummary {
  sessionId: string;
  batchId: string;
  title?: string;
  sessionNumber?: number;
  scheduledAt?: string;
  updatedAt: string;
  snapshotVersion: number;
  summary: WhiteboardMemorySummary;
}

export interface PreviousWhiteboardMemoryListResponse {
  boards: PreviousWhiteboardMemorySummary[];
}

export interface WhiteboardMemoryPageSearchResult {
  sessionId: string;
  batchId: string;
  pageId: string;
  title: string;
  tags: string[];
  order: number;
  updatedAt: string;
}

export interface WhiteboardMemoryPageSearchResponse {
  results: WhiteboardMemoryPageSearchResult[];
}
