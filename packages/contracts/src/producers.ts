export type ProducerKind = 'audio' | 'video' | 'screen';
export type ProducerStatus = 'live' | 'paused' | 'closed';

export interface RtpCodecParameters {
  mimeType: string;
  payloadType: number;
  clockRate: number;
  channels?: number;
  rtcpFeedback?: string[];
}

export interface RtpEncodingParameters {
  rid?: 'low' | 'medium' | 'high';
  ssrc: number;
  maxBitrate?: number;
  scaleResolutionDownBy?: number;
}

export interface RtpParameters {
  codecs: RtpCodecParameters[];
  encodings: RtpEncodingParameters[];
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
  rtpParameters: RtpParameters;
  status: ProducerStatus;
  createdAt: string;
}

export interface CreateProducerRequest {
  roomId: string;
  kind: ProducerKind;
  transportId: string;
  rtpParameters: RtpParameters;
}
