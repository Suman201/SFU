export type RecordingScope = 'room' | 'participant' | 'screen';
export type RecordingStatus = 'starting' | 'recording' | 'stopping' | 'stopped' | 'failed';
export type RecordingStorageDriver = 'local' | 's3';

export interface RecordingTrackManifestEntry {
  producerId: string;
  participantId: string;
  kind: string;
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
  consentVersion?: string;
  consentRequired?: boolean;
  tracks?: RecordingTrackManifestEntry[];
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
