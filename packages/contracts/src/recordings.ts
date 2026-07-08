export type RecordingScope = 'room' | 'participant' | 'screen';
export type RecordingStatus = 'starting' | 'recording' | 'stopping' | 'stopped' | 'failed';
export type RecordingStorageDriver = 'local' | 's3';

export interface RecordingTrackManifestEntry {
  producerId: string;
  participantId: string;
  kind: string;
  source?: string;
  status: string;
  startedAt?: string;
  closedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
}

export interface Recording {
  id: string;
  recordingId?: string;
  sessionId?: string;
  batchId?: string;
  roomId: string;
  participantId?: string;
  scope: RecordingScope;
  status: RecordingStatus;
  storageDriver: RecordingStorageDriver;
  storageKey?: string;
  url?: string;
  downloadUrl?: string;
  playbackUrl?: string;
  mimeType?: string;
  container?: string;
  size?: number;
  durationSeconds?: number;
  startedBy?: string;
  stoppedBy?: string;
  failureReason?: string;
  retentionExpiresAt?: string;
  publishedAt?: string;
  publishedByUserId?: string;
  unpublishedAt?: string;
  consentVersion?: string;
  consentRequired?: boolean;
  tracks?: RecordingTrackManifestEntry[];
  playbackProgress?: RecordingPlaybackProgress;
  startedAt: string;
  stoppedAt?: string;
}

export interface ClassSessionRecordingEvent {
  recording: Recording;
  sessionId: string;
  batchId: string;
  roomId: string;
  status: RecordingStatus;
  reason?: string;
}

export type RecordingPlaybackProgressEvent = 'play' | 'heartbeat' | 'pause' | 'seek' | 'ended';

export interface RecordingPlaybackProgressUpdateRequest {
  sessionId?: string;
  batchId?: string;
  event: RecordingPlaybackProgressEvent;
  positionSeconds?: number;
  durationSeconds?: number;
  watchedSeconds?: number;
  watchedSecondsDelta?: number;
  completed?: boolean;
}

export interface RecordingPlaybackProgress {
  recordingId: string;
  sessionId: string;
  batchId: string;
  studentId: string;
  firstPlayedAt?: string;
  lastPlayedAt?: string;
  lastPositionSeconds: number;
  watchedSeconds: number;
  durationSeconds?: number;
  completionPercent: number;
  completedAt?: string;
  playCount: number;
  pauseCount: number;
  seekCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface RecordingEngagementSummary {
  recordingsReady: number;
  studentsWatched: number;
  studentsUnwatched: number;
  averageCompletionPercent: number;
  totalWatchedSeconds: number;
  playCount: number;
  pauseCount: number;
  seekCount: number;
}
