import { ForbiddenException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type {
  Consumer,
  PipeAckMessage,
  PipeCloseMessage,
  PipeConsumerCloseMessage,
  PipeConsumerCreateMessage,
  PipeCoordinationEnvelope,
  PipeCoordinationMessage,
  PipeCreateMessage,
  PipeErrorCode,
  PipeErrorMessage,
  PipeFeedReleaseMessage,
  PipeFeedRequestMessage,
  PipeNodeEndpoint,
  PipeProducerStateMessage,
  PipeProducerCloseMessage,
  PipeProducerCreateMessage,
  PipePublishReleaseMessage,
  PipePublishRequestMessage,
  PipeTransportProtocol,
  PipeRtcpMessage,
  PipeStatsMessage,
  Producer,
  ProducerStatus,
  RtpParameters
} from '@native-sfu/contracts';
import { MediaService, PipeTransportManager, PipeTransportService } from '@native-sfu/nest-sfu';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { NodeRegistryService } from './node-registry.service';

const PIPE_STREAM = 'sfu:pipe-coordination';
const PIPE_PROTOCOL_VERSION = 1;
const PROCESSED_COMMAND_CACHE_LIMIT = 5000;
const SETTLED_REQUEST_CACHE_LIMIT = 5000;
const PROCESSED_COMMAND_TTL_SECONDS = 300;

type PipeCommandMessage = Exclude<PipeCoordinationMessage, PipeAckMessage>;
type PipeCommandEnvelope = PipeCoordinationEnvelope<PipeCommandMessage>;

interface PipeCoordinatorValidationFailure {
  ok: false;
  code: PipeErrorCode;
  message: string;
  reply: boolean;
  countRejection: boolean;
}

type PipeCoordinatorValidation = { ok: true } | PipeCoordinatorValidationFailure;

interface PendingPipeRequest<T extends PipeCoordinationMessage = PipeCoordinationMessage> {
  baseEnvelope: PipeCoordinationEnvelope<T>;
  attempts: number;
  timer?: NodeJS.Timeout;
  settled: boolean;
  resolve: (ack: PipeAckMessage) => void;
  reject: (error: unknown) => void;
  send: () => void;
}

interface SettledPipeRequest {
  status: 'ok' | 'error';
  envelope: PipeCoordinationEnvelope<PipeCoordinationMessage>;
}

interface PipeRtcpMediaHandler {
  getProducer?: (producerId: string) => Producer | undefined;
  registerPipeProducer?: (producer: Producer, pipeTransportId?: string) => Promise<void> | void;
  registerPipeConsumer?: (consumer: Consumer, pipeTransportId?: string) => Promise<void> | void;
  unregisterProducer?: (producerId: string) => Promise<void> | void;
  unregisterConsumer?: (consumerId: string) => Promise<void> | void;
  setProducerPaused?: (producerId: string, paused: boolean) => Promise<void> | void;
  setProducerPriority?: (producerId: string, priority: number) => void;
  handlePipeRtp?: (pipeTransportId: string, producerId: string | undefined, packet: Buffer) => Promise<number> | number;
  handlePipeRtcp?: (pipeTransportId: string, packet: Buffer, options?: { roomId?: string; sourceParticipantId?: string }) => Promise<unknown> | unknown;
  closePipeTransport?: (pipeTransportId: string) => Promise<void> | void;
}

interface PipeTransportState {
  roomId: string;
  ownerNodeId: string;
  remoteNodeId: string;
  protocol: PipeTransportProtocol;
  peerToken?: string;
  localEndpoint?: PipeNodeEndpoint;
  remoteEndpoint?: PipeNodeEndpoint;
  listenersAttached: boolean;
}

interface RemoteFeedState {
  roomId: string;
  pipeTransportId: string;
  ownerNodeId: string;
  ownerClaimedAt: string;
  remoteNodeId: string;
  producerId: string;
  proxyProducerId: string;
  pipeConsumerId: string;
  protocol: PipeTransportProtocol;
  references: number;
  createdAt: string;
}

interface RemotePublishedProducerState {
  roomId: string;
  pipeTransportId: string;
  ownerNodeId: string;
  ownerClaimedAt: string;
  remoteNodeId: string;
  producerId: string;
  participantId: string;
  kind: Producer['kind'];
  priority?: number;
  status?: ProducerStatus;
  pipeConsumerId: string;
  proxyProducerId: string;
  protocol: PipeTransportProtocol;
  createdAt: string;
}

export interface PipeCoordinatorSnapshot {
  enabled: boolean;
  localNodeId: string;
  activePipeTransports: number;
  pipeProducers: number;
  pipeConsumers: number;
  rejectedRequests: number;
}

export interface PipeCoordinatorHealthSnapshot {
  enabled: boolean;
  durable: boolean;
  supported: boolean;
  mediaWorkerMode: 'in-process' | 'worker';
  advertiseIpConfigured: boolean;
  defaultProtocol: PipeTransportProtocol;
  reason?: 'udp_advertise_ip_required';
}

@Injectable()
export class PipeCoordinatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipeCoordinatorService.name);
  private readonly enabled: boolean;
  private readonly clusterSecret?: string;
  private readonly coordinationTimeoutMs: number;
  private readonly coordinationMaxAttempts: number;
  private readonly maxSetupRequestsPerMinute: number;
  private readonly mediaWorkerMode: 'in-process' | 'worker';
  private readonly allowedNodeIds: ReadonlySet<string>;
  private readonly pipePortRange: { min: number; max: number };
  private readonly pipeProducers = new Map<string, PipeProducerCreateMessage>();
  private readonly pipeConsumers = new Map<string, PipeConsumerCreateMessage>();
  private readonly pipeStates = new Map<string, PipeTransportState>();
  private readonly ownerFeeds = new Map<string, RemoteFeedState>();
  private readonly remoteFeeds = new Map<string, RemoteFeedState>();
  private readonly remoteConsumerFeeds = new Map<string, string>();
  private readonly ownerPublishedProducers = new Map<string, RemotePublishedProducerState>();
  private readonly remotePublishedProducers = new Map<string, RemotePublishedProducerState>();
  private readonly pendingRequests = new Map<string, PendingPipeRequest>();
  private readonly processedCommands = new Map<string, PipeAckMessage>();
  private readonly settledRequests = new Map<string, SettledPipeRequest>();
  private readonly pipe: PipeTransportService;
  private setupWindowStartedAt = Date.now();
  private setupRequestsInWindow = 0;
  private rejectedRequests = 0;
  private nextUdpPort: number;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: NodeRegistryService,
    private readonly redis: RedisService,
    @Optional() pipe: PipeTransportService | undefined,
    private readonly metrics: MetricsService,
    @Optional() @Inject(MediaService) private readonly media?: PipeRtcpMediaHandler
  ) {
    this.enabled = config.get<boolean>('pipe.enabled', false);
    this.clusterSecret = config.get<string>('pipe.clusterSecret');
    this.coordinationTimeoutMs = config.get<number>('pipe.coordinationTimeoutMs', 5000);
    this.coordinationMaxAttempts = Math.max(1, config.get<number>('pipe.coordinationMaxAttempts', 3));
    this.maxSetupRequestsPerMinute = config.get<number>('pipe.maxSetupRequestsPerMinute', 120);
    this.mediaWorkerMode = config.get<'in-process' | 'worker'>('mediaWorker.mode', 'in-process');
    this.allowedNodeIds = new Set(config.get<string[]>('pipe.allowedNodeIds', []));
    this.pipePortRange = config.get<{ min: number; max: number }>('pipe.portRange', { min: 41000, max: 41100 });
    this.nextUdpPort = this.pipePortRange.min;
    this.pipe = pipe ?? new PipeTransportService(new PipeTransportManager());
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    this.assertClusterSecret();
    await this.redis.consumeDurable<PipeCoordinationEnvelope>(
      PIPE_STREAM,
      `pipe-coordinator:${this.registry.localNodeId()}`,
      async (envelope, meta) => {
        if (meta.replayed) {
          this.metrics.controlPlaneReplayMessages.labels('pipe_coordination').inc();
        }
        await this.handleEnvelope(envelope);
        this.metrics.controlPlaneMessagesDelivered.labels('pipe_coordination').inc();
      },
      {
        onError: (_error, phase) => {
          this.metrics.controlPlaneConsumeFailures.labels('pipe_coordination', phase).inc();
        }
      }
    );
  }

  onModuleDestroy(): void {
    for (const pending of [...this.pendingRequests.values()]) {
      this.settlePendingRequest(
        pending,
        undefined,
        this.pipeCoordinationError('transport_error', 'Pipe coordinator shut down before acknowledgement', pending.baseEnvelope.correlationId)
      );
    }
    for (const snapshot of this.pipe.snapshots()) {
      this.pipe.closeTransport(snapshot.id, 'module_destroy');
    }
    for (const snapshot of this.pipe.udpSnapshots()) {
      this.pipe.closeTransport(snapshot.id, 'module_destroy');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async publish<T extends PipeCoordinationMessage>(targetNodeId: string, payload: T): Promise<PipeCoordinationEnvelope<T>> {
    this.assertEnabled();
    const envelope = this.createEnvelope(targetNodeId, payload);
    if (isAckMessage(payload)) {
      await this.publishEnvelope(envelope);
      return envelope;
    }
    await this.publishWithAck(envelope);
    return envelope;
  }

  async createPipe(request: Omit<PipeCreateMessage, 'type' | 'ownerNodeId' | 'local'> & { targetNodeId: string }): Promise<PipeCoordinationEnvelope<PipeCreateMessage>> {
    this.assertEnabled();
    this.assertPipeMediaSupported('pipe:create');
    if (!this.reserveSetupRequest()) {
      this.reject('rate_limited');
      throw new ServiceUnavailableException('Pipe setup rate limit exceeded');
    }
    const startedAt = Date.now();
    const owner = await this.assertRoomOwner(request.roomId);
    this.assertPeerAllowed(request.targetNodeId);
    const ownerNodeId = this.registry.localNodeId();
    const state = await this.ensureLocalPipeTransport({
      roomId: request.roomId,
      pipeTransportId: request.pipeTransportId,
      ownerNodeId,
      remoteNodeId: request.remoteNodeId,
      protocol: request.protocol,
      remoteEndpoint: request.remote,
      peerToken: request.protocol === 'udp' ? randomPipeToken() : undefined
    });
    const message: PipeCreateMessage = {
      type: 'pipe:create',
      roomId: request.roomId,
      pipeTransportId: request.pipeTransportId,
      ownerClaimedAt: owner.claimedAt,
      ownerNodeId,
      remoteNodeId: request.remoteNodeId,
      protocol: request.protocol,
      peerToken: state.peerToken,
      local: {
        nodeId: ownerNodeId,
        advertiseIp: state.localEndpoint?.advertiseIp ?? this.config.get<string>('pipe.advertiseIp'),
        port: state.localEndpoint?.port
      },
      remote: request.remote
    };
    const envelope = this.createEnvelope(request.targetNodeId, message);
    this.metrics.pipeCreateRequests.labels(message.protocol).inc();
    try {
      const ack = await this.publishWithAck(envelope);
      await this.finalizePipeTransportFromAck(message, ack);
      this.metrics.pipeSetupLatency.observe(Date.now() - startedAt);
      return envelope;
    } catch (error) {
      this.pipe.closeTransport(message.pipeTransportId, 'error');
      this.pipeStates.delete(message.pipeTransportId);
      throw error;
    }
  }

  async ensureRemoteConsumerFeed(request: { roomId: string; producerId: string; consumerId: string }): Promise<{ pipeTransportId: string; proxyProducerId: string }> {
    this.assertEnabled();
    this.assertPipeMediaSupported('pipe:feed:request');
    const lookup = await this.registry.lookupRoomOwner(request.roomId);
    if (!lookup.owner || !lookup.available) {
      this.metrics.pipeRemoteAttachFailures.labels('owner_unavailable').inc();
      throw new ServiceUnavailableException('Room owner is unavailable for remote subscriber attach');
    }
    if (lookup.owner.nodeId === this.registry.localNodeId()) {
      this.metrics.pipeRemoteAttachFailures.labels('owner_local').inc();
      throw new ForbiddenException('Remote consumer feeds are only required on non-owner nodes');
    }
    this.assertPeerAllowed(lookup.owner.nodeId);
    const feedKey = remoteFeedKey(request.roomId, lookup.owner.nodeId, this.registry.localNodeId(), request.producerId);
    const existing = this.remoteFeeds.get(feedKey);
    if (existing) {
      existing.references += 1;
      this.remoteConsumerFeeds.set(request.consumerId, feedKey);
      return { pipeTransportId: existing.pipeTransportId, proxyProducerId: existing.proxyProducerId };
    }
    const protocol = this.preferredPipeProtocol();
    const pipeTransportId = transportIdFor(request.roomId, lookup.owner.nodeId, this.registry.localNodeId(), protocol);
    const message: PipeFeedRequestMessage = {
      type: 'pipe:feed:request',
      roomId: request.roomId,
      pipeTransportId,
      ownerClaimedAt: lookup.owner.claimedAt,
      ownerNodeId: lookup.owner.nodeId,
      remoteNodeId: this.registry.localNodeId(),
      producerId: request.producerId,
      protocol
    };
    try {
      await this.publish(lookup.owner.nodeId, message);
    } catch (error) {
      this.metrics.pipeRemoteAttachFailures.labels('feed_request').inc();
      throw error;
    }
    const state: RemoteFeedState = {
      roomId: request.roomId,
      pipeTransportId,
      ownerNodeId: lookup.owner.nodeId,
      ownerClaimedAt: lookup.owner.claimedAt,
      remoteNodeId: this.registry.localNodeId(),
      producerId: request.producerId,
      proxyProducerId: request.producerId,
      pipeConsumerId: ownerPipeConsumerId(request.producerId, this.registry.localNodeId()),
      protocol,
      references: 1,
      createdAt: new Date().toISOString()
    };
    this.remoteFeeds.set(feedKey, state);
    this.remoteConsumerFeeds.set(request.consumerId, feedKey);
    return { pipeTransportId, proxyProducerId: state.proxyProducerId };
  }

  async releaseRemoteConsumerFeed(consumerId: string, reason: PipeFeedReleaseMessage['reason'] = 'consumer_closed'): Promise<void> {
    const feedKey = this.remoteConsumerFeeds.get(consumerId);
    if (!feedKey) {
      return;
    }
    this.remoteConsumerFeeds.delete(consumerId);
    const state = this.remoteFeeds.get(feedKey);
    if (!state) {
      return;
    }
    state.references = Math.max(0, state.references - 1);
    if (state.references > 0) {
      return;
    }
    this.remoteFeeds.delete(feedKey);
    try {
      await this.publish(state.ownerNodeId, {
        type: 'pipe:feed:release',
        roomId: state.roomId,
        pipeTransportId: state.pipeTransportId,
        ownerClaimedAt: state.ownerClaimedAt,
        ownerNodeId: state.ownerNodeId,
        remoteNodeId: state.remoteNodeId,
        producerId: state.producerId,
        reason
      });
    } catch (error) {
      this.metrics.pipeRemoteAttachFailures.labels('feed_release').inc();
      throw error;
    }
  }

  async ensureRemoteProducerPublication(request: { roomId: string; producer: Producer }): Promise<{ pipeTransportId: string; proxyProducerId: string }> {
    this.assertEnabled();
    const lookup = await this.registry.lookupRoomOwner(request.roomId);
    if (!lookup.owner || !lookup.available) {
      this.metrics.pipeRemotePublishFailures.labels('owner_unavailable').inc();
      throw new ServiceUnavailableException('Room owner is unavailable for remote publisher attach');
    }
    if (lookup.owner.nodeId === this.registry.localNodeId()) {
      return { pipeTransportId: request.producer.transportId, proxyProducerId: request.producer.id };
    }
    this.assertPeerAllowed(lookup.owner.nodeId);
    const existing = this.remotePublishedProducers.get(request.producer.id);
    if (existing) {
      return {
        pipeTransportId: existing.pipeTransportId,
        proxyProducerId: existing.proxyProducerId
      };
    }
    const protocol = this.preferredPipeProtocol();
    const pipeTransportId = transportIdFor(request.roomId, lookup.owner.nodeId, this.registry.localNodeId(), protocol);
    const message: PipePublishRequestMessage = {
      type: 'pipe:publish:request',
      roomId: request.roomId,
      pipeTransportId,
      ownerClaimedAt: lookup.owner.claimedAt,
      ownerNodeId: lookup.owner.nodeId,
      remoteNodeId: this.registry.localNodeId(),
      producerId: request.producer.id,
      participantId: request.producer.participantId,
      kind: request.producer.kind,
      rtpParameters: request.producer.rtpParameters,
      protocol,
      status: request.producer.status,
      priority: request.producer.priority
    };
    try {
      await this.publish(lookup.owner.nodeId, message);
    } catch (error) {
      this.metrics.pipeRemotePublishFailures.labels('publish_request').inc();
      throw error;
    }
    const state: RemotePublishedProducerState = {
      roomId: request.roomId,
      pipeTransportId,
      ownerNodeId: lookup.owner.nodeId,
      ownerClaimedAt: lookup.owner.claimedAt,
      remoteNodeId: this.registry.localNodeId(),
      producerId: request.producer.id,
      participantId: request.producer.participantId,
      kind: request.producer.kind,
      priority: request.producer.priority,
      status: request.producer.status,
      pipeConsumerId: remotePublishPipeConsumerId(request.producer.id, this.registry.localNodeId()),
      proxyProducerId: request.producer.id,
      protocol,
      createdAt: new Date().toISOString()
    };
    this.remotePublishedProducers.set(request.producer.id, state);
    return { pipeTransportId, proxyProducerId: state.proxyProducerId };
  }

  async releaseRemoteProducerPublication(
    producerId: string,
    reason: PipePublishReleaseMessage['reason'] = 'producer_closed'
  ): Promise<void> {
    const state = this.remotePublishedProducers.get(producerId);
    if (!state) {
      return;
    }
    this.remotePublishedProducers.delete(producerId);
    try {
      await this.publish(state.ownerNodeId, {
        type: 'pipe:publish:release',
        roomId: state.roomId,
        pipeTransportId: state.pipeTransportId,
        ownerClaimedAt: state.ownerClaimedAt,
        ownerNodeId: state.ownerNodeId,
        remoteNodeId: state.remoteNodeId,
        producerId: state.producerId,
        reason
      });
    } catch (error) {
      this.metrics.pipeRemotePublishFailures.labels('publish_release').inc();
      throw error;
    }
  }

  async syncRemoteProducerState(request: { roomId: string; producerId: string; status?: ProducerStatus; priority?: number }): Promise<void> {
    const state = this.remotePublishedProducers.get(request.producerId);
    if (!state) {
      return;
    }
    state.status = request.status ?? state.status;
    state.priority = request.priority ?? state.priority;
    try {
      await this.publish(state.ownerNodeId, {
        type: 'pipe:producer:state',
        roomId: request.roomId,
        pipeTransportId: state.pipeTransportId,
        ownerClaimedAt: state.ownerClaimedAt,
        ownerNodeId: state.ownerNodeId,
        remoteNodeId: state.remoteNodeId,
        producerId: request.producerId,
        status: request.status,
        priority: request.priority
      });
    } catch (error) {
      this.metrics.pipeRemotePublishFailures.labels('publish_state').inc();
      throw error;
    }
  }

  async handleEnvelope(envelope: PipeCoordinationEnvelope): Promise<void> {
    if (!this.enabled) {
      this.reject('disabled');
      return;
    }
    const validation = this.validateTargetedEnvelope(envelope);
    if (!validation.ok) {
      if (validation.countRejection) {
        this.reject(validation.code);
      }
      if (validation.reply && isPipeEnvelope(envelope) && !isAckMessage(envelope.payload)) {
        await this.publishAck(envelope as PipeCommandEnvelope, this.createAck(envelope as PipeCommandEnvelope, false, validation.code, validation.message));
      }
      return;
    }
    if (isAckMessage(envelope.payload)) {
      this.handleAck(envelope as PipeCoordinationEnvelope<PipeAckMessage>);
      return;
    }
    const commandEnvelope = envelope as PipeCommandEnvelope;
    const commandValidation = await this.validateCommandEnvelope(commandEnvelope);
    if (!commandValidation.ok) {
      if (commandValidation.countRejection) {
        this.reject(commandValidation.code);
      }
      if (commandValidation.reply) {
        await this.publishAck(commandEnvelope, this.createAck(commandEnvelope, false, commandValidation.code, commandValidation.message));
      }
      return;
    }
    const idempotencyKey = commandKey(commandEnvelope);
    const cachedAck = (await this.restoreCommandResult(idempotencyKey)) ?? this.processedCommands.get(idempotencyKey);
    if (cachedAck) {
      this.metrics.controlPlaneDuplicateSuppressions.labels('pipe_coordination', 'command_idempotency').inc();
      await this.publishAck(commandEnvelope, this.cloneAckForEnvelope(commandEnvelope, cachedAck, true));
      return;
    }
    if (isSetupMessage(commandEnvelope.payload) && !this.reserveSetupRequest()) {
      this.reject('rate_limited');
      const ack = this.createAck(commandEnvelope, false, 'rate_limited', 'Pipe setup rate limit exceeded');
      await this.rememberCommandResult(idempotencyKey, ack);
      await this.publishAck(commandEnvelope, ack);
      return;
    }
    try {
      await this.applyMessage(commandEnvelope.payload);
      const ack = this.createAck(commandEnvelope, true);
      await this.rememberCommandResult(idempotencyKey, ack);
      await this.publishAck(commandEnvelope, ack);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Pipe coordination ${commandEnvelope.type} failed: ${message}`);
      this.reject('transport_error');
      const ack = this.createAck(commandEnvelope, false, 'transport_error', message);
      await this.rememberCommandResult(idempotencyKey, ack);
      await this.publishAck(commandEnvelope, ack);
    }
  }

  snapshot(): PipeCoordinatorSnapshot {
    const pipeSnapshots = [...this.pipe.snapshots(), ...this.pipe.udpSnapshots()];
    const activePipeTransports = pipeSnapshots.filter((snapshot) => snapshot.active).length;
    this.metrics.activePipeTransports.set(activePipeTransports);
    this.metrics.pipeProducers.set(this.pipeProducers.size);
    this.metrics.pipeConsumers.set(this.pipeConsumers.size);
    this.metrics.crossNodeSubscribers.set(this.pipeConsumers.size);
    for (const snapshot of pipeSnapshots) {
      this.metrics.pipePacketLoss.labels(snapshot.id).set(snapshot.rtpPackets > 0 ? snapshot.droppedPackets / snapshot.rtpPackets : 0);
    }
    return {
      enabled: this.enabled,
      localNodeId: this.registry.localNodeId(),
      activePipeTransports,
      pipeProducers: this.pipeProducers.size,
      pipeConsumers: this.pipeConsumers.size,
      rejectedRequests: this.rejectedRequests
    };
  }

  healthSnapshot(): PipeCoordinatorHealthSnapshot {
    const advertiseIpConfigured = Boolean(this.config.get<string>('pipe.advertiseIp'));
    const defaultProtocol = advertiseIpConfigured ? 'udp' : 'internal';
    const unsupportedReason =
      this.enabled && this.config.get<string>('nodeEnv', 'development') !== 'test' && !advertiseIpConfigured
          ? 'udp_advertise_ip_required'
          : undefined;
    return {
      enabled: this.enabled,
      durable: true,
      supported: !unsupportedReason,
      mediaWorkerMode: this.mediaWorkerMode,
      advertiseIpConfigured,
      defaultProtocol,
      reason: unsupportedReason
    };
  }

  private async applyMessage(message: PipeCommandMessage): Promise<void> {
    if (message.type === 'pipe:create') {
      await this.handleCreate(message);
    } else if (message.type === 'pipe:publish:request') {
      await this.handlePublishRequest(message);
    } else if (message.type === 'pipe:publish:release') {
      await this.handlePublishRelease(message);
    } else if (message.type === 'pipe:feed:request') {
      await this.handleFeedRequest(message);
    } else if (message.type === 'pipe:feed:release') {
      await this.handleFeedRelease(message);
    } else if (message.type === 'pipe:producer:create') {
      await this.handleProducerCreate(message);
    } else if (message.type === 'pipe:producer:state') {
      await this.handleProducerState(message);
    } else if (message.type === 'pipe:producer:close') {
      await this.handleProducerClose(message);
    } else if (message.type === 'pipe:consumer:create') {
      await this.handleConsumerCreate(message);
    } else if (message.type === 'pipe:consumer:close') {
      await this.handleConsumerClose(message);
    } else if (message.type === 'pipe:close') {
      this.handleClose(message);
    } else if (message.type === 'pipe:rtcp') {
      await this.handleRtcp(message);
    } else if (message.type === 'pipe:stats') {
      this.handleStats(message);
    } else if (message.type === 'pipe:error') {
      this.metrics.pipeErrors.labels(message.code).inc();
    }
    this.snapshot();
  }

  private async handleCreate(message: PipeCreateMessage): Promise<void> {
    this.assertPipeMediaSupported('pipe:create');
    this.assertPeerAllowed(message.ownerNodeId === this.registry.localNodeId() ? message.remoteNodeId : message.ownerNodeId);
    await this.ensureLocalPipeTransport({
      roomId: message.roomId,
      pipeTransportId: message.pipeTransportId,
      ownerNodeId: message.ownerNodeId,
      remoteNodeId: message.remoteNodeId,
      protocol: message.protocol,
      remoteEndpoint: message.remote,
      peerToken: message.peerToken
    });
  }

  private async handlePublishRequest(message: PipePublishRequestMessage): Promise<void> {
    this.assertPipeMediaSupported('pipe:publish:request');
    this.assertPeerAllowed(message.remoteNodeId);
    const publicationKey = remotePublishedProducerKey(message.roomId, message.ownerNodeId, message.remoteNodeId, message.producerId);
    if (this.ownerPublishedProducers.has(publicationKey)) {
      return;
    }
    if (!this.pipeStates.get(message.pipeTransportId)?.remoteEndpoint) {
      await this.createPipe({
        targetNodeId: message.remoteNodeId,
        roomId: message.roomId,
        pipeTransportId: message.pipeTransportId,
        remoteNodeId: message.remoteNodeId,
        protocol: message.protocol
      });
    }
    await this.handleProducerCreate({
      type: 'pipe:producer:create',
      roomId: message.roomId,
      pipeTransportId: message.pipeTransportId,
      ownerClaimedAt: message.ownerClaimedAt,
      producerId: message.producerId,
      participantId: message.participantId,
      kind: message.kind,
      rtpParameters: message.rtpParameters,
      status: message.status,
      priority: message.priority
    });
    const pipeConsumerId = remotePublishPipeConsumerId(message.producerId, message.remoteNodeId);
    await this.publish(message.remoteNodeId, {
      type: 'pipe:consumer:create',
      roomId: message.roomId,
      pipeTransportId: message.pipeTransportId,
      ownerClaimedAt: message.ownerClaimedAt,
      consumerId: pipeConsumerId,
      producerId: message.producerId,
      participantId: `pipe:${message.ownerNodeId}`,
      rtpParameters: message.rtpParameters
    });
    this.ownerPublishedProducers.set(publicationKey, {
      roomId: message.roomId,
      pipeTransportId: message.pipeTransportId,
      ownerNodeId: message.ownerNodeId,
      ownerClaimedAt: message.ownerClaimedAt ?? '',
      remoteNodeId: message.remoteNodeId,
      producerId: message.producerId,
      participantId: message.participantId,
      kind: message.kind,
      priority: message.priority,
      status: message.status,
      pipeConsumerId,
      proxyProducerId: message.producerId,
      protocol: message.protocol,
      createdAt: new Date().toISOString()
    });
  }

  private async handleFeedRequest(message: PipeFeedRequestMessage): Promise<void> {
    this.assertPipeMediaSupported('pipe:feed:request');
    this.assertPeerAllowed(message.remoteNodeId);
    const producer = this.media?.getProducer?.(message.producerId);
    if (!producer || producer.roomId !== message.roomId || producer.status === 'closed') {
      throw new Error(`Producer ${message.producerId} is not available on owner node`);
    }
    const feedKey = remoteFeedKey(message.roomId, message.ownerNodeId, message.remoteNodeId, message.producerId);
    const existing = this.ownerFeeds.get(feedKey);
    if (existing) {
      existing.references += 1;
      return;
    }
    const protocol = message.protocol;
    const pipeTransportId = message.pipeTransportId;
    if (!this.pipeStates.get(pipeTransportId)?.remoteEndpoint) {
      await this.createPipe({
        targetNodeId: message.remoteNodeId,
        roomId: message.roomId,
        pipeTransportId,
        remoteNodeId: message.remoteNodeId,
        protocol
      });
    }
    const pipeConsumerId = ownerPipeConsumerId(message.producerId, message.remoteNodeId);
    const pipeConsumerMessage: PipeConsumerCreateMessage = {
      type: 'pipe:consumer:create',
      roomId: message.roomId,
      pipeTransportId,
      ownerClaimedAt: message.ownerClaimedAt,
      consumerId: pipeConsumerId,
      producerId: message.producerId,
      participantId: `pipe:${message.remoteNodeId}`,
      rtpParameters: producer.rtpParameters
    };
    await this.handleConsumerCreate(pipeConsumerMessage);
    await this.publish(message.remoteNodeId, {
      type: 'pipe:producer:create',
      roomId: message.roomId,
      pipeTransportId,
      ownerClaimedAt: message.ownerClaimedAt,
      producerId: message.producerId,
      participantId: producer.participantId,
      kind: producer.kind,
      rtpParameters: producer.rtpParameters
    });
    this.ownerFeeds.set(feedKey, {
      roomId: message.roomId,
      pipeTransportId,
      ownerNodeId: message.ownerNodeId,
      ownerClaimedAt: message.ownerClaimedAt ?? '',
      remoteNodeId: message.remoteNodeId,
      producerId: message.producerId,
      proxyProducerId: message.producerId,
      pipeConsumerId,
      protocol,
      references: 1,
      createdAt: new Date().toISOString()
    });
  }

  private async handlePublishRelease(message: PipePublishReleaseMessage): Promise<void> {
    const publicationKey = remotePublishedProducerKey(message.roomId, message.ownerNodeId, message.remoteNodeId, message.producerId);
    const state = this.ownerPublishedProducers.get(publicationKey);
    if (!state) {
      return;
    }
    this.ownerPublishedProducers.delete(publicationKey);
    const dependentFeeds = [...this.ownerFeeds.entries()].filter(([, feed]) => feed.producerId === state.producerId);
    await this.handleProducerClose({
      type: 'pipe:producer:close',
      roomId: state.roomId,
      pipeTransportId: state.pipeTransportId,
      ownerClaimedAt: state.ownerClaimedAt,
      producerId: state.proxyProducerId,
      reason: 'producer_closed'
    });
    await this.publish(state.remoteNodeId, {
      type: 'pipe:consumer:close',
      roomId: state.roomId,
      pipeTransportId: state.pipeTransportId,
      ownerClaimedAt: state.ownerClaimedAt,
      consumerId: state.pipeConsumerId,
      producerId: state.producerId,
      reason: 'producer_closed'
    });
    for (const [feedKey, feed] of dependentFeeds) {
      this.ownerFeeds.delete(feedKey);
      await this.handleConsumerClose({
        type: 'pipe:consumer:close',
        roomId: feed.roomId,
        pipeTransportId: feed.pipeTransportId,
        ownerClaimedAt: feed.ownerClaimedAt,
        consumerId: feed.pipeConsumerId,
        producerId: feed.producerId,
        reason: 'producer_closed'
      });
      await this.publish(feed.remoteNodeId, {
        type: 'pipe:producer:close',
        roomId: feed.roomId,
        pipeTransportId: feed.pipeTransportId,
        ownerClaimedAt: feed.ownerClaimedAt,
        producerId: feed.proxyProducerId,
        reason: 'producer_closed'
      });
    }
  }

  private async handleFeedRelease(message: PipeFeedReleaseMessage): Promise<void> {
    const feedKey = remoteFeedKey(message.roomId, message.ownerNodeId, message.remoteNodeId, message.producerId);
    const state = this.ownerFeeds.get(feedKey);
    if (!state) {
      return;
    }
    state.references = Math.max(0, state.references - 1);
    if (state.references > 0) {
      return;
    }
    this.ownerFeeds.delete(feedKey);
    await this.handleConsumerClose({
      type: 'pipe:consumer:close',
      roomId: state.roomId,
      pipeTransportId: state.pipeTransportId,
      ownerClaimedAt: state.ownerClaimedAt,
      consumerId: state.pipeConsumerId,
      producerId: state.producerId,
      reason: 'consumer_closed'
    });
    await this.publish(state.remoteNodeId, {
      type: 'pipe:producer:close',
      roomId: state.roomId,
      pipeTransportId: state.pipeTransportId,
      ownerClaimedAt: state.ownerClaimedAt,
      producerId: state.proxyProducerId,
      reason: 'consumer_closed'
    });
  }

  private async handleProducerCreate(message: PipeProducerCreateMessage): Promise<void> {
    await this.ensureImplicitPipeTransport(message);
    this.pipe.createProducer(message.pipeTransportId, {
      id: message.producerId,
      participantId: message.participantId,
      rtpParameters: message.rtpParameters,
      ssrcMappings: message.ssrcMappings
    });
    this.pipeProducers.set(producerKey(message.pipeTransportId, message.producerId), message);
    await this.media?.registerPipeProducer?.(
      {
        id: message.producerId,
        roomId: message.roomId,
        participantId: message.participantId,
        kind: message.kind,
        transportId: message.pipeTransportId,
        priority: message.priority,
        rtpParameters: message.rtpParameters,
        status: message.status ?? 'live',
        createdAt: new Date().toISOString()
      },
      message.pipeTransportId
    );
    if (message.status === 'paused') {
      await this.media?.setProducerPaused?.(message.producerId, true);
    }
    if (typeof message.priority === 'number') {
      this.media?.setProducerPriority?.(message.producerId, message.priority);
    }
  }

  private async handleProducerState(message: PipeProducerStateMessage): Promise<void> {
    if (message.status) {
      await this.media?.setProducerPaused?.(message.producerId, message.status === 'paused');
    }
    if (typeof message.priority === 'number') {
      this.media?.setProducerPriority?.(message.producerId, message.priority);
    }
  }

  private async handleProducerClose(message: PipeProducerCloseMessage): Promise<void> {
    this.pipe.closeProducer(message.pipeTransportId, message.producerId);
    this.pipeProducers.delete(producerKey(message.pipeTransportId, message.producerId));
    await this.media?.unregisterProducer?.(message.producerId);
  }

  private async handleConsumerCreate(message: PipeConsumerCreateMessage): Promise<void> {
    await this.ensureImplicitPipeTransport(message);
    this.pipe.createConsumer(message.pipeTransportId, {
      id: message.consumerId,
      producerId: message.producerId,
      participantId: message.participantId,
      rtpParameters: message.rtpParameters,
      ssrcMappings: message.ssrcMappings
    });
    this.pipeConsumers.set(consumerKey(message.pipeTransportId, message.consumerId), message);
    await this.media?.registerPipeConsumer?.(
      {
        id: message.consumerId,
        producerId: message.producerId,
        participantId: message.participantId,
        roomId: message.roomId,
        transportId: message.pipeTransportId,
        rtpParameters: message.rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      },
      message.pipeTransportId
    );
  }

  private async handleConsumerClose(message: PipeConsumerCloseMessage): Promise<void> {
    this.pipe.closeConsumer(message.pipeTransportId, message.consumerId);
    this.pipeConsumers.delete(consumerKey(message.pipeTransportId, message.consumerId));
    await this.media?.unregisterConsumer?.(message.consumerId);
  }

  private handleClose(message: PipeCloseMessage): void {
    this.pipe.closeTransport(message.pipeTransportId, message.reason ?? 'manual');
    void this.media?.closePipeTransport?.(message.pipeTransportId);
    this.pipeStates.delete(message.pipeTransportId);
    for (const key of [...this.pipeProducers.keys()]) {
      if (key.startsWith(`${message.pipeTransportId}:`)) {
        this.pipeProducers.delete(key);
      }
    }
    for (const key of [...this.pipeConsumers.keys()]) {
      if (key.startsWith(`${message.pipeTransportId}:`)) {
        this.pipeConsumers.delete(key);
      }
    }
    for (const [key, state] of this.ownerFeeds) {
      if (state.pipeTransportId === message.pipeTransportId) {
        this.ownerFeeds.delete(key);
      }
    }
    for (const [key, state] of this.remoteFeeds) {
      if (state.pipeTransportId === message.pipeTransportId) {
        this.remoteFeeds.delete(key);
      }
    }
    for (const [key, state] of this.ownerPublishedProducers) {
      if (state.pipeTransportId === message.pipeTransportId) {
        this.ownerPublishedProducers.delete(key);
      }
    }
    for (const [producerId, state] of this.remotePublishedProducers) {
      if (state.pipeTransportId === message.pipeTransportId) {
        this.remotePublishedProducers.delete(producerId);
      }
    }
    this.metrics.pipeTeardowns.labels(message.reason ?? 'manual').inc();
  }

  private async handleRtcp(message: PipeRtcpMessage): Promise<void> {
    const packet = Buffer.from(message.packetBase64, 'base64');
    if (typeof this.media?.handlePipeRtcp === 'function') {
      const result = await this.media.handlePipeRtcp(message.pipeTransportId, packet, { roomId: message.roomId });
      const forwarded = typeof result === 'object' && result && 'forwarded' in result && typeof result.forwarded === 'number' ? result.forwarded : 0;
      if (forwarded > 0) {
        this.metrics.pipeRtcpForwarded.labels(message.direction).inc(forwarded);
      }
    }
    this.metrics.pipeRtcpPackets.labels(message.direction === 'owner-to-remote' ? 'received' : 'sent').inc();
    this.metrics.pipeRtcpBytes.labels(message.direction === 'owner-to-remote' ? 'received' : 'sent').inc(packet.length);
  }

  private handleStats(message: PipeStatsMessage): void {
    this.metrics.pipePacketLoss.labels(message.pipeTransportId).set(message.packetLoss ?? 0);
    this.metrics.pipeJitter.labels(message.pipeTransportId).set(message.jitterMs ?? 0);
    this.metrics.pipeRtt.labels(message.pipeTransportId).set(message.rttMs ?? 0);
  }

  private handleAck(envelope: PipeCoordinationEnvelope<PipeAckMessage>): void {
    const ack = envelope.payload;
    const pending = this.pendingRequests.get(ack.requestCorrelationId);
    if (!pending) {
      const settled = this.settledRequests.get(ack.requestCorrelationId);
      if (!settled) {
        this.metrics.controlPlaneDuplicateSuppressions.labels('pipe_coordination', 'unknown_ack').inc();
        return;
      }
      if (settled.status === 'ok') {
        this.metrics.controlPlaneDuplicateSuppressions.labels('pipe_coordination', 'ack_after_settle').inc();
        return;
      }
      if (ack.ok) {
        this.metrics.controlPlaneDuplicateSuppressions.labels('pipe_coordination', 'late_success_ack').inc();
        void this.cleanupLateSuccessfulAck(settled.envelope, envelope.sourceNodeId);
        return;
      }
      this.metrics.controlPlaneDuplicateSuppressions.labels('pipe_coordination', 'late_error_ack').inc();
      return;
    }
    if (pending.baseEnvelope.targetNodeId !== envelope.sourceNodeId || commandKey(pending.baseEnvelope) !== ack.idempotencyKey || pending.baseEnvelope.type !== ack.requestType) {
      this.reject('unauthorized');
      return;
    }
    if (ack.ok) {
      this.settlePendingRequest(pending, ack);
      return;
    }
    const code = ack.code ?? 'transport_error';
    this.reject(code);
    this.settlePendingRequest(pending, undefined, this.pipeCoordinationError(code, ack.message ?? `Pipe coordination ${ack.requestType} failed`, ack.requestCorrelationId));
  }

  private validateTargetedEnvelope(envelope: PipeCoordinationEnvelope): PipeCoordinatorValidation {
    if (!isPipeEnvelope(envelope)) {
      return { ok: false, code: 'invalid_message', message: 'Invalid pipe envelope', reply: false, countRejection: true };
    }
    if (envelope.targetNodeId !== this.registry.localNodeId()) {
      return { ok: false, code: 'unknown_node', message: 'Envelope targets another node', reply: false, countRejection: false };
    }
    if (!this.verifyEnvelope(envelope)) {
      return { ok: false, code: 'unauthorized', message: 'Invalid pipe coordination signature', reply: true, countRejection: true };
    }
    const age = Date.now() - Date.parse(envelope.sentAt);
    if (!Number.isFinite(age) || age > this.coordinationTimeoutMs) {
      return { ok: false, code: 'timeout', message: 'Pipe command timed out before delivery', reply: true, countRejection: true };
    }
    return { ok: true };
  }

  private async validateCommandEnvelope(envelope: PipeCommandEnvelope): Promise<PipeCoordinatorValidation> {
    const lookup = await this.registry.lookupRoomOwner(envelope.payload.roomId);
    if (!lookup.owner) {
      return { ok: false, code: 'owner_mismatch', message: `Room owner is missing: ${lookup.reason ?? 'missing'}`, reply: true, countRejection: true };
    }
    if (!lookup.available) {
      return { ok: false, code: 'owner_mismatch', message: `Room owner is unavailable: ${lookup.reason ?? 'unavailable'}`, reply: true, countRejection: true };
    }
    if (requiresOwnerFence(envelope.payload) && envelope.payload.ownerClaimedAt !== lookup.owner.claimedAt) {
      return { ok: false, code: 'owner_mismatch', message: 'Pipe command owner claim timestamp does not match the current room owner', reply: true, countRejection: true };
    }
    const ownerNodeId = lookup.owner.nodeId;
    if (isOwnerIssuedMessage(envelope.payload)) {
      if (envelope.sourceNodeId !== ownerNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Pipe command was not issued by the current room owner', reply: true, countRejection: true };
      }
      if (envelope.payload.type === 'pipe:create' && envelope.payload.ownerNodeId !== ownerNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Pipe create owner does not match current room owner', reply: true, countRejection: true };
      }
      if (envelope.payload.type === 'pipe:create' && envelope.payload.remoteNodeId !== envelope.targetNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Pipe create target does not match remote node', reply: true, countRejection: true };
      }
      return { ok: true };
    }
    if (envelope.payload.type === 'pipe:feed:request' || envelope.payload.type === 'pipe:feed:release') {
      if (envelope.targetNodeId !== ownerNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Remote feed command must target the current room owner', reply: true, countRejection: true };
      }
      if (envelope.payload.ownerNodeId !== ownerNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Remote feed command owner does not match the current room owner', reply: true, countRejection: true };
      }
      if (envelope.payload.remoteNodeId !== envelope.sourceNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Remote feed command source node does not match its declared remote node', reply: true, countRejection: true };
      }
      return { ok: true };
    }
    if (
      envelope.payload.type === 'pipe:publish:request' ||
      envelope.payload.type === 'pipe:publish:release' ||
      envelope.payload.type === 'pipe:producer:state'
    ) {
      if (envelope.targetNodeId !== ownerNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Remote publish command must target the current room owner', reply: true, countRejection: true };
      }
      if (envelope.payload.ownerNodeId !== ownerNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Remote publish command owner does not match the current room owner', reply: true, countRejection: true };
      }
      if (envelope.payload.remoteNodeId !== envelope.sourceNodeId) {
        return { ok: false, code: 'owner_mismatch', message: 'Remote publish command source node does not match its declared remote node', reply: true, countRejection: true };
      }
      return { ok: true };
    }
    if (envelope.sourceNodeId !== ownerNodeId && envelope.targetNodeId !== ownerNodeId) {
      return { ok: false, code: 'owner_mismatch', message: 'Pipe command does not involve the current room owner', reply: true, countRejection: true };
    }
    return { ok: true };
  }

  private createEnvelope<T extends PipeCoordinationMessage>(targetNodeId: string, payload: T): PipeCoordinationEnvelope<T> {
    const correlationId = randomUUID();
    const envelope: PipeCoordinationEnvelope<T> = {
      type: payload.type,
      correlationId,
      idempotencyKey: correlationId,
      attempt: 0,
      sourceNodeId: this.registry.localNodeId(),
      targetNodeId,
      sentAt: new Date().toISOString(),
      payload
    };
    envelope.auth = this.signEnvelope(envelope);
    return envelope;
  }

  private refreshEnvelope<T extends PipeCoordinationMessage>(envelope: PipeCoordinationEnvelope<T>, attempt: number): PipeCoordinationEnvelope<T> {
    const refreshed: PipeCoordinationEnvelope<T> = {
      ...envelope,
      attempt,
      sentAt: new Date().toISOString(),
      auth: undefined
    };
    refreshed.auth = this.signEnvelope(refreshed);
    return refreshed;
  }

  private signEnvelope(envelope: Omit<PipeCoordinationEnvelope, 'auth'> | PipeCoordinationEnvelope): NonNullable<PipeCoordinationEnvelope['auth']> {
    this.assertClusterSecret();
    const nonce = randomUUID();
    const issuedAt = new Date().toISOString();
    return {
      nonce,
      issuedAt,
      signature: this.signature({ ...envelope, auth: undefined }, nonce, issuedAt)
    };
  }

  private verifyEnvelope(envelope: PipeCoordinationEnvelope): boolean {
    if (!envelope.auth) {
      return false;
    }
    this.assertClusterSecret();
    const expected = this.signature({ ...envelope, auth: undefined }, envelope.auth.nonce, envelope.auth.issuedAt);
    return timingSafeStringEqual(expected, envelope.auth.signature);
  }

  private signature(envelope: Omit<PipeCoordinationEnvelope, 'auth'> | PipeCoordinationEnvelope, nonce: string, issuedAt: string): string {
    return createHmac('sha256', this.clusterSecret!)
      .update(
        JSON.stringify({
          version: PIPE_PROTOCOL_VERSION,
          nonce,
          issuedAt,
          type: envelope.type,
          correlationId: envelope.correlationId,
          idempotencyKey: envelope.idempotencyKey,
          attempt: envelope.attempt,
          sourceNodeId: envelope.sourceNodeId,
          targetNodeId: envelope.targetNodeId,
          sentAt: envelope.sentAt,
          payload: envelope.payload
        })
      )
      .digest('hex');
  }

  private async publishWithAck<T extends PipeCoordinationMessage>(envelope: PipeCoordinationEnvelope<T>): Promise<PipeAckMessage> {
    return new Promise<PipeAckMessage>((resolve, reject) => {
      const pending: PendingPipeRequest<T> = {
        baseEnvelope: envelope,
        attempts: 0,
        settled: false,
        resolve,
        reject,
        send: () => undefined
      };
      pending.send = () => {
        void this.publishPendingAttempt(pending).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.reject('transport_error');
          this.settlePendingRequest(pending, undefined, this.pipeCoordinationError('transport_error', message, pending.baseEnvelope.correlationId));
        });
      };
      this.pendingRequests.set(envelope.correlationId, pending as PendingPipeRequest);
      pending.send();
    });
  }

  private async publishPendingAttempt<T extends PipeCoordinationMessage>(pending: PendingPipeRequest<T>): Promise<void> {
    if (pending.settled) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    pending.attempts += 1;
    if (pending.attempts > 1) {
      this.metrics.pipeCoordinationRetries.labels(pending.baseEnvelope.type).inc();
    }
    const attemptEnvelope = this.refreshEnvelope(pending.baseEnvelope, pending.attempts);
    try {
      await this.publishEnvelope(attemptEnvelope);
    } catch (error) {
      if (pending.attempts >= this.coordinationMaxAttempts) {
        const message = error instanceof Error ? error.message : String(error);
        this.reject('transport_error');
        this.settlePendingRequest(pending, undefined, this.pipeCoordinationError('transport_error', message, pending.baseEnvelope.correlationId));
        return;
      }
      pending.send();
      return;
    }
    pending.timer = setTimeout(() => {
      if (pending.settled) {
        return;
      }
      if (pending.attempts >= this.coordinationMaxAttempts) {
        this.reject('timeout');
        this.metrics.pipeCoordinationTimeouts.labels(pending.baseEnvelope.type).inc();
        this.settlePendingRequest(
          pending,
          undefined,
          this.pipeCoordinationError('timeout', `Pipe coordination ${pending.baseEnvelope.type} timed out`, pending.baseEnvelope.correlationId)
        );
        return;
      }
      pending.send();
    }, this.coordinationTimeoutMs);
  }

  private settlePendingRequest(pending: PendingPipeRequest, ack?: PipeAckMessage, error?: unknown): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.pendingRequests.delete(pending.baseEnvelope.correlationId);
    this.rememberSettledRequest(pending.baseEnvelope, error ? 'error' : 'ok');
    if (error) {
      pending.reject(error);
      return;
    }
    pending.resolve(ack!);
  }

  private async publishEnvelope<T extends PipeCoordinationMessage>(envelope: PipeCoordinationEnvelope<T>): Promise<void> {
    try {
      await this.redis.publishDurable(PIPE_STREAM, envelope);
      this.metrics.controlPlaneMessagesPublished.labels('pipe_coordination').inc();
    } catch (error) {
      this.metrics.controlPlanePublishFailures.labels('pipe_coordination').inc();
      throw error;
    }
  }

  private async publishAck(envelope: PipeCommandEnvelope, ack: PipeAckMessage): Promise<void> {
    const response = this.createEnvelope(envelope.sourceNodeId, ack);
    await this.publishEnvelope(response).catch((error) => {
      this.logger.warn(`Pipe ack ${ack.requestCorrelationId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private createAck(envelope: PipeCommandEnvelope, ok: true): PipeAckMessage;
  private createAck(envelope: PipeCommandEnvelope, ok: false, code: PipeErrorCode, message: string): PipeAckMessage;
  private createAck(envelope: PipeCommandEnvelope, ok: boolean, code?: PipeErrorCode, message?: string): PipeAckMessage {
    const metadata =
      ok && envelope.payload.type === 'pipe:create'
        ? {
            protocol: envelope.payload.protocol,
            localEndpoint: this.pipeStates.get(envelope.payload.pipeTransportId)?.localEndpoint
          }
        : undefined;
    return {
      type: 'pipe:ack',
      roomId: envelope.payload.roomId,
      pipeTransportId: envelope.payload.pipeTransportId,
      ok,
      requestType: envelope.payload.type,
      requestCorrelationId: envelope.correlationId,
      idempotencyKey: commandKey(envelope),
      code,
      message,
      metadata
    };
  }

  private cloneAckForEnvelope(envelope: PipeCommandEnvelope, ack: PipeAckMessage, duplicate: boolean): PipeAckMessage {
    return {
      ...ack,
      roomId: envelope.payload.roomId,
      pipeTransportId: envelope.payload.pipeTransportId,
      requestType: envelope.payload.type,
      requestCorrelationId: envelope.correlationId,
      idempotencyKey: commandKey(envelope),
      duplicate
    };
  }

  private async rememberCommandResult(idempotencyKey: string, ack: PipeAckMessage): Promise<void> {
    if (this.processedCommands.has(idempotencyKey)) {
      this.processedCommands.set(idempotencyKey, ack);
      await this.redis.setJson(processedCommandRedisKey(idempotencyKey), ack, PROCESSED_COMMAND_TTL_SECONDS);
      return;
    }
    if (this.processedCommands.size >= PROCESSED_COMMAND_CACHE_LIMIT) {
      const oldestKey = this.processedCommands.keys().next().value as string | undefined;
      if (oldestKey) {
        this.processedCommands.delete(oldestKey);
      }
    }
    this.processedCommands.set(idempotencyKey, ack);
    await this.redis.setJson(processedCommandRedisKey(idempotencyKey), ack, PROCESSED_COMMAND_TTL_SECONDS);
  }

  private async restoreCommandResult(idempotencyKey: string): Promise<PipeAckMessage | undefined> {
    if (this.processedCommands.has(idempotencyKey)) {
      return this.processedCommands.get(idempotencyKey);
    }
    const cached = await this.redis.getJson<PipeAckMessage>(processedCommandRedisKey(idempotencyKey));
    if (cached) {
      this.processedCommands.set(idempotencyKey, cached);
    }
    return cached ?? undefined;
  }

  private rememberSettledRequest(envelope: PipeCoordinationEnvelope<PipeCoordinationMessage>, status: 'ok' | 'error'): void {
    if (!this.settledRequests.has(envelope.correlationId) && this.settledRequests.size >= SETTLED_REQUEST_CACHE_LIMIT) {
      const oldestKey = this.settledRequests.keys().next().value as string | undefined;
      if (oldestKey) {
        this.settledRequests.delete(oldestKey);
      }
    }
    this.settledRequests.set(envelope.correlationId, { status, envelope });
  }

  private async cleanupLateSuccessfulAck(
    envelope: PipeCoordinationEnvelope<PipeCoordinationMessage>,
    sourceNodeId: string
  ): Promise<void> {
    const payload = envelope.payload;
    if (payload.type === 'pipe:create') {
      this.pipe.closeTransport(payload.pipeTransportId, 'stale_ack');
      this.pipeStates.delete(payload.pipeTransportId);
      await this.publish(sourceNodeId, {
        type: 'pipe:close',
        roomId: payload.roomId,
        pipeTransportId: payload.pipeTransportId,
        ownerClaimedAt: payload.ownerClaimedAt,
        reason: 'stale_ack'
      }).catch(() => undefined);
      return;
    }
    if (payload.type === 'pipe:producer:create') {
      await this.publish(sourceNodeId, {
        type: 'pipe:producer:close',
        roomId: payload.roomId,
        pipeTransportId: payload.pipeTransportId,
        ownerClaimedAt: payload.ownerClaimedAt,
        producerId: payload.producerId,
        reason: 'stale_ack'
      }).catch(() => undefined);
      return;
    }
    if (payload.type === 'pipe:consumer:create') {
      await this.publish(sourceNodeId, {
        type: 'pipe:consumer:close',
        roomId: payload.roomId,
        pipeTransportId: payload.pipeTransportId,
        ownerClaimedAt: payload.ownerClaimedAt,
        consumerId: payload.consumerId,
        producerId: payload.producerId,
        reason: 'stale_ack'
      }).catch(() => undefined);
      return;
    }
    if (payload.type === 'pipe:feed:request') {
      await this.publish(sourceNodeId, {
        type: 'pipe:feed:release',
        roomId: payload.roomId,
        pipeTransportId: payload.pipeTransportId,
        ownerClaimedAt: payload.ownerClaimedAt,
        ownerNodeId: payload.ownerNodeId,
        remoteNodeId: payload.remoteNodeId,
        producerId: payload.producerId,
        reason: 'stale_ack'
      }).catch(() => undefined);
      return;
    }
    if (payload.type === 'pipe:publish:request') {
      await this.publish(sourceNodeId, {
        type: 'pipe:publish:release',
        roomId: payload.roomId,
        pipeTransportId: payload.pipeTransportId,
        ownerClaimedAt: payload.ownerClaimedAt,
        ownerNodeId: payload.ownerNodeId,
        remoteNodeId: payload.remoteNodeId,
        producerId: payload.producerId,
        reason: 'stale_ack'
      }).catch(() => undefined);
    }
  }

  private assertPipeMediaSupported(operation: string): void {
    void operation;
  }

  private assertPeerAllowed(nodeId: string): void {
    if (this.allowedNodeIds.size === 0 || this.allowedNodeIds.has(nodeId)) {
      return;
    }
    this.metrics.pipePeerAdmissionFailures.labels('not_allowlisted').inc();
    this.reject('peer_admission_failed');
    throw new ForbiddenException(`Pipe peer ${nodeId} is not allowlisted`);
  }

  private preferredPipeProtocol(): PipeTransportProtocol {
    return this.config.get<string>('pipe.advertiseIp') ? 'udp' : 'internal';
  }

  private async ensureLocalPipeTransport(options: {
    roomId: string;
    pipeTransportId: string;
    ownerNodeId: string;
    remoteNodeId: string;
    protocol: PipeTransportProtocol;
    remoteEndpoint?: PipeNodeEndpoint;
    peerToken?: string;
  }): Promise<PipeTransportState> {
    const existing = this.pipeStates.get(options.pipeTransportId);
    if (existing) {
      if (options.remoteEndpoint) {
        existing.remoteEndpoint = options.remoteEndpoint;
        if (existing.protocol === 'udp') {
          this.pipe.connectUdpTransport(options.pipeTransportId, toUdpRemoteEndpoint(options.remoteEndpoint));
        }
      }
      return existing;
    }
    if (options.protocol === 'udp') {
      const transport = this.pipe.createUdpTransport({
        id: options.pipeTransportId,
        roomId: options.roomId,
        localNodeId: this.registry.localNodeId(),
        remoteNodeId: options.ownerNodeId === this.registry.localNodeId() ? options.remoteNodeId : options.ownerNodeId,
        listenPort: this.allocateUdpPort(),
        advertisedIp: this.config.get<string>('pipe.advertiseIp'),
        peerToken: options.peerToken,
        authMode: options.peerToken ? 'token' : 'transport-id'
      });
      let localEndpoint;
      try {
        localEndpoint = await this.pipe.listenUdpTransport(transport.id);
      } catch (error) {
        await this.pipe.closeUdpTransport(transport.id, 'error');
        this.metrics.pipeUdpSetupFailures.labels('listen_failed').inc();
        throw error;
      }
      const state: PipeTransportState = {
        roomId: options.roomId,
        ownerNodeId: options.ownerNodeId,
        remoteNodeId: options.remoteNodeId,
        protocol: options.protocol,
        peerToken: options.peerToken,
        localEndpoint: {
          nodeId: localEndpoint.nodeId,
          advertiseIp: localEndpoint.advertisedIp,
          port: localEndpoint.advertisedPort
        },
        remoteEndpoint: options.remoteEndpoint,
        listenersAttached: false
      };
      this.pipeStates.set(options.pipeTransportId, state);
      if (options.remoteEndpoint) {
        this.pipe.connectUdpTransport(options.pipeTransportId, toUdpRemoteEndpoint(options.remoteEndpoint));
      }
      this.attachUdpListeners(options.pipeTransportId, state);
      this.metrics.pipeTransportsCreated.labels('udp').inc();
      return state;
    }
    this.pipe.createTransport({
      id: options.pipeTransportId,
      roomId: options.roomId,
      localNodeId: this.registry.localNodeId(),
      remoteNodeId: options.ownerNodeId === this.registry.localNodeId() ? options.remoteNodeId : options.ownerNodeId
    });
    const state: PipeTransportState = {
      roomId: options.roomId,
      ownerNodeId: options.ownerNodeId,
      remoteNodeId: options.remoteNodeId,
      protocol: options.protocol,
      peerToken: options.peerToken,
      remoteEndpoint: options.remoteEndpoint,
      listenersAttached: true
    };
    this.pipeStates.set(options.pipeTransportId, state);
    this.metrics.pipeTransportsCreated.labels('internal').inc();
    return state;
  }

  private async finalizePipeTransportFromAck(message: PipeCreateMessage, ack: PipeAckMessage): Promise<void> {
    if (message.protocol !== 'udp') {
      return;
    }
    const remoteEndpoint = ack.metadata?.localEndpoint;
    if (!remoteEndpoint) {
      this.metrics.pipeUdpSetupFailures.labels('missing_remote_endpoint').inc();
      this.pipe.closeTransport(message.pipeTransportId, 'error');
      throw new ServiceUnavailableException('UDP pipe setup acknowledgement did not include a remote endpoint');
    }
    const state = this.pipeStates.get(message.pipeTransportId);
    if (!state) {
      this.metrics.pipeUdpSetupFailures.labels('missing_local_state').inc();
      throw new ServiceUnavailableException('UDP pipe setup local state was not found');
    }
    state.remoteEndpoint = remoteEndpoint;
    this.pipe.connectUdpTransport(message.pipeTransportId, toUdpRemoteEndpoint(remoteEndpoint));
    this.metrics.pipeUdpSetupSuccess.inc();
  }

  private attachUdpListeners(pipeTransportId: string, state: PipeTransportState): void {
    if (state.listenersAttached) {
      return;
    }
    this.pipe.onUdpRtp(pipeTransportId, (event) => {
      this.metrics.pipeRtpPackets.labels('received').inc();
      this.metrics.pipeRtpBytes.labels('received').inc(event.packet.length);
      void this.media?.handlePipeRtp?.(pipeTransportId, event.producerId, event.packet);
    });
    this.pipe.onUdpRtcp(pipeTransportId, (event) => {
      this.metrics.pipeRtcpPackets.labels('received').inc();
      this.metrics.pipeRtcpBytes.labels('received').inc(event.packet.length);
      void this.media?.handlePipeRtcp?.(pipeTransportId, event.packet, { roomId: event.roomId });
    });
    state.listenersAttached = true;
  }

  private async ensureImplicitPipeTransport(message: PipeProducerCreateMessage | PipeConsumerCreateMessage): Promise<void> {
    if (this.pipeStates.has(message.pipeTransportId) || this.pipe.hasTransport(message.pipeTransportId)) {
      return;
    }
    await this.ensureLocalPipeTransport({
      roomId: message.roomId,
      pipeTransportId: message.pipeTransportId,
      ownerNodeId: this.registry.localNodeId(),
      remoteNodeId: this.registry.localNodeId(),
      protocol: 'internal'
    });
  }

  private allocateUdpPort(): number {
    const port = this.nextUdpPort;
    this.nextUdpPort += 1;
    if (this.nextUdpPort > this.pipePortRange.max) {
      this.nextUdpPort = this.pipePortRange.min;
    }
    return port;
  }

  private async assertRoomOwner(roomId: string): Promise<{ nodeId: string; claimedAt: string }> {
    const lookup = await this.registry.lookupRoomOwner(roomId);
    if (!lookup.owner || !lookup.available || lookup.owner.nodeId !== this.registry.localNodeId()) {
      throw new ForbiddenException('Only the current room owner can create pipe transports');
    }
    return { nodeId: lookup.owner.nodeId, claimedAt: lookup.owner.claimedAt };
  }

  private pipeCoordinationError(code: PipeErrorCode, message: string, correlationId: string): ServiceUnavailableException {
    return new ServiceUnavailableException({ code, message, correlationId }, message);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      this.reject('disabled');
      throw new ServiceUnavailableException('Pipe transport is disabled');
    }
    this.assertClusterSecret();
  }

  private assertClusterSecret(): void {
    if (!this.clusterSecret || this.clusterSecret.length < 24) {
      throw new ServiceUnavailableException('Pipe transport requires PIPE_CLUSTER_SECRET');
    }
  }

  private reserveSetupRequest(): boolean {
    const now = Date.now();
    if (now - this.setupWindowStartedAt >= 60_000) {
      this.setupWindowStartedAt = now;
      this.setupRequestsInWindow = 0;
    }
    this.setupRequestsInWindow += 1;
    return this.setupRequestsInWindow <= this.maxSetupRequestsPerMinute;
  }

  private reject(code: PipeErrorCode): void {
    this.rejectedRequests += 1;
    this.metrics.pipeErrors.labels(code).inc();
  }
}

function isPipeEnvelope(value: unknown): value is PipeCoordinationEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const envelope = value as PipeCoordinationEnvelope;
  return (
    typeof envelope.type === 'string' &&
    typeof envelope.correlationId === 'string' &&
    typeof envelope.sourceNodeId === 'string' &&
    typeof envelope.targetNodeId === 'string' &&
    typeof envelope.sentAt === 'string' &&
    Boolean(envelope.payload) &&
    envelope.type === envelope.payload.type &&
    typeof envelope.payload.roomId === 'string' &&
    typeof envelope.payload.pipeTransportId === 'string'
  );
}

function isAckMessage(message: PipeCoordinationMessage): message is PipeAckMessage {
  return (
    message.type === 'pipe:ack' &&
    typeof message.requestCorrelationId === 'string' &&
    typeof message.idempotencyKey === 'string' &&
    typeof message.requestType === 'string'
  );
}

function isSetupMessage(message: PipeCommandMessage): boolean {
  return (
    message.type === 'pipe:create' ||
    message.type === 'pipe:publish:request' ||
    message.type === 'pipe:feed:request' ||
    message.type === 'pipe:producer:create' ||
    message.type === 'pipe:consumer:create'
  );
}

function requiresOwnerFence(message: PipeCommandMessage): boolean {
  return message.type !== 'pipe:error' && message.type !== 'pipe:stats';
}

function processedCommandRedisKey(idempotencyKey: string): string {
  return `sfu:pipe-coordination:processed:${idempotencyKey}`;
}

function isOwnerIssuedMessage(message: PipeCommandMessage): boolean {
  return (
    message.type === 'pipe:create' ||
    message.type === 'pipe:close' ||
    message.type === 'pipe:producer:create' ||
    message.type === 'pipe:producer:close' ||
    message.type === 'pipe:consumer:create' ||
    message.type === 'pipe:consumer:close'
  );
}

function commandKey(envelope: Pick<PipeCoordinationEnvelope, 'correlationId' | 'idempotencyKey'>): string {
  return envelope.idempotencyKey ?? envelope.correlationId;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function producerKey(pipeTransportId: string, producerId: string): string {
  return `${pipeTransportId}:${producerId}`;
}

function consumerKey(pipeTransportId: string, consumerId: string): string {
  return `${pipeTransportId}:${consumerId}`;
}

function remoteFeedKey(roomId: string, ownerNodeId: string, remoteNodeId: string, producerId: string): string {
  return `${roomId}:${ownerNodeId}:${remoteNodeId}:${producerId}`;
}

function remotePublishedProducerKey(roomId: string, ownerNodeId: string, remoteNodeId: string, producerId: string): string {
  return `publish:${roomId}:${ownerNodeId}:${remoteNodeId}:${producerId}`;
}

function transportIdFor(roomId: string, ownerNodeId: string, remoteNodeId: string, protocol: PipeTransportProtocol): string {
  return `pipe:${protocol}:${roomId}:${ownerNodeId}:${remoteNodeId}`;
}

function ownerPipeConsumerId(producerId: string, remoteNodeId: string): string {
  return `pipe-consumer:${producerId}:${remoteNodeId}`;
}

function remotePublishPipeConsumerId(producerId: string, remoteNodeId: string): string {
  return `pipe-publisher:${producerId}:${remoteNodeId}`;
}

function randomPipeToken(): string {
  return randomBytes(24).toString('hex');
}

function toUdpRemoteEndpoint(endpoint: PipeNodeEndpoint): { address: string; port: number; nodeId?: string } {
  const port = endpoint.port;
  if (!endpoint.advertiseIp || !port) {
    throw new Error('Pipe endpoint is missing advertised IP or port');
  }
  return {
    address: endpoint.advertiseIp,
    port,
    nodeId: endpoint.nodeId
  };
}
