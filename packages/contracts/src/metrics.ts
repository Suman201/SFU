import type { ProducerKind, RtpLayerSelection, SvcLayerSelection } from './producers.js';
import type {
  Room,
  RoomAutopilotDecision,
  RoomAutopilotScope,
  RoomHealthState,
  RoomMediaProfile,
  RoomAutopilotAction,
  RoomIncidentActor,
  RoomIncidentState,
  RoomOperatorAlertCode
} from './rooms.js';

export interface NetworkQuality {
  bitrate: number;
  packetLoss: number;
  rtt: number;
  jitter: number;
  score: 1 | 2 | 3 | 4 | 5;
}

export interface RoomAnalytics {
  activeUsers: number;
  joinDurationMs: number;
  audioLevel: number;
  videoQuality: NetworkQuality;
}

export type QualityLevel = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export type QualityIssueReason =
  | 'stable'
  | 'packet_loss'
  | 'high_rtt'
  | 'high_jitter'
  | 'overuse'
  | 'underuse'
  | 'bandwidth_limited'
  | 'layer_unavailable'
  | 'keyframe_missing'
  | 'dynacast_suspended'
  | 'svc_dependency_filtered'
  | 'pacing_queue'
  | 'retransmission_loss'
  | 'probe_pending'
  | 'starvation_prevented'
  | 'recovered';

export interface QualityScoreBreakdown {
  packetLossScore: number;
  rttScore: number;
  jitterScore: number;
  congestionScore: number;
  retransmissionScore: number;
  allocationScore: number;
}

export interface QualityScore {
  score: number;
  level: QualityLevel;
  reasons: QualityIssueReason[];
  breakdown: QualityScoreBreakdown;
  updatedAt: string;
}

export interface QualityBitrateState {
  targetBitrate: number;
  allocatedBitrate: number;
  actualBitrate: number;
  availableBitrate: number;
  recommendedBitrate: number;
}

export interface QualityNetworkState {
  packetLoss: number;
  rtt: number;
  rttVariance?: number;
  jitter: number;
  delayVariationMs?: number;
  congestionState?: 'underuse' | 'normal' | 'overuse';
}

export interface PriorityAllocationState {
  priority: number;
  desiredBitrate: number;
  allocatedBitrate: number;
  minBitrate: number;
  maxBitrate: number;
  fairShareBitrate: number;
  starvationPrevented: boolean;
  reason: 'preferred' | 'bandwidth' | 'congestion' | 'starvation' | 'paused';
  updatedAt: string;
}

export interface LayerQualityState {
  layer?: RtpLayerSelection;
  svcLayer?: SvcLayerSelection;
  score: QualityScore;
  packets: number;
  bytes: number;
  packetsLost: number;
  fractionLost: number;
  jitter: number;
  rtt: number;
  targetBitrate?: number;
}

export interface ConsumerQualityState {
  roomId: string;
  participantId: string;
  consumerId: string;
  producerId: string;
  transportId: string;
  priority: number;
  score: QualityScore;
  allocation: PriorityAllocationState;
  network: QualityNetworkState;
  bitrate: QualityBitrateState;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  preferredLayers?: RtpLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  layerScores: LayerQualityState[];
  svcLayerScores: LayerQualityState[];
  pacingQueueDepth: number;
  retransmissions: {
    requestedPackets: number;
    retransmittedPackets: number;
    missingPackets: number;
    successRate: number;
    failureRate: number;
  };
  updatedAt: string;
}

export interface ProducerQualityState {
  roomId: string;
  participantId: string;
  producerId: string;
  transportId: string;
  kind: ProducerKind;
  priority: number;
  score: QualityScore;
  network: QualityNetworkState;
  bitrate: QualityBitrateState;
  layerScores: LayerQualityState[];
  svcLayerScores: LayerQualityState[];
  dynacastEnabled?: boolean;
  activeLayers: RtpLayerSelection[];
  suspendedLayers: RtpLayerSelection[];
  updatedAt: string;
}

export interface TransportQualityState {
  roomId: string;
  participantId: string;
  transportId: string;
  score: QualityScore;
  consumers: ConsumerQualityState[];
  producers: ProducerQualityState[];
  targetBitrate: number;
  allocatedBitrate: number;
  actualBitrate: number;
  pacingQueueDepth: number;
  updatedAt: string;
}

export interface RoomQualityState {
  roomId: string;
  score: QualityScore;
  consumers: ConsumerQualityState[];
  producers: ProducerQualityState[];
  transports: TransportQualityState[];
  targetBitrate: number;
  allocatedBitrate: number;
  actualBitrate: number;
  congestionState: 'underuse' | 'normal' | 'overuse';
  updatedAt: string;
}

export type RoomQualityRecommendationCode =
  | 'reduce_screen_share_preference'
  | 'lower_room_target_quality'
  | 'restrict_new_publishers'
  | 'throttle_new_joins'
  | 'drain_or_protect_node_admission'
  | 'monitor_room_stability';

export interface RoomQualityRecommendation {
  code: RoomQualityRecommendationCode;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  scope?: RoomAutopilotScope;
  suggestedAction?: RoomAutopilotAction;
}

export interface RoomQualitySummaryState {
  roomId: string;
  health: RoomHealthState;
  profile: RoomMediaProfile;
  qualitySource: 'local-owner' | 'remote-signal-cache' | 'local-fallback';
  ownerAuthoritativeQuality: boolean;
  score: QualityScore;
  congestionState: RoomQualityState['congestionState'];
  bitrate: {
    target: number;
    allocated: number;
    actual: number;
    maxAvailable: number;
    avgAvailable: number;
    maxRecommended: number;
    avgRecommended: number;
  };
  participantCount: number;
  admittedParticipantCount: number;
  pendingParticipantCount: number;
  activeProducerCount: number;
  activeScreenShareCount: number;
  degradedConsumers: number;
  degradedProducers: number;
  degradedTransports: number;
  degradedEntityIds: {
    consumers: string[];
    producers: string[];
    transports: string[];
  };
  protections: {
    join: RoomAutopilotDecision;
    publish: RoomAutopilotDecision;
    screenShare: RoomAutopilotDecision;
  };
  recommendations: RoomQualityRecommendation[];
  warnings: string[];
  updatedAt: string;
}

export type RoomIncidentEventType =
  | 'health_changed'
  | 'protection_changed'
  | 'join_throttled'
  | 'join_rejected'
  | 'publish_throttled'
  | 'publish_rejected'
  | 'screen_share_throttled'
  | 'screen_share_rejected'
  | 'profile_changed'
  | 'recommendation_changed'
  | 'snapshot_generated'
  | 'room_failed'
  | 'room_recovered'
  | 'manual_action'
  | 'approval_action'
  | 'alert_raised'
  | 'alert_suppressed'
  | 'infrastructure_impact';

export type RoomIncidentSeverity = 'info' | 'warn' | 'critical';

export type RoomSnapshotTriggerReason =
  | 'manual_operator'
  | 'critical_quality'
  | 'room_failure'
  | 'repeated_throttles'
  | 'repeated_snapshots';

export interface RoomIncidentTimelineEvent {
  id: string;
  roomId: string;
  type: RoomIncidentEventType;
  severity: RoomIncidentSeverity;
  summary: string;
  detail?: string;
  actor?: RoomIncidentActor;
  relatedParticipantId?: string;
  relatedProducerId?: string;
  relatedConsumerId?: string;
  relatedTransportId?: string;
  snapshotId?: string;
  alertCode?: RoomOperatorAlertCode;
  ownerNodeId?: string;
  workerId?: string;
  createdAt: string;
}

export interface RoomIncidentTimelineState {
  roomId: string;
  events: RoomIncidentTimelineEvent[];
  updatedAt: string;
}

export interface RoomSnapshotBundleSummary {
  bundleId: string;
  roomId: string;
  generatedAt: string;
  triggerReason: RoomSnapshotTriggerReason;
  automatic: boolean;
  actor?: RoomIncidentActor;
  health: RoomHealthState;
  status: RoomIncidentState['status'];
  protected: boolean;
  underRecovery: boolean;
  degradedEntityCount: number;
  warningCount: number;
}

export interface RoomSnapshotHistoryState {
  roomId: string;
  bundles: RoomSnapshotBundleSummary[];
  updatedAt: string;
}

export interface IncidentParticipantSummary {
  total: number;
  admitted: number;
  pending: number;
  viewers: number;
  hosts: number;
  coHosts: number;
  screenSharing: number;
  handRaised: number;
}

export interface IncidentProducerSummary {
  producerId: string;
  participantId: string;
  transportId: string;
  kind: ProducerKind;
  priority?: number;
  status: string;
  score?: number;
  level?: QualityLevel;
  currentLayers?: RtpLayerSelection;
  activeLayers?: RtpLayerSelection[];
  preferredLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
}

export interface IncidentConsumerSummary {
  consumerId: string;
  participantId: string;
  producerId: string;
  transportId: string;
  priority?: number;
  status: string;
  score?: number;
  level?: QualityLevel;
  currentLayers?: RtpLayerSelection;
  preferredLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
}

export interface IncidentTransportSummary {
  transportId: string;
  participantId: string;
  consumerCount: number;
  producerCount: number;
  score?: number;
  level?: QualityLevel;
  targetBitrate?: number;
  allocatedBitrate?: number;
  actualBitrate?: number;
  pacingQueueDepth?: number;
}

export interface RoomIncidentSnapshot {
  scope: 'room';
  generatedAt: string;
  room: Room;
  ownerNodeId?: string;
  ownerPublicUrl?: string;
  ownerAvailable: boolean;
  workerId?: string;
  roomProfile: RoomMediaProfile;
  roomQualitySummary: RoomQualitySummaryState;
  participantSummary: IncidentParticipantSummary;
  producers: IncidentProducerSummary[];
  consumers: IncidentConsumerSummary[];
  transports: IncidentTransportSummary[];
  degradedEntities: RoomQualitySummaryState['degradedEntityIds'];
  congestionIndicators: {
    congestionState: RoomQualityState['congestionState'];
    score: number;
    reasons: QualityIssueReason[];
    targetBitrate: number;
    allocatedBitrate: number;
    actualBitrate: number;
  };
  pipeContext?: {
    crossNode: boolean;
    localNodeId: string;
  };
}

export interface RoomIncidentSnapshotBundle extends RoomIncidentSnapshot {
  bundleId: string;
  triggerReason: RoomSnapshotTriggerReason;
  automatic: boolean;
  actor?: RoomIncidentActor;
  incidentState: RoomIncidentState;
  recentTimeline: RoomIncidentTimelineEvent[];
  distributedContext: {
    ownerLocal: boolean;
    ownerNodeId?: string;
    ownerPublicUrl?: string;
    qualitySource: RoomQualitySummaryState['qualitySource'];
    ownerAuthoritativeQuality: boolean;
    localNodeId: string;
  };
}

export interface TransportIncidentSnapshot {
  scope: 'transport';
  generatedAt: string;
  transport: IncidentTransportSummary;
  roomId: string;
  roomProfile: RoomMediaProfile;
  ownerNodeId?: string;
  ownerPublicUrl?: string;
  ownerAvailable: boolean;
  workerId?: string;
  roomQualitySummary: RoomQualitySummaryState;
  relatedProducers: IncidentProducerSummary[];
  relatedConsumers: IncidentConsumerSummary[];
  degradedEntities: RoomQualitySummaryState['degradedEntityIds'];
}

export interface SetProducerPriorityRequest {
  producerId: string;
  priority: number;
}

export interface GetConsumerQualityRequest {
  consumerId: string;
}

export interface GetProducerQualityRequest {
  producerId: string;
}

export interface GetRoomQualityRequest {
  roomId: string;
}

export interface GetTransportQualityRequest {
  transportId: string;
}
