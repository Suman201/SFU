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
import { RtcpFeedback, RtcpProcessor, RtpRouter } from '@native-sfu/sfu-core';
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

@Injectable()
export class MediaService {
  private readonly transports = new Map<string, ManagedTransport>();
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
      await this.sendRtcpToTransport(target.transportId, packet);
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
    const outboundSsrcs = rtpSsrcs(consumer.rtpParameters);
    transport.outboundSsrcs = mergeUnique(transport.outboundSsrcs, outboundSsrcs);
    const session = this.srtp.getSession(consumer.transportId);
    if (session) {
      session.setOutboundSsrcs(transport.outboundSsrcs);
    }
    this.consumers.set(consumer.id, consumer);
    this.router.addConsumer(
      consumer,
      async (packet, target) => {
        await this.sendRtpToConsumer(target, packet.serialize());
      },
      async (packet, target) => {
        await this.sendRtcpToTransport(target.transportId, packet);
      }
    );
    const existingState = this.router.consumerLayerSnapshot(consumer.id);
    if (existingState) {
      consumer.layerState = existingState;
      this.consumerLayerStates.set(consumer.id, existingState);
    }
  }

  async registerPipeConsumer(consumer: Consumer, pipeTransportId = consumer.transportId): Promise<void> {
    this.requirePipeTransport(pipeTransportId);
    const pipeConsumer = { ...consumer, transportId: pipeTransportId };
    this.consumers.set(pipeConsumer.id, pipeConsumer);
    this.router.addConsumer(
      pipeConsumer,
      async (packet, target) => {
        await this.requirePipe().sendRtp(pipeTransportId, target.producerId, packet.serialize());
      },
      async (packet, target) => {
        await this.requirePipe().sendRtcp(pipeTransportId, packet, { consumerId: target.id });
      }
    );
    const existingState = this.router.consumerLayerSnapshot(pipeConsumer.id);
    if (existingState) {
      pipeConsumer.layerState = existingState;
      this.consumerLayerStates.set(pipeConsumer.id, existingState);
    }
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
    const snapshot = this.requirePipe().snapshot(pipeTransportId);
    if (!snapshot) {
      throw new NotFoundException('Pipe transport not found');
    }
    const sourceParticipantId = options.sourceParticipantId ?? `pipe:${snapshot.remoteNodeId}`;
    const feedback = this.rtcp.process(options.roomId ?? snapshot.roomId, sourceParticipantId, packet);
    const forwarded = await this.router.routeRtcp(packet);
    return { feedback, forwarded };
  }

  async unregisterConsumer(consumerId: string): Promise<void> {
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
    return {
      bandwidth: this.router.bandwidthEstimates(),
      pacing: this.router.pacingSnapshots(),
      statistics: this.router.statistics(),
      consumerLayers: [...this.consumers.keys()].map((consumerId) => this.consumerLayerState(consumerId)).filter((state): state is ConsumerLayerState => Boolean(state)),
      producerLayers: [...this.producers.keys()].map((producerId) => this.producerLayerState(producerId)).filter((state): state is ProducerLayerState => Boolean(state)),
      quality: {
        consumers: [...this.consumers.keys()].map((consumerId) => this.consumerQualityState(consumerId)).filter((state): state is ConsumerQualityState => Boolean(state)),
        producers: [...this.producers.keys()].map((producerId) => this.producerQualityState(producerId)).filter((state): state is ProducerQualityState => Boolean(state)),
        transports: [...this.transports.keys()].map((transportId) => this.transportQualityState(transportId)).filter((state): state is TransportQualityState => Boolean(state)),
        rooms: [...new Set([...this.transports.values()].map((transport) => transport.roomId))].map((roomId) => this.roomQualityState(roomId)).filter((state): state is RoomQualityState => Boolean(state))
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
        this.producers.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.participantId === participantId) {
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
        this.producers.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.roomId === roomId) {
        this.consumers.delete(consumerId);
        this.consumerLayerStates.delete(consumerId);
        this.consumerQualityStates.delete(consumerId);
      }
    }
    this.roomQualityStates.delete(roomId);
    this.router.removeRoom(roomId);
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
