import type { ProducerKind, RtpLayerSelection, SvcLayerSelection } from './producers.js';

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
