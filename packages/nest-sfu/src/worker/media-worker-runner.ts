import { AudioLevelObserver, BandwidthEstimator, RtcpProcessor, RtpRouter, SimulcastSelector } from '@native-sfu/sfu-core';
import type { Consumer, Producer } from '@native-sfu/contracts';
import { DtlsService } from '../dtls.service';
import { IceService } from '../ice.service';
import { UdpPortAllocator } from '../ice/udp-port-allocator';
import { MediaService } from '../media.service';
import type { NestSfuOptions } from '../nest-sfu.options';
import { SrtpService } from '../srtp.service';
import {
  serializeError,
  type MediaWorkerHealth,
  type MediaWorkerMessage,
  type MediaWorkerPipeTransportSnapshot,
  type MediaWorkerRequest,
  type MediaWorkerResponse
} from './ipc';
import { WorkerPipeTransport } from './worker-pipe-transport';

interface WorkerState {
  rooms: Set<string>;
  transports: Map<string, { roomId: string; participantId: string }>;
  pipeTransports: Map<string, { roomId: string }>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  rtpPackets: number;
  rtcpPackets: number;
  droppedRtpPackets: number;
  lastDroppedRtpReason?: string;
  droppedRtpReasons: Map<string, number>;
}

export class MediaWorkerRunner {
  private readonly workerId = process.env.MEDIA_WORKER_ID ?? `media-worker-${process.pid}`;
  private readonly options = parseOptions();
  private readonly startedAt = new Date().toISOString();
  private readonly state: WorkerState = {
    rooms: new Set(),
    transports: new Map(),
    pipeTransports: new Map(),
    producers: new Map(),
      consumers: new Map(),
      rtpPackets: 0,
      rtcpPackets: 0,
      droppedRtpPackets: 0,
      droppedRtpReasons: new Map()
    };
  private readonly media: MediaService;
  private readonly pipe: WorkerPipeTransport;
  private heartbeat?: NodeJS.Timeout;
  private inFlight = 0;
  private ready = false;
  private lastHealthAt = Date.now();
  private lastRtpPackets = 0;
  private lastRtcpPackets = 0;

  constructor() {
    const range = this.options.hostCandidatePortRange ?? {
      min: this.options.hostCandidatePort ?? 40000,
      max: this.options.hostCandidatePort ?? 40000
    };
    const allocator = new UdpPortAllocator(range.min, range.max);
    const ice = new IceService(this.options, allocator);
    const dtls = new DtlsService();
    const srtp = new SrtpService();
    const rtcp = new RtcpProcessor({
      onReceiverReport: () => {
        this.state.rtcpPackets += 1;
      },
      onSenderReport: () => {
        this.state.rtcpPackets += 1;
      },
      onNack: () => {
        this.state.rtcpPackets += 1;
      },
      onPli: () => {
        this.state.rtcpPackets += 1;
      },
      onFir: () => {
        this.state.rtcpPackets += 1;
      },
      onRemb: () => {
        this.state.rtcpPackets += 1;
      },
      onTwcc: () => {
        this.state.rtcpPackets += 1;
      }
    });
    const router = new RtpRouter({
      onForwardedPacket: () => {
        this.state.rtpPackets += 1;
      },
      onDroppedPacket: (reason) => {
        this.state.droppedRtpPackets += 1;
        this.state.lastDroppedRtpReason = reason;
        this.state.droppedRtpReasons.set(reason, (this.state.droppedRtpReasons.get(reason) ?? 0) + 1);
      },
      onForwardedRtcpPacket: () => {
        this.state.rtcpPackets += 1;
      },
      retransmissionCacheSize: this.options.rtpRetransmissionCacheSize,
      keyframeRequestIntervalMs: this.options.keyframeRequestIntervalMs,
      maxReorderPackets: this.options.maxRtpReorderPackets,
      restartSequenceGap: this.options.rtpRestartSequenceGap,
      duplicateWindowSize: this.options.rtpDuplicateWindowSize,
      enableTwcc: this.options.enableTwcc,
      enablePacing: this.options.enablePacing,
      enableProbeScheduling: this.options.enableProbeScheduling,
      enableJoinKeyframeGate: this.options.enableJoinKeyframeGate,
      enableAdaptiveLayerSelection: this.options.enableAdaptiveLayerSelection,
      enableDynacast: this.options.enableDynacast,
      defaultPacingBitrateBps: this.options.defaultPacingBitrateBps,
      maxPacingQueueBytes: this.options.maxPacingQueueBytes,
      twccFeedbackIntervalMs: this.options.twccFeedbackIntervalMs,
      probeClusterIntervalMs: this.options.probeClusterIntervalMs,
      probeBurstPackets: this.options.probeBurstPackets,
      probeBitrateMultiplier: this.options.probeBitrateMultiplier,
      dynacastUpgradeHoldMs: this.options.dynacastUpgradeHoldMs,
      dynacastPriorityBias: this.options.dynacastPriorityBias,
      qualityUpdateIntervalMs: this.options.qualityUpdateIntervalMs,
      minAudioBitrateBps: this.options.minAudioBitrateBps,
      minVideoBitrateBps: this.options.minVideoBitrateBps,
      minScreenBitrateBps: this.options.minScreenBitrateBps,
      defaultVideoBitrateBps: this.options.defaultVideoBitrateBps,
      defaultScreenBitrateBps: this.options.defaultScreenBitrateBps
    });
    // Keep these dependencies instantiated here so future worker-local media features can reuse the same stack.
    void new SimulcastSelector();
    void new BandwidthEstimator();
    void new AudioLevelObserver();
    this.pipe = new WorkerPipeTransport({
      onInboundRtp: (event) => {
        void this.media.handlePipeRtp(event.pipeTransportId, event.producerId, event.packet).catch(() => undefined);
      },
      onInboundRtcp: (event) => {
        void this.media.handlePipeRtcp(event.pipeTransportId, event.packet, { roomId: event.roomId }).catch(() => undefined);
      },
      onOutboundIpcRtp: (event) =>
        this.send({
          kind: 'event',
          event: {
            type: 'pipe-rtp',
            pipeTransportId: event.pipeTransportId,
            roomId: event.roomId,
            producerId: event.producerId,
            packet: event.packet
          }
        }),
      onOutboundIpcRtcp: (event) =>
        this.send({
          kind: 'event',
          event: {
            type: 'pipe-rtcp',
            pipeTransportId: event.pipeTransportId,
            roomId: event.roomId,
            packet: event.packet,
            producerId: event.producerId,
            consumerId: event.consumerId
          }
        })
    });
    this.media = new MediaService(ice, dtls, srtp, rtcp, router, this.pipe);
    this.forwardMediaEvents();
  }

  start(): void {
    process.on('message', (message: MediaWorkerMessage) => {
      if (message?.kind === 'request') {
        void this.handleRequest(message);
      }
    });
    process.once('SIGTERM', () => {
      this.shutdown('sigterm');
    });
    this.ready = true;
    this.heartbeat = setInterval(() => this.sendHealth(), this.options.mediaWorkerHeartbeatIntervalMs ?? 2000);
    this.send({
      kind: 'event',
      event: {
        type: 'ready',
        workerId: this.workerId,
        pid: process.pid,
        health: this.health()
      }
    });
  }

  private async handleRequest(request: MediaWorkerRequest): Promise<void> {
    const startedAt = Date.now();
    this.inFlight += 1;
    try {
      const data = await this.dispatch(request);
      this.send({
        kind: 'response',
        id: request.id,
        ok: true,
        data,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      this.send({
        kind: 'response',
        id: request.id,
        ok: false,
        error: serializeError(error),
        durationMs: Date.now() - startedAt
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  private async dispatch(request: MediaWorkerRequest): Promise<MediaWorkerResponse['data']> {
    const command = request.command;
    switch (command.type) {
      case 'createWebRtcTransport': {
        const options = await this.media.createWebRtcTransport(command.roomId, command.participantId);
        this.state.rooms.add(command.roomId);
        this.state.transports.set(options.id, { roomId: command.roomId, participantId: command.participantId });
        return options;
      }
      case 'ensurePipeTransport':
        this.state.rooms.add(command.roomId);
        this.state.pipeTransports.set(command.pipeTransportId, { roomId: command.roomId });
        return (await this.pipe.ensureTransport({
          pipeTransportId: command.pipeTransportId,
          roomId: command.roomId,
          localNodeId: command.localNodeId,
          remoteNodeId: command.remoteNodeId,
          protocol: command.protocol,
          listenPort: command.listenPort,
          advertisedIp: command.advertisedIp,
          peerToken: command.peerToken,
          remoteEndpoint: command.remoteEndpoint
        })) as MediaWorkerPipeTransportSnapshot;
      case 'pipeTransportSnapshot':
        return this.pipe.transportSnapshot(command.pipeTransportId) as MediaWorkerPipeTransportSnapshot | undefined;
      case 'closePipeTransport':
        await this.media.closePipeTransport(command.pipeTransportId);
        await this.pipe.closeTransport(command.pipeTransportId);
        this.releasePipeTransportState(command.pipeTransportId);
        this.state.pipeTransports.delete(command.pipeTransportId);
        return undefined;
      case 'assertTransportOwner':
        this.media.assertTransportOwner(command.transportId, command.participantId);
        return undefined;
      case 'addRemoteCandidate':
        await this.media.addRemoteCandidate(command.transportId, command.participantId, command.candidate);
        return undefined;
      case 'setRemoteIceParameters':
        await this.media.setRemoteIceParameters(command.transportId, command.participantId, command.parameters);
        return undefined;
      case 'setRemoteDtlsParameters':
        await this.media.setRemoteDtlsParameters(command.transportId, command.participantId, command.parameters);
        return undefined;
      case 'restartIce':
        return this.media.restartIce(command.transportId, command.participantId);
      case 'bindProducer':
        await this.media.bindProducer(command.transportId, command.participantId, command.rtpParameters);
        return undefined;
      case 'registerProducer':
        await this.media.registerProducer(command.producer);
        this.state.producers.set(command.producer.id, command.producer);
        return undefined;
      case 'unregisterProducer':
        await this.media.unregisterProducer(command.producerId);
        this.state.producers.delete(command.producerId);
        return undefined;
      case 'setProducerPaused':
        await this.media.setProducerPaused(command.producerId, command.paused);
        return undefined;
      case 'setProducerPriority':
        this.media.setProducerPriority(command.producerId, command.priority);
        return undefined;
      case 'registerConsumer':
        await this.media.registerConsumer(command.consumer);
        this.state.consumers.set(command.consumer.id, command.consumer);
        return undefined;
      case 'registerPipeProducer':
        await this.media.registerPipeProducer(command.producer, command.pipeTransportId);
        this.state.producers.set(command.producer.id, {
          ...command.producer,
          transportId: command.pipeTransportId ?? command.producer.transportId
        });
        return undefined;
      case 'registerPipeConsumer':
        await this.media.registerPipeConsumer(command.consumer, command.pipeTransportId);
        this.state.consumers.set(command.consumer.id, {
          ...command.consumer,
          transportId: command.pipeTransportId ?? command.consumer.transportId
        });
        return undefined;
      case 'handleRtcp':
        return this.media.handleRtcp(command.transportId, command.participantId, Buffer.from(command.packet));
      case 'handlePipeRtp':
        return this.media.handlePipeRtp(command.pipeTransportId, command.producerId, Buffer.from(command.packet));
      case 'handlePipeRtcp':
        return this.media.handlePipeRtcp(command.pipeTransportId, Buffer.from(command.packet), command.options);
      case 'unregisterConsumer':
        await this.media.unregisterConsumer(command.consumerId);
        this.state.consumers.delete(command.consumerId);
        return undefined;
      case 'setConsumerPaused':
        await this.media.setConsumerPaused(command.consumerId, command.paused);
        return undefined;
      case 'setConsumerPreferredLayers':
        return this.media.setConsumerPreferredLayers(command.consumerId, command.preferredLayers);
      case 'setConsumerPreferredSvcLayers':
        return this.media.setConsumerPreferredSvcLayers(command.consumerId, command.preferredSvcLayers);
      case 'setConsumerPriority':
        this.media.setConsumerPriority(command.consumerId, command.priority);
        return undefined;
      case 'applyConsumerTwccObservation':
        return this.media.applyConsumerTwccObservation(command.consumerId, command.observation);
      case 'consumerLayerState':
        return this.media.consumerLayerState(command.consumerId);
      case 'consumerQualityState':
        return this.media.consumerQualityState(command.consumerId);
      case 'producerQualityState':
        return this.media.producerQualityState(command.producerId);
      case 'transportQualityState':
        return this.media.transportQualityState(command.transportId);
      case 'roomQualityState':
        return this.media.roomQualityState(command.roomId);
      case 'producerLayerState':
        return this.media.producerLayerState(command.producerId);
      case 'mediaCounters':
        return this.media.mediaCounters(command.transportId, command.participantId);
      case 'adaptiveTransportMetrics':
        return this.media.adaptiveTransportMetrics() as unknown as Record<string, unknown>;
      case 'waitForMediaIdle':
        await this.media.waitForMediaIdle(command.transportId, command.participantId, command.timeoutMs);
        return undefined;
      case 'closeParticipantTransports':
        await this.media.closeParticipantTransports(command.participantId);
        this.releaseParticipant(command.participantId);
        return undefined;
      case 'closeRoom':
        await this.media.closeRoom(command.roomId);
        await this.pipe.closeRoom(command.roomId);
        this.releaseRoom(command.roomId);
        return undefined;
      case 'workerHealth':
        return this.health();
      case 'shutdown':
        this.shutdown('request');
        return undefined;
    }
  }

  private forwardMediaEvents(): void {
    this.media.onConsumerLayerEvent((event) => this.send({ kind: 'event', event: { type: 'consumer-layer', event } }));
    this.media.onProducerDynacastEvent((event) => this.send({ kind: 'event', event: { type: 'producer-dynacast', event } }));
    this.media.onConsumerTwccObservation((state) => this.send({ kind: 'event', event: { type: 'consumer-twcc', state } }));
    this.media.onConsumerScoreUpdated((state) => this.send({ kind: 'event', event: { type: 'consumer-score', state } }));
    this.media.onProducerScoreUpdated((state) => this.send({ kind: 'event', event: { type: 'producer-score', state } }));
    this.media.onTransportQualityUpdated((state) => this.send({ kind: 'event', event: { type: 'transport-quality', state } }));
    this.media.onRoomQualityUpdated((state) => this.send({ kind: 'event', event: { type: 'room-quality', state } }));
  }

  private sendHealth(): void {
    this.send({ kind: 'event', event: { type: 'health', workerId: this.workerId, health: this.health() } });
  }

  private health(): MediaWorkerHealth {
    const packetCounts = this.observedPacketCounts();
    return {
      workerId: this.workerId,
      pid: process.pid,
      status: this.ready ? 'ready' : 'unhealthy',
      healthy: this.ready,
      ready: this.ready,
      startedAt: this.startedAt,
      lastHeartbeatAt: new Date().toISOString(),
      restarts: 0,
      crashes: 0,
      uptimeMs: Math.max(0, Date.now() - Date.parse(this.startedAt)),
      activeRooms: this.state.rooms.size,
      activeTransports: this.state.transports.size + this.state.pipeTransports.size,
      activeProducers: this.state.producers.size,
      activeConsumers: this.state.consumers.size,
      rtpPackets: packetCounts.rtpPackets,
      rtcpPackets: packetCounts.rtcpPackets,
      rtpPacketRate: this.packetRate('rtp', packetCounts.rtpPackets),
      rtcpPacketRate: this.packetRate('rtcp', packetCounts.rtcpPackets),
      inflightRequests: this.inFlight,
      queueDepth: this.inFlight,
      averageIpcLatencyMs: 0,
      ipcTimeouts: 0,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      droppedRtpPackets: this.state.droppedRtpPackets,
      lastDroppedRtpReason: this.state.lastDroppedRtpReason,
      droppedRtpReasons: Object.fromEntries(this.state.droppedRtpReasons)
    };
  }

  private observedPacketCounts(): { rtpPackets: number; rtcpPackets: number } {
    let bridgeRtpPackets = 0;
    let bridgeRtcpPackets = 0;
    for (const [transportId, transport] of this.state.transports) {
      try {
        const counters = this.media.mediaCounters(transportId, transport.participantId);
        bridgeRtpPackets += counters.inboundRtpPackets + counters.inboundSrtpPackets + counters.inboundDecryptedRtpPackets + counters.outboundRtpPackets;
        bridgeRtcpPackets += counters.inboundRtcpPackets + counters.inboundSrtcpPackets + counters.inboundDecryptedRtcpPackets + counters.outboundRtcpPackets;
      } catch {
        // Transport ownership can be removed while a heartbeat is being prepared.
      }
    }
    return {
      rtpPackets: Math.max(this.state.rtpPackets, bridgeRtpPackets),
      rtcpPackets: Math.max(this.state.rtcpPackets, bridgeRtcpPackets)
    };
  }

  private packetRate(kind: 'rtp' | 'rtcp', current: number): number {
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - this.lastHealthAt) / 1000);
    const previous = kind === 'rtp' ? this.lastRtpPackets : this.lastRtcpPackets;
    const rate = Math.max(0, (current - previous) / elapsedSeconds);
    if (kind === 'rtp') {
      this.lastRtpPackets = current;
    } else {
      this.lastRtcpPackets = current;
      this.lastHealthAt = now;
    }
    return rate;
  }

  private releasePipeTransportState(pipeTransportId: string): void {
    for (const [producerId, producer] of this.state.producers) {
      if (producer.transportId === pipeTransportId) {
        this.state.producers.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.state.consumers) {
      if (consumer.transportId === pipeTransportId) {
        this.state.consumers.delete(consumerId);
      }
    }
  }

  private releaseParticipant(participantId: string): void {
    for (const [transportId, transport] of this.state.transports) {
      if (transport.participantId === participantId) {
        this.state.transports.delete(transportId);
      }
    }
    for (const [producerId, producer] of this.state.producers) {
      if (producer.participantId === participantId) {
        this.state.producers.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.state.consumers) {
      if (consumer.participantId === participantId) {
        this.state.consumers.delete(consumerId);
      }
    }
    this.rebuildRooms();
  }

  private releaseRoom(roomId: string): void {
    for (const [transportId, transport] of this.state.transports) {
      if (transport.roomId === roomId) {
        this.state.transports.delete(transportId);
      }
    }
    for (const [pipeTransportId, transport] of this.state.pipeTransports) {
      if (transport.roomId === roomId) {
        this.state.pipeTransports.delete(pipeTransportId);
      }
    }
    for (const [producerId, producer] of this.state.producers) {
      if (producer.roomId === roomId) {
        this.state.producers.delete(producerId);
      }
    }
    for (const [consumerId, consumer] of this.state.consumers) {
      if (consumer.roomId === roomId) {
        this.state.consumers.delete(consumerId);
      }
    }
    this.state.rooms.delete(roomId);
  }

  private rebuildRooms(): void {
    this.state.rooms.clear();
    for (const transport of this.state.transports.values()) {
      this.state.rooms.add(transport.roomId);
    }
    for (const transport of this.state.pipeTransports.values()) {
      this.state.rooms.add(transport.roomId);
    }
  }

  private shutdown(_reason: string): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.ready = false;
    setTimeout(() => process.exit(0), 10).unref();
  }

  private send(message: MediaWorkerMessage): void {
    if (process.send) {
      process.send(message);
    }
  }
}

function parseOptions(): NestSfuOptions {
  const raw = process.env.MEDIA_WORKER_OPTIONS;
  if (!raw) {
    throw new Error('MEDIA_WORKER_OPTIONS is required');
  }
  return JSON.parse(raw) as NestSfuOptions;
}
