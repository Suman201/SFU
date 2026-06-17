import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  Consumer,
  ConsumerQualityState,
  ConsumerLayerEvent,
  ConsumerLayerState,
  IceCandidate,
  Producer,
  ProducerQualityState,
  ProducerDynacastEvent,
  ProducerDynacastState,
  ProducerLayerState,
  RoomQualityState,
  RtpLayerSelection,
  RtpParameters,
  SvcLayerSelection,
  TransportQualityState,
  TransportOptions
} from '@native-sfu/contracts';
import {
  type ConsumerTwccObservation,
  type ConsumerTwccObservationEvent,
  createPli,
  parseRtcpCompound,
  RTCP_PSFB,
  RTCP_RR,
  RTCP_RTPFB,
  RTCP_SR,
  RtcpFeedback,
  RtcpProcessor,
  RtpRouter,
  serializeRtcpPacket,
  type RtcpPacket
} from '@native-sfu/sfu-core';
import { DtlsService } from './dtls.service';
import { IceService } from './ice.service';
import { MediaPacketBridge, type MediaPacketBridgeCounters } from './media/media-packet-bridge';
import type { PipeTransportAdapter } from './pipe-transport.adapter';
import { SrtpService } from './srtp.service';
import type { MediaWorkerPoolSnapshot, MediaWorkerRoomFailureEvent } from './worker/ipc';

interface ManagedTransport {
  id: string;
  roomId: string;
  participantId: string;
  options: TransportOptions;
  remoteCandidates: IceCandidate[];
  iceAgentId: string;
  dtlsTransportId: string;
  producerRtp?: RtpParameters;
  inboundSsrcs: number[];
  outboundSsrcs: number[];
  bridge: MediaPacketBridge;
  closed: boolean;
}

interface ManagedPipeTransport {
  roomId: string;
  producerIds: Set<string>;
  consumerIds: Set<string>;
}

@Injectable()
export class MediaService {
  private readonly transports = new Map<string, ManagedTransport>();
  private readonly pipeTransports = new Map<string, ManagedPipeTransport>();
  private readonly producers = new Map<string, Producer>();
  private readonly consumers = new Map<string, Consumer>();
  private readonly consumerLayerStates = new Map<string, ConsumerLayerState>();
  private readonly producerDynacastStates = new Map<string, ProducerDynacastState>();
  private readonly consumerQualityStates = new Map<string, ConsumerQualityState>();
  private readonly producerQualityStates = new Map<string, ProducerQualityState>();
  private readonly transportQualityStates = new Map<string, TransportQualityState>();
  private readonly roomQualityStates = new Map<string, RoomQualityState>();
  private readonly layerEventListeners = new Set<(event: ConsumerLayerEvent) => void>();
  private readonly producerDynacastEventListeners = new Set<(event: ProducerDynacastEvent) => void>();
  private readonly consumerTwccObservationListeners = new Set<(state: ConsumerTwccObservationEvent) => void>();
  private readonly consumerQualityEventListeners = new Set<(state: ConsumerQualityState) => void>();
  private readonly producerQualityEventListeners = new Set<(state: ProducerQualityState) => void>();
  private readonly transportQualityEventListeners = new Set<(state: TransportQualityState) => void>();
  private readonly roomQualityEventListeners = new Set<(state: RoomQualityState) => void>();

  constructor(
    private readonly ice: IceService,
    private readonly dtls: DtlsService,
    private readonly srtp: SrtpService,
    private readonly rtcp: RtcpProcessor,
    private readonly router: RtpRouter,
    private readonly pipe?: PipeTransportAdapter
  ) {
    this.router.onConsumerLayerEvent((event) => {
      const consumer = this.consumers.get(event.consumerId);
      if (consumer) {
        consumer.currentLayers = event.currentLayers;
        consumer.targetLayers = event.targetLayers;
        consumer.currentSvcLayers = event.currentSvcLayers;
        consumer.targetSvcLayers = event.targetSvcLayers;
        consumer.preferredSvcLayers = event.preferredSvcLayers ?? consumer.preferredSvcLayers;
        consumer.layerState = this.consumerLayerStateFromEvent(event, consumer);
        this.consumerLayerStates.set(event.consumerId, consumer.layerState);
      }
      for (const listener of this.layerEventListeners) {
        listener(event);
      }
    });
    this.router.onProducerDynacastEvent((event) => {
      const producer = this.producers.get(event.producerId);
      if (producer) {
        producer.dynacast = event.state;
        this.producerDynacastStates.set(event.producerId, event.state);
      }
      for (const listener of this.producerDynacastEventListeners) {
        listener(event);
      }
    });
    this.router.onConsumerTwccObservation((state) => {
      for (const listener of this.consumerTwccObservationListeners) {
        listener(state);
      }
    });
    this.router.onConsumerScoreUpdated((state) => {
      const consumer = this.consumers.get(state.consumerId);
      if (consumer) {
        consumer.quality = state;
      }
      this.consumerQualityStates.set(state.consumerId, state);
      for (const listener of this.consumerQualityEventListeners) {
        listener(state);
      }
    });
    this.router.onProducerScoreUpdated((state) => {
      const producer = this.producers.get(state.producerId);
      if (producer) {
        producer.quality = state;
      }
      this.producerQualityStates.set(state.producerId, state);
      for (const listener of this.producerQualityEventListeners) {
        listener(state);
      }
    });
    this.router.onTransportQualityUpdated((state) => {
      this.transportQualityStates.set(state.transportId, state);
      for (const listener of this.transportQualityEventListeners) {
        listener(state);
      }
    });
    this.router.onRoomQualityUpdated((state) => {
      this.roomQualityStates.set(state.roomId, state);
      for (const listener of this.roomQualityEventListeners) {
        listener(state);
      }
    });
  }

  onConsumerLayerEvent(listener: (event: ConsumerLayerEvent) => void): () => void {
    this.layerEventListeners.add(listener);
    return () => this.layerEventListeners.delete(listener);
  }

  onProducerDynacastEvent(listener: (event: ProducerDynacastEvent) => void): () => void {
    this.producerDynacastEventListeners.add(listener);
    return () => this.producerDynacastEventListeners.delete(listener);
  }

  onConsumerTwccObservation(listener: (state: ConsumerTwccObservationEvent) => void): () => void {
    this.consumerTwccObservationListeners.add(listener);
    return () => this.consumerTwccObservationListeners.delete(listener);
  }

  onConsumerScoreUpdated(listener: (state: ConsumerQualityState) => void): () => void {
    this.consumerQualityEventListeners.add(listener);
    return () => this.consumerQualityEventListeners.delete(listener);
  }

  onProducerScoreUpdated(listener: (state: ProducerQualityState) => void): () => void {
    this.producerQualityEventListeners.add(listener);
    return () => this.producerQualityEventListeners.delete(listener);
  }

  onTransportQualityUpdated(listener: (state: TransportQualityState) => void): () => void {
    this.transportQualityEventListeners.add(listener);
    return () => this.transportQualityEventListeners.delete(listener);
  }

  onRoomQualityUpdated(listener: (state: RoomQualityState) => void): () => void {
    this.roomQualityEventListeners.add(listener);
    return () => this.roomQualityEventListeners.delete(listener);
  }

  onMediaWorkerRoomFailed(_listener: (event: MediaWorkerRoomFailureEvent) => void): () => void {
    return () => undefined;
  }

  async createWebRtcTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    const id = randomUUID();
    const agent = await this.ice.createAgent(id, roomId, participantId);
    const snapshot = agent.snapshot();
    const iceParameters = snapshot.localParameters;
    const iceCandidates = snapshot.localCandidates.map(toPublicCandidate);
    const dtlsTransport = await this.dtls.createTransport(id, agent);
    const bridge = new MediaPacketBridge({
      transportId: id,
      participantId,
      ice: agent,
      getSrtpSession: () => this.srtp.getSession(id),
      onRtp: (packet) => this.router.route(packet, { sourceTransportId: id, sourceParticipantId: participantId }),
      onRtcp: (packet) => this.handleRtcp(id, participantId, packet).then((result) => result.forwarded),
      onError: () => undefined
    });
    bridge.on('error', () => undefined);
    dtlsTransport.on('connect', (keyingMaterial) => {
      const session = this.srtp.createSession(id, keyingMaterial);
      const transport = this.transports.get(id);
      if (transport) {
        session.setInboundSsrcs(transport.inboundSsrcs);
        session.setOutboundSsrcs(transport.outboundSsrcs);
      }
    });
    const dtlsParameters = await this.dtls.createParameters();
    const options: TransportOptions = {
      id,
      roomId,
      participantId,
      iceParameters,
      iceCandidates,
      dtlsParameters
    };
    this.transports.set(id, {
      id,
      roomId,
      participantId,
      options,
      iceAgentId: id,
      dtlsTransportId: dtlsTransport.transportId,
      remoteCandidates: [],
      inboundSsrcs: [],
      outboundSsrcs: [],
      bridge,
      closed: false
    });
    return options;
  }

  assertTransportOwner(transportId: string, participantId: string): void {
    this.requireTransport(transportId, participantId);
  }

  async addRemoteCandidate(transportId: string, participantId: string, candidate: IceCandidate): Promise<void> {
    const transport = this.requireTransport(transportId, participantId);
    this.ice.validateCandidate(candidate);
    transport.remoteCandidates.push(candidate);
    this.ice.addRemoteCandidate(transportId, participantId, candidate);
  }

  async setRemoteIceParameters(transportId: string, participantId: string, parameters: TransportOptions['iceParameters']): Promise<void> {
    this.requireTransport(transportId, participantId);
    this.ice.setRemoteParameters(transportId, participantId, parameters);
  }

  async setRemoteDtlsParameters(transportId: string, participantId: string, parameters: TransportOptions['dtlsParameters']): Promise<void> {
    this.requireTransport(transportId, participantId);
    this.dtls.setRemoteParameters(transportId, parameters);
  }

  async restartIce(transportId: string, participantId: string): Promise<TransportOptions> {
    const transport = this.requireTransport(transportId, participantId);
    const snapshot = await this.ice.restartAgent(transportId, participantId);
    transport.options = {
      ...transport.options,
      iceParameters: snapshot.localParameters,
      iceCandidates: snapshot.localCandidates.map(toPublicCandidate)
    };
    transport.remoteCandidates = [];
    return transport.options;
  }

  async bindProducer(transportId: string, participantId: string, rtpParameters: RtpParameters): Promise<void> {
    const transport = this.requireTransport(transportId, participantId);
    transport.producerRtp = rtpParameters;
    const inboundSsrcs = rtpSsrcs(rtpParameters);
    transport.inboundSsrcs = inboundSsrcs;
    const session = this.srtp.getSession(transportId);
    if (session) {
      session.setInboundSsrcs(inboundSsrcs);
    }
  }

  async registerProducer(producer: Producer): Promise<void> {
    const transport = this.transports.get(producer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Producer transport not found');
    }
    this.producers.set(producer.id, producer);
    this.router.addProducer(producer, async (packet, target) => {
      await this.sendProducerRtcpToTransport(target.transportId, packet);
    });
    const dynacast = this.router.producerDynacastSnapshot(producer.id);
    const layers = this.router.producerLayerSnapshot(producer.id);
    if (layers?.svc) {
      producer.svc = layers.svc;
    }
    if (dynacast) {
      producer.dynacast = dynacast;
      this.producerDynacastStates.set(producer.id, dynacast);
    }
  }

  async registerPipeProducer(producer: Producer, pipeTransportId = producer.transportId): Promise<void> {
    this.requirePipeTransport(pipeTransportId);
    const pipeProducer = { ...producer, transportId: pipeTransportId };
    this.trackPipeProducer(pipeTransportId, pipeProducer);
    this.producers.set(pipeProducer.id, pipeProducer);
    this.router.addProducer(pipeProducer, async (packet, target) => {
      await this.requirePipe().sendRtcp(pipeTransportId, packet, { producerId: target.id });
    });
    const dynacast = this.router.producerDynacastSnapshot(pipeProducer.id);
    const layers = this.router.producerLayerSnapshot(pipeProducer.id);
    if (layers?.svc) {
      pipeProducer.svc = layers.svc;
    }
    if (dynacast) {
      pipeProducer.dynacast = dynacast;
      this.producerDynacastStates.set(pipeProducer.id, dynacast);
    }
  }

  async unregisterProducer(producerId: string): Promise<void> {
    this.releasePipeProducer(producerId);
    this.producers.delete(producerId);
    this.producerDynacastStates.delete(producerId);
    this.producerQualityStates.delete(producerId);
    this.router.removeProducer(producerId);
  }

  async setProducerPaused(producerId: string, paused: boolean): Promise<void> {
    this.router.setProducerPaused(producerId, paused);
  }

  setProducerPriority(producerId: string, priority: number): void {
    const producer = this.producers.get(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    producer.priority = this.router.setProducerPriority(producerId, priority) ?? producer.priority;
  }

  async registerConsumer(consumer: Consumer): Promise<void> {
    const transport = this.transports.get(consumer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Consumer transport not found');
    }
    const registeredConsumer = this.primePipeBackedConsumer(consumer);
    const outboundSsrcs = rtpSsrcs(consumer.rtpParameters);
    transport.outboundSsrcs = mergeUnique(transport.outboundSsrcs, outboundSsrcs);
    const session = this.srtp.getSession(consumer.transportId);
    if (session) {
      session.setOutboundSsrcs(transport.outboundSsrcs);
    }
    this.consumers.set(registeredConsumer.id, registeredConsumer);
    this.router.addConsumer(
      registeredConsumer,
      async (packet, target) => {
        await this.sendRtpToConsumer(target, packet.serialize());
      },
      async (packet, target, feedbackKind) => {
        const producerId = 'producerId' in target ? target.producerId : target.id;
        if (feedbackKind === 'sender-report') {
          await this.sendRtcpToTransport(target.transportId, packet);
          return;
        }
        const producer = this.producers.get(producerId);
        if (producer && this.transports.has(producer.transportId)) {
          await this.sendProducerRtcpToTransport(producer.transportId, packet);
          return;
        }
        if (producer && this.pipe?.hasTransport(producer.transportId)) {
          await this.requirePipe().sendRtcp(producer.transportId, packet, { producerId });
          return;
        }
        await this.sendRtcpToTransport(target.transportId, packet);
      }
    );
    const existingState = this.router.consumerLayerSnapshot(registeredConsumer.id);
    if (existingState) {
      registeredConsumer.layerState = existingState;
      this.consumerLayerStates.set(registeredConsumer.id, existingState);
    }
    await this.maybeRequestPipeBackedProducerKeyframe(registeredConsumer);
  }

  async registerPipeConsumer(consumer: Consumer, pipeTransportId = consumer.transportId): Promise<void> {
    this.requirePipeTransport(pipeTransportId);
    const pipeConsumer = { ...consumer, transportId: pipeTransportId };
    this.trackPipeConsumer(pipeTransportId, pipeConsumer);
    this.consumers.set(pipeConsumer.id, pipeConsumer);
    this.router.addConsumer(
      pipeConsumer,
      async (packet, target) => {
        await this.requirePipe().sendRtp(pipeTransportId, target.producerId, packet.serialize());
      },
      async (packet, target, feedbackKind) => {
        const producerId = 'producerId' in target ? target.producerId : target.id;
        if (feedbackKind === 'sender-report') {
          await this.requirePipe().sendRtcp(pipeTransportId, packet, { consumerId: target.id, producerId });
          return;
        }
        const producer = this.producers.get(producerId);
        if (producer && producer.transportId !== pipeTransportId && this.transports.has(producer.transportId)) {
          await this.sendProducerRtcpToTransport(producer.transportId, packet);
          return;
        }
        await this.requirePipe().sendRtcp(pipeTransportId, packet, { consumerId: target.id, producerId });
      }
    );
    const existingState = this.router.consumerLayerSnapshot(pipeConsumer.id);
    if (existingState) {
      pipeConsumer.layerState = existingState;
      this.consumerLayerStates.set(pipeConsumer.id, existingState);
    }
    await this.maybeRequestPipeConsumerKeyframe(pipeConsumer, pipeTransportId);
  }

  async handleRtcp(transportId: string, participantId: string, packet: Buffer): Promise<{ feedback: RtcpFeedback; forwarded: number }> {
    const transport = this.requireTransport(transportId, participantId);
    const feedback = this.rtcp.process(transport.roomId, participantId, packet);
    const forwarded = await this.router.routeRtcp(packet, { sourceTransportId: transportId, sourceParticipantId: participantId });
    return { feedback, forwarded };
  }

  async handlePipeRtp(pipeTransportId: string, producerId: string | undefined, packet: Buffer): Promise<number> {
    this.requirePipeTransport(pipeTransportId);
    const producer = producerId ? this.producers.get(producerId) : undefined;
    return this.router.route(packet, {
      sourceTransportId: pipeTransportId,
      sourceParticipantId: producer?.participantId
    });
  }

  async handlePipeRtcp(
    pipeTransportId: string,
    packet: Buffer,
    options: { roomId?: string; sourceParticipantId?: string } = {}
  ): Promise<{ feedback?: RtcpFeedback; forwarded: number }> {
    this.requirePipeTransport(pipeTransportId);
    const rewrittenPacket = this.rewritePipeRtcpForLocalProducers(pipeTransportId, packet);
    const snapshot = this.requirePipe().snapshot(pipeTransportId);
    if (!snapshot) {
      throw new NotFoundException('Pipe transport not found');
    }
    const sourceParticipantId = options.sourceParticipantId ?? `pipe:${snapshot.remoteNodeId}`;
    const feedback = this.rtcp.process(options.roomId ?? snapshot.roomId, sourceParticipantId, rewrittenPacket);
    const forwarded = await this.router.routeRtcp(rewrittenPacket, {
      sourceTransportId: pipeTransportId,
      sourceParticipantId
    });
    return { feedback, forwarded };
  }

  async unregisterConsumer(consumerId: string): Promise<void> {
    this.releasePipeConsumer(consumerId);
    this.consumers.delete(consumerId);
    this.consumerLayerStates.delete(consumerId);
    this.consumerQualityStates.delete(consumerId);
    this.router.removeConsumer(consumerId);
  }

  async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    this.router.setConsumerPaused(consumerId, paused);
  }

  async setConsumerPreferredLayers(
    consumerId: string,
    preferredLayers: RtpLayerSelection
  ): Promise<ConsumerLayerState | undefined> {
    this.router.setConsumerPreferredLayers(consumerId, preferredLayers);
    const snapshot = this.router.consumerLayerSnapshot(consumerId);
    if (snapshot) {
      this.consumerLayerStates.set(consumerId, snapshot);
    }
    return snapshot;
  }

  async setConsumerPreferredSvcLayers(
    consumerId: string,
    preferredSvcLayers: SvcLayerSelection
  ): Promise<ConsumerLayerState | undefined> {
    this.router.setConsumerPreferredSvcLayers(consumerId, preferredSvcLayers);
    const snapshot = this.router.consumerLayerSnapshot(consumerId);
    if (snapshot) {
      this.consumerLayerStates.set(consumerId, snapshot);
    }
    return snapshot;
  }

  setConsumerPriority(consumerId: string, priority: number): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    consumer.priority = this.router.setConsumerPriority(consumerId, priority) ?? consumer.priority;
  }

  applyConsumerTwccObservation(consumerId: string, observation: ConsumerTwccObservation): ConsumerQualityState | undefined {
    const state = this.router.applyExternalConsumerTwccObservation(consumerId, observation);
    if (!state) {
      return undefined;
    }
    const consumer = this.consumers.get(consumerId);
    if (consumer) {
      consumer.quality = state;
    }
    this.consumerQualityStates.set(consumerId, state);
    return state;
  }

  consumerLayerState(consumerId: string): ConsumerLayerState | undefined {
    return this.router.consumerLayerSnapshot(consumerId) ?? this.consumerLayerStates.get(consumerId);
  }

  consumerQualityState(consumerId: string): ConsumerQualityState | undefined {
    return this.router.consumerQualitySnapshot(consumerId) ?? this.consumerQualityStates.get(consumerId);
  }

  producerQualityState(producerId: string): ProducerQualityState | undefined {
    return this.router.producerQualitySnapshot(producerId) ?? this.producerQualityStates.get(producerId);
  }

  transportQualityState(transportId: string): TransportQualityState | undefined {
    return this.router.transportQualitySnapshot(transportId) ?? this.transportQualityStates.get(transportId);
  }

  roomQualityState(roomId: string): RoomQualityState | undefined {
    return this.router.roomQualitySnapshot(roomId) ?? this.roomQualityStates.get(roomId);
  }

  producerLayerState(producerId: string): ProducerLayerState | undefined {
    const producer = this.producers.get(producerId);
    const snapshot = this.router.producerLayerSnapshot(producerId);
    if (!producer || !snapshot) {
      return undefined;
    }
    return {
      producerId,
      roomId: producer.roomId,
      participantId: producer.participantId,
      availableLayers: snapshot.availableLayers,
      currentLayers: snapshot.currentLayers,
      svc: snapshot.svc,
      dynacast: snapshot.dynacast ?? this.producerDynacastStates.get(producerId),
      updatedAt: new Date().toISOString()
    };
  }

  getProducer(producerId: string): Producer | undefined {
    return this.producers.get(producerId);
  }

  mediaCounters(transportId: string, participantId: string): MediaPacketBridgeCounters {
    return this.requireTransport(transportId, participantId).bridge.snapshot();
  }

  adaptiveTransportMetrics(): {
    bandwidth: ReturnType<RtpRouter['bandwidthEstimates']>;
    pacing: ReturnType<RtpRouter['pacingSnapshots']>;
    statistics: ReturnType<RtpRouter['statistics']>;
    consumerLayers: ConsumerLayerState[];
    producerLayers: ProducerLayerState[];
    quality: {
      consumers: ConsumerQualityState[];
      producers: ProducerQualityState[];
      transports: TransportQualityState[];
      rooms: RoomQualityState[];
      };
  } {
    const transportIds = new Set<string>([
      ...this.transports.keys(),
      ...this.pipeTransports.keys(),
      ...[...this.producers.values()].map((producer) => producer.transportId),
      ...[...this.consumers.values()].map((consumer) => consumer.transportId)
    ]);
    const roomIds = new Set<string>([
      ...[...this.transports.values()].map((transport) => transport.roomId),
      ...[...this.pipeTransports.values()].map((transport) => transport.roomId),
      ...[...this.producers.values()].map((producer) => producer.roomId),
      ...[...this.consumers.values()].map((consumer) => consumer.roomId),
      ...this.roomQualityStates.keys()
    ]);
    return {
      bandwidth: this.router.bandwidthEstimates(),
      pacing: this.router.pacingSnapshots(),
      statistics: this.router.statistics(),
      consumerLayers: [...this.consumers.keys()].map((consumerId) => this.consumerLayerState(consumerId)).filter((state): state is ConsumerLayerState => Boolean(state)),
      producerLayers: [...this.producers.keys()].map((producerId) => this.producerLayerState(producerId)).filter((state): state is ProducerLayerState => Boolean(state)),
      quality: {
        consumers: [...this.consumers.keys()].map((consumerId) => this.consumerQualityState(consumerId)).filter((state): state is ConsumerQualityState => Boolean(state)),
        producers: [...this.producers.keys()].map((producerId) => this.producerQualityState(producerId)).filter((state): state is ProducerQualityState => Boolean(state)),
        transports: [...transportIds].map((transportId) => this.transportQualityState(transportId)).filter((state): state is TransportQualityState => Boolean(state)),
        rooms: [...roomIds].map((roomId) => this.roomQualityState(roomId)).filter((state): state is RoomQualityState => Boolean(state))
      }
    };
  }

  async waitForMediaIdle(transportId: string, participantId: string, timeoutMs?: number): Promise<void> {
    await this.requireTransport(transportId, participantId).bridge.waitForIdle(timeoutMs);
  }

  async closeParticipantTransports(participantId: string): Promise<void> {
    for (const transport of this.transports.values()) {
      if (transport.participantId === participantId) {
        transport.closed = true;
        transport.bridge.close();
        this.srtp.closeSession(transport.id);
        this.dtls.closeTransport(transport.id);
        this.ice.closeAgent(transport.id);
        this.transportQualityStates.delete(transport.id);
        this.transports.delete(transport.id);
      }
    }
    for (const [producerId, producer] of this.producers) {
      if (producer.participantId === participantId) {
        this.releasePipeProducer(producerId);
        this.producers.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.participantId === participantId) {
        this.releasePipeConsumer(consumerId);
        this.consumers.delete(consumerId);
        this.consumerLayerStates.delete(consumerId);
        this.consumerQualityStates.delete(consumerId);
      }
    }
    this.router.removeParticipant(participantId);
  }

  async closeRoom(roomId: string): Promise<void> {
    for (const transport of this.transports.values()) {
      if (transport.roomId === roomId) {
        transport.closed = true;
        transport.bridge.close();
        this.srtp.closeSession(transport.id);
        this.dtls.closeTransport(transport.id);
        this.ice.closeAgent(transport.id);
        this.transportQualityStates.delete(transport.id);
        this.transports.delete(transport.id);
      }
    }
    for (const [producerId, producer] of this.producers) {
      if (producer.roomId === roomId) {
        this.releasePipeProducer(producerId);
        this.producers.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.roomId === roomId) {
        this.releasePipeConsumer(consumerId);
        this.consumers.delete(consumerId);
        this.consumerLayerStates.delete(consumerId);
        this.consumerQualityStates.delete(consumerId);
      }
    }
    for (const [pipeTransportId, transport] of this.pipeTransports) {
      if (transport.roomId === roomId) {
        this.pipeTransports.delete(pipeTransportId);
      }
    }
    this.roomQualityStates.delete(roomId);
    this.router.removeRoom(roomId);
  }

  async closePipeTransport(pipeTransportId: string): Promise<void> {
    const transport = this.pipeTransports.get(pipeTransportId);
    if (!transport) {
      return;
    }
    for (const producerId of [...transport.producerIds]) {
      this.producers.delete(producerId);
      this.producerDynacastStates.delete(producerId);
      this.producerQualityStates.delete(producerId);
      this.router.removeProducer(producerId);
    }
    for (const consumerId of [...transport.consumerIds]) {
      this.consumers.delete(consumerId);
      this.consumerLayerStates.delete(consumerId);
      this.consumerQualityStates.delete(consumerId);
      this.router.removeConsumer(consumerId);
    }
    this.pipeTransports.delete(pipeTransportId);
  }

  workerPoolSnapshot(): MediaWorkerPoolSnapshot {
    return {
      mode: 'in-process',
      workerCount: 0,
      healthyWorkers: 0,
      readyWorkers: 0,
      drainingWorkers: 0,
      overloadedWorkers: 0,
      activeRooms: new Set([...this.transports.values()].map((transport) => transport.roomId)).size,
      failedRooms: [],
      failures: [],
      workers: []
    };
  }

  async drainMediaWorker(_workerId: string, _forceAfterMs?: number): Promise<MediaWorkerPoolSnapshot> {
    return this.workerPoolSnapshot();
  }

  private consumerLayerStateFromEvent(event: ConsumerLayerEvent, consumer: Consumer): ConsumerLayerState {
    return {
      roomId: event.roomId,
      participantId: event.participantId,
      consumerId: event.consumerId,
      producerId: event.producerId,
      preferredLayers: event.preferredLayers ?? consumer.preferredLayers,
      currentLayers: event.currentLayers,
      targetLayers: event.targetLayers,
      preferredSvcLayers: event.preferredSvcLayers ?? consumer.preferredSvcLayers,
      currentSvcLayers: event.currentSvcLayers,
      targetSvcLayers: event.targetSvcLayers,
      switchedAt: event.timestamp,
      switchReason: event.reason === 'missing_keyframe' || event.reason === 'missing_layer' ? 'unknown' : event.reason
    };
  }

  private requireTransport(transportId: string, participantId: string): ManagedTransport {
    const transport = this.transports.get(transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Transport not found');
    }
    if (transport.participantId !== participantId) {
      throw new ForbiddenException('Transport belongs to another participant');
    }
    return transport;
  }

  private async sendRtpToConsumer(consumer: Consumer, packet: Buffer): Promise<void> {
    const transport = this.transports.get(consumer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Consumer transport not found');
    }
    await transport.bridge.sendRtp(packet, consumer);
  }

  private async sendRtcpToTransport(transportId: string, packet: Buffer): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('RTCP target transport not found');
    }
    await transport.bridge.sendRtcp(packet, { transportId });
  }

  private async maybeRequestPipeConsumerKeyframe(consumer: Consumer, pipeTransportId: string): Promise<void> {
    const producer = this.producers.get(consumer.producerId);
    if (!producer || producer.kind !== 'video' || producer.transportId === pipeTransportId || !this.transports.has(producer.transportId)) {
      return;
    }
    const mediaSsrc = producer.rtpParameters.encodings[0]?.ssrc;
    const senderSsrc = consumer.rtpParameters.encodings[0]?.ssrc ?? mediaSsrc;
    if (!mediaSsrc || !senderSsrc) {
      return;
    }
    await this.sendProducerRtcpToTransport(producer.transportId, createPli({ senderSsrc, mediaSsrc })).catch(() => undefined);
  }

  private async maybeRequestPipeBackedProducerKeyframe(consumer: Consumer): Promise<void> {
    const producer = this.producers.get(consumer.producerId);
    if (!producer || producer.kind !== 'video' || !this.pipe?.hasTransport(producer.transportId)) {
      return;
    }
    const mediaSsrc = producer.rtpParameters.encodings[0]?.ssrc;
    const senderSsrc = consumer.rtpParameters.encodings[0]?.ssrc ?? mediaSsrc;
    if (!mediaSsrc || !senderSsrc) {
      return;
    }
    await this.requirePipe().sendRtcp(producer.transportId, createPli({ senderSsrc, mediaSsrc }), { producerId: producer.id }).catch(() => undefined);
  }

  private async sendProducerRtcpToTransport(transportId: string, packet: Buffer): Promise<void> {
    if (!isKeyframeControlPacket(packet)) {
      await this.sendRtcpToTransport(transportId, packet);
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.sendRtcpToTransport(transportId, packet);
        return;
      } catch (error) {
        lastError = error;
        if (!isRetryableTransportSendError(error) || attempt === 4) {
          throw error;
        }
        await delay(100 * (attempt + 1));
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  private primePipeBackedConsumer(consumer: Consumer): Consumer {
    if (consumer.preferredLayers || consumer.currentLayers || consumer.targetLayers) {
      return consumer;
    }
    const producer = this.producers.get(consumer.producerId);
    if (!producer || producer.kind !== 'video' || !this.pipe?.hasTransport(producer.transportId)) {
      return consumer;
    }
    const initialLayers = initialLayersForPipeConsumer(
      this.router.producerLayerSnapshot(producer.id)?.availableLayers[0],
      consumer.rtpParameters
    );
    if (!initialLayers) {
      return consumer;
    }
    return {
      ...consumer,
      preferredLayers: initialLayers
    };
  }

  private rewritePipeRtcpForLocalProducers(pipeTransportId: string, packet: Buffer): Buffer {
    const transport = this.pipeTransports.get(pipeTransportId);
    if (!transport) {
      return packet;
    }
    const mappings = new Map<number, number>();
    for (const consumerId of transport.consumerIds) {
      const consumer = this.consumers.get(consumerId);
      if (!consumer) {
        continue;
      }
      const producer = this.producers.get(consumer.producerId);
      if (!producer || producer.transportId === pipeTransportId || !this.transports.has(producer.transportId)) {
        continue;
      }
      for (const mapping of ssrcMappingsFromRtpParameters(consumer.rtpParameters, producer.rtpParameters)) {
        mappings.set(mapping.sourceSsrc >>> 0, mapping.targetSsrc >>> 0);
      }
    }
    if (mappings.size === 0) {
      return packet;
    }
    try {
      return Buffer.concat(parseRtcpCompound(packet).map((rtcp) => serializeRtcpPacket(rewriteRtcpPacketSsrcs(rtcp, mappings))));
    } catch {
      return packet;
    }
  }

  private requirePipe(): PipeTransportAdapter {
    if (!this.pipe) {
      throw new NotFoundException('Pipe transport service not available');
    }
    return this.pipe;
  }

  private requirePipeTransport(pipeTransportId: string) {
    if (!this.requirePipe().hasTransport(pipeTransportId)) {
      throw new NotFoundException('Pipe transport not found');
    }
    return pipeTransportId;
  }

  private trackPipeProducer(pipeTransportId: string, producer: Producer): void {
    let transport = this.pipeTransports.get(pipeTransportId);
    if (!transport) {
      transport = {
        roomId: producer.roomId,
        producerIds: new Set<string>(),
        consumerIds: new Set<string>()
      };
      this.pipeTransports.set(pipeTransportId, transport);
    }
    transport.producerIds.add(producer.id);
  }

  private trackPipeConsumer(pipeTransportId: string, consumer: Consumer): void {
    let transport = this.pipeTransports.get(pipeTransportId);
    if (!transport) {
      transport = {
        roomId: consumer.roomId,
        producerIds: new Set<string>(),
        consumerIds: new Set<string>()
      };
      this.pipeTransports.set(pipeTransportId, transport);
    }
    transport.consumerIds.add(consumer.id);
  }

  private releasePipeProducer(producerId: string): void {
    const producer = this.producers.get(producerId);
    if (!producer) {
      return;
    }
    const transport = this.pipeTransports.get(producer.transportId);
    if (!transport) {
      return;
    }
    transport.producerIds.delete(producerId);
    this.releasePipeTransportIfEmpty(producer.transportId, transport);
  }

  private releasePipeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      return;
    }
    const transport = this.pipeTransports.get(consumer.transportId);
    if (!transport) {
      return;
    }
    transport.consumerIds.delete(consumerId);
    this.releasePipeTransportIfEmpty(consumer.transportId, transport);
  }

  private releasePipeTransportIfEmpty(pipeTransportId: string, transport: ManagedPipeTransport): void {
    if (transport.producerIds.size === 0 && transport.consumerIds.size === 0) {
      this.pipeTransports.delete(pipeTransportId);
    }
  }
}

function toPublicCandidate(candidate: IceCandidate): IceCandidate {
  return {
    foundation: candidate.foundation,
    component: candidate.component,
    protocol: candidate.protocol,
    priority: candidate.priority,
    ip: candidate.ip,
    port: candidate.port,
    type: candidate.type,
    relatedAddress: candidate.relatedAddress,
    relatedPort: candidate.relatedPort,
    tcpType: candidate.tcpType
  };
}

function mergeUnique(left: number[], right: number[]): number[] {
  return [...new Set([...left, ...right].map((value) => value >>> 0))];
}

function rtpSsrcs(rtpParameters: RtpParameters): number[] {
  return rtpParameters.encodings
    .flatMap((encoding) => (encoding.rtx?.ssrc !== undefined ? [encoding.ssrc, encoding.rtx.ssrc] : [encoding.ssrc]))
    .filter((ssrc): ssrc is number => typeof ssrc === 'number' && Number.isFinite(ssrc) && ssrc > 0);
}

function initialLayersForPipeConsumer(
  availableLayer: RtpLayerSelection | undefined,
  rtpParameters: RtpParameters
): RtpLayerSelection | undefined {
  if (availableLayer) {
    return {
      spatialLayer: availableLayer.spatialLayer,
      temporalLayer: availableLayer.temporalLayer
    };
  }
  if (rtpParameters.encodings.length === 0) {
    return undefined;
  }
  return { spatialLayer: 0 };
}

function ssrcMappingsFromRtpParameters(source: RtpParameters, target: RtpParameters): Array<{ sourceSsrc: number; targetSsrc: number }> {
  return source.encodings.flatMap((encoding, index) => {
    const mapped = target.encodings[index];
    if (!mapped || typeof encoding.ssrc !== 'number' || typeof mapped.ssrc !== 'number') {
      return [];
    }
    const pairs: Array<{ sourceSsrc: number; targetSsrc: number }> = [{ sourceSsrc: encoding.ssrc, targetSsrc: mapped.ssrc }];
    if (typeof encoding.rtx?.ssrc === 'number' && typeof mapped.rtx?.ssrc === 'number') {
      pairs.push({ sourceSsrc: encoding.rtx.ssrc, targetSsrc: mapped.rtx.ssrc });
    }
    return pairs;
  });
}

function rewriteRtcpPacketSsrcs(packet: RtcpPacket, mappings: Map<number, number>): RtcpPacket {
  const payload = Buffer.from(packet.payload);
  const rewrite = (offset: number): void => {
    if (offset + 4 <= payload.length) {
      const mapped = mappings.get(payload.readUInt32BE(offset));
      if (mapped !== undefined) {
        payload.writeUInt32BE(mapped >>> 0, offset);
      }
    }
  };
  if (packet.type === RTCP_SR) {
    rewrite(0);
    for (let offset = 24; offset + 24 <= payload.length; offset += 24) {
      rewrite(offset);
    }
  } else if (packet.type === RTCP_RR) {
    rewrite(0);
    for (let offset = 4; offset + 24 <= payload.length; offset += 24) {
      rewrite(offset);
    }
  } else if (packet.type === RTCP_RTPFB || packet.type === RTCP_PSFB) {
    rewrite(0);
    rewrite(4);
    if (packet.type === RTCP_PSFB && packet.count === 4) {
      for (let offset = 8; offset + 8 <= payload.length; offset += 8) {
        rewrite(offset);
      }
    }
    if (packet.type === RTCP_PSFB && packet.count === 15 && payload.subarray(8, 12).toString('ascii') === 'REMB') {
      for (let offset = 16; offset + 4 <= payload.length; offset += 4) {
        rewrite(offset);
      }
    }
  }
  return { ...packet, payload };
}

function isKeyframeControlPacket(packet: Buffer): boolean {
  try {
    return parseRtcpCompound(packet).some((rtcp) => rtcp.type === RTCP_PSFB && (rtcp.count === 1 || rtcp.count === 4));
  } catch {
    return false;
  }
}

function isRetryableTransportSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SRTP session is required before RTCP egress') ||
    message.includes('ICE selected candidate pair is required before sending media datagrams') ||
    message.includes('Local ICE socket not found')
  );
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
}
