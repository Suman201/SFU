import type { RtpParameters } from './producers.js';

export type ConsumerStatus = 'live' | 'paused' | 'closed';

export interface Consumer {
  id: string;
  producerId: string;
  participantId: string;
  roomId: string;
  preferredLayer?: 'low' | 'medium' | 'high';
  rtpParameters: RtpParameters;
  status: ConsumerStatus;
  createdAt: string;
}

export interface CreateConsumerRequest {
  roomId: string;
  producerId: string;
  preferredLayer?: 'low' | 'medium' | 'high';
}
