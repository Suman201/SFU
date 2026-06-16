import type { ConsumerQualityState } from './metrics.js';
import type { RtpLayerSelection, RtpParameters, SvcLayerSelection } from './producers.js';

export type ConsumerStatus = 'live' | 'paused' | 'closed';
export type ConsumerLayerEventType = 'changed' | 'switching' | 'unavailable' | 'switch-failed';
export type ConsumerLayerSwitchReason = 'initial' | 'preferred' | 'bandwidth' | 'keyframe' | 'unavailable' | 'manual' | 'unknown';

export interface ConsumerLayerState {
  roomId: string;
  participantId: string;
  consumerId: string;
  producerId: string;
  preferredLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  switchedAt?: string;
  switchReason?: ConsumerLayerSwitchReason;
}

export interface ConsumerLayerEvent {
  type: ConsumerLayerEventType;
  roomId: string;
  participantId: string;
  consumerId: string;
  producerId: string;
  previousLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  preferredLayers?: RtpLayerSelection;
  previousSvcLayers?: SvcLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  reason: ConsumerLayerSwitchReason | 'missing_keyframe' | 'missing_layer';
  timestamp: string;
  switchDurationMs?: number;
}

export interface Consumer {
  id: string;
  producerId: string;
  participantId: string;
  roomId: string;
  transportId: string;
  priority?: number;
  preferredLayer?: 'low' | 'medium' | 'high';
  preferredLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  layerState?: ConsumerLayerState;
  quality?: ConsumerQualityState;
  rtpParameters: RtpParameters;
  status: ConsumerStatus;
  createdAt: string;
}

export interface CreateConsumerRequest {
  roomId: string;
  producerId: string;
  transportId: string;
  priority?: number;
  preferredLayer?: 'low' | 'medium' | 'high';
  preferredLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
}

export interface SetConsumerPreferredLayersRequest {
  consumerId: string;
  preferredLayers: RtpLayerSelection;
}

export interface SetConsumerPreferredSvcLayersRequest {
  consumerId: string;
  preferredSvcLayers: SvcLayerSelection;
}

export interface SetConsumerPriorityRequest {
  consumerId: string;
  priority: number;
}
