import type { RtpLayerSelection, RtpParameters } from './producers.js';

export type ConsumerStatus = 'live' | 'paused' | 'closed';

export interface Consumer {
  id: string;
  producerId: string;
  participantId: string;
  roomId: string;
  transportId: string;
  preferredLayer?: 'low' | 'medium' | 'high';
  preferredLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  rtpParameters: RtpParameters;
  status: ConsumerStatus;
  createdAt: string;
}

export interface CreateConsumerRequest {
  roomId: string;
  producerId: string;
  transportId: string;
  preferredLayer?: 'low' | 'medium' | 'high';
  preferredLayers?: RtpLayerSelection;
}

export interface SetConsumerPreferredLayersRequest {
  consumerId: string;
  preferredLayers: RtpLayerSelection;
}
