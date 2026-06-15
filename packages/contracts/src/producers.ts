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
  rtpParameters: RtpParameters;
  availableLayers?: RtpLayerInfo[];
  currentLayers?: RtpLayerSelection;
  status: ProducerStatus;
  createdAt: string;
}

export interface CreateProducerRequest {
  roomId: string;
  kind: ProducerKind;
  transportId: string;
  rtpParameters: RtpParameters;
}
