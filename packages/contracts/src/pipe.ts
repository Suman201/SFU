import type { ConsumerStatus } from './consumers.js';
import type { ProducerKind, ProducerStatus, RtpLayerSelection, RtpParameters, SvcLayerSelection } from './producers.js';

export type PipeTransportProtocol = 'internal' | 'udp';

export type PipeErrorCode =
  | 'disabled'
  | 'unauthorized'
  | 'owner_mismatch'
  | 'unknown_node'
  | 'timeout'
  | 'invalid_message'
  | 'rate_limited'
  | 'peer_admission_failed'
  | 'worker_unsupported'
  | 'transport_error';

export type PipeCoordinationType =
  | 'pipe:ack'
  | 'pipe:create'
  | 'pipe:close'
  | 'pipe:publish:request'
  | 'pipe:publish:release'
  | 'pipe:feed:request'
  | 'pipe:feed:release'
  | 'pipe:producer:create'
  | 'pipe:producer:state'
  | 'pipe:producer:close'
  | 'pipe:consumer:create'
  | 'pipe:consumer:state'
  | 'pipe:consumer:feedback'
  | 'pipe:consumer:close'
  | 'pipe:rtcp'
  | 'pipe:stats'
  | 'pipe:error';

export interface PipeNodeEndpoint {
  nodeId: string;
  advertiseIp?: string;
  port?: number;
}

export interface PipeSsrcMapping {
  sourceSsrc: number;
  targetSsrc: number;
}

export interface PipeAckMetadata {
  protocol?: PipeTransportProtocol;
  localEndpoint?: PipeNodeEndpoint;
}

export interface PipeAuthSignature {
  nonce: string;
  issuedAt: string;
  signature: string;
}

export interface PipeCoordinationEnvelope<T extends PipeCoordinationMessage = PipeCoordinationMessage> {
  type: T['type'];
  correlationId: string;
  idempotencyKey?: string;
  attempt?: number;
  sourceNodeId: string;
  targetNodeId: string;
  sentAt: string;
  auth?: PipeAuthSignature;
  payload: T;
}

export interface PipeMessageBase {
  type: PipeCoordinationType;
  roomId: string;
  pipeTransportId: string;
  ownerClaimedAt?: string;
}

export interface PipeAckMessage extends PipeMessageBase {
  type: 'pipe:ack';
  ok: boolean;
  requestType: Exclude<PipeCoordinationType, 'pipe:ack'>;
  requestCorrelationId: string;
  idempotencyKey: string;
  code?: PipeErrorCode;
  message?: string;
  duplicate?: boolean;
  metadata?: PipeAckMetadata;
}

export interface PipeCreateMessage extends PipeMessageBase {
  type: 'pipe:create';
  ownerNodeId: string;
  remoteNodeId: string;
  protocol: PipeTransportProtocol;
  peerToken?: string;
  local: PipeNodeEndpoint;
  remote?: PipeNodeEndpoint;
}

export interface PipeFeedRequestMessage extends PipeMessageBase {
  type: 'pipe:feed:request';
  ownerNodeId: string;
  remoteNodeId: string;
  producerId: string;
  bindingEpoch?: string;
  protocol: PipeTransportProtocol;
  status?: ConsumerStatus;
  priority?: number;
  preferredLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
}

export interface PipePublishRequestMessage extends PipeMessageBase {
  type: 'pipe:publish:request';
  ownerNodeId: string;
  remoteNodeId: string;
  producerId: string;
  participantId: string;
  kind: ProducerKind;
  rtpParameters: RtpParameters;
  bindingEpoch?: string;
  protocol: PipeTransportProtocol;
  status?: ProducerStatus;
  priority?: number;
}

export interface PipePublishReleaseMessage extends PipeMessageBase {
  type: 'pipe:publish:release';
  ownerNodeId: string;
  remoteNodeId: string;
  producerId: string;
  bindingEpoch?: string;
  reason?: 'producer_closed' | 'participant_left' | 'room_closed' | 'manual' | 'error' | 'stale_ack';
}

export interface PipeFeedReleaseMessage extends PipeMessageBase {
  type: 'pipe:feed:release';
  ownerNodeId: string;
  remoteNodeId: string;
  producerId: string;
  bindingEpoch?: string;
  reason?: 'consumer_closed' | 'participant_left' | 'room_closed' | 'manual' | 'error' | 'stale_ack';
}

export interface PipeCloseMessage extends PipeMessageBase {
  type: 'pipe:close';
  reason?: 'room_closed' | 'node_left' | 'producer_closed' | 'consumer_closed' | 'manual' | 'error' | 'stale_ack';
}

export interface PipeProducerCreateMessage extends PipeMessageBase {
  type: 'pipe:producer:create';
  producerId: string;
  participantId: string;
  kind: ProducerKind;
  rtpParameters: RtpParameters;
  bindingEpoch?: string;
  status?: ProducerStatus;
  priority?: number;
  ssrcMappings?: PipeSsrcMapping[];
}

export interface PipeProducerStateMessage extends PipeMessageBase {
  type: 'pipe:producer:state';
  ownerNodeId: string;
  remoteNodeId: string;
  producerId: string;
  bindingEpoch?: string;
  status?: ProducerStatus;
  priority?: number;
}

export interface PipeProducerCloseMessage extends PipeMessageBase {
  type: 'pipe:producer:close';
  producerId: string;
  bindingEpoch?: string;
  reason?: 'producer_closed' | 'consumer_closed' | 'room_closed' | 'node_left' | 'manual' | 'error' | 'stale_ack';
}

export interface PipeConsumerCreateMessage extends PipeMessageBase {
  type: 'pipe:consumer:create';
  consumerId: string;
  producerId: string;
  participantId: string;
  rtpParameters: RtpParameters;
  bindingEpoch?: string;
  stateVersion?: number;
  status?: ConsumerStatus;
  priority?: number;
  preferredLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  ssrcMappings?: PipeSsrcMapping[];
}

export interface PipeConsumerStateMessage extends PipeMessageBase {
  type: 'pipe:consumer:state';
  ownerNodeId: string;
  remoteNodeId: string;
  consumerId: string;
  producerId: string;
  bindingEpoch?: string;
  stateVersion?: number;
  status?: ConsumerStatus;
  priority?: number;
  preferredLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
}

export interface PipeConsumerFeedbackObservation {
  packetLoss: number;
  delayVariationMs: number;
  jitter?: number;
  rtt?: number;
  sendDeltaMs?: number;
  receiveDeltaMs?: number;
  timestamp?: number;
}

export interface PipeConsumerFeedbackMessage extends PipeMessageBase {
  type: 'pipe:consumer:feedback';
  ownerNodeId: string;
  remoteNodeId: string;
  consumerId: string;
  producerId: string;
  bindingEpoch?: string;
  feedbackVersion?: number;
  observation: PipeConsumerFeedbackObservation;
}

export interface PipeConsumerCloseMessage extends PipeMessageBase {
  type: 'pipe:consumer:close';
  consumerId: string;
  producerId: string;
  bindingEpoch?: string;
  stateVersion?: number;
  reason?: 'consumer_closed' | 'producer_closed' | 'room_closed' | 'node_left' | 'manual' | 'error' | 'stale_ack';
}

export interface PipeRtcpMessage extends PipeMessageBase {
  type: 'pipe:rtcp';
  producerId?: string;
  consumerId?: string;
  direction: 'owner-to-remote' | 'remote-to-owner';
  feedbackKind?: 'sender-report' | 'receiver-report' | 'nack' | 'pli' | 'fir' | 'remb' | 'twcc';
  packetBase64: string;
}

export interface PipeStatsMessage extends PipeMessageBase {
  type: 'pipe:stats';
  active: boolean;
  rtpPackets: number;
  rtpBytes: number;
  rtcpPackets: number;
  rtcpBytes: number;
  droppedPackets: number;
  backpressureEvents: number;
  jitterMs?: number;
  rttMs?: number;
  packetLoss?: number;
}

export interface PipeErrorMessage extends PipeMessageBase {
  type: 'pipe:error';
  code: PipeErrorCode;
  message: string;
  failedCorrelationId?: string;
}

export type PipeCoordinationMessage =
  | PipeAckMessage
  | PipeCreateMessage
  | PipeCloseMessage
  | PipePublishRequestMessage
  | PipePublishReleaseMessage
  | PipeFeedRequestMessage
  | PipeFeedReleaseMessage
  | PipeProducerCreateMessage
  | PipeProducerStateMessage
  | PipeProducerCloseMessage
  | PipeConsumerCreateMessage
  | PipeConsumerStateMessage
  | PipeConsumerFeedbackMessage
  | PipeConsumerCloseMessage
  | PipeRtcpMessage
  | PipeStatsMessage
  | PipeErrorMessage;
