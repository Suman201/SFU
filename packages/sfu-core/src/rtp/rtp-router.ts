import type {
  Consumer,
  ConsumerQualityState,
  ConsumerLayerEvent,
  ConsumerLayerState,
  ConsumerLayerSwitchReason,
  LayerQualityState,
  PriorityAllocationState,
  Producer,
  ProducerQualityState,
  ProducerDynacastEvent,
  ProducerDynacastState,
  ProducerDynacastReason,
  ProducerSvcState,
  ProducerKind,
  QualityBitrateState,
  QualityIssueReason,
  RtpCodecParameters,
  RtpEncodingParameters,
  RtpLayerInfo,
  RtpLayerSelection,
  RoomQualityState,
  TransportQualityState,
  SvcLayerSelection
} from '@native-sfu/contracts';
import { BandwidthEstimator, type BandwidthEstimatorStats, type BandwidthEstimate, type ProbeClusterSnapshot } from '../bandwidth/bandwidth-estimator';
import { PacketPacingQueue, type PacketPacingQueueSnapshot } from '../bandwidth/pacing-queue';
import { detectKeyframe } from '../codecs/keyframe-detector';
import { detectSvcLayer, type SvcLayerDetectionResult } from '../codecs/svc-layer-detector';
import { detectTemporalLayer } from '../codecs/temporal-layer-detector';
import { ProducerDynacastDemandState, type DynacastDemandChange } from '../dynacast/dynacast-state';
import { allocatePriorityBudget, type PriorityAllocationResult } from '../quality/priority-allocator';
import { combineQualityScores, computeQualityScore, networkStateFromEstimate } from '../quality/quality-scorer';
import {
  parseFir,
  parseNack,
  parsePli,
  parseReceiverReport,
  parseRemb,
  parseRtcpCompound,
  parseSenderReport,
  createSenderReport,
  createNack,
  createReceiverReport,
  createPli,
  createFir,
  createRemb,
  serializeRtcpPacket,
  type ReceiverReport
} from '../rtcp/rtcp-packet';
import {
  parseTransportWideCcFeedback,
  TransportWideSequenceNumber,
  TwccArrivalTracker,
  TwccSendHistory,
  twccMetricsFromFeedback,
  type TransportWideCcFeedback,
  type TwccSendHistorySnapshot
} from '../twcc/twcc';
import {
  absoluteSendTime24,
  cloneRtpPacketWithHeaderExtension,
  getRtpHeaderExtensionId,
  negotiateRtpHeaderExtensions,
  parseRtpHeaderExtensions,
  rewriteRtpHeaderExtensions
} from './rtp-header-extension';
import { RtpPacket } from './rtp-packet';
import { ConsumerRtpRewriter, type RtpRewriteMapping, type RtpRewriteSnapshot } from './rtp-rewriter';
import { RtpSourceStreamState, type RtpPacketDropReason, type RtpStreamSnapshot } from './rtp-stream-state';
import { createRtxPacket } from './rtx';
import { RtpRetransmissionCache, type RtpRetransmissionCacheSnapshot } from './retransmission-cache';
import { ProducerSimulcastState, isKnownSsrc, normalizeLayerSelection, preferredLayerNameToSelection, sameLayer } from '../simulcast/simulcast-state';
import { ProducerSvcStateTracker, normalizeSvcLayer, sameSvcLayer, toRtpLayerSelection } from '../svc/svc-state';

export type RtpWriter = (packet: RtpPacket, consumer: Consumer) => Promise<void>;
export type RtcpFeedbackKind = 'sender-report' | 'receiver-report' | 'nack' | 'pli' | 'fir' | 'remb' | 'twcc';
export type RtcpDirection = 'producer' | 'consumer';
export type RtcpDropReason = 'unknown_ssrc' | 'producer_paused' | 'consumer_paused' | 'no_consumers' | 'missing_writer';
export type RtcpWriter = (packet: Buffer, target: Producer | Consumer, feedbackKind: RtcpFeedbackKind) => Promise<void>;

export interface RtcpRouteContext {
  sourceTransportId?: string;
  sourceParticipantId?: string;
}

export type RtpRouteContext = RtcpRouteContext;

export interface ConsumerTwccObservation {
  packetLoss: number;
  delayVariationMs: number;
  jitter?: number;
  rtt?: number;
  sendDeltaMs?: number;
  receiveDeltaMs?: number;
  timestamp?: number;
}

export interface ConsumerTwccObservationEvent {
  roomId: string;
  participantId: string;
  consumerId: string;
  producerId: string;
  transportId: string;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  preferredLayers?: RtpLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  observation: ConsumerTwccObservation;
}

export interface RtpRouterOptions {
  onForwardedPacket?: (kind: ProducerKind) => void;
  onDroppedPacket?: (reason: RtpPacketDropReason) => void;
  onBufferedPacket?: (ssrc: number, sequenceNumber: number) => void;
  onReorderGapExpired?: (ssrc: number, expectedSequenceNumber: number, releasedSequenceNumber: number) => void;
  onStreamRestart?: (producerId: string, ssrc: number) => void;
  onForwardedRtcpPacket?: (feedbackKind: RtcpFeedbackKind, direction: RtcpDirection) => void;
  onDroppedRtcpPacket?: (reason: RtcpDropReason) => void;
  onRetransmittedPacket?: (kind: ProducerKind) => void;
  onRetransmissionMiss?: (ssrc: number, sequenceNumber: number) => void;
  onKeyframeRequestForwarded?: (producerId: string, feedbackKind: 'pli' | 'fir') => void;
  onKeyframeRequestCoalesced?: (producerId: string, feedbackKind: 'pli' | 'fir') => void;
  onTwccPacketArrival?: (id: string, sequenceNumber: number, direction: 'incoming' | 'outgoing') => void;
  onTwccFeedback?: (consumerId: string, feedback: TransportWideCcFeedback) => void;
  onConsumerTwccObservation?: (state: ConsumerTwccObservationEvent) => void;
  onBandwidthEstimate?: (id: string, estimate: BandwidthEstimate) => void;
  onPacingQueueDepth?: (snapshot: PacketPacingQueueSnapshot) => void;
  onKeyframeDetected?: (producerId: string, ssrc: number, codec: string) => void;
  onKeyframeGateOpened?: (consumerId: string, producerId: string) => void;
  onKeyframeGateDropped?: (consumerId: string, producerId: string) => void;
  onProducerLayerActive?: (producerId: string, layer: RtpLayerInfo) => void;
  onProducerDynacastEvent?: (event: ProducerDynacastEvent) => void;
  onConsumerScoreUpdated?: (state: ConsumerQualityState) => void;
  onProducerScoreUpdated?: (state: ProducerQualityState) => void;
  onTransportQualityUpdated?: (state: TransportQualityState) => void;
  onRoomQualityUpdated?: (state: RoomQualityState) => void;
  onConsumerLayersChanged?: (consumerId: string, layers: RtpLayerSelection) => void;
  onLayerSwitch?: (consumerId: string, producerId: string, from: RtpLayerSelection | undefined, to: RtpLayerSelection) => void;
  onLayerSwitchFailed?: (consumerId: string, producerId: string, target: RtpLayerSelection, reason: 'missing_keyframe' | 'missing_layer') => void;
  onConsumerSvcLayersChanged?: (consumerId: string, layers: SvcLayerSelection) => void;
  onSvcLayerSwitch?: (consumerId: string, producerId: string, from: SvcLayerSelection | undefined, to: SvcLayerSelection) => void;
  onSvcLayerSwitchFailed?: (consumerId: string, producerId: string, target: SvcLayerSelection, reason: 'missing_keyframe' | 'missing_layer') => void;
  retransmissionCacheSize?: number;
  keyframeRequestIntervalMs?: number;
  maxReorderPackets?: number;
  maxReorderDelayMs?: number;
  activeLayerTimeoutMs?: number;
  restartSequenceGap?: number;
  duplicateWindowSize?: number;
  enableTwcc?: boolean;
  enablePacing?: boolean;
  enableProbeScheduling?: boolean;
  enableJoinKeyframeGate?: boolean;
  enableAdaptiveLayerSelection?: boolean;
  enableDynacast?: boolean;
  defaultPacingBitrateBps?: number;
  maxPacingQueueBytes?: number;
  twccFeedbackIntervalMs?: number;
  probeClusterIntervalMs?: number;
  probeBurstPackets?: number;
  probeBitrateMultiplier?: number;
  dynacastUpgradeHoldMs?: number;
  dynacastPriorityBias?: number;
  qualityUpdateIntervalMs?: number;
  minAudioBitrateBps?: number;
  minVideoBitrateBps?: number;
  minScreenBitrateBps?: number;
  defaultVideoBitrateBps?: number;
  defaultScreenBitrateBps?: number;
  bandwidthEstimator?: BandwidthEstimator;
  sequenceNumberGenerator?: () => number;
  timestampGenerator?: () => number;
  now?: () => number;
}

export interface RtpMetricBucket {
  packets: number;
  bytes: number;
}

export interface RtxRepairMetrics {
  requestedPackets: number;
  retransmittedPackets: number;
  rtxPackets: number;
  primaryRetransmissionPackets: number;
  missingPackets: number;
  successRate: number;
  failureRate: number;
}

export interface RtpLayerScore {
  quality: number;
  lossScore: number;
  congestionScore: number;
  degradationReason?: 'packet_loss' | 'high_jitter' | 'high_rtt' | 'congestion';
  recoveryReason?: 'stable' | 'loss_recovered' | 'congestion_recovered';
}

export interface RtpLayerMetrics {
  layer: RtpLayerSelection;
  packets: number;
  bytes: number;
  packetsLost: number;
  fractionLost: number;
  jitter: number;
  rtt: number;
  score: RtpLayerScore;
  updatedAt?: string;
}

export interface RtpConsumerStatistics {
  consumerId: string;
  producerId: string;
  roomId: string;
  participantId: string;
  transportId: string;
  primaryRtp: RtpMetricBucket;
  retransmissions: RtxRepairMetrics;
  layers: RtpLayerMetrics[];
  svcLayers: RtpLayerMetrics[];
  preferredSvcLayers?: SvcLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  lastSvcAllocationAt?: number;
  lastSvcAllocation?: SvcLayerSelection;
  bitrate: BandwidthEstimatorStats;
  twccSendHistory: TwccSendHistorySnapshot;
  pacing: PacketPacingQueueSnapshot;
  activeProbe?: ActiveProbeSnapshot;
  allocation: PriorityAllocationState;
  quality: ConsumerQualityState;
}

export interface RtpProducerStatistics {
  producerId: string;
  roomId: string;
  participantId: string;
  transportId: string;
  kind: ProducerKind;
  primaryRtp: RtpMetricBucket;
  layers: RtpLayerMetrics[];
  svcLayers: RtpLayerMetrics[];
  retransmissionCache?: RtpRetransmissionCacheSnapshot;
  streams: RtpStreamSnapshot[];
  twccArrivals: ReturnType<TwccArrivalTracker['snapshot']>;
  dynacast?: ProducerDynacastState;
  svc?: ProducerSvcState;
  quality: ProducerQualityState;
}

export interface RtpRouterStatistics {
  generatedAt: string;
  producers: RtpProducerStatistics[];
  consumers: RtpConsumerStatistics[];
  bandwidth: BandwidthEstimate[];
  pacing: PacketPacingQueueSnapshot[];
  probes: ProbeClusterSnapshot[];
  rooms: RoomQualityState[];
}

interface RouteMetrics {
  primaryRtp: RtpMetricBucket;
  layerMetrics: Map<string, LayerMetricState>;
  svcLayerMetrics: Map<string, LayerMetricState>;
  retransmission: {
    requestedPackets: number;
    retransmittedPackets: number;
    rtxPackets: number;
    primaryRetransmissionPackets: number;
    missingPackets: number;
  };
}

interface LayerMetricState {
  layer: RtpLayerSelection;
  packets: number;
  bytes: number;
  packetsLost: number;
  fractionLost: number;
  jitter: number;
  rtt: number;
  congestion: number;
  updatedAt?: number;
}

interface ActiveProbe {
  clusterId: number;
  targetPackets: number;
  packetsSent: number;
  bytesSent: number;
  startedAt: number;
}

export interface ActiveProbeSnapshot extends ActiveProbe {
  targetBitrateBps: number;
}

interface ProducerRoute {
  producer: Producer;
  paused: boolean;
  priority: number;
  ssrcs: Set<number>;
  streams: Map<number, RtpSourceStreamState>;
  simulcast: ProducerSimulcastState;
  svc: ProducerSvcStateTracker;
  dynacast: ProducerDynacastDemandState;
  cache: RtpRetransmissionCache;
  metrics: RouteMetrics;
  twccArrivals: TwccArrivalTracker;
  lastTwccFeedbackAt: number;
  rtcpWriter?: RtcpWriter;
  lastQuality?: ProducerQualityState;
  lastQualityEmittedAt?: number;
  lastQualityScore?: number;
}

interface ConsumerRoute {
  consumer: Consumer;
  paused: boolean;
  writer: RtpWriter;
  rtcpWriter?: RtcpWriter;
  rewriter: ConsumerRtpRewriter;
  twccSequence: TransportWideSequenceNumber;
  twccSendHistory: TwccSendHistory;
  rtxSequence: TransportWideSequenceNumber;
  pacer: PacketPacingQueue;
  metrics: RouteMetrics;
  activeProbe?: ActiveProbe;
  lastProbeAt?: number;
  awaitingKeyframe: boolean;
  keyframeRequested: boolean;
  priority: number;
  preferredLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  targetSvcLayers?: SvcLayerSelection;
  lastDynacastAllocationAt?: number;
  lastDynacastAllocation?: RtpLayerSelection;
  lastSvcAllocationAt?: number;
  lastSvcAllocation?: SvcLayerSelection;
  allocation?: PriorityAllocationResult;
  starvedSince?: number;
  lastQuality?: ConsumerQualityState;
  lastQualityEmittedAt?: number;
  lastQualityScore?: number;
  switchStartedAt?: number;
  switchReason?: ConsumerLayerSwitchReason;
  lastSwitchingKey?: string;
  lastFailedKey?: string;
  lastUnavailableKey?: string;
  lastExternalObservationAt?: number;
}

interface SourceEncoding {
  encoding: RtpEncodingParameters;
  index: number;
  isRtx: boolean;
  mediaSsrc: number;
}

interface ConsumerDeliveryStateSnapshot {
  awaitingKeyframe: boolean;
  keyframeRequested: boolean;
  currentLayers?: RtpLayerSelection;
  currentSvcLayers?: SvcLayerSelection;
  switchStartedAt?: number;
  switchReason?: ConsumerLayerSwitchReason;
  lastSwitchingKey?: string;
  lastFailedKey?: string;
  consumerCurrentLayers?: RtpLayerSelection;
  consumerCurrentSvcLayers?: SvcLayerSelection;
  consumerLayerState?: ConsumerLayerState;
}

interface FeedbackSsrcResolution {
  producerId: string;
  sourceSsrc: number;
  consumerRoute?: ConsumerRoute;
}

export class RtpRouter {
  private readonly producers = new Map<string, ProducerRoute>();
  private readonly producerBySsrc = new Map<number, string>();
  private readonly mediaSsrcBySsrc = new Map<number, number>();
  private readonly consumers = new Map<string, ConsumerRoute>();
  private readonly consumersByProducer = new Map<string, Set<string>>();
  private readonly participantProducers = new Map<string, Set<string>>();
  private readonly participantConsumers = new Map<string, Set<string>>();
  private readonly keyframeRequests = new Map<string, { forwardedAt: number; origin: 'internal' | 'external' }>();
  private readonly transportPacers = new Map<string, PacketPacingQueue>();
  private readonly bandwidthEstimator: BandwidthEstimator;
  private readonly lastTransportQualityScores = new Map<string, { score: number; emittedAt: number }>();
  private readonly lastRoomQualityScores = new Map<string, { score: number; emittedAt: number }>();
  private readonly layerEventListeners = new Set<(event: ConsumerLayerEvent) => void>();
  private readonly producerDynacastListeners = new Set<(event: ProducerDynacastEvent) => void>();
  private readonly consumerTwccObservationListeners = new Set<(state: ConsumerTwccObservationEvent) => void>();
  private readonly consumerQualityListeners = new Set<(state: ConsumerQualityState) => void>();
  private readonly producerQualityListeners = new Set<(state: ProducerQualityState) => void>();
  private readonly transportQualityListeners = new Set<(state: TransportQualityState) => void>();
  private readonly roomQualityListeners = new Set<(state: RoomQualityState) => void>();
  private readonly reorderDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: RtpRouterOptions = {}) {
    this.bandwidthEstimator = options.bandwidthEstimator ?? new BandwidthEstimator();
  }

  addProducer(producer: Producer, rtcpWriter?: RtcpWriter): void {
    producer.priority = normalizeConsumerPriority(producer.priority);
    const simulcast = new ProducerSimulcastState(producer, this.now, this.options.activeLayerTimeoutMs);
    const svc = new ProducerSvcStateTracker(producer, this.now, this.options.activeLayerTimeoutMs);
    const dynacast = new ProducerDynacastDemandState(producer, {
      enabled: this.options.enableDynacast !== false,
      now: this.now
    });
    dynacast.setAvailableLayers(simulcast.availableLayers(), 'initial');
    const ssrcs = new Set(simulcast.knownSsrcList());
    const streams = new Map<number, RtpSourceStreamState>();
    for (const ssrc of ssrcs) {
      streams.set(ssrc, this.createProducerStreamState(producer, ssrc));
    }
    this.producers.set(producer.id, {
      producer,
      paused: producer.status === 'paused',
      priority: producer.priority,
      ssrcs,
      streams,
      simulcast,
      svc,
      dynacast,
      cache: new RtpRetransmissionCache(this.options.retransmissionCacheSize ?? 512, this.now),
      metrics: createRouteMetrics(),
      twccArrivals: new TwccArrivalTracker(),
      lastTwccFeedbackAt: 0,
      rtcpWriter
    });
    this.addToSet(this.participantProducers, producer.participantId, producer.id);
    for (const ssrc of ssrcs) {
      this.producerBySsrc.set(ssrc, producer.id);
      this.mediaSsrcBySsrc.set(ssrc, sourceEncodingForSsrc(producer, ssrc)?.mediaSsrc ?? ssrc);
    }
  }

  removeProducer(producerId: string): void {
    const route = this.producers.get(producerId);
    if (!route) {
      return;
    }
    for (const ssrc of route.ssrcs) {
      this.producerBySsrc.delete(ssrc);
      this.mediaSsrcBySsrc.delete(ssrc);
      this.clearReorderDrainTimer(producerId, ssrc);
    }
    route.cache.clear();
    this.publishDynacastChange(route, route.dynacast.setAvailableLayers([], 'producer_closed'));
    this.producers.delete(producerId);
    this.consumersByProducer.delete(producerId);
  }

  setProducerPaused(producerId: string, paused: boolean): void {
    const route = this.producers.get(producerId);
    if (route) {
      route.paused = paused;
      this.publishDynacastChange(route, route.dynacast.setAvailableLayers(route.simulcast.availableLayers(), paused ? 'producer_paused' : 'producer_resumed'));
      this.maybeEmitQualityForProducer(route);
    }
  }

  setProducerPriority(producerId: string, priority: number): number | undefined {
    const route = this.producers.get(producerId);
    if (!route) {
      return undefined;
    }
    route.priority = normalizeConsumerPriority(priority);
    route.producer.priority = route.priority;
    for (const consumerId of this.consumersByProducer.get(producerId) ?? []) {
      const consumerRoute = this.consumers.get(consumerId);
      if (consumerRoute) {
        this.recalculateTransportAllocation(consumerRoute.consumer.transportId);
        this.maybeEmitQualityForConsumer(consumerRoute);
      }
    }
    this.maybeEmitQualityForProducer(route);
    return route.priority;
  }

  addConsumer(consumer: Consumer, writer: RtpWriter, rtcpWriter?: RtcpWriter): void {
    const preferredLayers = normalizeLayerSelection(consumer.preferredLayers ?? preferredLayerNameToSelection(consumer.preferredLayer));
    const preferredSvcLayers = normalizeOptionalSvcLayer(consumer.preferredSvcLayers);
    const consumerRoute: ConsumerRoute = {
      consumer,
      writer,
      rtcpWriter,
      paused: consumer.status === 'paused',
      rewriter: new ConsumerRtpRewriter({
        sequenceNumberGenerator: this.options.sequenceNumberGenerator,
        timestampGenerator: this.options.timestampGenerator
      }),
      twccSequence: new TransportWideSequenceNumber(),
      twccSendHistory: new TwccSendHistory(),
      rtxSequence: new TransportWideSequenceNumber(this.options.sequenceNumberGenerator?.()),
      pacer: new PacketPacingQueue({
        id: `consumer:${consumer.id}`,
        targetBitrateBps: this.options.defaultPacingBitrateBps ?? 50_000_000,
        maxQueueBytes: this.options.maxPacingQueueBytes,
        now: this.now,
        onQueueDepth: (snapshot) => this.options.onPacingQueueDepth?.(snapshot)
      }),
      metrics: createRouteMetrics(),
      awaitingKeyframe: this.shouldGateConsumerUntilKeyframe(consumer),
      keyframeRequested: false,
      priority: normalizeConsumerPriority(consumer.priority),
      preferredLayers,
      currentLayers: normalizeLayerSelection(consumer.currentLayers),
      targetLayers: preferredLayers,
      preferredSvcLayers,
      currentSvcLayers: normalizeOptionalSvcLayer(consumer.currentSvcLayers),
      targetSvcLayers: preferredSvcLayers
    };
    consumer.priority = consumerRoute.priority;
    consumer.preferredLayers = preferredLayers;
    consumer.currentLayers = consumerRoute.currentLayers;
    consumer.preferredSvcLayers = preferredSvcLayers;
    consumer.currentSvcLayers = consumerRoute.currentSvcLayers;
    this.consumers.set(consumer.id, consumerRoute);
    this.addToSet(this.consumersByProducer, consumer.producerId, consumer.id);
    this.addToSet(this.participantConsumers, consumer.participantId, consumer.id);
    this.updateDynacastConsumerDemand(consumerRoute, 'consumer_joined');
    if (consumerRoute.awaitingKeyframe) {
      void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
    }
  }

  removeConsumer(consumerId: string): void {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return;
    }
    this.consumers.delete(consumerId);
    this.consumersByProducer.get(route.consumer.producerId)?.delete(consumerId);
    this.participantConsumers.get(route.consumer.participantId)?.delete(consumerId);
    const producerRoute = this.producers.get(route.consumer.producerId);
    if (producerRoute) {
      this.publishDynacastChange(producerRoute, producerRoute.dynacast.removeConsumer(consumerId, 'consumer_left'));
    }
    if (![...this.consumers.values()].some((consumerRoute) => consumerRoute.consumer.transportId === route.consumer.transportId)) {
      this.transportPacers.delete(route.consumer.transportId);
    }
  }

  setConsumerPaused(consumerId: string, paused: boolean): void {
    const route = this.consumers.get(consumerId);
    if (route) {
      route.paused = paused;
      route.consumer.status = paused ? 'paused' : 'live';
      if (!paused) {
        route.awaitingKeyframe = this.shouldGateConsumerUntilKeyframe(route.consumer);
        route.keyframeRequested = false;
        if (route.awaitingKeyframe) {
          void this.requestKeyframeForConsumer(route).catch(() => undefined);
        }
      }
      this.updateDynacastConsumerDemand(route, paused ? 'consumer_paused' : 'consumer_resumed');
    }
  }

  onConsumerLayerEvent(listener: (event: ConsumerLayerEvent) => void): () => void {
    this.layerEventListeners.add(listener);
    return () => this.layerEventListeners.delete(listener);
  }

  onProducerDynacastEvent(listener: (event: ProducerDynacastEvent) => void): () => void {
    this.producerDynacastListeners.add(listener);
    return () => this.producerDynacastListeners.delete(listener);
  }

  onConsumerTwccObservation(listener: (state: ConsumerTwccObservationEvent) => void): () => void {
    this.consumerTwccObservationListeners.add(listener);
    return () => this.consumerTwccObservationListeners.delete(listener);
  }

  onConsumerScoreUpdated(listener: (state: ConsumerQualityState) => void): () => void {
    this.consumerQualityListeners.add(listener);
    return () => this.consumerQualityListeners.delete(listener);
  }

  onProducerScoreUpdated(listener: (state: ProducerQualityState) => void): () => void {
    this.producerQualityListeners.add(listener);
    return () => this.producerQualityListeners.delete(listener);
  }

  onTransportQualityUpdated(listener: (state: TransportQualityState) => void): () => void {
    this.transportQualityListeners.add(listener);
    return () => this.transportQualityListeners.delete(listener);
  }

  onRoomQualityUpdated(listener: (state: RoomQualityState) => void): () => void {
    this.roomQualityListeners.add(listener);
    return () => this.roomQualityListeners.delete(listener);
  }

  setConsumerPreferredLayers(consumerId: string, preferredLayers: RtpLayerSelection): RtpLayerSelection | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    route.preferredLayers = normalizeLayerSelection(preferredLayers);
    route.targetLayers = route.preferredLayers;
    route.consumer.preferredLayers = route.preferredLayers;
    this.updateDynacastConsumerDemand(route, 'preferred_layers');
    if (!sameLayer(route.currentLayers, route.targetLayers)) {
      route.keyframeRequested = false;
      const producerRoute = this.producers.get(route.consumer.producerId);
      if (producerRoute && route.targetLayers) {
        this.startLayerSwitch(route, producerRoute, route.targetLayers, 'preferred');
      }
      void this.requestKeyframeForConsumer(route).catch(() => undefined);
    }
    return route.preferredLayers;
  }

  setConsumerPreferredSvcLayers(consumerId: string, preferredSvcLayers: SvcLayerSelection): SvcLayerSelection | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    route.preferredSvcLayers = normalizeSvcLayer(preferredSvcLayers);
    route.targetSvcLayers = route.preferredSvcLayers;
    route.consumer.preferredSvcLayers = route.preferredSvcLayers;
    route.consumer.targetSvcLayers = route.targetSvcLayers;
    const producerRoute = this.producers.get(route.consumer.producerId);
    if (producerRoute && route.targetSvcLayers) {
      this.startSvcLayerSwitch(route, producerRoute, route.targetSvcLayers, 'preferred');
      if (!this.sameSvcSpatialLayer(route.currentSvcLayers, route.targetSvcLayers)) {
        route.keyframeRequested = false;
        void this.requestKeyframeForConsumer(route).catch(() => undefined);
      }
    }
    return route.preferredSvcLayers;
  }

  setConsumerPriority(consumerId: string, priority: number): number | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    route.priority = normalizeConsumerPriority(priority);
    route.consumer.priority = route.priority;
    this.updateDynacastConsumerDemand(route, 'bandwidth');
    this.recalculateTransportAllocation(route.consumer.transportId);
    this.maybeEmitQualityForConsumer(route);
    return route.priority;
  }

  consumerLayerSnapshot(consumerId: string): ConsumerLayerState | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    return {
      roomId: route.consumer.roomId,
      participantId: route.consumer.participantId,
      consumerId: route.consumer.id,
      producerId: route.consumer.producerId,
      preferredLayers: route.preferredLayers,
      currentLayers: route.currentLayers,
      targetLayers: route.targetLayers,
      preferredSvcLayers: route.preferredSvcLayers,
      currentSvcLayers: route.currentSvcLayers,
      targetSvcLayers: route.targetSvcLayers,
      switchedAt: route.consumer.layerState?.switchedAt,
      switchReason: route.switchReason ?? route.consumer.layerState?.switchReason
    };
  }

  producerLayerSnapshot(producerId: string): { availableLayers: RtpLayerInfo[]; currentLayers?: RtpLayerSelection; svc?: ProducerSvcState; dynacast?: ProducerDynacastState } | undefined {
    const route = this.producers.get(producerId);
    if (!route) {
      return undefined;
    }
    return {
      availableLayers: route.simulcast.availableLayers(),
      currentLayers: route.simulcast.currentLayers(),
      svc: route.svc.snapshot(),
      dynacast: route.dynacast.snapshot()
    };
  }

  producerDynacastSnapshot(producerId: string): ProducerDynacastState | undefined {
    return this.producers.get(producerId)?.dynacast.snapshot();
  }

  applyExternalConsumerTwccObservation(
    consumerId: string,
    observation: ConsumerTwccObservation
  ): ConsumerQualityState | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    const timestamp = observation.timestamp ?? this.now();
    if (route.lastExternalObservationAt !== undefined && timestamp <= route.lastExternalObservationAt) {
      return route.lastQuality ?? this.buildConsumerQuality(route, timestamp);
    }
    route.lastExternalObservationAt = timestamp;
    return this.applyTwccObservationToRoute(route, { ...observation, timestamp }, { emitObservation: false });
  }

  consumerQualitySnapshot(consumerId: string): ConsumerQualityState | undefined {
    const route = this.consumers.get(consumerId);
    return route ? this.buildConsumerQuality(route, this.now()) : undefined;
  }

  producerQualitySnapshot(producerId: string): ProducerQualityState | undefined {
    const route = this.producers.get(producerId);
    return route ? this.buildProducerQuality(route, this.now()) : undefined;
  }

  transportQualitySnapshot(transportId: string): TransportQualityState | undefined {
    return this.buildTransportQuality(transportId, this.now());
  }

  roomQualitySnapshot(roomId: string): RoomQualityState | undefined {
    return this.buildRoomQuality(roomId, this.now());
  }

  roomQualitySnapshots(): RoomQualityState[] {
    const roomIds = new Set<string>([...this.producers.values()].map((route) => route.producer.roomId).concat([...this.consumers.values()].map((route) => route.consumer.roomId)));
    return [...roomIds].map((roomId) => this.buildRoomQuality(roomId, this.now())).filter((state): state is RoomQualityState => Boolean(state));
  }

  async route(buffer: Buffer, context: RtpRouteContext = {}): Promise<number> {
    let packet: RtpPacket;
    try {
      packet = RtpPacket.parse(buffer);
    } catch (error) {
      this.options.onDroppedPacket?.(error instanceof Error && error.message.includes('Unsupported RTP version') ? 'invalid_version' : 'invalid_packet');
      return 0;
    }
    const resolution = this.resolveProducerForPacket(packet, context);
    if (!resolution) {
      this.options.onDroppedPacket?.('unknown_ssrc');
      return 0;
    }
    const { producerId, producerRoute, stream } = resolution;
    if (!producerRoute || producerRoute.paused) {
      this.options.onDroppedPacket?.('producer_paused');
      return 0;
    }
    const accepted = stream.accept(packet);
    if (accepted.dropReason) {
      this.options.onDroppedPacket?.(accepted.dropReason);
      if (accepted.packets.length === 0) {
        return 0;
      }
    }
    if (accepted.expiredGap) {
      this.options.onReorderGapExpired?.(
        accepted.expiredGap.ssrc,
        accepted.expiredGap.previousExpectedSequenceNumber,
        accepted.expiredGap.releasedSequenceNumber
      );
    }
    if (accepted.buffered) {
      this.options.onBufferedPacket?.(packet.ssrc, packet.sequenceNumber);
      this.scheduleReorderDrain(producerId, packet.ssrc);
      return 0;
    }
    if (accepted.restarted) {
      this.options.onStreamRestart?.(producerId, packet.ssrc);
      for (const consumerId of this.consumersByProducer.get(producerId) ?? []) {
        this.consumers.get(consumerId)?.rewriter.resetSource(packet.ssrc);
      }
    }
    this.clearReorderDrainTimer(producerId, packet.ssrc);
    const forwarded = await this.forwardReleasedPackets(producerId, producerRoute, accepted.packets, buffer.length);
    if (stream.snapshot().packetsBuffered > 0) {
      this.scheduleReorderDrain(producerId, packet.ssrc);
    }
    return forwarded;
  }

  private async forwardReleasedPackets(producerId: string, producerRoute: ProducerRoute, packets: RtpPacket[], fallbackSize: number): Promise<number> {
    const consumerIds = this.consumersByProducer.get(producerId);
    if (!consumerIds || consumerIds.size === 0) {
      this.options.onDroppedPacket?.('no_consumers');
      return 0;
    }
    let forwarded = 0;
    for (const released of packets) {
      const releasedSize = fallbackSize || released.serialize().length;
      recordMetric(producerRoute.metrics.primaryRtp, releasedSize);
      producerRoute.cache.store(released);
      this.recordInboundAdaptiveState(producerRoute, released, releasedSize);
      const svcDetection = this.packetSvcLayer(producerRoute, released);
      const temporalLayer = this.packetTemporalLayer(producerRoute, released);
      const svcActivity = svcDetection ? producerRoute.svc.markPacket(released.ssrc, svcDetection) : undefined;
      const activity = svcDetection ? undefined : producerRoute.simulcast.markPacket(released.ssrc, temporalLayer);
      const packetLayer = svcDetection ? producerRoute.svc.layerSelectionForPacket(svcDetection) : producerRoute.simulcast.layerSelectionForSsrc(released.ssrc, temporalLayer);
      if (packetLayer) {
        recordLayerPacket(producerRoute.metrics, packetLayer, releasedSize, this.now());
      }
      if (svcActivity?.layer) {
        recordSvcLayerPacket(producerRoute.metrics, toRtpLayerSelection(svcActivity.layer) ?? packetLayer ?? {}, releasedSize, this.now());
      }
      if (activity?.becameActive) {
        this.options.onProducerLayerActive?.(producerId, activity.layer);
        this.publishDynacastChange(producerRoute, producerRoute.dynacast.setAvailableLayers(producerRoute.simulcast.availableLayers(), 'layer_active'));
      }
      for (const consumerId of consumerIds) {
        const consumerRoute = this.consumers.get(consumerId);
        if (!consumerRoute) {
          continue;
        }
        const deliveryState = captureConsumerDeliveryState(consumerRoute);
        if (consumerRoute.paused || !packetLayer || !this.shouldForwardLayer(producerRoute, consumerRoute, released, packetLayer, Boolean(svcDetection))) {
          continue;
        }
        if (this.shouldHoldForKeyframe(producerRoute, consumerRoute, released)) {
          continue;
        }
        const rewritten = this.rewriteForConsumer(producerRoute.producer, consumerRoute, released);
        if (!rewritten) {
          restoreConsumerDeliveryState(consumerRoute, deliveryState);
          this.options.onDroppedPacket?.('invalid_ssrc');
          continue;
        }
        try {
          await this.sendRtpToConsumer(consumerRoute, rewritten, { kind: 'primary', layer: packetLayer, svcLayer: svcDetection ? toRtpLayerSelection(producerRoute.svc.svcSelectionForPacket(svcDetection)) : undefined });
        } catch {
          restoreConsumerDeliveryState(consumerRoute, deliveryState);
          continue;
        }
        this.options.onForwardedPacket?.(producerRoute.producer.kind);
        forwarded += 1;
      }
    }
    return forwarded;
  }

  async routeRtcp(buffer: Buffer, context: RtcpRouteContext = {}): Promise<number> {
    let forwarded = 0;
    for (const packet of parseRtcpCompound(buffer)) {
      const rawPacket = serializeRtcpPacket(packet);
      const senderReport = parseSenderReport(packet);
      if (senderReport) {
        forwarded += await this.routeRtcpToConsumers(senderReport.senderSsrc, rawPacket, 'sender-report');
        continue;
      }
      const receiverReport = parseReceiverReport(packet);
      if (receiverReport) {
        forwarded += await this.routeReceiverReport(receiverReport, context);
        continue;
      }
      const twcc = parseTransportWideCcFeedback(packet);
      if (twcc) {
        this.handleTwccFeedback(twcc, context);
        continue;
      }
      const nack = parseNack(packet);
      if (nack) {
        forwarded += await this.handleNack(nack.senderSsrc, nack.mediaSsrc, nack.lostPacketIds, rawPacket, context);
        continue;
      }
      const pli = parsePli(packet);
      if (pli) {
        forwarded += await this.routePli(pli.senderSsrc, pli.mediaSsrc, context);
        continue;
      }
      const fir = parseFir(packet);
      if (fir) {
        forwarded += await this.routeFir(fir.senderSsrc, fir.mediaSsrc, fir.entries, context);
        continue;
      }
      const remb = parseRemb(packet);
      if (remb) {
        forwarded += await this.routeRemb(remb.senderSsrc, remb.mediaSsrc, remb.bitrateBps, remb.ssrcs, context);
      }
    }
    return forwarded;
  }

  retransmissionCacheSnapshot(producerId: string): RtpRetransmissionCacheSnapshot | undefined {
    return this.producers.get(producerId)?.cache.snapshot();
  }

  streamSnapshots(producerId: string): RtpStreamSnapshot[] {
    return [...(this.producers.get(producerId)?.streams.values() ?? [])].map((stream) => stream.snapshot());
  }

  consumerRewriteSnapshot(consumerId: string): RtpRewriteSnapshot[] {
    return this.consumers.get(consumerId)?.rewriter.snapshot() ?? [];
  }

  twccSnapshot(id: string): ReturnType<TwccArrivalTracker['snapshot']> | undefined {
    return this.producers.get(id)?.twccArrivals.snapshot();
  }

  bandwidthEstimate(id: string): BandwidthEstimate {
    return this.bandwidthEstimator.estimate(id);
  }

  bandwidthEstimates(): BandwidthEstimate[] {
    return this.bandwidthEstimator.snapshot();
  }

  pacingSnapshots(): PacketPacingQueueSnapshot[] {
    return [...this.consumers.values()].map((route) => route.pacer.snapshot()).concat([...this.transportPacers.values()].map((pacer) => pacer.snapshot()));
  }

  statistics(): RtpRouterStatistics {
    const now = this.now();
    return {
      generatedAt: new Date(now).toISOString(),
      producers: [...this.producers.values()].map((route) => ({
        producerId: route.producer.id,
        roomId: route.producer.roomId,
        participantId: route.producer.participantId,
        transportId: route.producer.transportId,
        kind: route.producer.kind,
        primaryRtp: { ...route.metrics.primaryRtp },
        layers: layerMetricsSnapshot(route.metrics),
        svcLayers: svcLayerMetricsSnapshot(route.metrics),
        retransmissionCache: route.cache.snapshot(),
        streams: [...route.streams.values()].map((stream) => stream.snapshot()),
        twccArrivals: route.twccArrivals.snapshot(),
        dynacast: route.dynacast.snapshot(),
        svc: route.svc.snapshot(),
        quality: this.buildProducerQuality(route, now)
      })),
      consumers: [...this.consumers.values()].map((route) => ({
        consumerId: route.consumer.id,
        producerId: route.consumer.producerId,
        roomId: route.consumer.roomId,
        participantId: route.consumer.participantId,
        transportId: route.consumer.transportId,
        primaryRtp: { ...route.metrics.primaryRtp },
        retransmissions: retransmissionMetricsSnapshot(route.metrics),
        layers: layerMetricsSnapshot(route.metrics),
        svcLayers: svcLayerMetricsSnapshot(route.metrics),
        preferredSvcLayers: route.preferredSvcLayers,
        currentSvcLayers: route.currentSvcLayers,
        targetSvcLayers: route.targetSvcLayers,
        bitrate: this.bandwidthEstimator.stats(route.consumer.id),
        twccSendHistory: route.twccSendHistory.snapshot(),
        pacing: route.pacer.snapshot(),
        activeProbe: this.activeProbeSnapshot(route),
        allocation: route.allocation ?? this.defaultAllocation(route, now),
        quality: this.buildConsumerQuality(route, now)
      })),
      bandwidth: this.bandwidthEstimates(),
      pacing: this.pacingSnapshots(),
      probes: [...this.consumers.values()].flatMap((route) => this.bandwidthEstimator.probeClusters(route.consumer.id)),
      rooms: this.roomQualitySnapshots()
    };
  }

  removeParticipant(participantId: string): void {
    for (const producerId of this.participantProducers.get(participantId) ?? []) {
      this.removeProducer(producerId);
    }
    for (const consumerId of this.participantConsumers.get(participantId) ?? []) {
      this.removeConsumer(consumerId);
    }
    this.participantProducers.delete(participantId);
    this.participantConsumers.delete(participantId);
  }

  removeRoom(roomId: string): void {
    for (const route of [...this.producers.values()]) {
      if (route.producer.roomId === roomId) {
        this.removeProducer(route.producer.id);
      }
    }
    for (const route of [...this.consumers.values()]) {
      if (route.consumer.roomId === roomId) {
        this.removeConsumer(route.consumer.id);
      }
    }
  }

  private resolveProducerForPacket(packet: RtpPacket, context: RtpRouteContext): { producerId: string; producerRoute: ProducerRoute; stream: RtpSourceStreamState } | undefined {
    const knownProducerId = this.producerBySsrc.get(packet.ssrc);
    if (knownProducerId) {
      const producerRoute = this.producers.get(knownProducerId);
      if (producerRoute) {
        this.reconcileProducerEncodingForPacket(producerRoute, packet);
      }
      const stream = producerRoute?.streams.get(packet.ssrc);
      return producerRoute && stream ? { producerId: knownProducerId, producerRoute, stream } : undefined;
    }
    for (const producerRoute of this.producerRoutesForContext(context)) {
      const parsed = safeParseRtpHeaderExtensions(packet, producerRoute.producer.rtpParameters);
      const rid = parsed.find((extension) => extension.kind === 'rid' && typeof extension.value === 'string')?.value as string | undefined;
      const rrid = parsed.find((extension) => extension.kind === 'rrid' && typeof extension.value === 'string')?.value as string | undefined;
      const bound = rrid ? producerRoute.simulcast.bindRtxSsrc(rrid, packet.ssrc) : rid ? producerRoute.simulcast.bindMediaSsrc(rid, packet.ssrc) : undefined;
      if (!bound) {
        continue;
      }
      const stream = this.registerProducerSsrc(producerRoute, packet.ssrc);
      return { producerId: producerRoute.producer.id, producerRoute, stream };
    }
    const rebound = this.bindSingleEncodingProducerSsrcForPacket(packet, context);
    if (rebound) {
      return rebound;
    }
    return undefined;
  }

  private producerRoutesForContext(context: RtpRouteContext): ProducerRoute[] {
    return [...this.producers.values()].filter((route) => {
      if (context.sourceTransportId && route.producer.transportId !== context.sourceTransportId) {
        return false;
      }
      if (context.sourceParticipantId && route.producer.participantId !== context.sourceParticipantId) {
        return false;
      }
      return true;
    });
  }

  private registerProducerSsrc(producerRoute: ProducerRoute, ssrc: number): RtpSourceStreamState {
    producerRoute.ssrcs.add(ssrc);
    this.producerBySsrc.set(ssrc, producerRoute.producer.id);
    this.mediaSsrcBySsrc.set(ssrc, sourceEncodingForSsrc(producerRoute.producer, ssrc)?.mediaSsrc ?? ssrc);
    let stream = producerRoute.streams.get(ssrc);
    if (!stream) {
      stream = this.createProducerStreamState(producerRoute.producer, ssrc);
      producerRoute.streams.set(ssrc, stream);
    }
    return stream;
  }

  private createProducerStreamState(producer: Producer, ssrc: number): RtpSourceStreamState {
    return new RtpSourceStreamState({
      ssrc,
      allowedPayloadTypes: allowedPayloadTypesForSsrc(producer, ssrc),
      maxReorderPackets: this.options.maxReorderPackets,
      maxReorderDelayMs: this.options.maxReorderDelayMs,
      restartSequenceGap: this.options.restartSequenceGap,
      duplicateWindowSize: this.options.duplicateWindowSize,
      now: this.now
    });
  }

  private reconcileProducerEncodingForPacket(producerRoute: ProducerRoute, packet: RtpPacket): void {
    const source = sourceEncodingForSsrc(producerRoute.producer, packet.ssrc);
    if (!source?.isRtx || source.encoding.rtx?.ssrc !== packet.ssrc) {
      return;
    }
    const primaryPayloadTypes = producerRoute.producer.rtpParameters.codecs
      .filter((codec) => !isRtxCodec(codec))
      .map((codec) => codec.payloadType);
    if (!primaryPayloadTypes.includes(packet.payloadType)) {
      return;
    }
    const previousMediaSsrc = source.encoding.ssrc;
    if (!isKnownSsrc(previousMediaSsrc) || previousMediaSsrc === packet.ssrc) {
      return;
    }
    const previousMediaStream = producerRoute.streams.get(previousMediaSsrc);
    if (previousMediaStream?.snapshot().packetsReceived) {
      return;
    }
    const currentRtxStream = producerRoute.streams.get(packet.ssrc);
    if (currentRtxStream?.snapshot().packetsReceived) {
      return;
    }
    source.encoding.ssrc = packet.ssrc;
    source.encoding.rtx = { ...source.encoding.rtx, ssrc: previousMediaSsrc };
    this.mediaSsrcBySsrc.set(packet.ssrc, packet.ssrc);
    this.mediaSsrcBySsrc.set(previousMediaSsrc, packet.ssrc);
    producerRoute.streams.set(packet.ssrc, this.createProducerStreamState(producerRoute.producer, packet.ssrc));
    producerRoute.streams.set(previousMediaSsrc, this.createProducerStreamState(producerRoute.producer, previousMediaSsrc));
  }

  private bindSingleEncodingProducerSsrcForPacket(
    packet: RtpPacket,
    context: RtpRouteContext
  ): { producerId: string; producerRoute: ProducerRoute; stream: RtpSourceStreamState } | undefined {
    const candidates = this.producerRoutesForContext(context).filter((producerRoute) => {
      if (producerRoute.producer.rtpParameters.encodings.length !== 1) {
        return false;
      }
      const primaryPayloadTypes = producerRoute.producer.rtpParameters.codecs
        .filter((codec) => !isRtxCodec(codec))
        .map((codec) => codec.payloadType);
      return primaryPayloadTypes.includes(packet.payloadType);
    });
    if (candidates.length !== 1) {
      return undefined;
    }
    const producerRoute = candidates[0]!;
    const encoding = producerRoute.producer.rtpParameters.encodings[0];
    if (!encoding || !isKnownSsrc(encoding.ssrc) || encoding.ssrc === packet.ssrc || encoding.rtx?.ssrc === packet.ssrc) {
      return undefined;
    }
    const previousMediaStream = producerRoute.streams.get(encoding.ssrc);
    if (previousMediaStream?.snapshot().packetsReceived) {
      return undefined;
    }
    const previousMediaSsrc = encoding.ssrc;
    encoding.ssrc = packet.ssrc;
    producerRoute.ssrcs.delete(previousMediaSsrc);
    producerRoute.ssrcs.add(packet.ssrc);
    this.producerBySsrc.delete(previousMediaSsrc);
    this.producerBySsrc.set(packet.ssrc, producerRoute.producer.id);
    this.mediaSsrcBySsrc.delete(previousMediaSsrc);
    this.mediaSsrcBySsrc.set(packet.ssrc, packet.ssrc);
    if (isKnownSsrc(encoding.rtx?.ssrc)) {
      this.mediaSsrcBySsrc.set(encoding.rtx.ssrc, packet.ssrc);
    }
    producerRoute.streams.delete(previousMediaSsrc);
    const stream = this.createProducerStreamState(producerRoute.producer, packet.ssrc);
    producerRoute.streams.set(packet.ssrc, stream);
    return { producerId: producerRoute.producer.id, producerRoute, stream };
  }

  private shouldForwardLayer(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute, packet: RtpPacket, packetLayer: RtpLayerSelection, isSvcPacket = false): boolean {
    if (producerRoute.producer.kind === 'audio') {
      return true;
    }
    if (isSvcPacket) {
      return this.shouldForwardSvcLayer(producerRoute, consumerRoute, packet, packetLayer);
    }
    if (!this.layerWithinConsumerPreference(packetLayer, consumerRoute.preferredLayers)) {
      return false;
    }
    const targetResult = this.selectTargetLayers(producerRoute, consumerRoute);
    const target = targetResult.layers;
    if (!target) {
      this.options.onLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, packetLayer, 'missing_layer');
      this.emitLayerUnavailable(consumerRoute, producerRoute, packetLayer, targetResult.reason);
      return false;
    }
    if (consumerRoute.preferredLayers && !this.layerExists(producerRoute, consumerRoute.preferredLayers)) {
      this.emitLayerUnavailable(consumerRoute, producerRoute, consumerRoute.preferredLayers, 'unavailable');
    }
    if (consumerRoute.currentLayers && !sameLayer(consumerRoute.currentLayers, target)) {
      this.startLayerSwitch(consumerRoute, producerRoute, target, targetResult.reason);
    }
    consumerRoute.targetLayers = target;
    consumerRoute.consumer.targetLayers = target;
    this.updateDynacastConsumerDemand(consumerRoute, targetResult.reason === 'bandwidth' ? 'bandwidth' : 'preferred_layers');
    if (!producerRoute.dynacast.layerDesired(packetLayer)) {
      return false;
    }
    if (!this.packetMatchesLayerTarget(packetLayer, target)) {
      if (!consumerRoute.currentLayers || this.sameSpatialLayer(consumerRoute.currentLayers, target)) {
        return false;
      }
      return this.packetMatchesLayerTarget(packetLayer, consumerRoute.currentLayers);
    }
    if (!consumerRoute.currentLayers) {
      if (consumerRoute.awaitingKeyframe && !this.packetIsKeyframe(producerRoute, packet)) {
        this.options.onKeyframeGateDropped?.(consumerRoute.consumer.id, producerRoute.producer.id);
        this.options.onLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, target, 'missing_keyframe');
        this.emitLayerSwitchFailed(consumerRoute, producerRoute, target, 'missing_keyframe');
        if (!consumerRoute.keyframeRequested) {
          void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
        }
        return false;
      }
      if (consumerRoute.awaitingKeyframe) {
        this.options.onKeyframeGateOpened?.(consumerRoute.consumer.id, producerRoute.producer.id);
      }
      this.setCurrentLayers(consumerRoute, producerRoute, target, consumerRoute.switchReason ?? 'initial');
      return true;
    }
    if (sameLayer(consumerRoute.currentLayers, target)) {
      return this.packetMatchesLayerTarget(packetLayer, consumerRoute.currentLayers);
    }
    if (this.sameSpatialLayer(consumerRoute.currentLayers, target)) {
      this.setCurrentLayers(consumerRoute, producerRoute, target, consumerRoute.switchReason ?? targetResult.reason);
      return true;
    }
    if (!this.packetIsKeyframe(producerRoute, packet)) {
      this.options.onLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, target, 'missing_keyframe');
      this.emitLayerSwitchFailed(consumerRoute, producerRoute, target, 'missing_keyframe');
      if (!consumerRoute.keyframeRequested) {
        void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
      }
      return false;
    }
    this.setCurrentLayers(consumerRoute, producerRoute, target, consumerRoute.switchReason ?? targetResult.reason);
    return true;
  }

  private shouldForwardSvcLayer(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute, packet: RtpPacket, packetLayer: RtpLayerSelection): boolean {
    const packetSvcLayer = normalizeSvcLayer({
      spatialLayerId: packetLayer.spatialLayer,
      temporalLayerId: packetLayer.temporalLayer,
      qualityLayerId: packetLayer.spatialLayer
    });
    if (!this.svcLayerWithinConsumerPreference(packetSvcLayer, consumerRoute.preferredSvcLayers)) {
      return false;
    }
    const targetResult = this.selectTargetSvcLayers(producerRoute, consumerRoute);
    const targetSvc = targetResult.svcLayers;
    const target = targetResult.layers;
    if (!targetSvc || !target) {
      this.options.onSvcLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, packetSvcLayer, 'missing_layer');
      this.emitSvcLayerUnavailable(consumerRoute, producerRoute, packetSvcLayer, targetResult.reason);
      return false;
    }
    if (consumerRoute.preferredSvcLayers && !this.svcLayerExists(producerRoute, consumerRoute.preferredSvcLayers)) {
      this.emitSvcLayerUnavailable(consumerRoute, producerRoute, consumerRoute.preferredSvcLayers, 'unavailable');
    }
    if (consumerRoute.currentSvcLayers && !sameSvcLayer(consumerRoute.currentSvcLayers, targetSvc)) {
      this.startSvcLayerSwitch(consumerRoute, producerRoute, targetSvc, targetResult.reason);
    }
    consumerRoute.targetSvcLayers = targetSvc;
    consumerRoute.consumer.targetSvcLayers = targetSvc;
    consumerRoute.targetLayers = target;
    consumerRoute.consumer.targetLayers = target;
    this.updateDynacastConsumerDemand(consumerRoute, targetResult.reason === 'bandwidth' ? 'bandwidth' : 'preferred_layers');
    if (!producerRoute.dynacast.layerDesired(target)) {
      return false;
    }
    if (!this.packetMatchesSvcTarget(packetSvcLayer, targetSvc)) {
      if (!consumerRoute.currentSvcLayers || this.sameSvcSpatialLayer(consumerRoute.currentSvcLayers, targetSvc)) {
        return false;
      }
      return this.packetMatchesSvcTarget(packetSvcLayer, consumerRoute.currentSvcLayers);
    }
    if (!consumerRoute.currentSvcLayers) {
      if (consumerRoute.awaitingKeyframe && !this.packetIsKeyframe(producerRoute, packet)) {
        this.options.onKeyframeGateDropped?.(consumerRoute.consumer.id, producerRoute.producer.id);
        this.options.onSvcLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, targetSvc, 'missing_keyframe');
        this.emitSvcLayerSwitchFailed(consumerRoute, producerRoute, targetSvc, 'missing_keyframe');
        if (!consumerRoute.keyframeRequested) {
          void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
        }
        return false;
      }
      if (consumerRoute.awaitingKeyframe) {
        this.options.onKeyframeGateOpened?.(consumerRoute.consumer.id, producerRoute.producer.id);
      }
      this.setCurrentSvcLayers(consumerRoute, producerRoute, targetSvc, consumerRoute.switchReason ?? 'initial');
      return true;
    }
    if (sameSvcLayer(consumerRoute.currentSvcLayers, targetSvc)) {
      if (
        producerRoute.svc.hasSeen(targetSvc)
        && !producerRoute.svc.isActive(targetSvc)
        && !sameSvcLayer(consumerRoute.currentSvcLayers, packetSvcLayer)
        && this.packetMatchesSvcTarget(packetSvcLayer, consumerRoute.currentSvcLayers)
      ) {
        this.setCurrentSvcLayers(consumerRoute, producerRoute, packetSvcLayer, consumerRoute.switchReason ?? 'unavailable');
      }
      return this.packetMatchesSvcTarget(packetSvcLayer, consumerRoute.currentSvcLayers);
    }
    if (this.sameSvcSpatialLayer(consumerRoute.currentSvcLayers, targetSvc)) {
      this.setCurrentSvcLayers(consumerRoute, producerRoute, targetSvc, consumerRoute.switchReason ?? targetResult.reason);
      return true;
    }
    if (isSvcLayerDowngrade(consumerRoute.currentSvcLayers, targetSvc)) {
      this.setCurrentSvcLayers(consumerRoute, producerRoute, targetSvc, consumerRoute.switchReason ?? targetResult.reason);
      return true;
    }
    if (!this.packetIsKeyframe(producerRoute, packet)) {
      this.options.onSvcLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, targetSvc, 'missing_keyframe');
      this.emitSvcLayerSwitchFailed(consumerRoute, producerRoute, targetSvc, 'missing_keyframe');
      if (!consumerRoute.keyframeRequested) {
        void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
      }
      return false;
    }
    this.setCurrentSvcLayers(consumerRoute, producerRoute, targetSvc, consumerRoute.switchReason ?? targetResult.reason);
    return true;
  }

  private selectTargetLayers(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute): { layers?: RtpLayerSelection; reason: ConsumerLayerSwitchReason } {
    const estimate = this.bandwidthEstimator.estimate(consumerRoute.consumer.id);
    const allocation = this.dynacastAllocationEstimate(estimate, consumerRoute);
    const result = producerRoute.simulcast.selectLayer(allocation.estimate, consumerRoute.preferredLayers, this.options.enableAdaptiveLayerSelection !== false);
    let layers = normalizeLayerSelection(result.selection);
    if (layers && !this.layerExists(producerRoute, layers)) {
      layers = this.fallbackAvailableLayer(producerRoute, consumerRoute.preferredLayers);
    }
    layers = this.applyDynacastAllocationHysteresis(consumerRoute, layers);
    return {
      layers,
      reason:
        result.reason === 'adaptive' || allocation.reason === 'bandwidth'
          ? 'bandwidth'
          : result.reason === 'none' || result.reason === 'audio'
            ? 'unavailable'
            : result.reason === 'fallback'
              ? 'unknown'
            : result.reason
    };
  }

  private selectTargetSvcLayers(
    producerRoute: ProducerRoute,
    consumerRoute: ConsumerRoute
  ): { svcLayers?: SvcLayerSelection; layers?: RtpLayerSelection; reason: ConsumerLayerSwitchReason } {
    const estimate = this.bandwidthEstimator.estimate(consumerRoute.consumer.id);
    const allocation = this.dynacastAllocationEstimate(estimate, consumerRoute);
    const result = producerRoute.svc.selectLayer(allocation.estimate, consumerRoute.preferredSvcLayers, this.options.enableAdaptiveLayerSelection !== false);
    let svcLayers = normalizeOptionalSvcLayer(result.selection);
    if (svcLayers && !this.svcLayerExists(producerRoute, svcLayers)) {
      svcLayers = this.fallbackAvailableSvcLayer(producerRoute, consumerRoute.preferredSvcLayers);
    }
    svcLayers = this.applySvcAllocationHysteresis(consumerRoute, svcLayers);
    return {
      svcLayers,
      layers: toRtpLayerSelection(svcLayers),
      reason:
        result.reason === 'adaptive' || allocation.reason === 'bandwidth'
          ? 'bandwidth'
          : result.reason === 'none' || result.reason === 'audio'
            ? 'unavailable'
            : result.reason === 'fallback'
              ? 'unknown'
              : result.reason
    };
  }

  private dynacastAllocationEstimate(estimate: BandwidthEstimate, consumerRoute: ConsumerRoute): { estimate: BandwidthEstimate; reason: ConsumerLayerSwitchReason } {
    if (this.options.enableAdaptiveLayerSelection === false) {
      return { estimate, reason: 'preferred' };
    }
    this.recalculateTransportAllocation(consumerRoute.consumer.transportId);
    const allocation = consumerRoute.allocation;
    if (!allocation) {
      return { estimate, reason: 'preferred' };
    }
    const priorityBias = this.options.dynacastPriorityBias ?? 0.35;
    const producerPriority = this.producers.get(consumerRoute.consumer.producerId)?.priority ?? 1;
    const priorityMultiplier = 1 + (normalizeConsumerPriority(consumerRoute.priority * producerPriority) - 1) * priorityBias;
    const availableBitrate = Math.max(0, estimate.availableBitrate || estimate.recommendedBitrate || estimate.estimatedOutgoingBitrate || allocation.allocatedBitrate);
    const recommendedBitrate = Math.max(0, estimate.recommendedBitrate || availableBitrate);
    const allocatedBitrate = Math.max(1, allocation.allocatedBitrate, Math.round(recommendedBitrate * priorityMultiplier));
    return {
      estimate: {
        ...estimate,
        availableBitrate: Math.max(availableBitrate, allocatedBitrate),
        recommendedBitrate: Math.max(recommendedBitrate, allocatedBitrate)
      },
      reason: allocation.reason === 'preferred' ? 'preferred' : allocation.reason === 'paused' ? 'unavailable' : 'bandwidth'
    };
  }

  private applyDynacastAllocationHysteresis(consumerRoute: ConsumerRoute, target: RtpLayerSelection | undefined): RtpLayerSelection | undefined {
    if (!target) {
      return target;
    }
    const normalized = normalizeLayerSelection(target);
    if (!normalized) {
      return target;
    }
    const now = this.now();
    const holdMs = this.options.dynacastUpgradeHoldMs ?? 0;
    const previous = consumerRoute.lastDynacastAllocation ?? consumerRoute.currentLayers ?? consumerRoute.targetLayers;
    if (previous && holdMs > 0 && isLayerUpgrade(previous, normalized) && consumerRoute.lastDynacastAllocationAt !== undefined && now - consumerRoute.lastDynacastAllocationAt < holdMs) {
      return previous;
    }
    if (!sameLayer(previous, normalized)) {
      consumerRoute.lastDynacastAllocationAt = now;
      consumerRoute.lastDynacastAllocation = normalized;
    }
    return normalized;
  }

  private applySvcAllocationHysteresis(consumerRoute: ConsumerRoute, target: SvcLayerSelection | undefined): SvcLayerSelection | undefined {
    if (!target) {
      return target;
    }
    const normalized = normalizeSvcLayer(target);
    const now = this.now();
    const holdMs = this.options.dynacastUpgradeHoldMs ?? 0;
    const previous = consumerRoute.lastSvcAllocation ?? consumerRoute.currentSvcLayers ?? consumerRoute.targetSvcLayers;
    if (previous && holdMs > 0 && isSvcLayerUpgrade(previous, normalized) && consumerRoute.lastSvcAllocationAt !== undefined && now - consumerRoute.lastSvcAllocationAt < holdMs) {
      return previous;
    }
    if (!sameSvcLayer(previous, normalized)) {
      consumerRoute.lastSvcAllocationAt = now;
      consumerRoute.lastSvcAllocation = normalized;
    }
    return normalized;
  }

  private recalculateTransportAllocation(transportId: string): void {
    const routes = [...this.consumers.values()].filter((route) => route.consumer.transportId === transportId);
    if (routes.length === 0) {
      return;
    }
    const now = this.now();
    const transportEstimate = this.bandwidthEstimator.estimate(`transport:${transportId}`);
    const routeEstimates = routes.map((route) => this.bandwidthEstimator.estimate(route.consumer.id));
    const baselineBudget = Math.max(
      transportEstimate.recommendedBitrate,
      transportEstimate.availableBitrate,
      transportEstimate.estimatedOutgoingBitrate,
      ...routeEstimates.map((estimate) => Math.max(estimate.recommendedBitrate, estimate.availableBitrate, estimate.estimatedOutgoingBitrate)),
      routes.reduce((sum, route) => sum + this.minimumBitrateForConsumer(route), 0),
      300_000
    );
    const congested = transportEstimate.overuseState === 'overuse' || routeEstimates.some((estimate) => estimate.overuseState === 'overuse' || estimate.packetLoss >= 0.05);
    const safetyMargin = congested ? 0.75 : 0.9;
    const candidates = routes.map((route) => {
      const producerRoute = this.producers.get(route.consumer.producerId);
      const estimate = this.bandwidthEstimator.estimate(route.consumer.id);
      const healthScore = computeQualityScore({
        packetLoss: estimate.packetLoss,
        rtt: estimate.rtt,
        jitter: estimate.jitter,
        delayVariationMs: estimate.delayVariationMs,
        overuseState: estimate.overuseState,
        pacingQueueBytes: route.pacer.snapshot().queuedBytes,
        retransmissionFailureRate: retransmissionMetricsSnapshot(route.metrics).failureRate,
        now
      }).score;
      return {
        id: route.consumer.id,
        roomId: route.consumer.roomId,
        transportId: route.consumer.transportId,
        kind: producerRoute?.producer.kind ?? 'video',
        paused: route.paused || !producerRoute || producerRoute.paused,
        priority: route.priority * (producerRoute?.priority ?? 1),
        desiredBitrate: this.desiredBitrateForConsumer(route, producerRoute),
        minBitrate: this.minimumBitrateForConsumer(route, producerRoute),
        maxBitrate: this.maximumBitrateForConsumer(route, producerRoute),
        healthScore,
        starvedSince: route.starvedSince
      };
    });
    const allocations = allocatePriorityBudget(candidates, Math.floor(baselineBudget * safetyMargin), {
      now,
      minEffectivePriority: 0.35,
      maxSingleConsumerShare: 0.6
    });
    for (const route of routes) {
      const allocation = allocations.get(route.consumer.id);
      if (!allocation) {
        continue;
      }
      route.allocation = allocation;
      if (allocation.allocatedBitrate < allocation.minBitrate && !route.starvedSince) {
        route.starvedSince = now;
      }
      if (allocation.allocatedBitrate >= allocation.minBitrate) {
        route.starvedSince = undefined;
      }
      route.pacer.updateTargetBitrate(Math.max(1, allocation.allocatedBitrate || this.options.defaultPacingBitrateBps || 300_000));
    }
  }

  private desiredBitrateForConsumer(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute | undefined): number {
    if (!producerRoute || producerRoute.producer.kind === 'audio') {
      return this.options.minAudioBitrateBps ?? 64_000;
    }
    const preferred = consumerRoute.preferredLayers ?? consumerRoute.targetLayers ?? consumerRoute.currentLayers;
    const svcPreferred = consumerRoute.preferredSvcLayers ?? consumerRoute.targetSvcLayers ?? consumerRoute.currentSvcLayers;
    const layerBitrate = svcPreferred ? this.bitrateForSvcLayer(producerRoute, svcPreferred) : preferred ? this.bitrateForLayer(producerRoute, preferred) : undefined;
    return layerBitrate ?? this.maximumBitrateForConsumer(consumerRoute, producerRoute);
  }

  private minimumBitrateForConsumer(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute | undefined = this.producers.get(consumerRoute.consumer.producerId)): number {
    const kind = producerRoute?.producer.kind ?? 'video';
    if (kind === 'audio') {
      return this.options.minAudioBitrateBps ?? 48_000;
    }
    if (kind === 'screen') {
      return this.options.minScreenBitrateBps ?? 250_000;
    }
    return this.options.minVideoBitrateBps ?? 150_000;
  }

  private maximumBitrateForConsumer(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute | undefined = this.producers.get(consumerRoute.consumer.producerId)): number {
    if (!producerRoute || producerRoute.producer.kind === 'audio') {
      return Math.max(this.options.minAudioBitrateBps ?? 64_000, 96_000);
    }
    const advertised = producerRoute.producer.rtpParameters.encodings.map((encoding) => encoding.maxBitrate ?? 0).filter((value) => value > 0);
    const maxAdvertised = advertised.length > 0 ? Math.max(...advertised) : 0;
    const fallback = producerRoute.producer.kind === 'screen' ? this.options.defaultScreenBitrateBps ?? 3_500_000 : this.options.defaultVideoBitrateBps ?? 2_500_000;
    return Math.max(this.minimumBitrateForConsumer(consumerRoute, producerRoute), maxAdvertised, fallback);
  }

  private bitrateForLayer(producerRoute: ProducerRoute, layer: RtpLayerSelection): number | undefined {
    const match = producerRoute.simulcast
      .availableLayers()
      .find((candidate) => candidate.spatialLayer === layer.spatialLayer && (layer.temporalLayer === undefined || candidate.temporalLayer === layer.temporalLayer));
    if (match?.maxBitrate) {
      return match.maxBitrate;
    }
    const encoding = match?.rid ? producerRoute.producer.rtpParameters.encodings.find((item) => item.rid === match.rid) : undefined;
    return encoding?.maxBitrate;
  }

  private bitrateForSvcLayer(producerRoute: ProducerRoute, layer: SvcLayerSelection): number | undefined {
    const match = producerRoute.svc
      .availableLayers()
      .find(
        (candidate) =>
          candidate.spatialLayerId === layer.spatialLayerId &&
          (layer.temporalLayerId === undefined || candidate.temporalLayerId === layer.temporalLayerId) &&
          (layer.qualityLayerId === undefined || (candidate.qualityLayerId ?? candidate.spatialLayerId) === layer.qualityLayerId)
      );
    return match?.maxBitrate;
  }

  private fallbackAvailableLayer(producerRoute: ProducerRoute, preferred: RtpLayerSelection | undefined): RtpLayerSelection | undefined {
    const candidates = producerRoute.simulcast
      .availableLayers()
      .filter((layer) => (layer.active || isKnownSsrc(layer.ssrc)) && this.layerWithinConsumerPreference(layer, preferred))
      .sort((left, right) => left.spatialLayer - right.spatialLayer || (left.temporalLayer ?? 0) - (right.temporalLayer ?? 0));
    const fallback = candidates.at(-1);
    return fallback ? normalizeLayerSelection({ spatialLayer: fallback.spatialLayer, temporalLayer: fallback.temporalLayer }) : undefined;
  }

  private fallbackAvailableSvcLayer(producerRoute: ProducerRoute, preferred: SvcLayerSelection | undefined): SvcLayerSelection | undefined {
    const candidates = producerRoute.svc
      .availableLayers()
      .filter((layer) => (layer.active || layer.decodable) && this.svcLayerWithinConsumerPreference(layer, preferred))
      .sort((left, right) => (left.spatialLayerId ?? 0) - (right.spatialLayerId ?? 0) || (left.temporalLayerId ?? 0) - (right.temporalLayerId ?? 0));
    const fallback = candidates.at(-1);
    return fallback ? normalizeSvcLayer(fallback) : undefined;
  }

  private packetTemporalLayer(producerRoute: ProducerRoute, packet: RtpPacket): number | undefined {
    const codec = sourceCodecForPacket(producerRoute.producer, packet);
    if (!codec) {
      return undefined;
    }
    return detectTemporalLayer(packet, codec)?.temporalLayer;
  }

  private packetSvcLayer(producerRoute: ProducerRoute, packet: RtpPacket): SvcLayerDetectionResult | null {
    if (!producerRoute.svc.enabled()) {
      return null;
    }
    const codec = sourceCodecForPacket(producerRoute.producer, packet);
    if (!codec) {
      return null;
    }
    return detectSvcLayer(packet, codec, sourceEncodingForSsrc(producerRoute.producer, packet.ssrc)?.encoding);
  }

  private layerWithinConsumerPreference(layer: RtpLayerSelection, preferred: RtpLayerSelection | undefined): boolean {
    if (preferred?.spatialLayer !== undefined && layer.spatialLayer !== undefined && layer.spatialLayer > preferred.spatialLayer) {
      return false;
    }
    if (preferred?.temporalLayer !== undefined && layer.temporalLayer !== undefined && layer.temporalLayer > preferred.temporalLayer) {
      return false;
    }
    return true;
  }

  private packetMatchesLayerTarget(packetLayer: RtpLayerSelection, target: RtpLayerSelection | undefined): boolean {
    if (!target) {
      return false;
    }
    if (packetLayer.spatialLayer !== target.spatialLayer) {
      return false;
    }
    if (target.temporalLayer === undefined || packetLayer.temporalLayer === undefined) {
      return true;
    }
    return packetLayer.temporalLayer <= target.temporalLayer;
  }

  private packetMatchesSvcTarget(packetLayer: SvcLayerSelection, target: SvcLayerSelection | undefined): boolean {
    if (!target) {
      return false;
    }
    if ((packetLayer.spatialLayerId ?? 0) > (target.spatialLayerId ?? 0)) {
      return false;
    }
    if (target.temporalLayerId === undefined || packetLayer.temporalLayerId === undefined) {
      return true;
    }
    return packetLayer.temporalLayerId <= target.temporalLayerId;
  }

  private svcLayerWithinConsumerPreference(layer: SvcLayerSelection, preferred: SvcLayerSelection | undefined): boolean {
    if (preferred?.spatialLayerId !== undefined && (layer.spatialLayerId ?? 0) > preferred.spatialLayerId) {
      return false;
    }
    if (preferred?.temporalLayerId !== undefined && (layer.temporalLayerId ?? 0) > preferred.temporalLayerId) {
      return false;
    }
    if (preferred?.qualityLayerId !== undefined && (layer.qualityLayerId ?? layer.spatialLayerId ?? 0) > preferred.qualityLayerId) {
      return false;
    }
    return true;
  }

  private sameSpatialLayer(left: RtpLayerSelection | undefined, right: RtpLayerSelection | undefined): boolean {
    return left?.spatialLayer === right?.spatialLayer;
  }

  private sameSvcSpatialLayer(left: SvcLayerSelection | undefined, right: SvcLayerSelection | undefined): boolean {
    return left?.spatialLayerId === right?.spatialLayerId;
  }

  private packetIsKeyframe(producerRoute: ProducerRoute, packet: RtpPacket): boolean {
    const codec = sourceCodecForPacket(producerRoute.producer, packet);
    if (!codec) {
      return true;
    }
    const detection = detectKeyframe(packet, codec);
    if (detection?.keyframe) {
      this.options.onKeyframeDetected?.(producerRoute.producer.id, packet.ssrc, detection.codec);
      return true;
    }
    return false;
  }

  private setCurrentLayers(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute, layers: RtpLayerSelection, reason: ConsumerLayerSwitchReason): void {
    const normalized = normalizeLayerSelection(layers);
    if (!normalized) {
      return;
    }
    const now = this.now();
    const previous = consumerRoute.currentLayers;
    consumerRoute.currentLayers = normalized;
    consumerRoute.consumer.currentLayers = normalized;
    consumerRoute.consumer.targetLayers = consumerRoute.targetLayers;
    consumerRoute.switchReason = reason;
    consumerRoute.consumer.layerState = this.buildConsumerLayerState(consumerRoute, now, reason);
    consumerRoute.awaitingKeyframe = false;
    consumerRoute.keyframeRequested = false;
    if (!sameLayer(previous, normalized)) {
      const switchDurationMs = consumerRoute.switchStartedAt === undefined ? undefined : Math.max(0, now - consumerRoute.switchStartedAt);
      this.options.onConsumerLayersChanged?.(consumerRoute.consumer.id, normalized);
      if (previous) {
        this.options.onLayerSwitch?.(consumerRoute.consumer.id, producerRoute.producer.id, previous, normalized);
      }
      this.emitConsumerLayerEvent({
        type: 'changed',
        roomId: consumerRoute.consumer.roomId,
        participantId: consumerRoute.consumer.participantId,
        consumerId: consumerRoute.consumer.id,
        producerId: producerRoute.producer.id,
        previousLayers: previous,
        currentLayers: normalized,
        targetLayers: consumerRoute.targetLayers,
        preferredLayers: consumerRoute.preferredLayers,
        reason,
        timestamp: new Date(now).toISOString(),
        switchDurationMs
      });
    }
    consumerRoute.switchStartedAt = undefined;
    consumerRoute.lastSwitchingKey = undefined;
    consumerRoute.lastFailedKey = undefined;
  }

  private setCurrentSvcLayers(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute, layers: SvcLayerSelection, reason: ConsumerLayerSwitchReason): void {
    const normalized = normalizeSvcLayer(layers);
    const rtpLayers = toRtpLayerSelection(normalized);
    if (!rtpLayers) {
      return;
    }
    const now = this.now();
    const previous = consumerRoute.currentSvcLayers;
    const previousRtp = consumerRoute.currentLayers;
    consumerRoute.currentSvcLayers = normalized;
    consumerRoute.currentLayers = rtpLayers;
    consumerRoute.consumer.currentSvcLayers = normalized;
    consumerRoute.consumer.currentLayers = rtpLayers;
    consumerRoute.consumer.targetSvcLayers = consumerRoute.targetSvcLayers;
    consumerRoute.consumer.targetLayers = consumerRoute.targetLayers;
    consumerRoute.switchReason = reason;
    consumerRoute.consumer.layerState = this.buildConsumerLayerState(consumerRoute, now, reason);
    consumerRoute.awaitingKeyframe = false;
    consumerRoute.keyframeRequested = false;
    if (!sameSvcLayer(previous, normalized)) {
      const switchDurationMs = consumerRoute.switchStartedAt === undefined ? undefined : Math.max(0, now - consumerRoute.switchStartedAt);
      this.options.onConsumerSvcLayersChanged?.(consumerRoute.consumer.id, normalized);
      this.options.onConsumerLayersChanged?.(consumerRoute.consumer.id, rtpLayers);
      if (previous) {
        this.options.onSvcLayerSwitch?.(consumerRoute.consumer.id, producerRoute.producer.id, previous, normalized);
      }
      if (previousRtp && !sameLayer(previousRtp, rtpLayers)) {
        this.options.onLayerSwitch?.(consumerRoute.consumer.id, producerRoute.producer.id, previousRtp, rtpLayers);
      }
      this.emitConsumerLayerEvent({
        type: 'changed',
        roomId: consumerRoute.consumer.roomId,
        participantId: consumerRoute.consumer.participantId,
        consumerId: consumerRoute.consumer.id,
        producerId: producerRoute.producer.id,
        previousLayers: previousRtp,
        currentLayers: rtpLayers,
        targetLayers: consumerRoute.targetLayers,
        preferredLayers: consumerRoute.preferredLayers,
        previousSvcLayers: previous,
        currentSvcLayers: normalized,
        targetSvcLayers: consumerRoute.targetSvcLayers,
        preferredSvcLayers: consumerRoute.preferredSvcLayers,
        reason,
        timestamp: new Date(now).toISOString(),
        switchDurationMs
      });
    }
    consumerRoute.switchStartedAt = undefined;
    consumerRoute.lastSwitchingKey = undefined;
    consumerRoute.lastFailedKey = undefined;
  }

  private startLayerSwitch(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute, target: RtpLayerSelection, reason: ConsumerLayerSwitchReason): void {
    const normalized = normalizeLayerSelection(target);
    if (!normalized || sameLayer(consumerRoute.currentLayers, normalized)) {
      return;
    }
    const key = layerKey(normalized, reason);
    if (consumerRoute.lastSwitchingKey === key) {
      return;
    }
    const now = this.now();
    consumerRoute.targetLayers = normalized;
    consumerRoute.switchStartedAt = now;
    consumerRoute.switchReason = reason;
    consumerRoute.lastSwitchingKey = key;
    consumerRoute.consumer.targetLayers = normalized;
    consumerRoute.consumer.layerState = this.buildConsumerLayerState(consumerRoute, now, reason);
    this.emitConsumerLayerEvent({
      type: 'switching',
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: producerRoute.producer.id,
      previousLayers: consumerRoute.currentLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: normalized,
      preferredLayers: consumerRoute.preferredLayers,
      reason,
      timestamp: new Date(now).toISOString()
    });
  }

  private startSvcLayerSwitch(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute, target: SvcLayerSelection, reason: ConsumerLayerSwitchReason): void {
    const normalized = normalizeSvcLayer(target);
    if (sameSvcLayer(consumerRoute.currentSvcLayers, normalized)) {
      return;
    }
    const rtpTarget = toRtpLayerSelection(normalized);
    if (!rtpTarget) {
      return;
    }
    const key = svcLayerEventKey(normalized, reason);
    if (consumerRoute.lastSwitchingKey === key) {
      return;
    }
    const now = this.now();
    consumerRoute.targetSvcLayers = normalized;
    consumerRoute.targetLayers = rtpTarget;
    consumerRoute.switchStartedAt = now;
    consumerRoute.switchReason = reason;
    consumerRoute.lastSwitchingKey = key;
    consumerRoute.consumer.targetSvcLayers = normalized;
    consumerRoute.consumer.targetLayers = rtpTarget;
    consumerRoute.consumer.layerState = this.buildConsumerLayerState(consumerRoute, now, reason);
    this.emitConsumerLayerEvent({
      type: 'switching',
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: producerRoute.producer.id,
      previousLayers: consumerRoute.currentLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: rtpTarget,
      preferredLayers: consumerRoute.preferredLayers,
      previousSvcLayers: consumerRoute.currentSvcLayers,
      currentSvcLayers: consumerRoute.currentSvcLayers,
      targetSvcLayers: normalized,
      preferredSvcLayers: consumerRoute.preferredSvcLayers,
      reason,
      timestamp: new Date(now).toISOString()
    });
  }

  private emitLayerUnavailable(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute, target: RtpLayerSelection, reason: ConsumerLayerSwitchReason): void {
    const key = layerKey(target, reason);
    if (consumerRoute.lastUnavailableKey === key) {
      return;
    }
    consumerRoute.lastUnavailableKey = key;
    const now = this.now();
    this.emitConsumerLayerEvent({
      type: 'unavailable',
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: producerRoute.producer.id,
      previousLayers: consumerRoute.currentLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: target,
      preferredLayers: consumerRoute.preferredLayers,
      reason,
      timestamp: new Date(now).toISOString()
    });
  }

  private emitSvcLayerUnavailable(consumerRoute: ConsumerRoute, producerRoute: ProducerRoute, target: SvcLayerSelection, reason: ConsumerLayerSwitchReason): void {
    const key = svcLayerEventKey(target, reason);
    if (consumerRoute.lastUnavailableKey === key) {
      return;
    }
    consumerRoute.lastUnavailableKey = key;
    const now = this.now();
    this.emitConsumerLayerEvent({
      type: 'unavailable',
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: producerRoute.producer.id,
      previousLayers: consumerRoute.currentLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: toRtpLayerSelection(target),
      preferredLayers: consumerRoute.preferredLayers,
      previousSvcLayers: consumerRoute.currentSvcLayers,
      currentSvcLayers: consumerRoute.currentSvcLayers,
      targetSvcLayers: target,
      preferredSvcLayers: consumerRoute.preferredSvcLayers,
      reason,
      timestamp: new Date(now).toISOString()
    });
  }

  private emitLayerSwitchFailed(
    consumerRoute: ConsumerRoute,
    producerRoute: ProducerRoute,
    target: RtpLayerSelection,
    reason: 'missing_keyframe' | 'missing_layer'
  ): void {
    const key = layerKey(target, reason);
    if (consumerRoute.lastFailedKey === key) {
      return;
    }
    consumerRoute.lastFailedKey = key;
    const now = this.now();
    const switchDurationMs = consumerRoute.switchStartedAt === undefined ? undefined : Math.max(0, now - consumerRoute.switchStartedAt);
    this.emitConsumerLayerEvent({
      type: 'switch-failed',
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: producerRoute.producer.id,
      previousLayers: consumerRoute.currentLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: target,
      preferredLayers: consumerRoute.preferredLayers,
      reason,
      timestamp: new Date(now).toISOString(),
      switchDurationMs
    });
  }

  private emitSvcLayerSwitchFailed(
    consumerRoute: ConsumerRoute,
    producerRoute: ProducerRoute,
    target: SvcLayerSelection,
    reason: 'missing_keyframe' | 'missing_layer'
  ): void {
    const key = svcLayerEventKey(target, reason);
    if (consumerRoute.lastFailedKey === key) {
      return;
    }
    consumerRoute.lastFailedKey = key;
    const now = this.now();
    const switchDurationMs = consumerRoute.switchStartedAt === undefined ? undefined : Math.max(0, now - consumerRoute.switchStartedAt);
    this.emitConsumerLayerEvent({
      type: 'switch-failed',
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: producerRoute.producer.id,
      previousLayers: consumerRoute.currentLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: toRtpLayerSelection(target),
      preferredLayers: consumerRoute.preferredLayers,
      previousSvcLayers: consumerRoute.currentSvcLayers,
      currentSvcLayers: consumerRoute.currentSvcLayers,
      targetSvcLayers: target,
      preferredSvcLayers: consumerRoute.preferredSvcLayers,
      reason,
      timestamp: new Date(now).toISOString(),
      switchDurationMs
    });
  }

  private layerExists(producerRoute: ProducerRoute, target: RtpLayerSelection): boolean {
    return producerRoute.simulcast
      .availableLayers()
      .some((layer) => layer.spatialLayer === target.spatialLayer && (target.temporalLayer === undefined || layer.temporalLayer === target.temporalLayer) && (layer.active || isKnownSsrc(layer.ssrc)));
  }

  private svcLayerExists(producerRoute: ProducerRoute, target: SvcLayerSelection): boolean {
    return producerRoute.svc
      .availableLayers()
      .some(
        (layer) =>
          layer.spatialLayerId === target.spatialLayerId &&
          (target.temporalLayerId === undefined || layer.temporalLayerId === target.temporalLayerId) &&
          (layer.active || layer.decodable)
      );
  }

  private buildConsumerLayerState(consumerRoute: ConsumerRoute, timestamp: number, reason: ConsumerLayerSwitchReason): ConsumerLayerState {
    return {
      roomId: consumerRoute.consumer.roomId,
      participantId: consumerRoute.consumer.participantId,
      consumerId: consumerRoute.consumer.id,
      producerId: consumerRoute.consumer.producerId,
      preferredLayers: consumerRoute.preferredLayers,
      currentLayers: consumerRoute.currentLayers,
      targetLayers: consumerRoute.targetLayers,
      preferredSvcLayers: consumerRoute.preferredSvcLayers,
      currentSvcLayers: consumerRoute.currentSvcLayers,
      targetSvcLayers: consumerRoute.targetSvcLayers,
      switchedAt: new Date(timestamp).toISOString(),
      switchReason: reason
    };
  }

  private emitConsumerLayerEvent(event: ConsumerLayerEvent): void {
    for (const listener of this.layerEventListeners) {
      listener(event);
    }
  }

  private updateDynacastConsumerDemand(consumerRoute: ConsumerRoute, reason: ProducerDynacastReason): void {
    const producerRoute = this.producers.get(consumerRoute.consumer.producerId);
    if (!producerRoute) {
      return;
    }
    this.publishDynacastChange(
      producerRoute,
      producerRoute.dynacast.updateConsumerLayers(
        consumerRoute.consumer.id,
        consumerRoute.preferredLayers,
        consumerRoute.targetLayers ?? consumerRoute.currentLayers,
        consumerRoute.currentLayers,
        consumerRoute.paused,
        reason
      )
    );
  }

  private publishDynacastChange(producerRoute: ProducerRoute, change: DynacastDemandChange | undefined): void {
    if (!change) {
      return;
    }
    producerRoute.producer.dynacast = change.state;
    if (change.neededLayers.length > 0) {
      this.emitProducerDynacastEvent(producerRoute.dynacast.event('layers-needed', change));
    }
    if (change.unneededLayers.length > 0) {
      this.emitProducerDynacastEvent(producerRoute.dynacast.event('layers-unneeded', change));
    }
    this.emitProducerDynacastEvent(producerRoute.dynacast.event('updated', change));
  }

  private emitProducerDynacastEvent(event: ProducerDynacastEvent): void {
    this.options.onProducerDynacastEvent?.(event);
    for (const listener of this.producerDynacastListeners) {
      listener(event);
    }
  }

  private async routeRtcpToProducerSsrcs(resolutions: Set<FeedbackSsrcResolution>, packet: Buffer, feedbackKind: RtcpFeedbackKind): Promise<number> {
    const producerIds = new Set<string>();
    for (const resolution of resolutions) {
      producerIds.add(resolution.producerId);
    }
    if (producerIds.size === 0) {
      this.options.onDroppedRtcpPacket?.('unknown_ssrc');
      return 0;
    }
    let forwarded = 0;
    for (const producerId of producerIds) {
      const route = this.producers.get(producerId);
      if (!route || route.paused) {
        this.options.onDroppedRtcpPacket?.('producer_paused');
        continue;
      }
      if (!route.rtcpWriter) {
        this.options.onDroppedRtcpPacket?.('missing_writer');
        continue;
      }
      await route.rtcpWriter(packet, route.producer, feedbackKind);
      this.options.onForwardedRtcpPacket?.(feedbackKind, 'producer');
      forwarded += 1;
    }
    return forwarded;
  }

  private async handleNack(senderSsrc: number, mediaSsrc: number, lostPacketIds: number[], packet: Buffer, context: RtcpRouteContext): Promise<number> {
    const resolution = this.resolveFeedbackSsrc(mediaSsrc, context);
    if (!resolution) {
      this.options.onDroppedRtcpPacket?.('unknown_ssrc');
      return 0;
    }
    const { producerId, sourceSsrc } = resolution;
    const producerRoute = this.producers.get(producerId);
    if (!producerRoute || producerRoute.paused) {
      this.options.onDroppedRtcpPacket?.('producer_paused');
      return 0;
    }
    const consumers = this.targetConsumersForFeedback(producerId, context);
    const missing: number[] = [];
    let retransmitted = 0;
    for (const consumerRoute of consumers) {
      consumerRoute.metrics.retransmission.requestedPackets += lostPacketIds.length;
    }
    for (const sequenceNumber of lostPacketIds) {
      const sourceSequence = resolution.consumerRoute?.rewriter.sourceSequenceForTarget(mediaSsrc, sequenceNumber)?.sequenceNumber ?? sequenceNumber;
      const cached = producerRoute.cache.get(sourceSsrc, sourceSequence);
      if (!cached) {
        missing.push(sourceSequence);
        for (const consumerRoute of consumers) {
          consumerRoute.metrics.retransmission.missingPackets += 1;
        }
        this.options.onRetransmissionMiss?.(sourceSsrc, sourceSequence);
        continue;
      }
      for (const consumerRoute of consumers) {
        const svcDetection = this.packetSvcLayer(producerRoute, cached);
        const temporalLayer = this.packetTemporalLayer(producerRoute, cached);
        const packetLayer = svcDetection ? producerRoute.svc.layerSelectionForPacket(svcDetection) : producerRoute.simulcast.layerSelectionForSsrc(cached.ssrc, temporalLayer);
        if (!packetLayer || !this.shouldForwardLayer(producerRoute, consumerRoute, cached, packetLayer, Boolean(svcDetection))) {
          continue;
        }
        const repair = this.rewriteRetransmissionForConsumer(producerRoute.producer, consumerRoute, cached);
        if (!repair) {
          consumerRoute.metrics.retransmission.missingPackets += 1;
          continue;
        }
        await this.sendRtpToConsumer(consumerRoute, repair.packet, { kind: 'retransmission', rtx: repair.rtx });
        this.options.onRetransmittedPacket?.(producerRoute.producer.kind);
        retransmitted += 1;
      }
    }
    if (missing.length === 0) {
      return retransmitted;
    }
    const upstreamNack = createNack({ senderSsrc, mediaSsrc: sourceSsrc, lostPacketIds: missing });
    return retransmitted + (await this.routeRtcpToProducerSsrcs(new Set([resolution]), upstreamNack.length > 0 ? upstreamNack : packet, 'nack'));
  }

  private async routeKeyframeRequest(resolutions: Set<FeedbackSsrcResolution>, packet: Buffer, feedbackKind: 'pli' | 'fir'): Promise<number> {
    const producerIds = new Set<string>();
    for (const resolution of resolutions) {
      producerIds.add(resolution.producerId);
    }
    let forwarded = 0;
    for (const producerId of producerIds) {
      if (!this.canForwardKeyframeRequest(producerId, feedbackKind, 'external')) {
        this.options.onKeyframeRequestCoalesced?.(producerId, feedbackKind);
        continue;
      }
      try {
        const sent = await this.routeRtcpToProducerSsrcs(new Set([...resolutions].filter((resolution) => resolution.producerId === producerId)), packet, feedbackKind);
        if (sent > 0) {
          this.recordForwardedKeyframeRequest(producerId, 'external');
          this.options.onKeyframeRequestForwarded?.(producerId, feedbackKind);
          forwarded += sent;
        }
      } catch {}
    }
    if (producerIds.size === 0) {
      this.options.onDroppedRtcpPacket?.('unknown_ssrc');
    }
    return forwarded;
  }

  private targetConsumersForFeedback(producerId: string, context: RtcpRouteContext): ConsumerRoute[] {
    const consumerIds = this.consumersByProducer.get(producerId);
    if (!consumerIds || consumerIds.size === 0) {
      this.options.onDroppedRtcpPacket?.('no_consumers');
      return [];
    }
    const routes: ConsumerRoute[] = [];
    for (const consumerId of consumerIds) {
      const route = this.consumers.get(consumerId);
      if (!route || route.paused) {
        this.options.onDroppedRtcpPacket?.('consumer_paused');
        continue;
      }
      if (context.sourceTransportId && route.consumer.transportId !== context.sourceTransportId) {
        continue;
      }
      if (context.sourceParticipantId && route.consumer.participantId !== context.sourceParticipantId) {
        continue;
      }
      routes.push(route);
    }
    return routes;
  }

  private async routeRtcpToConsumers(senderSsrc: number, packet: Buffer, feedbackKind: RtcpFeedbackKind): Promise<number> {
    const producerId = this.producerBySsrc.get(senderSsrc);
    if (!producerId) {
      this.options.onDroppedRtcpPacket?.('unknown_ssrc');
      return 0;
    }
    const producerRoute = this.producers.get(producerId);
    if (!producerRoute || producerRoute.paused) {
      this.options.onDroppedRtcpPacket?.('producer_paused');
      return 0;
    }
    const consumerIds = this.consumersByProducer.get(producerId);
    if (!consumerIds || consumerIds.size === 0) {
      this.options.onDroppedRtcpPacket?.('no_consumers');
      return 0;
    }
    let forwarded = 0;
    for (const consumerId of consumerIds) {
      const consumerRoute = this.consumers.get(consumerId);
      if (!consumerRoute || consumerRoute.paused) {
        this.options.onDroppedRtcpPacket?.('consumer_paused');
        continue;
      }
      if (!consumerRoute.rtcpWriter) {
        this.options.onDroppedRtcpPacket?.('missing_writer');
        continue;
      }
      const rewritten = this.rewriteRtcpForConsumer(senderSsrc, packet, feedbackKind, consumerRoute, producerRoute);
      if (!rewritten) {
        this.options.onDroppedRtcpPacket?.('unknown_ssrc');
        continue;
      }
      await consumerRoute.rtcpWriter(rewritten, consumerRoute.consumer, feedbackKind);
      this.options.onForwardedRtcpPacket?.(feedbackKind, 'consumer');
      forwarded += 1;
    }
    return forwarded;
  }

  private rewriteRtcpForConsumer(senderSsrc: number, packet: Buffer, feedbackKind: RtcpFeedbackKind, consumerRoute: ConsumerRoute, producerRoute: ProducerRoute): Buffer | undefined {
    try {
      const rewrittenPackets: Buffer[] = [];
      for (const rtcpPacket of parseRtcpCompound(packet)) {
        const senderReport = parseSenderReport(rtcpPacket);
        if (senderReport) {
          const target = consumerRoute.rewriter.targetInfoForSource(senderReport.senderSsrc, senderReport.rtpTimestamp);
          if (!target) {
            if (producerRoute.ssrcs.size > 1) {
              continue;
            }
            rewrittenPackets.push(serializeRtcpPacket(rtcpPacket));
            continue;
          }
          rewrittenPackets.push(
            createSenderReport({
              senderSsrc: target.targetSsrc,
              ntpTimestamp: senderReport.ntpTimestamp,
              rtpTimestamp: target.targetTimestamp,
              packetCount: senderReport.packetCount,
              octetCount: senderReport.octetCount,
              reports: rewriteReportBlocksForConsumer(senderReport.reports, consumerRoute)
            })
          );
          continue;
        }
        const receiverReport = parseReceiverReport(rtcpPacket);
        if (receiverReport) {
          rewrittenPackets.push(
            createReceiverReport({
              reporterSsrc: receiverReport.reporterSsrc,
              reports: rewriteReportBlocksForConsumer(receiverReport.reports, consumerRoute)
            })
          );
          continue;
        }
        rewrittenPackets.push(serializeRtcpPacket(rtcpPacket));
      }
      return rewrittenPackets.length === 0 ? undefined : Buffer.concat(rewrittenPackets);
    } catch {
      return feedbackKind === 'sender-report' ? undefined : packet;
    }
  }

  private canForwardKeyframeRequest(producerId: string, feedbackKind: 'pli' | 'fir', origin: 'internal' | 'external'): boolean {
    const key = `${producerId}:keyframe`;
    const now = this.now();
    const lastRequest = this.keyframeRequests.get(key);
    if (
      lastRequest &&
      now - lastRequest.forwardedAt < (this.options.keyframeRequestIntervalMs ?? 1000) &&
      (lastRequest.origin === 'external' || origin === 'internal')
    ) {
      return false;
    }
    return true;
  }

  private recordForwardedKeyframeRequest(producerId: string, origin: 'internal' | 'external'): void {
    this.keyframeRequests.set(`${producerId}:keyframe`, { forwardedAt: this.now(), origin });
  }

  private scheduleReorderDrain(producerId: string, ssrc: number): void {
    const delayMs = this.options.maxReorderDelayMs ?? 0;
    if (delayMs <= 0) {
      return;
    }
    const key = this.reorderDrainKey(producerId, ssrc);
    if (this.reorderDrainTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.reorderDrainTimers.delete(key);
      void this.drainReorderBuffer(producerId, ssrc).catch(() => undefined);
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.reorderDrainTimers.set(key, timer);
  }

  private async drainReorderBuffer(producerId: string, ssrc: number): Promise<void> {
    const producerRoute = this.producers.get(producerId);
    const stream = producerRoute?.streams.get(ssrc);
    if (!producerRoute || !stream || producerRoute.paused) {
      return;
    }
    const drained = stream.drainExpired();
    if (drained.expiredGap) {
      this.options.onReorderGapExpired?.(
        drained.expiredGap.ssrc,
        drained.expiredGap.previousExpectedSequenceNumber,
        drained.expiredGap.releasedSequenceNumber
      );
    }
    if (drained.packets.length > 0) {
      await this.forwardReleasedPackets(producerId, producerRoute, drained.packets, 0);
    }
    if (stream.snapshot().packetsBuffered > 0) {
      this.scheduleReorderDrain(producerId, ssrc);
    }
  }

  private clearReorderDrainTimer(producerId: string, ssrc: number): void {
    const key = this.reorderDrainKey(producerId, ssrc);
    const timer = this.reorderDrainTimers.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.reorderDrainTimers.delete(key);
  }

  private reorderDrainKey(producerId: string, ssrc: number): string {
    return `${producerId}:${ssrc}`;
  }

  private now = (): number => this.options.now?.() ?? Date.now();

  private async routeReceiverReport(receiverReport: { reporterSsrc: number; reports: Array<{ ssrc: number; fractionLost: number; packetsLost: number; highestSequence: number; jitter: number; lastSenderReport: number; delaySinceLastSenderReport: number }> }, context: RtcpRouteContext): Promise<number> {
    let forwarded = 0;
    for (const report of receiverReport.reports) {
      const resolution = this.resolveFeedbackSsrc(report.ssrc, context);
      if (!resolution) {
        this.options.onDroppedRtcpPacket?.('unknown_ssrc');
        continue;
      }
      const layer = resolution.consumerRoute?.currentLayers ?? this.producers.get(resolution.producerId)?.simulcast.layerSelectionForSsrc(resolution.sourceSsrc);
      const now = this.now();
      if (layer) {
        const producerRoute = this.producers.get(resolution.producerId);
        if (producerRoute) {
          recordLayerReport(producerRoute.metrics, layer, report, now);
          if (producerRoute.svc.enabled()) {
            recordSvcLayerReport(producerRoute.metrics, layer, report, now);
          }
          this.maybeEmitQualityForProducer(producerRoute);
        }
        if (resolution.consumerRoute) {
          recordLayerReport(resolution.consumerRoute.metrics, layer, report, now);
          if (resolution.consumerRoute.currentSvcLayers) {
            recordSvcLayerReport(resolution.consumerRoute.metrics, layer, report, now);
          }
          this.maybeEmitQualityForConsumer(resolution.consumerRoute);
        }
      }
      forwarded += await this.routeRtcpToProducerSsrcs(
        new Set([resolution]),
        createReceiverReport({
          reporterSsrc: receiverReport.reporterSsrc,
          reports: [{ ...report, ssrc: resolution.sourceSsrc }]
        }),
        'receiver-report'
      );
    }
    return forwarded;
  }

  private async routePli(senderSsrc: number, mediaSsrc: number, context: RtcpRouteContext): Promise<number> {
    const resolution = this.resolveFeedbackSsrc(mediaSsrc, context);
    if (!resolution) {
      this.options.onDroppedRtcpPacket?.('unknown_ssrc');
      return 0;
    }
    return this.routeKeyframeRequest(new Set([resolution]), createPli({ senderSsrc, mediaSsrc: resolution.sourceSsrc }), 'pli');
  }

  private async routeFir(senderSsrc: number, mediaSsrc: number, entries: Array<{ ssrc: number; sequenceNumber: number }>, context: RtcpRouteContext): Promise<number> {
    const sourceEntries = entries.length > 0 ? entries : [{ ssrc: mediaSsrc, sequenceNumber: 1 }];
    let forwarded = 0;
    for (const entry of sourceEntries) {
      const resolution = this.resolveFeedbackSsrc(entry.ssrc, context);
      if (!resolution) {
        this.options.onDroppedRtcpPacket?.('unknown_ssrc');
        continue;
      }
      forwarded += await this.routeKeyframeRequest(
        new Set([resolution]),
        createFir({
          senderSsrc,
          mediaSsrc: resolution.sourceSsrc,
          entries: [{ ssrc: resolution.sourceSsrc, sequenceNumber: entry.sequenceNumber }]
        }),
        'fir'
      );
    }
    return forwarded;
  }

  private async routeRemb(senderSsrc: number, mediaSsrc: number, bitrateBps: number, ssrcs: number[], context: RtcpRouteContext): Promise<number> {
    let forwarded = 0;
    const feedbackSsrcs = ssrcs.length > 0 ? ssrcs : [mediaSsrc];
    for (const resolution of this.resolveFeedbackSsrcs(feedbackSsrcs, context)) {
      forwarded += await this.routeRtcpToProducerSsrcs(
        new Set([resolution]),
        createRemb({
          senderSsrc,
          mediaSsrc: resolution.sourceSsrc,
          bitrateBps,
          ssrcs: [resolution.sourceSsrc]
        }),
        'remb'
      );
    }
    return forwarded;
  }

  private recordInboundAdaptiveState(producerRoute: ProducerRoute, packet: RtpPacket, fallbackSize: number): void {
    const now = this.now();
    const size = fallbackSize || packet.serialize().length;
    const estimate = this.bandwidthEstimator.observePacket(producerRoute.producer.id, 'incoming', size, now);
    this.options.onBandwidthEstimate?.(producerRoute.producer.id, estimate);
    this.maybeEmitQualityForProducer(producerRoute);
    if (this.options.enableTwcc === false) {
      return;
    }
    const twcc = safeParseRtpHeaderExtensions(packet, producerRoute.producer.rtpParameters).find((extension) => extension.kind === 'twcc');
    if (typeof twcc?.value !== 'number') {
      return;
    }
    producerRoute.twccArrivals.recordArrival({
      sequenceNumber: twcc.value,
      arrivalTimeMs: now,
      size,
      ssrc: packet.ssrc
    });
    this.options.onTwccPacketArrival?.(producerRoute.producer.id, twcc.value, 'incoming');
    void this.maybeSendTwccFeedback(producerRoute, packet.ssrc).catch(() => undefined);
  }

  private async maybeSendTwccFeedback(producerRoute: ProducerRoute, mediaSsrc: number): Promise<void> {
    if (!producerRoute.rtcpWriter) {
      return;
    }
    const now = this.now();
    const feedback = producerRoute.twccArrivals.createFeedback(0, mediaSsrc, {
      compact: true,
      minIntervalMs: this.options.twccFeedbackIntervalMs ?? 100,
      now
    });
    if (!feedback) {
      return;
    }
    producerRoute.lastTwccFeedbackAt = now;
    await producerRoute.rtcpWriter(feedback, producerRoute.producer, 'twcc');
    this.options.onForwardedRtcpPacket?.('twcc', 'producer');
  }

  private async sendRtpToConsumer(
    consumerRoute: ConsumerRoute,
    packet: RtpPacket,
    mode: { kind: 'primary' | 'retransmission'; rtx?: boolean; layer?: RtpLayerSelection; svcLayer?: RtpLayerSelection }
  ): Promise<void> {
    const size = packet.serialize().length;
    const send = async () => {
      const sentAt = this.now();
      await consumerRoute.writer(packet, consumerRoute.consumer);
      this.recordConsumerSendMetrics(consumerRoute, packet, size, mode, sentAt);
      const estimate = this.bandwidthEstimator.observePacket(consumerRoute.consumer.id, 'outgoing', size, sentAt);
      const transportEstimate = this.bandwidthEstimator.observePacket(`transport:${consumerRoute.consumer.transportId}`, 'outgoing', size, sentAt);
      this.recalculateTransportAllocation(consumerRoute.consumer.transportId);
      consumerRoute.pacer.updateTargetBitrate(consumerRoute.allocation?.allocatedBitrate || estimate.recommendedBitrate || this.options.defaultPacingBitrateBps || 50_000_000);
      this.options.onBandwidthEstimate?.(consumerRoute.consumer.id, estimate);
      this.options.onBandwidthEstimate?.(`transport:${consumerRoute.consumer.transportId}`, transportEstimate);
      const twcc = safeParseRtpHeaderExtensions(packet, consumerRoute.consumer.rtpParameters).find((extension) => extension.kind === 'twcc');
      if (typeof twcc?.value === 'number') {
        consumerRoute.twccSendHistory.recordSend({
          sequenceNumber: twcc.value,
          sentAtMs: sentAt,
          size,
          ssrc: packet.ssrc,
          retransmission: mode.kind === 'retransmission'
        });
        this.options.onTwccPacketArrival?.(consumerRoute.consumer.id, twcc.value, 'outgoing');
      }
      this.recordProbeSend(consumerRoute, size, estimate, sentAt);
      this.maybeEmitQualityForConsumer(consumerRoute);
    };
    if (this.options.enablePacing === false) {
      await send();
      return;
    }
    try {
      await consumerRoute.pacer.enqueue(size, () => this.transportPacer(consumerRoute.consumer.transportId).enqueue(size, send));
    } catch (error) {
      this.options.onDroppedPacket?.('no_consumers');
      throw error;
    }
  }

  private recordConsumerSendMetrics(
    consumerRoute: ConsumerRoute,
    _packet: RtpPacket,
    size: number,
    mode: { kind: 'primary' | 'retransmission'; rtx?: boolean; layer?: RtpLayerSelection; svcLayer?: RtpLayerSelection },
    sentAt: number
  ): void {
    if (mode.kind === 'primary') {
      recordMetric(consumerRoute.metrics.primaryRtp, size);
      if (mode.layer) {
        recordLayerPacket(consumerRoute.metrics, mode.layer, size, sentAt);
      }
      if (mode.svcLayer) {
        recordSvcLayerPacket(consumerRoute.metrics, mode.svcLayer, size, sentAt);
      }
      return;
    }
    consumerRoute.metrics.retransmission.retransmittedPackets += 1;
    if (mode.rtx) {
      consumerRoute.metrics.retransmission.rtxPackets += 1;
    } else {
      consumerRoute.metrics.retransmission.primaryRetransmissionPackets += 1;
    }
  }

  private recordProbeSend(consumerRoute: ConsumerRoute, size: number, estimate: BandwidthEstimate, sentAt: number): void {
    if (this.options.enableProbeScheduling === false) {
      return;
    }
    this.maybeStartProbeCluster(consumerRoute, estimate, sentAt);
    const active = consumerRoute.activeProbe;
    if (!active) {
      return;
    }
    active.packetsSent += 1;
    active.bytesSent += size;
    if (active.packetsSent < active.targetPackets) {
      return;
    }
    const updated = this.bandwidthEstimator.recordProbeResult(consumerRoute.consumer.id, active.clusterId, active.bytesSent, active.startedAt, sentAt);
    consumerRoute.activeProbe = undefined;
    consumerRoute.pacer.updateTargetBitrate(updated.recommendedBitrate || this.options.defaultPacingBitrateBps || 50_000_000);
    this.options.onBandwidthEstimate?.(consumerRoute.consumer.id, updated);
  }

  private maybeStartProbeCluster(consumerRoute: ConsumerRoute, estimate: BandwidthEstimate, timestamp: number): void {
    if (typeof this.bandwidthEstimator.startProbeCluster !== 'function') {
      return;
    }
    if (consumerRoute.activeProbe || estimate.overuseState === 'overuse' || estimate.packetLoss > 0.05) {
      return;
    }
    const intervalMs = this.options.probeClusterIntervalMs ?? 2500;
    if (consumerRoute.lastProbeAt !== undefined && timestamp - consumerRoute.lastProbeAt < intervalMs) {
      return;
    }
    const targetBitrate = Math.max(
      this.options.defaultPacingBitrateBps ?? 300_000,
      Math.floor((estimate.availableBitrate || 300_000) * (this.options.probeBitrateMultiplier ?? 1.5))
    );
    const cluster = this.bandwidthEstimator.startProbeCluster(consumerRoute.consumer.id, targetBitrate, timestamp);
    consumerRoute.activeProbe = {
      clusterId: cluster.id,
      targetPackets: this.options.probeBurstPackets ?? 5,
      packetsSent: 0,
      bytesSent: 0,
      startedAt: timestamp
    };
    consumerRoute.lastProbeAt = timestamp;
  }

  private transportPacer(transportId: string): PacketPacingQueue {
    let pacer = this.transportPacers.get(transportId);
    if (!pacer) {
      pacer = new PacketPacingQueue({
        id: `transport:${transportId}`,
        targetBitrateBps: this.options.defaultPacingBitrateBps ?? 50_000_000,
        maxQueueBytes: this.options.maxPacingQueueBytes,
        now: this.now,
        onQueueDepth: (snapshot) => this.options.onPacingQueueDepth?.(snapshot)
      });
      this.transportPacers.set(transportId, pacer);
    }
    return pacer;
  }

  private shouldHoldForKeyframe(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute, packet: RtpPacket): boolean {
    if (!consumerRoute.awaitingKeyframe) {
      return false;
    }
    const codec = sourceCodecForPacket(producerRoute.producer, packet);
    if (!codec) {
      return false;
    }
    const detection = detectKeyframe(packet, codec);
    if (detection?.keyframe) {
      consumerRoute.awaitingKeyframe = false;
      this.options.onKeyframeDetected?.(producerRoute.producer.id, packet.ssrc, detection.codec);
      this.options.onKeyframeGateOpened?.(consumerRoute.consumer.id, producerRoute.producer.id);
      return false;
    }
    this.options.onKeyframeGateDropped?.(consumerRoute.consumer.id, producerRoute.producer.id);
    if (!consumerRoute.keyframeRequested) {
      void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
    }
    return true;
  }

  private async requestKeyframeForConsumer(consumerRoute: ConsumerRoute): Promise<void> {
    if (consumerRoute.keyframeRequested) {
      return;
    }
    const producerRoute = this.producers.get(consumerRoute.consumer.producerId);
    if (!producerRoute || !producerRoute.rtcpWriter || producerRoute.paused) {
      return;
    }
    const mediaSsrc = this.targetMediaSsrcForConsumer(producerRoute, consumerRoute) ?? firstMediaSsrc(producerRoute.producer);
    if (mediaSsrc === undefined) {
      return;
    }
    if (!this.canForwardKeyframeRequest(producerRoute.producer.id, 'pli', 'internal')) {
      this.options.onKeyframeRequestCoalesced?.(producerRoute.producer.id, 'pli');
      return;
    }
    consumerRoute.keyframeRequested = true;
    const senderSsrc = firstMediaSsrcFromRtpParameters(consumerRoute.consumer.rtpParameters) ?? 0;
    try {
      await producerRoute.rtcpWriter(createPli({ senderSsrc, mediaSsrc }), producerRoute.producer, 'pli');
      this.recordForwardedKeyframeRequest(producerRoute.producer.id, 'internal');
      this.options.onKeyframeRequestForwarded?.(producerRoute.producer.id, 'pli');
      this.options.onForwardedRtcpPacket?.('pli', 'producer');
      if (producerRoute.producer.transportId.startsWith('pipe')) {
        consumerRoute.keyframeRequested = false;
      }
    } catch (error) {
      consumerRoute.keyframeRequested = false;
      throw error;
    }
  }

  private targetMediaSsrcForConsumer(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute): number | undefined {
    const target = consumerRoute.targetLayers ?? consumerRoute.preferredLayers;
    if (!target) {
      return undefined;
    }
    return producerRoute.simulcast
      .availableLayers()
      .find((layer) => layer.spatialLayer === target.spatialLayer && (target.temporalLayer === undefined || layer.temporalLayer === target.temporalLayer))?.ssrc;
  }

  private handleTwccFeedback(feedback: TransportWideCcFeedback, context: RtcpRouteContext): void {
    const route = this.resolveFeedbackSsrc(feedback.mediaSsrc, context)?.consumerRoute ?? this.consumerRoutesForContext(context)[0];
    if (!route) {
      return;
    }
    const metrics = twccMetricsFromFeedback(feedback);
    const now = this.now();
    const correlation = route.twccSendHistory.correlate(feedback, now);
    const receiveDeltas = feedback.statuses.map((status) => status.deltaMs).filter((value): value is number => value !== undefined);
    const fallbackReceiveDelta = receiveDeltas.length > 0 ? receiveDeltas.reduce((sum, value) => sum + value, 0) / receiveDeltas.length : undefined;
    const observation = {
      packetLoss: correlation.correlatedPackets > 0 ? correlation.packetLoss : metrics.packetLoss,
      delayVariationMs: correlation.correlatedPackets > 0 ? correlation.delayVariationMs : metrics.delayVariationMs,
      sendDeltaMs: correlation.meanSendDeltaMs,
      receiveDeltaMs: correlation.meanReceiveDeltaMs ?? fallbackReceiveDelta,
      rtt: correlation.rttMs,
      timestamp: now
    };
    this.options.onTwccFeedback?.(route.consumer.id, feedback);
    this.applyTwccObservationToRoute(route, observation);
  }

  private applyTwccObservationToRoute(
    route: ConsumerRoute,
    observation: ConsumerTwccObservation,
    options: { emitObservation?: boolean } = {}
  ): ConsumerQualityState {
    const now = observation.timestamp ?? this.now();
    const normalizedObservation: ConsumerTwccObservation = {
      packetLoss: clamp01(observation.packetLoss),
      delayVariationMs: Math.max(0, observation.delayVariationMs),
      jitter: observation.jitter === undefined ? undefined : Math.max(0, observation.jitter),
      rtt: observation.rtt === undefined ? undefined : Math.max(0, observation.rtt),
      sendDeltaMs: observation.sendDeltaMs,
      receiveDeltaMs: observation.receiveDeltaMs,
      timestamp: now
    };
    const estimate = this.bandwidthEstimator.updateTwcc(route.consumer.id, normalizedObservation);
    const transportEstimate = this.bandwidthEstimator.updateTwcc(`transport:${route.consumer.transportId}`, normalizedObservation);
    if (route.currentLayers) {
      recordLayerCongestion(
        route.metrics,
        route.currentLayers,
        normalizedObservation.packetLoss,
        normalizedObservation.rtt,
        normalizedObservation.delayVariationMs,
        now
      );
      const producerRoute = this.producers.get(route.consumer.producerId);
      if (producerRoute) {
        recordLayerCongestion(
          producerRoute.metrics,
          route.currentLayers,
          normalizedObservation.packetLoss,
          normalizedObservation.rtt,
          normalizedObservation.delayVariationMs,
          now
        );
      }
    }
    if (route.currentSvcLayers && route.currentLayers) {
      recordSvcLayerCongestion(
        route.metrics,
        route.currentLayers,
        normalizedObservation.packetLoss,
        normalizedObservation.rtt,
        normalizedObservation.delayVariationMs,
        now
      );
      const producerRoute = this.producers.get(route.consumer.producerId);
      if (producerRoute) {
        recordSvcLayerCongestion(
          producerRoute.metrics,
          route.currentLayers,
          normalizedObservation.packetLoss,
          normalizedObservation.rtt,
          normalizedObservation.delayVariationMs,
          now
        );
      }
    }
    this.recalculateTransportAllocation(route.consumer.transportId);
    route.pacer.updateTargetBitrate(route.allocation?.allocatedBitrate || estimate.recommendedBitrate || this.options.defaultPacingBitrateBps || 50_000_000);
    this.options.onBandwidthEstimate?.(route.consumer.id, estimate);
    this.options.onBandwidthEstimate?.(`transport:${route.consumer.transportId}`, transportEstimate);
    if (options.emitObservation !== false) {
      const event: ConsumerTwccObservationEvent = {
        roomId: route.consumer.roomId,
        participantId: route.consumer.participantId,
        consumerId: route.consumer.id,
        producerId: route.consumer.producerId,
        transportId: route.consumer.transportId,
        currentLayers: route.currentLayers,
        targetLayers: route.targetLayers,
        preferredLayers: route.preferredLayers,
        currentSvcLayers: route.currentSvcLayers,
        targetSvcLayers: route.targetSvcLayers,
        preferredSvcLayers: route.preferredSvcLayers,
        observation: {
          ...normalizedObservation,
          jitter: normalizedObservation.jitter ?? estimate.jitter,
          rtt: normalizedObservation.rtt ?? estimate.rtt
        }
      };
      this.options.onConsumerTwccObservation?.(event);
      for (const listener of this.consumerTwccObservationListeners) {
        listener(event);
      }
    }
    this.maybeEmitQualityForConsumer(route);
    return route.lastQuality ?? this.buildConsumerQuality(route, now);
  }

  private rewriteForConsumer(producer: Producer, consumerRoute: ConsumerRoute, packet: RtpPacket): RtpPacket | undefined {
    const mapping = rewriteMappingForPacket(producer, consumerRoute.consumer, packet);
    if (!mapping) {
      return undefined;
    }
    const rewritten = consumerRoute.rewriter.rewrite(packet, mapping);
    return this.applyConsumerHeaderExtensions(producer, consumerRoute, packet, rewritten);
  }

  private rewriteRetransmissionForConsumer(producer: Producer, consumerRoute: ConsumerRoute, packet: RtpPacket): { packet: RtpPacket; rtx: boolean } | undefined {
    const mapping = rewriteMappingForPacket(producer, consumerRoute.consumer, packet);
    if (!mapping) {
      return undefined;
    }
    const rewrittenPrimary = this.applyConsumerHeaderExtensions(producer, consumerRoute, packet, consumerRoute.rewriter.preview(packet, mapping));
    const source = sourceEncodingForSsrc(producer, packet.ssrc);
    const targetEncoding = source ? targetEncodingForSource(consumerRoute.consumer, source) : undefined;
    const rtxSsrc = targetEncoding?.rtx?.ssrc;
    const rtxPayloadType =
      targetEncoding?.rtx?.payloadType ??
      consumerRoute.consumer.rtpParameters.codecs.find((codec) => isRtxCodec(codec) && codecParameterNumber(codec, 'apt') === rewrittenPrimary.payloadType)?.payloadType;
    if (source?.isRtx || rtxSsrc === undefined || rtxPayloadType === undefined) {
      return { packet: rewrittenPrimary, rtx: false };
    }
    return {
      packet: createRtxPacket(rewrittenPrimary, {
        rtxSsrc,
        rtxPayloadType,
        sequenceNumber: consumerRoute.rtxSequence.next(),
        timestamp: rewrittenPrimary.timestamp
      }),
      rtx: true
    };
  }

  private applyConsumerHeaderExtensions(producer: Producer, consumerRoute: ConsumerRoute, source: RtpPacket, rewritten: RtpPacket): RtpPacket {
    const plan = negotiateRtpHeaderExtensions(producer.rtpParameters, consumerRoute.consumer.rtpParameters);
    if (plan.length === 0) {
      return cloneRtpPacketWithHeaderExtension(rewritten, null);
    }
    const headerExtension = rewriteRtpHeaderExtensions(source, plan, {
      twccSequenceNumber: getRtpHeaderExtensionId(consumerRoute.consumer.rtpParameters, 'twcc') === undefined ? undefined : consumerRoute.twccSequence.next(),
      absoluteSendTime: getRtpHeaderExtensionId(consumerRoute.consumer.rtpParameters, 'absoluteSendTime') === undefined ? undefined : absoluteSendTime24(this.now())
    });
    return cloneRtpPacketWithHeaderExtension(rewritten, headerExtension);
  }

  private resolveFeedbackSsrcs(ssrcs: Iterable<number>, context: RtcpRouteContext): Set<FeedbackSsrcResolution> {
    const resolutions = new Map<string, FeedbackSsrcResolution>();
    for (const ssrc of ssrcs) {
      const resolution = this.resolveFeedbackSsrc(ssrc, context);
      if (resolution) {
        resolutions.set(`${resolution.producerId}:${resolution.sourceSsrc}`, resolution);
      }
    }
    return new Set(resolutions.values());
  }

  private resolveFeedbackSsrc(ssrc: number, context: RtcpRouteContext): FeedbackSsrcResolution | undefined {
    if (context.sourceTransportId || context.sourceParticipantId) {
      for (const consumerRoute of this.consumerRoutesForContext(context)) {
        const sourceSsrc = consumerRoute.rewriter.sourceSsrcForTarget(ssrc);
        if (sourceSsrc === undefined) {
          const negotiatedSourceSsrc = this.sourceSsrcForConsumerFeedback(consumerRoute, ssrc);
          if (negotiatedSourceSsrc === undefined) {
            continue;
          }
          return { producerId: consumerRoute.consumer.producerId, sourceSsrc: negotiatedSourceSsrc, consumerRoute };
        }
        const producerId = this.producerBySsrc.get(sourceSsrc);
        if (producerId) {
          return { producerId, sourceSsrc, consumerRoute };
        }
      }
    }
    const directSourceSsrc = this.mediaSsrcBySsrc.get(ssrc) ?? ssrc;
    const directProducerId = this.producerBySsrc.get(directSourceSsrc);
    if (directProducerId) {
      return { producerId: directProducerId, sourceSsrc: directSourceSsrc };
    }
    for (const consumerRoute of this.consumerRoutesForContext(context)) {
      const sourceSsrc = consumerRoute.rewriter.sourceSsrcForTarget(ssrc);
      if (sourceSsrc === undefined) {
        const negotiatedSourceSsrc = this.sourceSsrcForConsumerFeedback(consumerRoute, ssrc);
        if (negotiatedSourceSsrc === undefined) {
          continue;
        }
        return { producerId: consumerRoute.consumer.producerId, sourceSsrc: negotiatedSourceSsrc, consumerRoute };
      }
      const producerId = this.producerBySsrc.get(sourceSsrc);
      if (producerId) {
        return { producerId, sourceSsrc, consumerRoute };
      }
    }
    return undefined;
  }

  private sourceSsrcForConsumerFeedback(consumerRoute: ConsumerRoute, targetSsrc: number): number | undefined {
    const producerRoute = this.producers.get(consumerRoute.consumer.producerId);
    if (!producerRoute) {
      return undefined;
    }
    return sourceSsrcForConsumerSsrc(producerRoute.producer, consumerRoute.consumer, targetSsrc);
  }

  private consumerRoutesForContext(context: RtcpRouteContext): ConsumerRoute[] {
    return [...this.consumers.values()].filter((route) => {
      if (context.sourceTransportId && route.consumer.transportId !== context.sourceTransportId) {
        return false;
      }
      if (context.sourceParticipantId && route.consumer.participantId !== context.sourceParticipantId) {
        return false;
      }
      return true;
    });
  }

  private addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
    const existing = map.get(key) ?? new Set<string>();
    existing.add(value);
    map.set(key, existing);
  }

  private shouldGateConsumerUntilKeyframe(consumer: Consumer): boolean {
    if (this.options.enableJoinKeyframeGate === false) {
      return false;
    }
    if (consumer.participantId.startsWith('pipe:')) {
      return false;
    }
    const producerRoute = this.producers.get(consumer.producerId);
    if (!producerRoute || producerRoute.producer.kind === 'audio') {
      return false;
    }
    return producerRoute.producer.rtpParameters.codecs.some((codec) =>
      codec.rtcpFeedback?.some((feedback) => /\b(pli|fir)\b/i.test(feedback) || /\bccm\s+fir\b/i.test(feedback))
    );
  }

  private activeProbeSnapshot(route: ConsumerRoute): ActiveProbeSnapshot | undefined {
    if (!route.activeProbe) {
      return undefined;
    }
    const cluster = this.bandwidthEstimator.probeClusters(route.consumer.id).find((probe) => probe.id === route.activeProbe?.clusterId);
    return {
      ...route.activeProbe,
      targetBitrateBps: cluster?.targetBitrateBps ?? 0
    };
  }

  private buildConsumerQuality(route: ConsumerRoute, now: number): ConsumerQualityState {
    const estimate = this.bandwidthEstimator.estimate(route.consumer.id);
    const allocation = route.allocation ?? this.defaultAllocation(route, now);
    const retransmissions = retransmissionMetricsSnapshot(route.metrics);
    const pacing = route.pacer.snapshot();
    const allocationRatio = allocation.desiredBitrate > 0 ? allocation.allocatedBitrate / allocation.desiredBitrate : 1;
    const score = computeQualityScore({
      packetLoss: estimate.packetLoss,
      rtt: estimate.rtt,
      jitter: estimate.jitter,
      delayVariationMs: estimate.delayVariationMs,
      overuseState: estimate.overuseState,
      pacingQueueBytes: pacing.queuedBytes,
      retransmissionFailureRate: retransmissions.failureRate,
      allocationRatio,
      staleMs: Math.max(0, now - estimate.updatedAt),
      additionalReasons: this.consumerQualityReasons(route, allocation),
      now
    });
    return {
      roomId: route.consumer.roomId,
      participantId: route.consumer.participantId,
      consumerId: route.consumer.id,
      producerId: route.consumer.producerId,
      transportId: route.consumer.transportId,
      priority: route.priority,
      score,
      allocation,
      network: networkStateFromEstimate(estimate),
      bitrate: this.qualityBitrateState(estimate, allocation.desiredBitrate, allocation.allocatedBitrate),
      currentLayers: route.currentLayers,
      targetLayers: route.targetLayers,
      preferredLayers: route.preferredLayers,
      currentSvcLayers: route.currentSvcLayers,
      targetSvcLayers: route.targetSvcLayers,
      preferredSvcLayers: route.preferredSvcLayers,
      layerScores: this.layerQualityStates(route.metrics, false, now),
      svcLayerScores: this.layerQualityStates(route.metrics, true, now),
      pacingQueueDepth: pacing.queuedBytes,
      retransmissions: {
        requestedPackets: retransmissions.requestedPackets,
        retransmittedPackets: retransmissions.retransmittedPackets,
        missingPackets: retransmissions.missingPackets,
        successRate: retransmissions.successRate,
        failureRate: retransmissions.failureRate
      },
      updatedAt: new Date(now).toISOString()
    };
  }

  private buildProducerQuality(route: ProducerRoute, now: number): ProducerQualityState {
    const estimate = this.bandwidthEstimator.estimate(route.producer.id);
    const layerScores = this.layerQualityStates(route.metrics, false, now);
    const svcLayerScores = this.layerQualityStates(route.metrics, true, now);
    const dynacast = route.dynacast.snapshot();
    const baseScore = computeQualityScore({
      packetLoss: estimate.packetLoss,
      rtt: estimate.rtt,
      jitter: estimate.jitter,
      delayVariationMs: estimate.delayVariationMs,
      overuseState: estimate.overuseState,
      staleMs: Math.max(0, now - estimate.updatedAt),
      additionalReasons: route.paused ? ['bandwidth_limited'] : undefined,
      now
    });
    const score = layerScores.length + svcLayerScores.length > 0 ? combineQualityScores([baseScore, ...layerScores.map((item) => item.score), ...svcLayerScores.map((item) => item.score)], now) : baseScore;
    const targetBitrate = Math.max(...route.producer.rtpParameters.encodings.map((encoding) => encoding.maxBitrate ?? 0), estimate.estimatedIncomingBitrate, 0);
    return {
      roomId: route.producer.roomId,
      participantId: route.producer.participantId,
      producerId: route.producer.id,
      transportId: route.producer.transportId,
      kind: route.producer.kind,
      priority: route.priority,
      score,
      network: networkStateFromEstimate(estimate),
      bitrate: this.qualityBitrateState(estimate, targetBitrate, targetBitrate),
      layerScores,
      svcLayerScores,
      dynacastEnabled: dynacast.enabled,
      activeLayers: dynacast.activeLayers,
      suspendedLayers: dynacast.suspendedLayers,
      updatedAt: new Date(now).toISOString()
    };
  }

  private buildTransportQuality(transportId: string, now: number): TransportQualityState | undefined {
    const consumers = [...this.consumers.values()].filter((route) => route.consumer.transportId === transportId).map((route) => this.buildConsumerQuality(route, now));
    const producers = [...this.producers.values()].filter((route) => route.producer.transportId === transportId).map((route) => this.buildProducerQuality(route, now));
    if (consumers.length === 0 && producers.length === 0) {
      return undefined;
    }
    const score = combineQualityScores(consumers.map((item) => item.score).concat(producers.map((item) => item.score)), now);
    const transportPacing = this.transportPacers.get(transportId)?.snapshot();
    return {
      roomId: consumers[0]?.roomId ?? producers[0]!.roomId,
      participantId: consumers[0]?.participantId ?? producers[0]!.participantId,
      transportId,
      score,
      consumers,
      producers,
      targetBitrate: sum(consumers.map((item) => item.bitrate.targetBitrate).concat(producers.map((item) => item.bitrate.targetBitrate))),
      allocatedBitrate: sum(consumers.map((item) => item.bitrate.allocatedBitrate).concat(producers.map((item) => item.bitrate.allocatedBitrate))),
      actualBitrate: sum(consumers.map((item) => item.bitrate.actualBitrate).concat(producers.map((item) => item.bitrate.actualBitrate))),
      pacingQueueDepth: (transportPacing?.queuedBytes ?? 0) + sum(consumers.map((item) => item.pacingQueueDepth)),
      updatedAt: new Date(now).toISOString()
    };
  }

  private buildRoomQuality(roomId: string, now: number): RoomQualityState | undefined {
    const transportIds = new Set<string>();
    for (const route of this.consumers.values()) {
      if (route.consumer.roomId === roomId) {
        transportIds.add(route.consumer.transportId);
      }
    }
    for (const route of this.producers.values()) {
      if (route.producer.roomId === roomId) {
        transportIds.add(route.producer.transportId);
      }
    }
    const transports = [...transportIds].map((transportId) => this.buildTransportQuality(transportId, now)).filter((state): state is TransportQualityState => Boolean(state));
    if (transports.length === 0) {
      return undefined;
    }
    const consumers = transports.flatMap((transport) => transport.consumers);
    const producers = transports.flatMap((transport) => transport.producers);
    const score = combineQualityScores(transports.map((transport) => transport.score), now);
    return {
      roomId,
      score,
      consumers,
      producers,
      transports,
      targetBitrate: sum(transports.map((transport) => transport.targetBitrate)),
      allocatedBitrate: sum(transports.map((transport) => transport.allocatedBitrate)),
      actualBitrate: sum(transports.map((transport) => transport.actualBitrate)),
      congestionState: score.reasons.includes('overuse') ? 'overuse' : score.reasons.includes('underuse') ? 'underuse' : 'normal',
      updatedAt: new Date(now).toISOString()
    };
  }

  private layerQualityStates(metrics: RouteMetrics, svc: boolean, now: number): LayerQualityState[] {
    const snapshots = svc ? svcLayerMetricsSnapshot(metrics) : layerMetricsSnapshot(metrics);
    return snapshots.map((snapshot) => ({
      layer: snapshot.layer,
      svcLayer: svc
        ? {
            spatialLayerId: snapshot.layer.spatialLayer,
            temporalLayerId: snapshot.layer.temporalLayer,
            qualityLayerId: snapshot.layer.spatialLayer
          }
        : undefined,
      score: computeQualityScore({
        packetLoss: snapshot.fractionLost,
        rtt: snapshot.rtt,
        jitter: snapshot.jitter,
        delayVariationMs: snapshot.jitter,
        additionalReasons: snapshot.score.degradationReason ? [mapLayerDegradationReason(snapshot.score.degradationReason)] : undefined,
        now
      }),
      packets: snapshot.packets,
      bytes: snapshot.bytes,
      packetsLost: snapshot.packetsLost,
      fractionLost: snapshot.fractionLost,
      jitter: snapshot.jitter,
      rtt: snapshot.rtt,
      targetBitrate: undefined
    }));
  }

  private defaultAllocation(route: ConsumerRoute, now: number): PriorityAllocationState {
    const producerRoute = this.producers.get(route.consumer.producerId);
    const desiredBitrate = this.desiredBitrateForConsumer(route, producerRoute);
    const minBitrate = this.minimumBitrateForConsumer(route, producerRoute);
    return {
      priority: route.priority,
      desiredBitrate,
      allocatedBitrate: desiredBitrate,
      minBitrate,
      maxBitrate: this.maximumBitrateForConsumer(route, producerRoute),
      fairShareBitrate: desiredBitrate,
      starvationPrevented: false,
      reason: route.paused ? 'paused' : 'preferred',
      updatedAt: new Date(now).toISOString()
    };
  }

  private qualityBitrateState(estimate: BandwidthEstimate, targetBitrate: number, allocatedBitrate: number): QualityBitrateState {
    return {
      targetBitrate: Math.max(0, Math.floor(targetBitrate)),
      allocatedBitrate: Math.max(0, Math.floor(allocatedBitrate)),
      actualBitrate: Math.max(estimate.estimatedOutgoingBitrate, estimate.estimatedIncomingBitrate, 0),
      availableBitrate: Math.max(0, estimate.availableBitrate),
      recommendedBitrate: Math.max(0, estimate.recommendedBitrate)
    };
  }

  private consumerQualityReasons(route: ConsumerRoute, allocation: PriorityAllocationState): QualityIssueReason[] {
    const reasons: QualityIssueReason[] = [];
    if (allocation.reason === 'bandwidth' || allocation.reason === 'congestion') {
      reasons.push('bandwidth_limited');
    }
    if (allocation.reason === 'starvation' || allocation.starvationPrevented) {
      reasons.push('starvation_prevented');
    }
    if (route.awaitingKeyframe) {
      reasons.push('keyframe_missing');
    }
    if (route.lastUnavailableKey) {
      reasons.push('layer_unavailable');
    }
    const producerRoute = this.producers.get(route.consumer.producerId);
    if (producerRoute && route.targetLayers && !producerRoute.dynacast.layerDesired(route.targetLayers)) {
      reasons.push('dynacast_suspended');
    }
    return reasons;
  }

  private maybeEmitQualityForConsumer(route: ConsumerRoute): void {
    const now = this.now();
    const state = this.buildConsumerQuality(route, now);
    route.lastQuality = state;
    if (!this.shouldEmitQuality(route.lastQualityEmittedAt, route.lastQualityScore, state.score.score, now)) {
      return;
    }
    route.lastQualityEmittedAt = now;
    route.lastQualityScore = state.score.score;
    this.options.onConsumerScoreUpdated?.(state);
    for (const listener of this.consumerQualityListeners) {
      listener(state);
    }
    this.emitTransportAndRoomQuality(route.consumer.transportId, route.consumer.roomId, now);
  }

  private maybeEmitQualityForProducer(route: ProducerRoute): void {
    const now = this.now();
    const state = this.buildProducerQuality(route, now);
    route.lastQuality = state;
    if (!this.shouldEmitQuality(route.lastQualityEmittedAt, route.lastQualityScore, state.score.score, now)) {
      return;
    }
    route.lastQualityEmittedAt = now;
    route.lastQualityScore = state.score.score;
    this.options.onProducerScoreUpdated?.(state);
    for (const listener of this.producerQualityListeners) {
      listener(state);
    }
    this.emitTransportAndRoomQuality(route.producer.transportId, route.producer.roomId, now);
  }

  private emitTransportAndRoomQuality(transportId: string, roomId: string, now: number): void {
    const transport = this.buildTransportQuality(transportId, now);
    if (transport) {
      const previous = this.lastTransportQualityScores.get(transportId);
      if (this.shouldEmitQuality(previous?.emittedAt, previous?.score, transport.score.score, now)) {
        this.lastTransportQualityScores.set(transportId, { score: transport.score.score, emittedAt: now });
        this.options.onTransportQualityUpdated?.(transport);
        for (const listener of this.transportQualityListeners) {
          listener(transport);
        }
      }
    }
    const room = this.buildRoomQuality(roomId, now);
    if (room) {
      const previous = this.lastRoomQualityScores.get(roomId);
      if (this.shouldEmitQuality(previous?.emittedAt, previous?.score, room.score.score, now)) {
        this.lastRoomQualityScores.set(roomId, { score: room.score.score, emittedAt: now });
        this.options.onRoomQualityUpdated?.(room);
        for (const listener of this.roomQualityListeners) {
          listener(room);
        }
      }
    }
  }

  private shouldEmitQuality(lastEmittedAt: number | undefined, lastScore: number | undefined, score: number, now: number): boolean {
    if (lastEmittedAt === undefined || lastScore === undefined) {
      return true;
    }
    if (Math.abs(score - lastScore) >= 5) {
      return true;
    }
    return now - lastEmittedAt >= (this.options.qualityUpdateIntervalMs ?? 1000);
  }
}

function createRouteMetrics(): RouteMetrics {
  return {
    primaryRtp: { packets: 0, bytes: 0 },
    layerMetrics: new Map(),
    svcLayerMetrics: new Map(),
    retransmission: {
      requestedPackets: 0,
      retransmittedPackets: 0,
      rtxPackets: 0,
      primaryRetransmissionPackets: 0,
      missingPackets: 0
    }
  };
}

function recordMetric(bucket: RtpMetricBucket, bytes: number): void {
  bucket.packets += 1;
  bucket.bytes += Math.max(0, bytes);
}

function recordLayerPacket(metrics: RouteMetrics, layer: RtpLayerSelection, bytes: number, now: number): void {
  const state = layerMetricState(metrics, layer);
  state.packets += 1;
  state.bytes += Math.max(0, bytes);
  state.updatedAt = now;
}

function recordSvcLayerPacket(metrics: RouteMetrics, layer: RtpLayerSelection, bytes: number, now: number): void {
  const state = svcLayerMetricState(metrics, layer);
  state.packets += 1;
  state.bytes += Math.max(0, bytes);
  state.updatedAt = now;
}

function recordLayerReport(metrics: RouteMetrics, layer: RtpLayerSelection, report: ReceiverReport, now: number): void {
  const state = layerMetricState(metrics, layer);
  state.packetsLost = Math.max(state.packetsLost, Math.max(0, report.packetsLost));
  state.fractionLost = clamp01(report.fractionLost > 1 ? report.fractionLost / 256 : report.fractionLost);
  state.jitter = Math.max(0, report.jitter);
  state.rtt = report.delaySinceLastSenderReport > 0 ? report.delaySinceLastSenderReport * 1000 / 65536 : state.rtt;
  state.updatedAt = now;
}

function recordSvcLayerReport(metrics: RouteMetrics, layer: RtpLayerSelection, report: ReceiverReport, now: number): void {
  const state = svcLayerMetricState(metrics, layer);
  state.packetsLost = Math.max(state.packetsLost, Math.max(0, report.packetsLost));
  state.fractionLost = clamp01(report.fractionLost > 1 ? report.fractionLost / 256 : report.fractionLost);
  state.jitter = Math.max(0, report.jitter);
  state.rtt = report.delaySinceLastSenderReport > 0 ? report.delaySinceLastSenderReport * 1000 / 65536 : state.rtt;
  state.updatedAt = now;
}

function recordLayerCongestion(metrics: RouteMetrics, layer: RtpLayerSelection, packetLoss: number, rtt: number | undefined, delayVariationMs: number, now: number): void {
  const state = layerMetricState(metrics, layer);
  state.fractionLost = clamp01(packetLoss);
  state.jitter = Math.max(0, delayVariationMs);
  if (rtt !== undefined) {
    state.rtt = Math.max(0, rtt);
  }
  state.congestion = clamp01(packetLoss + Math.max(0, delayVariationMs - 30) / 200);
  state.updatedAt = now;
}

function recordSvcLayerCongestion(metrics: RouteMetrics, layer: RtpLayerSelection, packetLoss: number, rtt: number | undefined, delayVariationMs: number, now: number): void {
  const state = svcLayerMetricState(metrics, layer);
  state.fractionLost = clamp01(packetLoss);
  state.jitter = Math.max(0, delayVariationMs);
  if (rtt !== undefined) {
    state.rtt = Math.max(0, rtt);
  }
  state.congestion = clamp01(packetLoss + Math.max(0, delayVariationMs - 30) / 200);
  state.updatedAt = now;
}

function layerMetricsSnapshot(metrics: RouteMetrics): RtpLayerMetrics[] {
  return [...metrics.layerMetrics.values()]
    .sort((left, right) => (left.layer.spatialLayer ?? 0) - (right.layer.spatialLayer ?? 0) || (left.layer.temporalLayer ?? 0) - (right.layer.temporalLayer ?? 0))
    .map((state) => ({
      layer: { ...state.layer },
      packets: state.packets,
      bytes: state.bytes,
      packetsLost: state.packetsLost,
      fractionLost: state.fractionLost,
      jitter: state.jitter,
      rtt: state.rtt,
      score: layerScore(state),
      updatedAt: state.updatedAt === undefined ? undefined : new Date(state.updatedAt).toISOString()
    }));
}

function svcLayerMetricsSnapshot(metrics: RouteMetrics): RtpLayerMetrics[] {
  return [...metrics.svcLayerMetrics.values()]
    .sort((left, right) => (left.layer.spatialLayer ?? 0) - (right.layer.spatialLayer ?? 0) || (left.layer.temporalLayer ?? 0) - (right.layer.temporalLayer ?? 0))
    .map((state) => ({
      layer: { ...state.layer },
      packets: state.packets,
      bytes: state.bytes,
      packetsLost: state.packetsLost,
      fractionLost: state.fractionLost,
      jitter: state.jitter,
      rtt: state.rtt,
      score: layerScore(state),
      updatedAt: state.updatedAt === undefined ? undefined : new Date(state.updatedAt).toISOString()
    }));
}

function layerMetricState(metrics: RouteMetrics, layer: RtpLayerSelection): LayerMetricState {
  const normalized = normalizeLayerSelection(layer) ?? {};
  const key = metricLayerKey(normalized);
  let state = metrics.layerMetrics.get(key);
  if (!state) {
    state = {
      layer: normalized,
      packets: 0,
      bytes: 0,
      packetsLost: 0,
      fractionLost: 0,
      jitter: 0,
      rtt: 0,
      congestion: 0
    };
    metrics.layerMetrics.set(key, state);
  }
  return state;
}

function svcLayerMetricState(metrics: RouteMetrics, layer: RtpLayerSelection): LayerMetricState {
  const normalized = normalizeLayerSelection(layer) ?? {};
  const key = metricLayerKey(normalized);
  let state = metrics.svcLayerMetrics.get(key);
  if (!state) {
    state = {
      layer: normalized,
      packets: 0,
      bytes: 0,
      packetsLost: 0,
      fractionLost: 0,
      jitter: 0,
      rtt: 0,
      congestion: 0
    };
    metrics.svcLayerMetrics.set(key, state);
  }
  return state;
}

function layerScore(state: LayerMetricState): RtpLayerScore {
  const lossPenalty = clamp01(state.fractionLost) * 100;
  const jitterPenalty = Math.min(25, state.jitter / 4);
  const rttPenalty = state.rtt <= 150 ? 0 : Math.min(25, (state.rtt - 150) / 10);
  const congestionPenalty = clamp01(state.congestion) * 30;
  const quality = clampScore(100 - lossPenalty - jitterPenalty - rttPenalty - congestionPenalty);
  const lossScore = clampScore(100 - lossPenalty);
  const congestionScore = clampScore(100 - congestionPenalty);
  const degradationReason =
    state.fractionLost > 0.05
      ? 'packet_loss'
      : state.jitter > 50
        ? 'high_jitter'
        : state.rtt > 300
          ? 'high_rtt'
          : state.congestion > 0.4
            ? 'congestion'
            : undefined;
  return {
    quality,
    lossScore,
    congestionScore,
    degradationReason,
    recoveryReason: degradationReason ? undefined : state.packets > 0 ? 'stable' : undefined
  };
}

function mapLayerDegradationReason(reason: NonNullable<RtpLayerScore['degradationReason']>): QualityIssueReason {
  switch (reason) {
    case 'packet_loss':
      return 'packet_loss';
    case 'high_jitter':
      return 'high_jitter';
    case 'high_rtt':
      return 'high_rtt';
    case 'congestion':
      return 'overuse';
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function metricLayerKey(layer: RtpLayerSelection): string {
  return `${layer.spatialLayer ?? 'x'}:${layer.temporalLayer ?? 'x'}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function retransmissionMetricsSnapshot(metrics: RouteMetrics): RtxRepairMetrics {
  const requestedPackets = metrics.retransmission.requestedPackets;
  const missingPackets = metrics.retransmission.missingPackets;
  return {
    requestedPackets,
    retransmittedPackets: metrics.retransmission.retransmittedPackets,
    rtxPackets: metrics.retransmission.rtxPackets,
    primaryRetransmissionPackets: metrics.retransmission.primaryRetransmissionPackets,
    missingPackets,
    successRate: requestedPackets === 0 ? 1 : metrics.retransmission.retransmittedPackets / requestedPackets,
    failureRate: requestedPackets === 0 ? 0 : missingPackets / requestedPackets
  };
}

function captureConsumerDeliveryState(consumerRoute: ConsumerRoute): ConsumerDeliveryStateSnapshot {
  return {
    awaitingKeyframe: consumerRoute.awaitingKeyframe,
    keyframeRequested: consumerRoute.keyframeRequested,
    currentLayers: normalizeLayerSelection(consumerRoute.currentLayers),
    currentSvcLayers: normalizeOptionalSvcLayer(consumerRoute.currentSvcLayers),
    switchStartedAt: consumerRoute.switchStartedAt,
    switchReason: consumerRoute.switchReason,
    lastSwitchingKey: consumerRoute.lastSwitchingKey,
    lastFailedKey: consumerRoute.lastFailedKey,
    consumerCurrentLayers: normalizeLayerSelection(consumerRoute.consumer.currentLayers),
    consumerCurrentSvcLayers: normalizeOptionalSvcLayer(consumerRoute.consumer.currentSvcLayers),
    consumerLayerState: consumerRoute.consumer.layerState ? { ...consumerRoute.consumer.layerState } : undefined
  };
}

function restoreConsumerDeliveryState(consumerRoute: ConsumerRoute, snapshot: ConsumerDeliveryStateSnapshot): void {
  consumerRoute.awaitingKeyframe = snapshot.awaitingKeyframe;
  consumerRoute.keyframeRequested = snapshot.keyframeRequested;
  consumerRoute.currentLayers = snapshot.currentLayers;
  consumerRoute.currentSvcLayers = snapshot.currentSvcLayers;
  consumerRoute.switchStartedAt = snapshot.switchStartedAt;
  consumerRoute.switchReason = snapshot.switchReason;
  consumerRoute.lastSwitchingKey = snapshot.lastSwitchingKey;
  consumerRoute.lastFailedKey = snapshot.lastFailedKey;
  consumerRoute.consumer.currentLayers = snapshot.consumerCurrentLayers;
  consumerRoute.consumer.currentSvcLayers = snapshot.consumerCurrentSvcLayers;
  consumerRoute.consumer.layerState = snapshot.consumerLayerState ? { ...snapshot.consumerLayerState } : undefined;
}

function allowedPayloadTypesForSsrc(producer: Producer, ssrc: number): number[] {
  const source = sourceEncodingForSsrc(producer, ssrc);
  if (!source) {
    return [];
  }
  if (source.isRtx) {
    const rtxPayloadType = source.encoding.rtx?.payloadType ?? rtxCodecForEncoding(producer, source.encoding)?.payloadType;
    return rtxPayloadType === undefined ? [] : [rtxPayloadType];
  }
  return producer.rtpParameters.codecs.filter((codec) => !isRtxCodec(codec)).map((codec) => codec.payloadType);
}

function rewriteReportBlocksForConsumer(reports: ReceiverReport[], consumerRoute: ConsumerRoute): ReceiverReport[] {
  const mappings = consumerRoute.rewriter.snapshot();
  return reports.map((report) => {
    const mapping = mappings.find((candidate) => candidate.sourceSsrc === report.ssrc);
    return mapping ? { ...report, ssrc: mapping.targetSsrc } : report;
  });
}

function sourceEncodingForSsrc(producer: Producer, ssrc: number): SourceEncoding | undefined {
  const index = producer.rtpParameters.encodings.findIndex((encoding) => encoding.ssrc === ssrc || encoding.rtx?.ssrc === ssrc);
  if (index < 0) {
    return undefined;
  }
  const encoding = producer.rtpParameters.encodings[index]!;
  if (!isKnownSsrc(encoding.ssrc)) {
    return undefined;
  }
  return {
    encoding,
    index,
    isRtx: encoding.rtx?.ssrc === ssrc,
    mediaSsrc: encoding.ssrc
  };
}

function rewriteMappingForPacket(producer: Producer, consumer: Consumer, packet: RtpPacket): RtpRewriteMapping | undefined {
  const source = sourceEncodingForSsrc(producer, packet.ssrc);
  if (!source) {
    return undefined;
  }
  const targetEncoding = targetEncodingForSource(consumer, source);
  if (!targetEncoding) {
    return undefined;
  }
  const targetSsrc = source.isRtx ? targetEncoding.rtx?.ssrc : targetEncoding.ssrc;
  if (targetSsrc === undefined) {
    return undefined;
  }
  const targetPayloadType = targetPayloadTypeForPacket(producer, consumer, packet.payloadType, source);
  if (targetPayloadType === undefined) {
    return undefined;
  }
  return {
    sourceSsrc: packet.ssrc,
    targetSsrc,
    sourcePayloadType: packet.payloadType,
    targetPayloadType
  };
}

function targetEncodingForSource(consumer: Consumer, source: SourceEncoding): RtpEncodingParameters | undefined {
  return (
    (source.encoding.rid ? consumer.rtpParameters.encodings.find((encoding) => encoding.rid === source.encoding.rid) : undefined) ??
    consumer.rtpParameters.encodings[source.index] ??
    consumer.rtpParameters.encodings[0]
  );
}

function sourceSsrcForConsumerSsrc(producer: Producer, consumer: Consumer, targetSsrc: number): number | undefined {
  const targetIndex = consumer.rtpParameters.encodings.findIndex((encoding) => encoding.ssrc === targetSsrc || encoding.rtx?.ssrc === targetSsrc);
  if (targetIndex < 0) {
    return undefined;
  }
  const targetEncoding = consumer.rtpParameters.encodings[targetIndex]!;
  const sourceEncoding =
    (targetEncoding.rid ? producer.rtpParameters.encodings.find((encoding) => encoding.rid === targetEncoding.rid) : undefined) ??
    producer.rtpParameters.encodings[targetIndex] ??
    producer.rtpParameters.encodings[0];
  if (!sourceEncoding) {
    return undefined;
  }
  if (targetEncoding.rtx?.ssrc === targetSsrc) {
    return sourceEncoding.rtx?.ssrc ?? sourceEncoding.ssrc;
  }
  return sourceEncoding.ssrc;
}

function targetPayloadTypeForPacket(producer: Producer, consumer: Consumer, sourcePayloadType: number, source: SourceEncoding): number | undefined {
  const sourceCodec = producer.rtpParameters.codecs.find((codec) => codec.payloadType === sourcePayloadType);
  if (!sourceCodec) {
    return undefined;
  }
  if (!source.isRtx) {
    return consumer.rtpParameters.codecs.find((codec) => codec.mimeType.toLowerCase() === sourceCodec.mimeType.toLowerCase())?.payloadType ?? sourcePayloadType;
  }
  const sourceApt = codecParameterNumber(sourceCodec, 'apt') ?? primaryPayloadTypeForEncoding(producer, source.encoding);
  const targetPrimary = sourceApt === undefined ? undefined : targetPrimaryPayloadTypeForApt(producer, consumer, sourceApt);
  const targetRtx = consumer.rtpParameters.codecs.find((codec) => isRtxCodec(codec) && (targetPrimary === undefined || codecParameterNumber(codec, 'apt') === targetPrimary));
  return targetRtx?.payloadType ?? sourcePayloadType;
}

function targetPrimaryPayloadTypeForApt(producer: Producer, consumer: Consumer, sourceApt: number): number | undefined {
  const sourceCodec = producer.rtpParameters.codecs.find((codec) => codec.payloadType === sourceApt);
  if (!sourceCodec) {
    return undefined;
  }
  return consumer.rtpParameters.codecs.find((codec) => codec.mimeType.toLowerCase() === sourceCodec.mimeType.toLowerCase())?.payloadType;
}

function primaryPayloadTypeForEncoding(producer: Producer, _encoding: RtpEncodingParameters): number | undefined {
  return producer.rtpParameters.codecs.find((codec) => !isRtxCodec(codec))?.payloadType;
}

function rtxCodecForEncoding(producer: Producer, encoding: RtpEncodingParameters): RtpCodecParameters | undefined {
  if (encoding.rtx?.payloadType !== undefined) {
    return producer.rtpParameters.codecs.find((codec) => codec.payloadType === encoding.rtx?.payloadType);
  }
  const primaryPayloadType = primaryPayloadTypeForEncoding(producer, encoding);
  return producer.rtpParameters.codecs.find((codec) => isRtxCodec(codec) && codecParameterNumber(codec, 'apt') === primaryPayloadType);
}

function isRtxCodec(codec: RtpCodecParameters): boolean {
  return /\/rtx$/i.test(codec.mimeType);
}

function codecParameterNumber(codec: RtpCodecParameters, key: string): number | undefined {
  const value = codec.parameters?.[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstMediaSsrc(producer: Producer): number | undefined {
  return producer.rtpParameters.encodings.map((encoding) => encoding.ssrc).find(isKnownSsrc);
}

function firstMediaSsrcFromRtpParameters(parameters: { encodings: RtpEncodingParameters[] }): number | undefined {
  return parameters.encodings.map((encoding) => encoding.ssrc).find(isKnownSsrc);
}

function normalizeConsumerPriority(priority: number | undefined): number {
  if (priority === undefined || !Number.isFinite(priority)) {
    return 1;
  }
  return Math.max(0.1, Math.min(10, priority));
}

function isLayerUpgrade(previous: RtpLayerSelection, next: RtpLayerSelection): boolean {
  return (next.spatialLayer ?? -1) > (previous.spatialLayer ?? -1) || ((next.spatialLayer ?? -1) === (previous.spatialLayer ?? -1) && (next.temporalLayer ?? -1) > (previous.temporalLayer ?? -1));
}

function isSvcLayerUpgrade(previous: SvcLayerSelection, next: SvcLayerSelection): boolean {
  return (
    (next.spatialLayerId ?? -1) > (previous.spatialLayerId ?? -1) ||
    ((next.spatialLayerId ?? -1) === (previous.spatialLayerId ?? -1) && (next.temporalLayerId ?? -1) > (previous.temporalLayerId ?? -1))
  );
}

function isSvcLayerDowngrade(previous: SvcLayerSelection | undefined, next: SvcLayerSelection): boolean {
  if (!previous) {
    return false;
  }
  return (
    (next.spatialLayerId ?? -1) < (previous.spatialLayerId ?? -1) ||
    ((next.spatialLayerId ?? -1) === (previous.spatialLayerId ?? -1) && (next.temporalLayerId ?? -1) < (previous.temporalLayerId ?? -1))
  );
}

function normalizeOptionalSvcLayer(selection: SvcLayerSelection | undefined): SvcLayerSelection | undefined {
  return selection ? normalizeSvcLayer(selection) : undefined;
}

function layerKey(layer: RtpLayerSelection | undefined, reason: string): string {
  return `${layer?.spatialLayer ?? 'x'}:${layer?.temporalLayer ?? 'x'}:${reason}`;
}

function svcLayerEventKey(layer: SvcLayerSelection | undefined, reason: string): string {
  return `${layer?.spatialLayerId ?? 'x'}:${layer?.temporalLayerId ?? 'x'}:${layer?.qualityLayerId ?? layer?.spatialLayerId ?? 'x'}:${reason}`;
}

function sourceCodecForPacket(producer: Producer, packet: RtpPacket): RtpCodecParameters | undefined {
  if (sourceEncodingForSsrc(producer, packet.ssrc)?.isRtx) {
    const source = sourceEncodingForSsrc(producer, packet.ssrc);
    return source ? rtxCodecForEncoding(producer, source.encoding) : undefined;
  }
  return producer.rtpParameters.codecs.find((codec) => codec.payloadType === packet.payloadType && !isRtxCodec(codec));
}

function safeParseRtpHeaderExtensions(packet: RtpPacket, parameters: Parameters<typeof parseRtpHeaderExtensions>[1]): ReturnType<typeof parseRtpHeaderExtensions> {
  try {
    return parseRtpHeaderExtensions(packet, parameters);
  } catch {
    return [];
  }
}
