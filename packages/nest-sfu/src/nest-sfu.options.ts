import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency, Type } from '@nestjs/common';
import type { ProducerKind, RtpLayerInfo, RtpLayerSelection } from '@native-sfu/contracts';
import type {
  FullIntraRequest,
  NackFeedback,
  PictureLossIndication,
  ReceiverEstimatedMaximumBitrate,
  ReceiverReport,
  RtcpDirection,
  RtcpDropReason,
  RtcpFeedbackKind,
  BandwidthEstimate,
  PacketPacingQueueSnapshot,
  RtpPacketDropReason,
  SenderReport,
  TransportWideCcFeedback
} from '@native-sfu/sfu-core';
import type { TurnServerOptions } from './ice/ice.types';

export interface NestSfuMetricsHooks {
  onForwardedRtpPacket?: (kind: ProducerKind) => void;
  onDroppedRtpPacket?: (reason: RtpPacketDropReason) => void;
  onBufferedRtpPacket?: (ssrc: number, sequenceNumber: number) => void;
  onRtpStreamRestart?: (producerId: string, ssrc: number) => void;
  onForwardedRtcpPacket?: (kind: RtcpFeedbackKind, direction: RtcpDirection) => void;
  onDroppedRtcpPacket?: (reason: RtcpDropReason) => void;
  onRetransmittedRtpPacket?: (kind: ProducerKind) => void;
  onRetransmissionMiss?: (ssrc: number, sequenceNumber: number) => void;
  onKeyframeRequestForwarded?: (producerId: string, feedbackKind: 'pli' | 'fir') => void;
  onKeyframeRequestCoalesced?: (producerId: string, feedbackKind: 'pli' | 'fir') => void;
  onTwccPacketArrival?: (id: string, sequenceNumber: number, direction: 'incoming' | 'outgoing') => void;
  onTwccFeedback?: (consumerId: string, feedback: TransportWideCcFeedback) => void;
  onBandwidthEstimate?: (id: string, estimate: BandwidthEstimate) => void;
  onPacingQueueDepth?: (snapshot: PacketPacingQueueSnapshot) => void;
  onKeyframeDetected?: (producerId: string, ssrc: number, codec: string) => void;
  onKeyframeGateOpened?: (consumerId: string, producerId: string) => void;
  onKeyframeGateDropped?: (consumerId: string, producerId: string) => void;
  onProducerLayerActive?: (producerId: string, layer: RtpLayerInfo) => void;
  onConsumerLayersChanged?: (consumerId: string, layers: RtpLayerSelection) => void;
  onLayerSwitch?: (consumerId: string, producerId: string, from: RtpLayerSelection | undefined, to: RtpLayerSelection) => void;
  onLayerSwitchFailed?: (consumerId: string, producerId: string, target: RtpLayerSelection, reason: 'missing_keyframe' | 'missing_layer') => void;
  onSenderReport?: (roomId: string, participantId: string, report: SenderReport) => void;
  onReceiverReport?: (roomId: string, participantId: string, report: ReceiverReport) => void;
  onNack?: (roomId: string, participantId: string, feedback: NackFeedback) => void;
  onPli?: (roomId: string, participantId: string, feedback: PictureLossIndication) => void;
  onFir?: (roomId: string, participantId: string, feedback: FullIntraRequest) => void;
  onRemb?: (roomId: string, participantId: string, feedback: ReceiverEstimatedMaximumBitrate) => void;
  onTwcc?: (roomId: string, participantId: string, feedback: TransportWideCcFeedback) => void;
}

export interface NestSfuOptions {
  turnSecret: string;
  turnUris: string[];
  stunServers?: string[];
  turnServers?: TurnServerOptions[];
  hostCandidatePort?: number;
  hostCandidatePortRange?: {
    min: number;
    max: number;
  };
  includeLoopbackCandidates?: boolean;
  gatherInterfaces?: string[];
  iceRole?: 'controlling' | 'controlled';
  iceTaMs?: number;
  iceTransactionTimeoutMs?: number;
  consentIntervalMs?: number;
  consentTimeoutMs?: number;
  maxConsentFailures?: number;
  turnCredentialTtlSeconds?: number;
  rtpRetransmissionCacheSize?: number;
  keyframeRequestIntervalMs?: number;
  maxRtpReorderPackets?: number;
  rtpRestartSequenceGap?: number;
  rtpDuplicateWindowSize?: number;
  enableTwcc?: boolean;
  enablePacing?: boolean;
  enableJoinKeyframeGate?: boolean;
  enableAdaptiveLayerSelection?: boolean;
  defaultPacingBitrateBps?: number;
  maxPacingQueueBytes?: number;
  twccFeedbackIntervalMs?: number;
  metrics?: NestSfuMetricsHooks;
}

export interface NestSfuOptionsFactory {
  createNestSfuOptions(): Promise<NestSfuOptions> | NestSfuOptions;
}

export interface NestSfuAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useExisting?: Type<NestSfuOptionsFactory>;
  useClass?: Type<NestSfuOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<NestSfuOptions> | NestSfuOptions;
}
