import type { ProducerQualityState } from './metrics.js';
import type { RoomAutopilotDecision } from './rooms.js';

export type ProducerKind = 'audio' | 'video' | 'screen';
export type ProducerStatus = 'live' | 'paused' | 'closed';
export type SimulcastLayerName = 'low' | 'medium' | 'high';

export interface RtpLayerInfo {
  spatialLayer: number;
  temporalLayer?: number;
  rid?: string;
  ssrc?: number;
  rtxSsrc?: number;
  maxBitrate?: number;
  scaleResolutionDownBy?: number;
  active: boolean;
}

export interface RtpLayerSelection {
  spatialLayer?: number;
  temporalLayer?: number;
}

export type SvcCodecName = 'VP8' | 'VP9' | 'H264' | 'unknown';
export type SvcFallbackMode = 'native_svc' | 'vp8_temporal_only' | 'h264_single_layer' | 'unsupported_codec' | 'missing_scalability_mode';

export interface SvcLayerSelection {
  spatialLayerId?: number;
  temporalLayerId?: number;
  qualityLayerId?: number;
}

export interface SvcLayerInfo extends SvcLayerSelection {
  codec: SvcCodecName;
  active: boolean;
  decodable: boolean;
  requiresKeyframe: boolean;
  ssrc?: number;
  maxBitrate?: number;
  dependencyLayerIds?: SvcLayerSelection[];
}

export interface SvcCapabilities {
  supported: boolean;
  codec: SvcCodecName;
  scalabilityMode?: string;
  spatialLayerCount: number;
  temporalLayerCount: number;
  fallback: SvcFallbackMode;
  canPauseIndividualLayers: boolean;
  requiresKeyframeForSpatialSwitch: boolean;
}

export interface ProducerSvcState {
  producerId: string;
  roomId: string;
  participantId: string;
  capabilities: SvcCapabilities;
  activeLayers: SvcLayerSelection[];
  availableLayers: SvcLayerInfo[];
  currentLayers?: SvcLayerSelection;
  updatedAt: string;
}

export type ProducerDynacastEventType = 'layers-needed' | 'layers-unneeded' | 'updated';

export type ProducerDynacastReason =
  | 'initial'
  | 'consumer_joined'
  | 'consumer_left'
  | 'consumer_paused'
  | 'consumer_resumed'
  | 'preferred_layers'
  | 'bandwidth'
  | 'layer_active'
  | 'producer_paused'
  | 'producer_resumed'
  | 'producer_closed'
  | 'manual'
  | 'unknown';

export interface ProducerDynacastLayerState {
  layer: RtpLayerSelection;
  active: boolean;
  desired: boolean;
  suspended: boolean;
  demandCount: number;
  consumerIds: string[];
  maxBitrate?: number;
  rid?: string;
  ssrc?: number;
  stateChangedAt?: string;
  activeDurationMs?: number;
  suspendedDurationMs?: number;
}

export interface ProducerDynacastState {
  producerId: string;
  roomId: string;
  participantId: string;
  enabled: boolean;
  activeLayers: RtpLayerSelection[];
  desiredLayers: RtpLayerSelection[];
  suspendedLayers: RtpLayerSelection[];
  highestRequiredSpatialLayer?: number;
  highestRequiredTemporalLayer?: number;
  layers: ProducerDynacastLayerState[];
  layerDemandChanges: number;
  layerResumeCount: number;
  layerSuspendCount: number;
  estimatedBandwidthSavedBps: number;
  estimatedIngressBandwidthSavedBps: number;
  activeLayerDurationMs: number;
  suspendedLayerDurationMs: number;
  reason: ProducerDynacastReason;
  updatedAt: string;
}

export interface ProducerDynacastEvent {
  type: ProducerDynacastEventType;
  producerId: string;
  roomId: string;
  participantId: string;
  enabled: boolean;
  activeLayers: RtpLayerSelection[];
  desiredLayers: RtpLayerSelection[];
  suspendedLayers: RtpLayerSelection[];
  neededLayers: RtpLayerSelection[];
  unneededLayers: RtpLayerSelection[];
  reason: ProducerDynacastReason;
  estimatedBandwidthSavedBps: number;
  state: ProducerDynacastState;
  timestamp: string;
}

export interface ProducerLayerState {
  producerId: string;
  roomId: string;
  participantId: string;
  availableLayers: RtpLayerInfo[];
  currentLayers?: RtpLayerSelection;
  svc?: ProducerSvcState;
  dynacast?: ProducerDynacastState;
  updatedAt: string;
}

export interface RtpCodecParameters {
  mimeType: string;
  payloadType: number;
  clockRate: number;
  channels?: number;
  parameters?: Record<string, string | number | boolean>;
  rtcpFeedback?: string[];
}

export interface RtpEncodingParameters {
  rid?: string;
  ssrc?: number;
  rtx?: {
    ssrc?: number;
    payloadType?: number;
  };
  spatialLayer?: number;
  temporalLayer?: number;
  active?: boolean;
  maxBitrate?: number;
  scaleResolutionDownBy?: number;
  scalabilityMode?: string;
}

export type RtpHeaderExtensionDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

export interface RtpHeaderExtensionParameters {
  uri: string;
  id: number;
  direction?: RtpHeaderExtensionDirection;
  encrypt?: boolean;
  parameters?: Record<string, string | number | boolean>;
}

export interface RtpParameters {
  codecs: RtpCodecParameters[];
  headerExtensions?: RtpHeaderExtensionParameters[];
  encodings: RtpEncodingParameters[];
  simulcast?: {
    direction: 'send' | 'recv';
    rids: string[];
    pausedRids?: string[];
  };
  rtcp: {
    cname: string;
    reducedSize: boolean;
  };
}

export interface Producer {
  id: string;
  participantId: string;
  roomId: string;
  kind: ProducerKind;
  transportId: string;
  priority?: number;
  rtpParameters: RtpParameters;
  availableLayers?: RtpLayerInfo[];
  currentLayers?: RtpLayerSelection;
  svc?: ProducerSvcState;
  dynacast?: ProducerDynacastState;
  quality?: ProducerQualityState;
  policyDecision?: RoomAutopilotDecision;
  status: ProducerStatus;
  createdAt: string;
}

export interface CreateProducerRequest {
  roomId: string;
  kind: ProducerKind;
  transportId: string;
  priority?: number;
  rtpParameters: RtpParameters;
}

export interface ProducerDynacastControlFailureReport {
  producerId: string;
  reason: string;
  layer?: RtpLayerSelection;
}
