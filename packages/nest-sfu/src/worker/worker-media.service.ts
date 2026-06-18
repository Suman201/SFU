import { ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import type {
  Consumer,
  ConsumerLayerEvent,
  ConsumerLayerState,
  ConsumerQualityState,
  IceCandidate,
  PipeNodeEndpoint,
  PipeTransportProtocol,
  Producer,
  ProducerDynacastEvent,
  ProducerDynacastState,
  ProducerLayerState,
  ProducerQualityState,
  RoomQualityState,
  RtpLayerSelection,
  RtpParameters,
  SvcLayerSelection,
  TransportOptions,
  TransportQualityState
} from '@native-sfu/contracts';
import type { ConsumerTwccObservation, ConsumerTwccObservationEvent, RtcpFeedback } from '@native-sfu/sfu-core';
import type { MediaPacketBridgeCounters } from '../media/media-packet-bridge';
import { MediaService, type MediaRoomCleanupSummary } from '../media.service';
import type { NestSfuOptions } from '../nest-sfu.options';
import { PipeTransportService } from '../pipe-transport.service';
import { MediaWorkerPool } from './media-worker-pool';
import type {
  MediaWorkerPipeTransportSnapshot,
  MediaWorkerPoolSnapshot,
  MediaWorkerRoomFailureEvent
} from './ipc';

type AdaptiveMetricsSnapshot = ReturnType<MediaService['adaptiveTransportMetrics']>;

interface TransportOwner {
  roomId: string;
  participantId: string;
}

interface PipeTransportBinding {
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  protocol: PipeTransportProtocol;
  localEndpoint?: PipeNodeEndpoint;
  remoteEndpoint?: PipeNodeEndpoint;
}

@Injectable()
export class WorkerMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: MediaWorkerPool;
  private readonly transports = new Map<string, TransportOwner>();
  private readonly producers = new Map<string, Producer>();
  private readonly consumers = new Map<string, Consumer>();
  private readonly pipeTransports = new Map<string, PipeTransportBinding>();
  private readonly consumerLayerStates = new Map<string, ConsumerLayerState>();
  private readonly producerLayerStates = new Map<string, ProducerLayerState>();
  private readonly producerDynacastStates = new Map<string, ProducerDynacastState>();
  private readonly consumerQualityStates = new Map<string, ConsumerQualityState>();
  private readonly producerQualityStates = new Map<string, ProducerQualityState>();
  private readonly transportQualityStates = new Map<string, TransportQualityState>();
  private readonly roomQualityStates = new Map<string, RoomQualityState>();
  private readonly counterSnapshots = new Map<string, MediaPacketBridgeCounters>();
  private readonly layerEventListeners = new Set<(event: ConsumerLayerEvent) => void>();
  private readonly producerDynacastEventListeners = new Set<(event: ProducerDynacastEvent) => void>();
  private readonly consumerTwccObservationListeners = new Set<(state: ConsumerTwccObservationEvent) => void>();
  private readonly consumerQualityEventListeners = new Set<(state: ConsumerQualityState) => void>();
  private readonly producerQualityEventListeners = new Set<(state: ProducerQualityState) => void>();
  private readonly transportQualityEventListeners = new Set<(state: TransportQualityState) => void>();
  private readonly roomQualityEventListeners = new Set<(state: RoomQualityState) => void>();
  private readonly roomFailureEventListeners = new Set<(event: MediaWorkerRoomFailureEvent) => void>();
  private adaptiveMetricsSnapshot: AdaptiveMetricsSnapshot = emptyAdaptiveMetrics();

  constructor(
    private readonly options: NestSfuOptions,
    private readonly pipe?: PipeTransportService
  ) {
    this.pool = new MediaWorkerPool({
      options,
      workerCount: options.mediaWorkerCount ?? 1,
      requestTimeoutMs: options.mediaWorkerRequestTimeoutMs ?? 5000,
      startupTimeoutMs: options.mediaWorkerStartupTimeoutMs ?? 10000,
      heartbeatTimeoutMs: options.mediaWorkerHeartbeatTimeoutMs ?? 6000,
      restartBackoffMs: options.mediaWorkerRestartBackoffMs ?? 1000,
      maxRoomsPerWorker: options.mediaWorkerMaxRoomsPerWorker ?? 100,
      maxTransportsPerWorker: options.mediaWorkerMaxTransportsPerWorker ?? 500,
      maxInFlightRequestsPerWorker: options.mediaWorkerMaxInFlightRequestsPerWorker ?? 1000,
      softMemoryLimitBytes: options.mediaWorkerSoftMemoryLimitBytes,
      hardMemoryLimitBytes: options.mediaWorkerHardMemoryLimitBytes,
      softIpcLatencyMs: options.mediaWorkerSoftIpcLatencyMs ?? 100,
      hardIpcLatencyMs: options.mediaWorkerHardIpcLatencyMs ?? 1000,
      drainTimeoutMs: options.mediaWorkerDrainTimeoutMs ?? options.mediaWorkerShutdownTimeoutMs ?? 30000,
      execArgv: options.mediaWorkerExecArgv
    });
    this.pool.on('event', (event) => this.handleWorkerEvent(event));
    this.pool.on('ipc', (event) => this.handleIpcMetric(event));
    this.pool.on('crash', (event) => {
      const reason = event.signal ?? `exit_${event.code ?? 'unknown'}`;
      this.options.metrics?.onMediaWorkerCrash?.(event.workerId, reason, event.roomIds.length);
    });
    this.pool.on('roomFailure', (event) => this.handleRoomFailure(event));
    this.pool.on('restart', (event) => this.options.metrics?.onMediaWorkerRestart?.(event.workerId, event.reason));
    this.pool.on('drain', (event) => this.options.metrics?.onMediaWorkerDrain?.(event.workerId, event.state, event.roomIds.length));
  }

  async onModuleInit(): Promise<void> {
    await this.pool.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.stop();
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

  onMediaWorkerRoomFailed(listener: (event: MediaWorkerRoomFailureEvent) => void): () => void {
    this.roomFailureEventListeners.add(listener);
    return () => this.roomFailureEventListeners.delete(listener);
  }

  acknowledgeRoomFailure(roomId: string): void {
    this.pool.clearRoomFailure(roomId);
  }

  async createWebRtcTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    const worker = this.pool.workerForRoom(roomId);
    const options = (await worker.request({ type: 'createWebRtcTransport', roomId, participantId })) as TransportOptions;
    this.transports.set(options.id, { roomId, participantId });
    this.pool.bindTransport(roomId, options.id, worker.workerId);
    return options;
  }

  assertTransportOwner(transportId: string, participantId: string): void {
    const owner = this.transports.get(transportId);
    if (!owner) {
      throw new NotFoundException('Transport not found');
    }
    if (owner.participantId !== participantId) {
      throw new ForbiddenException('Transport belongs to another participant');
    }
  }

  async addRemoteCandidate(transportId: string, participantId: string, candidate: IceCandidate): Promise<void> {
    this.assertTransportOwner(transportId, participantId);
    await this.pool.workerForTransport(transportId).request({ type: 'addRemoteCandidate', transportId, participantId, candidate });
  }

  async setRemoteIceParameters(transportId: string, participantId: string, parameters: TransportOptions['iceParameters']): Promise<void> {
    this.assertTransportOwner(transportId, participantId);
    await this.pool.workerForTransport(transportId).request({ type: 'setRemoteIceParameters', transportId, participantId, parameters });
  }

  async setRemoteDtlsParameters(transportId: string, participantId: string, parameters: TransportOptions['dtlsParameters']): Promise<void> {
    this.assertTransportOwner(transportId, participantId);
    await this.pool.workerForTransport(transportId).request({ type: 'setRemoteDtlsParameters', transportId, participantId, parameters });
  }

  async restartIce(transportId: string, participantId: string): Promise<TransportOptions> {
    this.assertTransportOwner(transportId, participantId);
    return (await this.pool.workerForTransport(transportId).request({ type: 'restartIce', transportId, participantId })) as TransportOptions;
  }

  async bindProducer(transportId: string, participantId: string, rtpParameters: RtpParameters): Promise<void> {
    this.assertTransportOwner(transportId, participantId);
    await this.pool.workerForTransport(transportId).request({ type: 'bindProducer', transportId, participantId, rtpParameters });
  }

  async registerProducer(producer: Producer): Promise<void> {
    const worker = this.pool.workerForTransport(producer.transportId);
    await worker.request({ type: 'registerProducer', producer });
    this.producers.set(producer.id, producer);
    this.pool.bindProducer(producer, worker.workerId);
    const layerState = (await worker.request({ type: 'producerLayerState', producerId: producer.id })) as ProducerLayerState | undefined;
    if (layerState) {
      this.producerLayerStates.set(producer.id, layerState);
      if (layerState.svc) {
        producer.svc = layerState.svc;
      }
      if (layerState.dynacast) {
        producer.dynacast = layerState.dynacast;
        this.producerDynacastStates.set(producer.id, layerState.dynacast);
      }
    }
  }

  async unregisterProducer(producerId: string): Promise<void> {
    const worker = this.pool.workerForProducer(producerId);
    await worker.request({ type: 'unregisterProducer', producerId });
    this.producers.delete(producerId);
    this.producerLayerStates.delete(producerId);
    this.producerDynacastStates.delete(producerId);
    this.producerQualityStates.delete(producerId);
    this.pool.releaseProducer(producerId);
  }

  async setProducerPaused(producerId: string, paused: boolean): Promise<void> {
    await this.pool.workerForProducer(producerId).request({ type: 'setProducerPaused', producerId, paused });
  }

  setProducerPriority(producerId: string, priority: number): void {
    const producer = this.producers.get(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    producer.priority = priority;
    void this.pool.workerForProducer(producerId).request({ type: 'setProducerPriority', producerId, priority });
  }

  async registerConsumer(consumer: Consumer): Promise<void> {
    const worker = this.pool.workerForTransport(consumer.transportId);
    await worker.request({ type: 'registerConsumer', consumer });
    this.consumers.set(consumer.id, consumer);
    this.pool.bindConsumer(consumer, worker.workerId);
    const layerState = (await worker.request({ type: 'consumerLayerState', consumerId: consumer.id })) as ConsumerLayerState | undefined;
    if (layerState) {
      consumer.layerState = layerState;
      this.consumerLayerStates.set(consumer.id, layerState);
    }
  }

  async registerPipeProducer(producer: Producer, pipeTransportId = producer.transportId): Promise<void> {
    const binding = await this.ensurePipeTransportBinding(pipeTransportId, producer.roomId);
    const worker = this.pool.workerForRoom(binding.roomId);
    await worker.request({
      type: 'registerPipeProducer',
      producer,
      pipeTransportId
    });
    const pipeProducer = { ...producer, transportId: pipeTransportId };
    this.producers.set(pipeProducer.id, pipeProducer);
    this.pool.bindProducer(pipeProducer, worker.workerId);
    const layerState = (await worker.request({ type: 'producerLayerState', producerId: producer.id })) as ProducerLayerState | undefined;
    if (layerState) {
      this.producerLayerStates.set(producer.id, layerState);
      if (layerState.svc) {
        pipeProducer.svc = layerState.svc;
      }
      if (layerState.dynacast) {
        pipeProducer.dynacast = layerState.dynacast;
        this.producerDynacastStates.set(producer.id, layerState.dynacast);
      }
    }
  }

  async registerPipeConsumer(consumer: Consumer, pipeTransportId = consumer.transportId): Promise<void> {
    const binding = await this.ensurePipeTransportBinding(pipeTransportId, consumer.roomId);
    const worker = this.pool.workerForRoom(binding.roomId);
    await worker.request({
      type: 'registerPipeConsumer',
      consumer,
      pipeTransportId
    });
    const pipeConsumer = { ...consumer, transportId: pipeTransportId };
    this.consumers.set(pipeConsumer.id, pipeConsumer);
    this.pool.bindConsumer(pipeConsumer, worker.workerId);
    const layerState = (await worker.request({ type: 'consumerLayerState', consumerId: consumer.id })) as ConsumerLayerState | undefined;
    if (layerState) {
      pipeConsumer.layerState = layerState;
      this.consumerLayerStates.set(consumer.id, layerState);
    }
  }

  async handleRtcp(transportId: string, participantId: string, packet: Buffer): Promise<{ feedback: RtcpFeedback; forwarded: number }> {
    this.assertTransportOwner(transportId, participantId);
    return (await this.pool.workerForTransport(transportId).request({ type: 'handleRtcp', transportId, participantId, packet })) as { feedback: RtcpFeedback; forwarded: number };
  }

  async ensurePipeTransport(options: {
    pipeTransportId: string;
    roomId: string;
    localNodeId: string;
    remoteNodeId: string;
    protocol: PipeTransportProtocol;
    listenPort?: number;
    advertisedIp?: string;
    peerToken?: string;
    remoteEndpoint?: PipeNodeEndpoint;
  }): Promise<MediaWorkerPipeTransportSnapshot> {
    const worker = this.pool.workerForRoom(options.roomId);
    const snapshot = (await worker.request({
      type: 'ensurePipeTransport',
      ...options
    })) as MediaWorkerPipeTransportSnapshot;
    this.pipeTransports.set(options.pipeTransportId, {
      roomId: snapshot.roomId,
      localNodeId: snapshot.localNodeId,
      remoteNodeId: snapshot.remoteNodeId,
      protocol: snapshot.protocol,
      localEndpoint: snapshot.localEndpoint,
      remoteEndpoint: snapshot.remoteEndpoint
    });
    return snapshot;
  }

  async pipeTransportSnapshot(pipeTransportId: string): Promise<MediaWorkerPipeTransportSnapshot | undefined> {
    const binding = this.pipeTransports.get(pipeTransportId);
    if (!binding) {
      return undefined;
    }
    const snapshot = (await this.pool.workerForRoom(binding.roomId).request({
      type: 'pipeTransportSnapshot',
      pipeTransportId
    })) as MediaWorkerPipeTransportSnapshot | undefined;
    if (snapshot) {
      this.pipeTransports.set(pipeTransportId, {
        roomId: snapshot.roomId,
        localNodeId: snapshot.localNodeId,
        remoteNodeId: snapshot.remoteNodeId,
        protocol: snapshot.protocol,
        localEndpoint: snapshot.localEndpoint,
        remoteEndpoint: snapshot.remoteEndpoint
      });
    }
    return snapshot;
  }

  async handlePipeRtp(pipeTransportId: string, producerId: string | undefined, packet: Buffer): Promise<number> {
    const binding = await this.ensurePipeTransportBinding(pipeTransportId);
    return (await this.pool.workerForRoom(binding.roomId).request({
      type: 'handlePipeRtp',
      pipeTransportId,
      producerId,
      packet
    })) as number;
  }

  async handlePipeRtcp(
    pipeTransportId: string,
    packet: Buffer,
    _options: { roomId?: string; sourceParticipantId?: string } = {}
  ): Promise<{ feedback?: RtcpFeedback; forwarded: number }> {
    const binding = await this.ensurePipeTransportBinding(pipeTransportId, _options.roomId);
    return (await this.pool.workerForRoom(binding.roomId).request({
      type: 'handlePipeRtcp',
      pipeTransportId,
      packet,
      options: _options
    })) as { feedback?: RtcpFeedback; forwarded: number };
  }

  async closePipeTransport(pipeTransportId: string): Promise<void> {
    const binding = this.pipeTransports.get(pipeTransportId);
    if (!binding) {
      return;
    }
    await this.pool.workerForRoom(binding.roomId).request({ type: 'closePipeTransport', pipeTransportId });
    for (const [producerId, producer] of this.producers) {
      if (producer.transportId === pipeTransportId) {
        this.producers.delete(producerId);
        this.producerLayerStates.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
        this.pool.releaseProducer(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.transportId === pipeTransportId) {
        this.consumers.delete(consumerId);
        this.consumerLayerStates.delete(consumerId);
        this.consumerQualityStates.delete(consumerId);
        this.pool.releaseConsumer(consumerId);
      }
    }
    this.pipeTransports.delete(pipeTransportId);
  }

  async unregisterConsumer(consumerId: string): Promise<void> {
    const worker = this.pool.workerForConsumer(consumerId);
    await worker.request({ type: 'unregisterConsumer', consumerId });
    this.consumers.delete(consumerId);
    this.consumerLayerStates.delete(consumerId);
    this.consumerQualityStates.delete(consumerId);
    this.pool.releaseConsumer(consumerId);
  }

  async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    await this.pool.workerForConsumer(consumerId).request({ type: 'setConsumerPaused', consumerId, paused });
  }

  async setConsumerPreferredLayers(consumerId: string, preferredLayers: RtpLayerSelection): Promise<ConsumerLayerState | undefined> {
    const state = (await this.pool.workerForConsumer(consumerId).request({ type: 'setConsumerPreferredLayers', consumerId, preferredLayers })) as ConsumerLayerState | undefined;
    if (state) {
      this.consumerLayerStates.set(consumerId, state);
    }
    return state;
  }

  async setConsumerPreferredSvcLayers(consumerId: string, preferredSvcLayers: SvcLayerSelection): Promise<ConsumerLayerState | undefined> {
    const state = (await this.pool.workerForConsumer(consumerId).request({ type: 'setConsumerPreferredSvcLayers', consumerId, preferredSvcLayers })) as ConsumerLayerState | undefined;
    if (state) {
      this.consumerLayerStates.set(consumerId, state);
    }
    return state;
  }

  setConsumerPriority(consumerId: string, priority: number): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    consumer.priority = priority;
    void this.pool.workerForConsumer(consumerId).request({ type: 'setConsumerPriority', consumerId, priority });
  }

  async applyConsumerTwccObservation(
    consumerId: string,
    observation: ConsumerTwccObservation
  ): Promise<ConsumerQualityState | undefined> {
    const state = (await this.pool.workerForConsumer(consumerId).request({
      type: 'applyConsumerTwccObservation',
      consumerId,
      observation
    })) as ConsumerQualityState | undefined;
    if (state) {
      this.consumerQualityStates.set(consumerId, state);
      const consumer = this.consumers.get(consumerId);
      if (consumer) {
        consumer.quality = state;
      }
    }
    return state;
  }

  consumerLayerState(consumerId: string): ConsumerLayerState | undefined {
    if (!this.consumers.has(consumerId)) {
      return this.consumerLayerStates.get(consumerId);
    }
    void this.refreshConsumerLayerState(consumerId);
    return this.consumerLayerStates.get(consumerId);
  }

  consumerQualityState(consumerId: string): ConsumerQualityState | undefined {
    if (!this.consumers.has(consumerId)) {
      return this.consumerQualityStates.get(consumerId);
    }
    void this.refreshConsumerQualityState(consumerId);
    return this.consumerQualityStates.get(consumerId);
  }

  producerQualityState(producerId: string): ProducerQualityState | undefined {
    if (!this.producers.has(producerId)) {
      return this.producerQualityStates.get(producerId);
    }
    void this.refreshProducerQualityState(producerId);
    return this.producerQualityStates.get(producerId);
  }

  transportQualityState(transportId: string): TransportQualityState | undefined {
    if (!this.transports.has(transportId)) {
      return this.transportQualityStates.get(transportId);
    }
    void this.refreshTransportQualityState(transportId);
    return this.transportQualityStates.get(transportId);
  }

  roomQualityState(roomId: string): RoomQualityState | undefined {
    void this.refreshRoomQualityState(roomId);
    return this.roomQualityStates.get(roomId);
  }

  producerLayerState(producerId: string): ProducerLayerState | undefined {
    if (!this.producers.has(producerId)) {
      return this.producerLayerStates.get(producerId);
    }
    void this.refreshProducerLayerState(producerId);
    return this.producerLayerStates.get(producerId);
  }

  getProducer(producerId: string): Producer | undefined {
    return this.producers.get(producerId);
  }

  mediaCounters(transportId: string, participantId: string): MediaPacketBridgeCounters {
    this.assertTransportOwner(transportId, participantId);
    void this.refreshMediaCounters(transportId, participantId);
    return this.counterSnapshots.get(transportId) ?? emptyMediaCounters();
  }

  adaptiveTransportMetrics(): AdaptiveMetricsSnapshot {
    void this.refreshAdaptiveMetrics();
    return this.adaptiveMetricsSnapshot;
  }

  async waitForMediaIdle(transportId: string, participantId: string, timeoutMs?: number): Promise<void> {
    this.assertTransportOwner(transportId, participantId);
    await this.pool.workerForTransport(transportId).request({ type: 'waitForMediaIdle', transportId, participantId, timeoutMs }, timeoutMs);
  }

  async closeParticipantTransports(participantId: string): Promise<void> {
    const workers = new Map<string, ReturnType<MediaWorkerPool['workerForTransport']>>();
    for (const [transportId, owner] of this.transports) {
      if (owner.participantId === participantId) {
        const worker = this.pool.workerForTransport(transportId);
        workers.set(worker.workerId, worker);
        this.transports.delete(transportId);
        this.counterSnapshots.delete(transportId);
        this.pool.releaseTransport(transportId);
      }
    }
    for (const worker of workers.values()) {
      await worker.request({ type: 'closeParticipantTransports', participantId });
    }
    for (const [producerId, producer] of this.producers) {
      if (producer.participantId === participantId) {
        this.producers.delete(producerId);
        this.producerLayerStates.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
        this.pool.releaseProducer(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.participantId === participantId) {
        this.consumers.delete(consumerId);
        this.consumerLayerStates.delete(consumerId);
        this.consumerQualityStates.delete(consumerId);
        this.pool.releaseConsumer(consumerId);
      }
    }
  }

  async closeRoom(roomId: string): Promise<MediaRoomCleanupSummary> {
    const summary: MediaRoomCleanupSummary = {
      participantIds: [],
      transportCount: 0,
      consumerCount: 0,
      producerCounts: {},
      pipeTransportCount: 0
    };
    const participantIds = new Set<string>();
    for (const owner of this.transports.values()) {
      if (owner.roomId === roomId) {
        summary.transportCount += 1;
        participantIds.add(owner.participantId);
      }
    }
    for (const producer of this.producers.values()) {
      if (producer.roomId === roomId) {
        if (!this.pipeTransports.has(producer.transportId)) {
          summary.producerCounts[producer.kind] = (summary.producerCounts[producer.kind] ?? 0) + 1;
        }
      }
    }
    for (const consumer of this.consumers.values()) {
      if (consumer.roomId === roomId) {
        if (!this.pipeTransports.has(consumer.transportId)) {
          summary.consumerCount += 1;
        }
      }
    }
    for (const binding of this.pipeTransports.values()) {
      if (binding.roomId === roomId) {
        summary.pipeTransportCount += 1;
      }
    }
    summary.participantIds = [...participantIds];
    const hasLocalState = summary.transportCount > 0
      || summary.consumerCount > 0
      || summary.pipeTransportCount > 0
      || Object.keys(summary.producerCounts).length > 0
      || this.roomQualityStates.has(roomId);
    if (!hasLocalState) {
      return summary;
    }
    const worker = this.pool.workerForRoom(roomId);
    await worker.request({ type: 'closeRoom', roomId });
    for (const [transportId, owner] of this.transports) {
      if (owner.roomId === roomId) {
        this.transports.delete(transportId);
        this.transportQualityStates.delete(transportId);
        this.counterSnapshots.delete(transportId);
        this.pool.releaseTransport(transportId);
      }
    }
    for (const [producerId, producer] of this.producers) {
      if (producer.roomId === roomId) {
        this.producers.delete(producerId);
        this.producerLayerStates.delete(producerId);
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
    for (const [pipeTransportId, binding] of this.pipeTransports) {
      if (binding.roomId === roomId) {
        this.pipeTransports.delete(pipeTransportId);
      }
    }
    this.pool.releaseRoom(roomId);
    return summary;
  }

  workerPoolSnapshot(): MediaWorkerPoolSnapshot {
    return this.pool.snapshot();
  }

  async drainMediaWorker(workerId: string, forceAfterMs?: number): Promise<MediaWorkerPoolSnapshot> {
    await this.pool.drainWorker(workerId, forceAfterMs);
    return this.workerPoolSnapshot();
  }

  private handleRoomFailure(event: MediaWorkerRoomFailureEvent): void {
    this.failRoomLocal(event.roomId);
    this.options.metrics?.onMediaWorkerRoomFailed?.(event.workerId, event.roomId, event.reason);
    for (const listener of this.roomFailureEventListeners) {
      listener(event);
    }
  }

  private failRoomLocal(roomId: string): void {
    for (const [transportId, owner] of this.transports) {
      if (owner.roomId === roomId) {
        this.transports.delete(transportId);
        this.transportQualityStates.delete(transportId);
        this.counterSnapshots.delete(transportId);
        this.pool.releaseTransport(transportId);
      }
    }
    for (const [producerId, producer] of this.producers) {
      if (producer.roomId === roomId) {
        this.producers.delete(producerId);
        this.producerLayerStates.delete(producerId);
        this.producerDynacastStates.delete(producerId);
        this.producerQualityStates.delete(producerId);
        this.pool.releaseProducer(producerId);
      }
    }
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.roomId === roomId) {
        this.consumers.delete(consumerId);
        this.consumerLayerStates.delete(consumerId);
        this.consumerQualityStates.delete(consumerId);
        this.pool.releaseConsumer(consumerId);
      }
    }
    for (const [pipeTransportId, binding] of this.pipeTransports) {
      if (binding.roomId === roomId) {
        this.pipeTransports.delete(pipeTransportId);
      }
    }
    this.roomQualityStates.delete(roomId);
    this.pool.releaseRoom(roomId, { preserveFailure: true });
  }

  private handleWorkerEvent(event: import('./ipc').MediaWorkerEventPayload): void {
    if (event.type === 'consumer-layer') {
      this.consumerLayerStates.set(event.event.consumerId, this.consumerLayerStateFromEvent(event.event));
      for (const listener of this.layerEventListeners) {
        listener(event.event);
      }
      return;
    }
    if (event.type === 'producer-dynacast') {
      this.producerDynacastStates.set(event.event.producerId, event.event.state);
      const producer = this.producers.get(event.event.producerId);
      if (producer) {
        producer.dynacast = event.event.state;
      }
      for (const listener of this.producerDynacastEventListeners) {
        listener(event.event);
      }
      return;
    }
    if (event.type === 'consumer-twcc') {
      for (const listener of this.consumerTwccObservationListeners) {
        listener(event.state);
      }
      return;
    }
    if (event.type === 'pipe-rtp') {
      const operation = this.pipe?.sendRtp(event.pipeTransportId, event.producerId, event.packet);
      if (!operation) {
        this.options.metrics?.onPipeDrop?.('worker_pipe_missing_transport');
        return;
      }
      void operation
        .then((sent) => {
          if (sent) {
            this.options.metrics?.onPipeRtpPacket?.('sent', event.packet.length);
            return;
          }
          this.options.metrics?.onPipeDrop?.('worker_pipe_rtp_send_rejected');
        })
        .catch(() => {
          this.options.metrics?.onPipeDrop?.('worker_pipe_rtp_send_failed');
        });
      return;
    }
    if (event.type === 'pipe-rtcp') {
      const operation = this.pipe?.sendRtcp(event.pipeTransportId, event.packet, {
        producerId: event.producerId,
        consumerId: event.consumerId
      });
      if (!operation) {
        this.options.metrics?.onPipeDrop?.('worker_pipe_missing_transport');
        return;
      }
      void operation
        .then((sent) => {
          if (sent) {
            this.options.metrics?.onPipeRtcpPacket?.('sent', event.packet.length);
            return;
          }
          this.options.metrics?.onPipeDrop?.('worker_pipe_rtcp_send_rejected');
        })
        .catch(() => {
          this.options.metrics?.onPipeDrop?.('worker_pipe_rtcp_send_failed');
        });
      return;
    }
    if (event.type === 'consumer-score') {
      this.consumerQualityStates.set(event.state.consumerId, event.state);
      const consumer = this.consumers.get(event.state.consumerId);
      if (consumer) {
        consumer.quality = event.state;
      }
      for (const listener of this.consumerQualityEventListeners) {
        listener(event.state);
      }
      return;
    }
    if (event.type === 'producer-score') {
      this.producerQualityStates.set(event.state.producerId, event.state);
      const producer = this.producers.get(event.state.producerId);
      if (producer) {
        producer.quality = event.state;
      }
      for (const listener of this.producerQualityEventListeners) {
        listener(event.state);
      }
      return;
    }
    if (event.type === 'transport-quality') {
      this.transportQualityStates.set(event.state.transportId, event.state);
      for (const listener of this.transportQualityEventListeners) {
        listener(event.state);
      }
      return;
    }
    if (event.type === 'room-quality') {
      this.roomQualityStates.set(event.state.roomId, event.state);
      for (const listener of this.roomQualityEventListeners) {
        listener(event.state);
      }
    }
  }

  private handleIpcMetric(event: { operation: string; status: 'ok' | 'error' | 'timeout'; durationMs: number }): void {
    this.options.metrics?.onMediaWorkerIpcRequest?.(event.operation, event.status, event.durationMs);
  }

  private consumerLayerStateFromEvent(event: ConsumerLayerEvent): ConsumerLayerState {
    const consumer = this.consumers.get(event.consumerId);
    return {
      roomId: event.roomId,
      participantId: event.participantId,
      consumerId: event.consumerId,
      producerId: event.producerId,
      preferredLayers: event.preferredLayers ?? consumer?.preferredLayers,
      currentLayers: event.currentLayers,
      targetLayers: event.targetLayers,
      preferredSvcLayers: event.preferredSvcLayers ?? consumer?.preferredSvcLayers,
      currentSvcLayers: event.currentSvcLayers,
      targetSvcLayers: event.targetSvcLayers,
      switchedAt: event.timestamp,
      switchReason: event.reason === 'missing_keyframe' || event.reason === 'missing_layer' ? 'unknown' : event.reason
    };
  }

  private async refreshConsumerLayerState(consumerId: string): Promise<void> {
    const state = (await this.pool.workerForConsumer(consumerId).request({ type: 'consumerLayerState', consumerId })) as ConsumerLayerState | undefined;
    if (state) {
      this.consumerLayerStates.set(consumerId, state);
    }
  }

  private async refreshProducerLayerState(producerId: string): Promise<void> {
    const state = (await this.pool.workerForProducer(producerId).request({ type: 'producerLayerState', producerId })) as ProducerLayerState | undefined;
    if (state) {
      this.producerLayerStates.set(producerId, state);
    }
  }

  private async refreshConsumerQualityState(consumerId: string): Promise<void> {
    const state = (await this.pool.workerForConsumer(consumerId).request({ type: 'consumerQualityState', consumerId })) as ConsumerQualityState | undefined;
    if (state) {
      this.consumerQualityStates.set(consumerId, state);
    }
  }

  private async refreshProducerQualityState(producerId: string): Promise<void> {
    const state = (await this.pool.workerForProducer(producerId).request({ type: 'producerQualityState', producerId })) as ProducerQualityState | undefined;
    if (state) {
      this.producerQualityStates.set(producerId, state);
    }
  }

  private async refreshTransportQualityState(transportId: string): Promise<void> {
    const state = (await this.pool.workerForTransport(transportId).request({ type: 'transportQualityState', transportId })) as TransportQualityState | undefined;
    if (state) {
      this.transportQualityStates.set(transportId, state);
    }
  }

  private async refreshRoomQualityState(roomId: string): Promise<void> {
    const state = (await this.pool.workerForRoom(roomId).request({ type: 'roomQualityState', roomId })) as RoomQualityState | undefined;
    if (state) {
      this.roomQualityStates.set(roomId, state);
    }
  }

  private async refreshMediaCounters(transportId: string, participantId: string): Promise<void> {
    const state = (await this.pool.workerForTransport(transportId).request({ type: 'mediaCounters', transportId, participantId })) as MediaPacketBridgeCounters;
    this.counterSnapshots.set(transportId, state);
  }

  private async refreshAdaptiveMetrics(): Promise<void> {
    const rooms = new Set<string>([
      ...[...this.transports.values()].map((transport) => transport.roomId),
      ...[...this.pipeTransports.values()].map((transport) => transport.roomId),
      ...[...this.producers.values()].map((producer) => producer.roomId),
      ...[...this.consumers.values()].map((consumer) => consumer.roomId),
      ...this.roomQualityStates.keys()
    ]);
    if (rooms.size === 0) {
      this.adaptiveMetricsSnapshot = emptyAdaptiveMetrics();
      return;
    }
    const results = await Promise.all(
      [...rooms].map((roomId) => this.pool.workerForRoom(roomId).request({ type: 'adaptiveTransportMetrics' }).catch(() => emptyAdaptiveMetrics()))
    );
    this.adaptiveMetricsSnapshot = mergeAdaptiveMetrics(results as AdaptiveMetricsSnapshot[]);
  }

  private async ensurePipeTransportBinding(pipeTransportId: string, roomId?: string): Promise<PipeTransportBinding> {
    const existing = this.pipeTransports.get(pipeTransportId);
    if (existing) {
      return existing;
    }
    const snapshot = this.pipe?.snapshot(pipeTransportId);
    const protocol = this.pipe?.transportProtocol(pipeTransportId);
    if (!snapshot || !protocol) {
      throw new ServiceUnavailableException(`Pipe transport ${pipeTransportId} must be explicitly provisioned before worker registration`);
    }
    if (protocol === 'udp') {
      throw new ServiceUnavailableException(`UDP pipe transport ${pipeTransportId} must be provisioned through ensurePipeTransport before worker registration`);
    }
    const ensured = await this.ensurePipeTransport({
      pipeTransportId,
      roomId: roomId ?? snapshot.roomId,
      localNodeId: snapshot.localNodeId,
      remoteNodeId: snapshot.remoteNodeId,
      protocol
    });
    return {
      roomId: ensured.roomId,
      localNodeId: ensured.localNodeId,
      remoteNodeId: ensured.remoteNodeId,
      protocol: ensured.protocol,
      localEndpoint: ensured.localEndpoint,
      remoteEndpoint: ensured.remoteEndpoint
    };
  }

}

function emptyAdaptiveMetrics(): AdaptiveMetricsSnapshot {
  return {
    bandwidth: [],
    pacing: [],
    statistics: {
      generatedAt: new Date().toISOString(),
      producers: [],
      consumers: [],
      bandwidth: [],
      pacing: [],
      probes: [],
      rooms: []
    },
    consumerLayers: [],
    producerLayers: [],
    quality: {
      consumers: [],
      producers: [],
      transports: [],
      rooms: []
    }
  };
}

function mergeAdaptiveMetrics(snapshots: AdaptiveMetricsSnapshot[]): AdaptiveMetricsSnapshot {
  const empty = emptyAdaptiveMetrics();
  return {
    bandwidth: snapshots.flatMap((snapshot) => snapshot.bandwidth ?? []),
    pacing: snapshots.flatMap((snapshot) => snapshot.pacing ?? []),
    statistics: {
      generatedAt: new Date().toISOString(),
      producers: snapshots.flatMap((snapshot) => snapshot.statistics?.producers ?? []),
      consumers: snapshots.flatMap((snapshot) => snapshot.statistics?.consumers ?? []),
      bandwidth: snapshots.flatMap((snapshot) => snapshot.statistics?.bandwidth ?? []),
      pacing: snapshots.flatMap((snapshot) => snapshot.statistics?.pacing ?? []),
      probes: snapshots.flatMap((snapshot) => snapshot.statistics?.probes ?? []),
      rooms: snapshots.flatMap((snapshot) => snapshot.statistics?.rooms ?? [])
    },
    consumerLayers: snapshots.flatMap((snapshot) => snapshot.consumerLayers ?? []),
    producerLayers: snapshots.flatMap((snapshot) => snapshot.producerLayers ?? []),
    quality: {
      consumers: snapshots.flatMap((snapshot) => snapshot.quality?.consumers ?? []),
      producers: snapshots.flatMap((snapshot) => snapshot.quality?.producers ?? []),
      transports: snapshots.flatMap((snapshot) => snapshot.quality?.transports ?? []),
      rooms: snapshots.flatMap((snapshot) => snapshot.quality?.rooms ?? [])
    }
  } satisfies AdaptiveMetricsSnapshot;
}

function emptyMediaCounters(): MediaPacketBridgeCounters {
  return {
    inboundPackets: 0,
    inboundStunPackets: 0,
    inboundDtlsPackets: 0,
    inboundRtpPackets: 0,
    inboundRtcpPackets: 0,
    inboundSrtpPackets: 0,
    inboundSrtcpPackets: 0,
    inboundUnknownPackets: 0,
    inboundDecryptedRtpPackets: 0,
    inboundDecryptedRtcpPackets: 0,
    inboundErrors: 0,
    outboundRtpPackets: 0,
    outboundRtcpPackets: 0,
    outboundDatagrams: 0,
    outboundErrors: 0,
    routedRtpPackets: 0,
    routedRtcpPackets: 0,
    inboundRtpPaddingOnlyPackets: 0,
    inboundRtpSsrcCounts: {},
    inboundRtpPayloadTypeCounts: {},
    queueDepth: 0,
    maxQueueDepth: 0
  };
}
