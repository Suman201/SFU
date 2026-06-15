import type { Consumer, Producer, ProducerKind, RtpCodecParameters, RtpEncodingParameters, RtpLayerInfo, RtpLayerSelection } from '@native-sfu/contracts';
import { BandwidthEstimator, type BandwidthEstimate } from '../bandwidth/bandwidth-estimator';
import { PacketPacingQueue, type PacketPacingQueueSnapshot } from '../bandwidth/pacing-queue';
import { detectKeyframe } from '../codecs/keyframe-detector';
import {
  parseFir,
  parseNack,
  parsePli,
  parseReceiverReport,
  parseRemb,
  parseRtcpCompound,
  parseSenderReport,
  createNack,
  createReceiverReport,
  createPli,
  createFir,
  createRemb,
  serializeRtcpPacket
} from '../rtcp/rtcp-packet';
import { parseTransportWideCcFeedback, TransportWideSequenceNumber, TwccArrivalTracker, twccMetricsFromFeedback, type TransportWideCcFeedback } from '../twcc/twcc';
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
import { RtpRetransmissionCache, type RtpRetransmissionCacheSnapshot } from './retransmission-cache';
import { ProducerSimulcastState, isKnownSsrc, normalizeLayerSelection, preferredLayerNameToSelection, sameLayer } from '../simulcast/simulcast-state';

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

export interface RtpRouterOptions {
  onForwardedPacket?: (kind: ProducerKind) => void;
  onDroppedPacket?: (reason: RtpPacketDropReason) => void;
  onBufferedPacket?: (ssrc: number, sequenceNumber: number) => void;
  onStreamRestart?: (producerId: string, ssrc: number) => void;
  onForwardedRtcpPacket?: (feedbackKind: RtcpFeedbackKind, direction: RtcpDirection) => void;
  onDroppedRtcpPacket?: (reason: RtcpDropReason) => void;
  onRetransmittedPacket?: (kind: ProducerKind) => void;
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
  retransmissionCacheSize?: number;
  keyframeRequestIntervalMs?: number;
  maxReorderPackets?: number;
  restartSequenceGap?: number;
  duplicateWindowSize?: number;
  enableTwcc?: boolean;
  enablePacing?: boolean;
  enableJoinKeyframeGate?: boolean;
  enableAdaptiveLayerSelection?: boolean;
  defaultPacingBitrateBps?: number;
  maxPacingQueueBytes?: number;
  twccFeedbackIntervalMs?: number;
  bandwidthEstimator?: BandwidthEstimator;
  sequenceNumberGenerator?: () => number;
  timestampGenerator?: () => number;
  now?: () => number;
}

interface ProducerRoute {
  producer: Producer;
  paused: boolean;
  ssrcs: Set<number>;
  streams: Map<number, RtpSourceStreamState>;
  simulcast: ProducerSimulcastState;
  cache: RtpRetransmissionCache;
  twccArrivals: TwccArrivalTracker;
  lastTwccFeedbackAt: number;
  rtcpWriter?: RtcpWriter;
}

interface ConsumerRoute {
  consumer: Consumer;
  paused: boolean;
  writer: RtpWriter;
  rtcpWriter?: RtcpWriter;
  rewriter: ConsumerRtpRewriter;
  twccSequence: TransportWideSequenceNumber;
  pacer: PacketPacingQueue;
  awaitingKeyframe: boolean;
  keyframeRequested: boolean;
  preferredLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
}

interface SourceEncoding {
  encoding: RtpEncodingParameters;
  index: number;
  isRtx: boolean;
  mediaSsrc: number;
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
  private readonly keyframeRequests = new Map<string, number>();
  private readonly transportPacers = new Map<string, PacketPacingQueue>();
  private readonly bandwidthEstimator: BandwidthEstimator;

  constructor(private readonly options: RtpRouterOptions = {}) {
    this.bandwidthEstimator = options.bandwidthEstimator ?? new BandwidthEstimator();
  }

  addProducer(producer: Producer, rtcpWriter?: RtcpWriter): void {
    const simulcast = new ProducerSimulcastState(producer, this.now);
    const ssrcs = new Set(simulcast.knownSsrcList());
    const streams = new Map<number, RtpSourceStreamState>();
    for (const ssrc of ssrcs) {
      streams.set(
        ssrc,
        new RtpSourceStreamState({
          ssrc,
          allowedPayloadTypes: allowedPayloadTypesForSsrc(producer, ssrc),
          maxReorderPackets: this.options.maxReorderPackets,
          restartSequenceGap: this.options.restartSequenceGap,
          duplicateWindowSize: this.options.duplicateWindowSize
        })
      );
    }
    this.producers.set(producer.id, {
      producer,
      paused: producer.status === 'paused',
      ssrcs,
      streams,
      simulcast,
      cache: new RtpRetransmissionCache(this.options.retransmissionCacheSize ?? 512, this.now),
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
    }
    route.cache.clear();
    this.producers.delete(producerId);
    this.consumersByProducer.delete(producerId);
  }

  setProducerPaused(producerId: string, paused: boolean): void {
    const route = this.producers.get(producerId);
    if (route) {
      route.paused = paused;
    }
  }

  addConsumer(consumer: Consumer, writer: RtpWriter, rtcpWriter?: RtcpWriter): void {
    const preferredLayers = normalizeLayerSelection(consumer.preferredLayers ?? preferredLayerNameToSelection(consumer.preferredLayer));
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
      pacer: new PacketPacingQueue({
        id: `consumer:${consumer.id}`,
        targetBitrateBps: this.options.defaultPacingBitrateBps ?? 50_000_000,
        maxQueueBytes: this.options.maxPacingQueueBytes,
        now: this.now,
        onQueueDepth: (snapshot) => this.options.onPacingQueueDepth?.(snapshot)
      }),
      awaitingKeyframe: this.shouldGateConsumerUntilKeyframe(consumer),
      keyframeRequested: false,
      preferredLayers,
      currentLayers: normalizeLayerSelection(consumer.currentLayers),
      targetLayers: preferredLayers
    };
    consumer.preferredLayers = preferredLayers;
    consumer.currentLayers = consumerRoute.currentLayers;
    this.consumers.set(consumer.id, consumerRoute);
    this.addToSet(this.consumersByProducer, consumer.producerId, consumer.id);
    this.addToSet(this.participantConsumers, consumer.participantId, consumer.id);
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
    if (![...this.consumers.values()].some((consumerRoute) => consumerRoute.consumer.transportId === route.consumer.transportId)) {
      this.transportPacers.delete(route.consumer.transportId);
    }
  }

  setConsumerPaused(consumerId: string, paused: boolean): void {
    const route = this.consumers.get(consumerId);
    if (route) {
      route.paused = paused;
    }
  }

  setConsumerPreferredLayers(consumerId: string, preferredLayers: RtpLayerSelection): RtpLayerSelection | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    route.preferredLayers = normalizeLayerSelection(preferredLayers);
    route.targetLayers = route.preferredLayers;
    route.consumer.preferredLayers = route.preferredLayers;
    if (!sameLayer(route.currentLayers, route.targetLayers)) {
      route.keyframeRequested = false;
      void this.requestKeyframeForConsumer(route).catch(() => undefined);
    }
    return route.preferredLayers;
  }

  consumerLayerSnapshot(consumerId: string): { preferredLayers?: RtpLayerSelection; currentLayers?: RtpLayerSelection; targetLayers?: RtpLayerSelection } | undefined {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return undefined;
    }
    return {
      preferredLayers: route.preferredLayers,
      currentLayers: route.currentLayers,
      targetLayers: route.targetLayers
    };
  }

  producerLayerSnapshot(producerId: string): { availableLayers: RtpLayerInfo[]; currentLayers?: RtpLayerSelection } | undefined {
    const route = this.producers.get(producerId);
    if (!route) {
      return undefined;
    }
    return {
      availableLayers: route.simulcast.availableLayers(),
      currentLayers: route.simulcast.currentLayers()
    };
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
    if (accepted.buffered) {
      this.options.onBufferedPacket?.(packet.ssrc, packet.sequenceNumber);
      return 0;
    }
    if (accepted.restarted) {
      this.options.onStreamRestart?.(producerId, packet.ssrc);
      for (const consumerId of this.consumersByProducer.get(producerId) ?? []) {
        this.consumers.get(consumerId)?.rewriter.resetSource(packet.ssrc);
      }
    }
    const consumerIds = this.consumersByProducer.get(producerId);
    if (!consumerIds || consumerIds.size === 0) {
      this.options.onDroppedPacket?.('no_consumers');
      return 0;
    }
    let forwarded = 0;
    for (const released of accepted.packets) {
      producerRoute.cache.store(released);
      this.recordInboundAdaptiveState(producerRoute, released, buffer.length);
      const activity = producerRoute.simulcast.markPacket(released.ssrc);
      if (activity?.becameActive) {
        this.options.onProducerLayerActive?.(producerId, activity.layer);
      }
      for (const consumerId of consumerIds) {
        const consumerRoute = this.consumers.get(consumerId);
        if (!consumerRoute || consumerRoute.paused || !this.shouldForwardLayer(producerRoute, consumerRoute, released)) {
          continue;
        }
        if (this.shouldHoldForKeyframe(producerRoute, consumerRoute, released)) {
          continue;
        }
        const rewritten = this.rewriteForConsumer(producerRoute.producer, consumerRoute, released);
        if (!rewritten) {
          this.options.onDroppedPacket?.('invalid_ssrc');
          continue;
        }
        await this.sendRtpToConsumer(consumerRoute, rewritten);
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
      stream = new RtpSourceStreamState({
        ssrc,
        allowedPayloadTypes: allowedPayloadTypesForSsrc(producerRoute.producer, ssrc),
        maxReorderPackets: this.options.maxReorderPackets,
        restartSequenceGap: this.options.restartSequenceGap,
        duplicateWindowSize: this.options.duplicateWindowSize
      });
      producerRoute.streams.set(ssrc, stream);
    }
    return stream;
  }

  private shouldForwardLayer(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute, packet: RtpPacket): boolean {
    if (producerRoute.producer.kind === 'audio') {
      return true;
    }
    const packetLayer = producerRoute.simulcast.layerSelectionForSsrc(packet.ssrc);
    if (!packetLayer) {
      return false;
    }
    const target = this.selectTargetLayers(producerRoute, consumerRoute);
    if (!target) {
      this.options.onLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, packetLayer, 'missing_layer');
      return false;
    }
    consumerRoute.targetLayers = target;
    if (!consumerRoute.currentLayers) {
      if (!sameLayer(packetLayer, target)) {
        return false;
      }
      if (consumerRoute.awaitingKeyframe && !this.packetIsKeyframe(producerRoute, packet)) {
        this.options.onKeyframeGateDropped?.(consumerRoute.consumer.id, producerRoute.producer.id);
        this.options.onLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, target, 'missing_keyframe');
        if (!consumerRoute.keyframeRequested) {
          void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
        }
        return false;
      }
      if (consumerRoute.awaitingKeyframe) {
        this.options.onKeyframeGateOpened?.(consumerRoute.consumer.id, producerRoute.producer.id);
      }
      this.setCurrentLayers(consumerRoute, producerRoute.producer.id, target);
      return true;
    }
    if (sameLayer(consumerRoute.currentLayers, target)) {
      return sameLayer(packetLayer, consumerRoute.currentLayers);
    }
    if (sameLayer(packetLayer, target)) {
      if (!this.packetIsKeyframe(producerRoute, packet)) {
        this.options.onLayerSwitchFailed?.(consumerRoute.consumer.id, producerRoute.producer.id, target, 'missing_keyframe');
        if (!consumerRoute.keyframeRequested) {
          void this.requestKeyframeForConsumer(consumerRoute).catch(() => undefined);
        }
        return false;
      }
      this.setCurrentLayers(consumerRoute, producerRoute.producer.id, target);
      return true;
    }
    return sameLayer(packetLayer, consumerRoute.currentLayers);
  }

  private selectTargetLayers(producerRoute: ProducerRoute, consumerRoute: ConsumerRoute): RtpLayerSelection | undefined {
    const estimate = this.bandwidthEstimator.estimate(consumerRoute.consumer.id);
    const result = producerRoute.simulcast.selectLayer(estimate, consumerRoute.preferredLayers, this.options.enableAdaptiveLayerSelection !== false);
    return normalizeLayerSelection(result.selection);
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

  private setCurrentLayers(consumerRoute: ConsumerRoute, producerId: string, layers: RtpLayerSelection): void {
    const normalized = normalizeLayerSelection(layers);
    if (!normalized) {
      return;
    }
    const previous = consumerRoute.currentLayers;
    consumerRoute.currentLayers = normalized;
    consumerRoute.consumer.currentLayers = normalized;
    consumerRoute.awaitingKeyframe = false;
    consumerRoute.keyframeRequested = false;
    if (!sameLayer(previous, normalized)) {
      this.options.onConsumerLayersChanged?.(consumerRoute.consumer.id, normalized);
      if (previous) {
        this.options.onLayerSwitch?.(consumerRoute.consumer.id, producerId, previous, normalized);
      }
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
    for (const sequenceNumber of lostPacketIds) {
      const sourceSequence = resolution.consumerRoute?.rewriter.sourceSequenceForTarget(mediaSsrc, sequenceNumber)?.sequenceNumber ?? sequenceNumber;
      const cached = producerRoute.cache.get(sourceSsrc, sourceSequence);
      if (!cached) {
        missing.push(sourceSequence);
        this.options.onRetransmissionMiss?.(sourceSsrc, sourceSequence);
        continue;
      }
      for (const consumerRoute of consumers) {
        if (!this.shouldForwardLayer(producerRoute, consumerRoute, cached)) {
          continue;
        }
        const rewritten = this.rewriteForConsumer(producerRoute.producer, consumerRoute, cached);
        if (!rewritten) {
          continue;
        }
        await consumerRoute.writer(rewritten, consumerRoute.consumer);
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
      if (!this.shouldForwardKeyframeRequest(producerId, feedbackKind)) {
        this.options.onKeyframeRequestCoalesced?.(producerId, feedbackKind);
        continue;
      }
      this.options.onKeyframeRequestForwarded?.(producerId, feedbackKind);
      forwarded += await this.routeRtcpToProducerSsrcs(new Set([...resolutions].filter((resolution) => resolution.producerId === producerId)), packet, feedbackKind);
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
      await consumerRoute.rtcpWriter(packet, consumerRoute.consumer, feedbackKind);
      this.options.onForwardedRtcpPacket?.(feedbackKind, 'consumer');
      forwarded += 1;
    }
    return forwarded;
  }

  private shouldForwardKeyframeRequest(producerId: string, feedbackKind: 'pli' | 'fir'): boolean {
    const key = `${producerId}:keyframe`;
    const now = this.now();
    const lastForwardedAt = this.keyframeRequests.get(key);
    if (lastForwardedAt !== undefined && now - lastForwardedAt < (this.options.keyframeRequestIntervalMs ?? 1000)) {
      return false;
    }
    this.keyframeRequests.set(key, now);
    return true;
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
    if (now - producerRoute.lastTwccFeedbackAt < (this.options.twccFeedbackIntervalMs ?? 100)) {
      return;
    }
    const feedback = producerRoute.twccArrivals.createFeedback(0, mediaSsrc);
    if (!feedback) {
      return;
    }
    producerRoute.lastTwccFeedbackAt = now;
    await producerRoute.rtcpWriter(feedback, producerRoute.producer, 'twcc');
    this.options.onForwardedRtcpPacket?.('twcc', 'producer');
  }

  private async sendRtpToConsumer(consumerRoute: ConsumerRoute, packet: RtpPacket): Promise<void> {
    const size = packet.serialize().length;
    const send = async () => {
      await consumerRoute.writer(packet, consumerRoute.consumer);
      const estimate = this.bandwidthEstimator.observePacket(consumerRoute.consumer.id, 'outgoing', size, this.now());
      consumerRoute.pacer.updateTargetBitrate(estimate.recommendedBitrate || this.options.defaultPacingBitrateBps || 50_000_000);
      this.options.onBandwidthEstimate?.(consumerRoute.consumer.id, estimate);
      const twcc = safeParseRtpHeaderExtensions(packet, consumerRoute.consumer.rtpParameters).find((extension) => extension.kind === 'twcc');
      if (typeof twcc?.value === 'number') {
        this.options.onTwccPacketArrival?.(consumerRoute.consumer.id, twcc.value, 'outgoing');
      }
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
    consumerRoute.keyframeRequested = true;
    if (!this.shouldForwardKeyframeRequest(producerRoute.producer.id, 'pli')) {
      this.options.onKeyframeRequestCoalesced?.(producerRoute.producer.id, 'pli');
      return;
    }
    const senderSsrc = firstMediaSsrcFromRtpParameters(consumerRoute.consumer.rtpParameters) ?? 0;
    this.options.onKeyframeRequestForwarded?.(producerRoute.producer.id, 'pli');
    await producerRoute.rtcpWriter(createPli({ senderSsrc, mediaSsrc }), producerRoute.producer, 'pli');
    this.options.onForwardedRtcpPacket?.('pli', 'producer');
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
    const estimate = this.bandwidthEstimator.updateTwcc(route.consumer.id, {
      packetLoss: metrics.packetLoss,
      delayVariationMs: metrics.delayVariationMs,
      timestamp: this.now()
    });
    route.pacer.updateTargetBitrate(estimate.recommendedBitrate || this.options.defaultPacingBitrateBps || 50_000_000);
    this.options.onTwccFeedback?.(route.consumer.id, feedback);
    this.options.onBandwidthEstimate?.(route.consumer.id, estimate);
  }

  private rewriteForConsumer(producer: Producer, consumerRoute: ConsumerRoute, packet: RtpPacket): RtpPacket | undefined {
    const mapping = rewriteMappingForPacket(producer, consumerRoute.consumer, packet);
    if (!mapping) {
      return undefined;
    }
    const rewritten = consumerRoute.rewriter.rewrite(packet, mapping);
    const plan = negotiateRtpHeaderExtensions(producer.rtpParameters, consumerRoute.consumer.rtpParameters);
    if (plan.length === 0) {
      return cloneRtpPacketWithHeaderExtension(rewritten, null);
    }
    const headerExtension = rewriteRtpHeaderExtensions(packet, plan, {
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
          continue;
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
        continue;
      }
      const producerId = this.producerBySsrc.get(sourceSsrc);
      if (producerId) {
        return { producerId, sourceSsrc, consumerRoute };
      }
    }
    return undefined;
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
    const producerRoute = this.producers.get(consumer.producerId);
    if (!producerRoute || producerRoute.producer.kind === 'audio') {
      return false;
    }
    return producerRoute.producer.rtpParameters.codecs.some((codec) =>
      codec.rtcpFeedback?.some((feedback) => /\b(pli|fir)\b/i.test(feedback) || /\bccm\s+fir\b/i.test(feedback))
    );
  }
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
