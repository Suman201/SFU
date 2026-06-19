import type { Consumer } from './consumers.js';
import type { Participant } from './participants.js';
import type { Producer, ProducerKind, RtpLayerSelection } from './producers.js';
import type { RoomOwnerInfo, RoomOwnerRedirect } from './cluster.js';

export type RoomVisibility = 'public' | 'private' | 'invite-only';
export type RoomMediaProfileId = 'meeting' | 'webinar' | 'classroom' | 'support';
export type RoomHealthState = 'stable' | 'degraded' | 'critical';
export type RoomAutopilotAction = 'allow' | 'warn' | 'soft-throttle' | 'reject';
export type RoomAutopilotScope = 'join' | 'publish' | 'screen-share';
export type RoomIncidentStatus = 'stable' | 'degraded' | 'critical' | 'recovering' | 'failed';
export type RoomIncidentActorType = 'participant' | 'operator' | 'automation' | 'system' | 'worker' | 'node';
export type RoomIncidentWorkflowId = 'protect_room' | 'drain_prepare' | 'reopen_room' | 'acknowledge_failure';
export type RoomIncidentWorkflowStatus = 'available' | 'recommended' | 'active' | 'blocked';
export type RoomRecoveryActionType =
  | 'protect_room'
  | 'unprotect_room'
  | 'reopen_admissions'
  | 'pause_new_publishing'
  | 'resume_new_publishing'
  | 'force_incident_snapshot'
  | 'mark_operator_recovery'
  | 'clear_recovery';
export type RoomOperatorAlertCode =
  | 'room_critical'
  | 'repeated_throttles'
  | 'room_failed'
  | 'distributed_owner_risk'
  | 'repeated_snapshots'
  | 'protection_prolonged'
  | 'critical_state_prolonged';
export type ScreenSharePreference = 'balanced' | 'prefer-detail' | 'prefer-motion' | 'protect-room';
export type CongestionResponseMode = 'balanced' | 'aggressive' | 'protective';
export type RoomAutopilotReasonCode =
  | 'stable'
  | 'profile_policy'
  | 'room_degraded'
  | 'room_critical'
  | 'room_congestion'
  | 'node_draining'
  | 'node_overloaded'
  | 'worker_draining'
  | 'worker_overloaded'
  | 'worker_unavailable'
  | 'operator_protected'
  | 'operator_publish_paused'
  | 'room_failed'
  | 'screen_share_protected'
  | 'publisher_protected';

export interface RoomAutopilotThresholdPolicy {
  stable: RoomAutopilotAction;
  degraded: RoomAutopilotAction;
  critical: RoomAutopilotAction;
}

export interface RoomMediaProfilePolicy {
  consumerPriorityWeights: Record<ProducerKind, number>;
  producerPriorityWeights: Record<ProducerKind, number>;
  bitrateFloorBps: Partial<Record<ProducerKind, number>>;
  bitrateCeilingBps: Partial<Record<ProducerKind, number>>;
  defaultLayerPreferences: {
    camera?: RtpLayerSelection;
    screen?: RtpLayerSelection;
    viewer?: RtpLayerSelection;
  };
  screenSharePreference: ScreenSharePreference;
  congestionResponse: CongestionResponseMode;
  dynacastEnabled: boolean;
  admissionProtection: {
    join: RoomAutopilotThresholdPolicy;
    publish: RoomAutopilotThresholdPolicy;
    screenShare: RoomAutopilotThresholdPolicy;
  };
}

export interface RoomMediaProfile {
  id: RoomMediaProfileId;
  label: string;
  description: string;
  policy: RoomMediaProfilePolicy;
  updatedAt?: string;
  updatedByParticipantId?: string;
}

export interface RoomAutopilotDecision {
  scope: RoomAutopilotScope;
  health: RoomHealthState;
  action: RoomAutopilotAction;
  code: RoomAutopilotReasonCode;
  message: string;
  triggeredBy: Array<'room' | 'node' | 'worker' | 'profile' | 'operator'>;
  updatedAt: string;
}

export interface RoomIncidentActor {
  type: RoomIncidentActorType;
  participantId?: string;
  userId?: string;
  label?: string;
  nodeId?: string;
  workerId?: string;
}

export interface RoomOperatorAlert {
  code: RoomOperatorAlertCode;
  severity: 'warn' | 'critical';
  title: string;
  detail: string;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  occurrenceCount: number;
}

export interface RoomRecoveryWorkflow {
  id: RoomIncidentWorkflowId;
  title: string;
  status: RoomIncidentWorkflowStatus;
  detail: string;
  nextStep?: string;
  blockedReason?: string;
  suggestedActions: RoomRecoveryActionType[];
}

export interface RoomIncidentState {
  roomId: string;
  status: RoomIncidentStatus;
  health: RoomHealthState;
  protected: boolean;
  protectedAt?: string;
  protectedByParticipantId?: string;
  protectedReason?: string;
  admissionsState: 'default' | 'reopened' | 'protected';
  publishingState: 'default' | 'paused' | 'protected';
  underRecovery: boolean;
  recoveryStartedAt?: string;
  recoveryStartedByParticipantId?: string;
  recoveryClearedAt?: string;
  recoveryClearedByParticipantId?: string;
  recoveryReason?: string;
  healthChangedAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: RoomFailureEvent['reason'];
  lastFailureMessage?: string;
  lastRecoveryAction?: RoomRecoveryActionType;
  lastRecoveryActionAt?: string;
  blockedReasons?: string[];
  workflows?: RoomRecoveryWorkflow[];
  activeAlerts: RoomOperatorAlert[];
  snapshotCount: number;
  latestSnapshotId?: string;
  updatedAt: string;
}

export interface RoomSettings {
  locked: boolean;
  waitingRoomEnabled: boolean;
  joinApprovalRequired: boolean;
  visibility: RoomVisibility;
  maxParticipants: number;
  recordingEnabled: boolean;
  chatEnabled: boolean;
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  settings: RoomSettings;
  mediaProfile: RoomMediaProfile;
  mediaState?: RoomMediaState;
  incidentState?: RoomIncidentState;
  owner?: RoomOwnerInfo;
  participants: Participant[];
  producers: Producer[];
  consumers: Consumer[];
  createdAt: string;
  closedAt?: string;
}

export interface RoomMediaState {
  status: 'active' | 'failed';
  failedAt?: string;
  failureReason?: string;
  failureMessage?: string;
  workerId?: string;
}

export interface RoomFailureEvent {
  roomId: string;
  reason: 'worker_crashed' | 'worker_drained_forced' | 'worker_unhealthy' | 'worker_overloaded';
  message: string;
  failedAt: string;
  recoverable: boolean;
  affectedParticipants?: string[];
  affectedTransports?: string[];
  affectedProducers?: string[];
  affectedConsumers?: string[];
  workerId?: string;
}

export interface CreateRoomRequest {
  name: string;
  visibility?: RoomVisibility;
  waitingRoomEnabled?: boolean;
  joinApprovalRequired?: boolean;
  maxParticipants?: number;
  mediaProfileId?: RoomMediaProfileId;
}

export interface UpdateRoomMediaProfileRequest {
  roomId: string;
  profileId: RoomMediaProfileId;
}

export interface GetRoomIncidentTimelineRequest {
  roomId: string;
  limit?: number;
}

export interface GetRoomSnapshotHistoryRequest {
  roomId: string;
  limit?: number;
}

export interface RunRoomRecoveryActionRequest {
  roomId: string;
  action: RoomRecoveryActionType;
  reason?: string;
}

export interface JoinRoomRequest {
  roomId: string;
  displayName: string;
  inviteCode?: string;
  asViewer?: boolean;
}

export interface JoinRoomResponse {
  room: Room;
  participantId: string;
  admitted: boolean;
  admissionDecision?: RoomAutopilotDecision;
  redirect?: RoomOwnerRedirect;
}

export interface RoomRecoveryActionResult {
  roomId: string;
  action: RoomRecoveryActionType;
  executed: boolean;
  blockedReason?: string;
  room: Room;
  incidentState: RoomIncidentState;
  generatedSnapshotId?: string;
}
