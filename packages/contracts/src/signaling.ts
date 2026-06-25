import type { ChatMessage, ChatReadReceiptEvent, ChatReadState, MarkChatReadRequest, SendChatMessageRequest, SendChatMessageResponse } from './chat.js';
import type {
  Consumer,
  ConsumerLayerEvent,
  ConsumerLayerState,
  CreateConsumerRequest,
  SetConsumerPreferredLayersRequest,
  SetConsumerPreferredSvcLayersRequest,
  SetConsumerPriorityRequest
} from './consumers.js';
import type {
  ConsumerQualityState,
  GetConsumerQualityRequest,
  GetProducerQualityRequest,
  GetRoomQualityRequest,
  RoomIncidentTimelineState,
  RoomSnapshotHistoryState,
  GetTransportQualityRequest,
  ProducerQualityState,
  RoomQualityState,
  SetProducerPriorityRequest,
  TransportQualityState
} from './metrics.js';
import type { Participant, ParticipantPatch } from './participants.js';
import type { Permissions } from './permissions.js';
import type { ClassSessionRecordingEvent } from './recordings.js';
import type { ClassSessionMaterialEvent } from './materials.js';
import type { WhiteboardCommand, WhiteboardCursor, WhiteboardPermissionLevel } from './whiteboard.js';
import type { CreateProducerRequest, Producer, ProducerDynacastControlFailureReport, ProducerDynacastEvent, ProducerLayerState } from './producers.js';
import type {
  CreateRoomRequest,
  GetRoomIncidentTimelineRequest,
  GetRoomSnapshotHistoryRequest,
  JoinRoomRequest,
  JoinRoomResponse,
  Room,
  RoomFailureEvent,
  RoomIncidentState,
  RoomRecoveryActionResult,
  RunRoomRecoveryActionRequest,
  UpdateRoomMediaProfileRequest
} from './rooms.js';
import type { RoomOwnerInfo, RoomOwnerLookupResponse } from './cluster.js';
import type { DtlsParameters, IceCandidate, IceParameters, TransportOptions } from './transport.js';
import type { RoomQualitySummaryState } from './metrics.js';

export type ClassSessionLifecycleStatus = 'live' | 'completed';

export interface ClassSessionLifecycleEvent {
  sessionId: string;
  batchId: string;
  roomId: string;
  status: ClassSessionLifecycleStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface ClassSessionWatchRequest {
  sessionId: string;
  batchId?: string;
}

export type StudentMediaModerationAction = 'mute-mic' | 'unmute-mic' | 'stop-camera' | 'restore-camera';

export interface StudentMediaModerationRequest {
  roomId: string;
  participantId: string;
}

export interface StudentMediaModerationEvent {
  roomId: string;
  participantId: string;
  producerId?: string;
  kind: 'audio' | 'video';
  action: StudentMediaModerationAction;
  moderatedByParticipantId: string;
  permissions?: Permissions;
  reason?: string;
  message?: string;
}

export interface ClassStudentMediaModerationRequest {
  roomId: string;
}

export interface ClassStudentMediaModerationResponse {
  roomId: string;
  action: Extract<StudentMediaModerationAction, 'mute-mic' | 'stop-camera'>;
  moderatedCount: number;
  events: StudentMediaModerationEvent[];
}

export interface ClassStudentSpeakRequest {
  roomId: string;
  participantId: string;
}

export interface ClassStudentSpeakEvent {
  roomId: string;
  participantId: string;
  allowedToSpeak: boolean;
  allowedToSpeakAt?: string;
  allowedToSpeakBy?: string;
  moderatedByParticipantId: string;
  permissions: Permissions;
  message: string;
}

export interface WhiteboardControlRequest {
  roomId: string;
  participantId: string;
  permissionLevel?: WhiteboardPermissionLevel;
  pageId?: string;
}

export interface WhiteboardControlEvent {
  sessionId?: string;
  batchId?: string;
  roomId: string;
  participantId: string;
  displayName?: string;
  granted: boolean;
  permissionLevel: WhiteboardPermissionLevel;
  pageId?: string;
  grantedAt?: string;
  grantedByParticipantId?: string;
  revokedByParticipantId?: string;
  reason?: string;
  message?: string;
}

export interface WhiteboardLockRequest {
  roomId: string;
  locked: boolean;
}

export interface WhiteboardLockEvent {
  sessionId?: string;
  batchId?: string;
  roomId: string;
  locked: boolean;
  changedAt: string;
  lockedByParticipantId?: string;
  unlockedByParticipantId?: string;
  reason?: string;
  message?: string;
}

export interface WhiteboardCommandRequest {
  roomId: string;
  command: WhiteboardCommand;
}

export interface WhiteboardCommandEvent {
  roomId: string;
  participantId: string;
  displayName: string;
  command: WhiteboardCommand;
}

export interface WhiteboardCursorRequest {
  roomId: string;
  cursor: Pick<WhiteboardCursor, 'position'> & Partial<Pick<WhiteboardCursor, 'color'>>;
}

export interface WhiteboardCursorEvent {
  roomId: string;
  cursor: WhiteboardCursor;
}

export interface ClassSessionActivityRequest {
  roomId: string;
  active: boolean;
  visible: boolean;
  focused: boolean;
  reason?: 'heartbeat' | 'user' | 'visibility' | 'focus' | 'blur';
}

export interface ClientToServerEvents {
  'session:watch': (request: ClassSessionWatchRequest, ack: Ack<void>) => void;
  'session:unwatch': (request: { sessionId: string }, ack: Ack<void>) => void;
  'room:create': (request: CreateRoomRequest, ack: Ack<Room>) => void;
  'room:get-owner': (request: { roomId: string }, ack: Ack<RoomOwnerLookupResponse>) => void;
  'room:join': (request: JoinRoomRequest, ack: Ack<JoinRoomResponse>) => void;
  'room:leave': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:close': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:lock': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:unlock': (request: { roomId: string }, ack: Ack<void>) => void;
  'room:update-media-profile': (request: UpdateRoomMediaProfileRequest, ack: Ack<Room>) => void;
  'room:admit': (request: { roomId: string; participantId: string }, ack: Ack<void>) => void;
  'room:reject': (request: { roomId: string; participantId: string }, ack: Ack<void>) => void;
  'transport:create': (request: { roomId: string }, ack: Ack<TransportOptions>) => void;
  'transport:ice-parameters': (request: { transportId: string; iceParameters: IceParameters }, ack: Ack<void>) => void;
  'transport:ice-candidate': (request: { transportId: string; candidate: IceCandidate }, ack: Ack<void>) => void;
  'transport:ice-restart': (request: { transportId: string }, ack: Ack<TransportOptions>) => void;
  'transport:dtls-parameters': (request: { transportId: string; dtlsParameters: DtlsParameters }, ack: Ack<void>) => void;
  'producer:create': (request: CreateProducerRequest, ack: Ack<Producer>) => void;
  'producer:pause': (request: { producerId: string }, ack: Ack<void>) => void;
  'producer:resume': (request: { producerId: string }, ack: Ack<void>) => void;
  'producer:close': (request: { producerId: string }, ack: Ack<void>) => void;
  'producer:set-priority': (request: SetProducerPriorityRequest, ack: Ack<Producer>) => void;
  'producer:dynacast-control-failed': (request: ProducerDynacastControlFailureReport, ack: Ack<void>) => void;
  'consumer:create': (request: CreateConsumerRequest, ack: Ack<Consumer>) => void;
  'consumer:pause': (request: { consumerId: string }, ack: Ack<void>) => void;
  'consumer:resume': (request: { consumerId: string }, ack: Ack<void>) => void;
  'consumer:set-preferred-layers': (request: SetConsumerPreferredLayersRequest, ack: Ack<Consumer>) => void;
  'consumer:set-preferred-svc-layers': (request: SetConsumerPreferredSvcLayersRequest, ack: Ack<Consumer>) => void;
  'consumer:set-priority': (request: SetConsumerPriorityRequest, ack: Ack<Consumer>) => void;
  'consumer:get-layers': (request: { consumerId: string }, ack: Ack<ConsumerLayerState>) => void;
  'producer:get-layers': (request: { producerId: string }, ack: Ack<ProducerLayerState>) => void;
  'consumer:get-quality': (request: GetConsumerQualityRequest, ack: Ack<ConsumerQualityState>) => void;
  'producer:get-quality': (request: GetProducerQualityRequest, ack: Ack<ProducerQualityState>) => void;
  'room:get-quality': (request: GetRoomQualityRequest, ack: Ack<RoomQualityState>) => void;
  'room:get-quality-summary': (request: GetRoomQualityRequest, ack: Ack<RoomQualitySummaryState>) => void;
  'room:get-incident-state': (request: GetRoomQualityRequest, ack: Ack<RoomIncidentState>) => void;
  'room:get-incident-timeline': (request: GetRoomIncidentTimelineRequest, ack: Ack<RoomIncidentTimelineState>) => void;
  'room:get-snapshot-history': (request: GetRoomSnapshotHistoryRequest, ack: Ack<RoomSnapshotHistoryState>) => void;
  'room:run-recovery-action': (request: RunRoomRecoveryActionRequest, ack: Ack<RoomRecoveryActionResult>) => void;
  'transport:get-quality': (request: GetTransportQualityRequest, ack: Ack<TransportQualityState>) => void;
  'consumer:close': (request: { consumerId: string }, ack: Ack<void>) => void;
  'permission:update': (request: { roomId: string; participantId: string; permissions: Partial<Permissions> }, ack: Ack<void>) => void;
  'participant:kick': (request: { roomId: string; participantId: string; reason?: string }, ack: Ack<void>) => void;
  'participant:ban': (request: { roomId: string; participantId: string; reason?: string }, ack: Ack<void>) => void;
  'participant:unban': (request: { roomId: string; participantId: string }, ack: Ack<void>) => void;
  'participant:mute': (request: { roomId: string; participantId: string; force?: boolean }, ack: Ack<void>) => void;
  'class:mute-all-students': (request: ClassStudentMediaModerationRequest, ack: Ack<ClassStudentMediaModerationResponse>) => void;
  'class:stop-all-cameras': (request: ClassStudentMediaModerationRequest, ack: Ack<ClassStudentMediaModerationResponse>) => void;
  'class:allow-speak': (request: ClassStudentSpeakRequest, ack: Ack<ClassStudentSpeakEvent>) => void;
  'class:revoke-speak': (request: ClassStudentSpeakRequest, ack: Ack<ClassStudentSpeakEvent>) => void;
  'class:lower-hand': (request: ClassStudentSpeakRequest, ack: Ack<ParticipantPatch>) => void;
  'whiteboard:grant-control': (request: WhiteboardControlRequest, ack: Ack<WhiteboardControlEvent>) => void;
  'whiteboard:revoke-control': (request: Partial<WhiteboardControlRequest> & { roomId: string }, ack: Ack<WhiteboardControlEvent>) => void;
  'whiteboard:set-lock': (request: WhiteboardLockRequest, ack: Ack<WhiteboardLockEvent>) => void;
  'whiteboard:command': (request: WhiteboardCommandRequest, ack: Ack<WhiteboardCommandEvent>) => void;
  'whiteboard:cursor': (request: WhiteboardCursorRequest, ack: Ack<WhiteboardCursorEvent>) => void;
  'student:mute-mic': (request: StudentMediaModerationRequest, ack: Ack<StudentMediaModerationEvent>) => void;
  'student:unmute-mic': (request: StudentMediaModerationRequest, ack: Ack<StudentMediaModerationEvent>) => void;
  'student:stop-camera': (request: StudentMediaModerationRequest, ack: Ack<StudentMediaModerationEvent>) => void;
  'student:restore-camera': (request: StudentMediaModerationRequest, ack: Ack<StudentMediaModerationEvent>) => void;
  'screen:start': (request: CreateProducerRequest, ack: Ack<Producer>) => void;
  'screen:stop': (request: { producerId: string }, ack: Ack<void>) => void;
  'chat:send': (request: SendChatMessageRequest, ack: Ack<SendChatMessageResponse>) => void;
  'chat:mark-read': (request: MarkChatReadRequest, ack: Ack<ChatReadState>) => void;
  'hand:raise': (request: { roomId: string; raised: boolean }, ack: Ack<ParticipantPatch>) => void;
  'class:activity': (request: ClassSessionActivityRequest, ack: Ack<ParticipantPatch>) => void;
}

export interface ServerToClientEvents {
  'session:started': (event: ClassSessionLifecycleEvent) => void;
  'session:ended': (event: ClassSessionLifecycleEvent) => void;
  'recording:started': (event: ClassSessionRecordingEvent) => void;
  'recording:updated': (event: ClassSessionRecordingEvent) => void;
  'recording:stopped': (event: ClassSessionRecordingEvent) => void;
  'recording:failed': (event: ClassSessionRecordingEvent) => void;
  'material:shared': (event: ClassSessionMaterialEvent) => void;
  'material:unshared': (event: ClassSessionMaterialEvent) => void;
  'material:updated': (event: ClassSessionMaterialEvent) => void;
  'room:updated': (room: Room) => void;
  'room:closed': (roomId: string) => void;
  'room:failed': (event: RoomFailureEvent) => void;
  'room:owner-changed': (owner: RoomOwnerInfo) => void;
  'room:incident-updated': (state: RoomIncidentState) => void;
  'room:incident-event': (state: RoomIncidentTimelineState['events'][number]) => void;
  'room:snapshot-generated': (summary: RoomSnapshotHistoryState['bundles'][number]) => void;
  'participant:joined': (participant: Participant) => void;
  'participant:left': (participantId: string) => void;
  'participant:updated': (participantId: string, patch: ParticipantPatch) => void;
  'participant:kicked': (reason?: string) => void;
  'participant:banned': (reason?: string) => void;
  'permissions:updated': (participantId: string, permissions: Permissions) => void;
  'student:media-moderated': (event: StudentMediaModerationEvent) => void;
  'whiteboard:control-granted': (event: WhiteboardControlEvent) => void;
  'whiteboard:control-revoked': (event: WhiteboardControlEvent) => void;
  'whiteboard:lock-changed': (event: WhiteboardLockEvent) => void;
  'whiteboard:command': (event: WhiteboardCommandEvent) => void;
  'whiteboard:cursor': (event: WhiteboardCursorEvent) => void;
  'producer:created': (producer: Producer) => void;
  'producer:updated': (producer: Producer) => void;
  'producer:closed': (producerId: string) => void;
  'producer:layers-needed': (event: ProducerDynacastEvent) => void;
  'producer:layers-unneeded': (event: ProducerDynacastEvent) => void;
  'producer:dynacast-updated': (event: ProducerDynacastEvent) => void;
  'producer:score-updated': (state: ProducerQualityState) => void;
  'consumer:created': (consumer: Consumer) => void;
  'consumer:updated': (consumer: Consumer) => void;
  'consumer:closed': (consumerId: string) => void;
  'consumer:score-updated': (state: ConsumerQualityState) => void;
  'transport:quality-updated': (state: TransportQualityState) => void;
  'room:quality-updated': (state: RoomQualityState) => void;
  'room:quality-summary-updated': (state: RoomQualitySummaryState) => void;
  'consumer:layers-changed': (event: ConsumerLayerEvent) => void;
  'consumer:layers-switching': (event: ConsumerLayerEvent) => void;
  'consumer:layers-unavailable': (event: ConsumerLayerEvent) => void;
  'consumer:layers-switch-failed': (event: ConsumerLayerEvent) => void;
  'consumer:svc-layers-changed': (event: ConsumerLayerEvent) => void;
  'consumer:svc-layers-switching': (event: ConsumerLayerEvent) => void;
  'consumer:svc-layers-unavailable': (event: ConsumerLayerEvent) => void;
  'consumer:svc-layers-switch-failed': (event: ConsumerLayerEvent) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:read': (state: ChatReadReceiptEvent) => void;
  'network:quality': (quality: { participantId: string; score: number; packetLoss: number; rtt: number; jitter: number }) => void;
  'waiting-room:pending': (participant: Participant) => void;
}

export type Ack<T> = (response: AckResponse<T>) => void;

export type AckResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };
