export type RecordingScope = 'room' | 'participant' | 'screen';
export type RecordingStatus = 'starting' | 'recording' | 'stopped' | 'failed';

export interface Recording {
  id: string;
  roomId: string;
  participantId?: string;
  scope: RecordingScope;
  status: RecordingStatus;
  storageDriver: 'local' | 's3';
  path?: string;
  downloadUrl?: string;
  startedAt: string;
  stoppedAt?: string;
}
