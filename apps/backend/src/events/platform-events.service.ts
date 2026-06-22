import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  CreateRedisStreamEndpointRequest,
  CreateWebhookEndpointRequest,
  DELIVERY_SNAPSHOT_SOURCES,
  DeliveryBacklogAgingSummary,
  DeliveryBacklogEndpointSummary,
  DeliveryFairnessDiagnosticsSummary,
  EVENT_DELIVERY_ADAPTER_KINDS,
  EVENT_DELIVERY_FAILURE_CATEGORIES,
  EventDeliveryFailureCategory,
  EventDeliverySnapshot,
  EventingDiagnosticsSummary,
  PLATFORM_EVENT_SCHEMA_VERSION,
  PlatformEvent,
  PlatformEventActor,
  PlatformEventBase,
  PlatformEventListResponse,
  PlatformEventPayloadByType,
  PlatformEventQuery,
  PlatformEventType,
  RedisStreamEndpoint,
  RedisStreamEndpointListResponse,
  RedisStreamEndpointSnapshot,
  ReplayWebhookDeliveryResponse,
  UpdateRedisStreamEndpointRequest,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  WebhookDeliveryListResponse,
  WebhookDeliveryQuery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointSnapshot,
  WebhookEndpointListResponse,
  WebhookEndpointSecretResponse
} from '@native-sfu/contracts';
import { Model } from 'mongoose';
import { NodeRegistryService } from '../cluster/node-registry.service';
import {
  PlatformEventDocument,
  PlatformEventMongoDocument,
  RedisStreamEndpointDocument,
  RedisStreamEndpointMongoDocument,
  WebhookDeliveryDocument,
  WebhookDeliveryMongoDocument,
  WebhookEndpointDocument,
  WebhookEndpointMongoDocument
} from '../database/schemas';
import { MetricsService } from '../metrics/metrics.service';
import { EventDeliveryAdapterRegistry } from './adapters/event-delivery-adapter.registry';
import { EventDeliveryExecutionRequest } from './adapters/event-delivery-adapter';

type AppendPlatformEventOptions = {
  deliverWebhook?: boolean;
};

type InternalWebhookEndpointSnapshot = Omit<WebhookEndpointSnapshot, 'endpointUpdatedAt' | 'secretLastRotatedAt'> & {
  adapterKind: 'webhook';
  endpointUpdatedAt?: Date;
  secretLastRotatedAt?: Date;
  signingSecretCiphertext: string;
  signingSecretIv: string;
  signingSecretAuthTag: string;
};

type InternalRedisStreamEndpointSnapshot = Omit<RedisStreamEndpointSnapshot, 'endpointUpdatedAt'> & {
  adapterKind: 'redis-stream';
  endpointUpdatedAt?: Date;
};

type InternalDeliverySnapshot = InternalWebhookEndpointSnapshot | InternalRedisStreamEndpointSnapshot;
type DeliveryEndpointDocument = WebhookEndpointMongoDocument | RedisStreamEndpointMongoDocument;
type EligibleDeliveryLane = {
  adapterKind: WebhookDelivery['adapterKind'];
  endpointId: string;
  liveDispatching: number;
  expiredDispatching: number;
  dueQueued: number;
  dueRetrying: number;
  reclaimAt?: Date;
  nextDueAt?: Date;
};

type OutstandingBacklogLane = {
  adapterKind: WebhookDelivery['adapterKind'];
  endpointId: string;
  total: number;
  queued: number;
  retrying: number;
  dispatching: number;
  oldestQueuedAt?: Date;
  oldestRetryingAt?: Date;
  oldestDispatchingAt?: Date;
};

type OutstandingBacklogTelemetry = {
  backlogAging: DeliveryBacklogAgingSummary;
  backlogAgingByAdapter: Record<WebhookDelivery['adapterKind'], DeliveryBacklogAgingSummary>;
  laneCountsByAdapter: Record<WebhookDelivery['adapterKind'], DeliveryBacklogAgingSummary>;
  fairness: DeliveryFairnessDiagnosticsSummary;
  topBacklogEndpoints: DeliveryBacklogEndpointSummary[];
};

type ReplayContext = {
  replayOfDeliveryId?: string;
  replayedBy?: PlatformEventActor;
  snapshotSource?: 'original_delivery_snapshot' | 'current_endpoint_state';
  endpointSnapshot?: InternalDeliverySnapshot;
};

@Injectable()
export class PlatformEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformEventsService.name);
  private pumpTimer?: NodeJS.Timeout;
  private preferRetryLane = false;
  private nextAdapterIndex = 0;
  private pumpActive = false;
  private activeDispatches = 0;
  private readonly activeDispatchesByAdapter = new Map<WebhookDelivery['adapterKind'], number>();
  private readonly activeDispatchesByEndpoint = new Map<string, number>();
  private readonly webhookEnabled: boolean;
  private readonly secretKey: Buffer;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultInitialBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly deliveryConcurrency: number;
  private readonly deliveryMaxBatchPerPump: number;
  private readonly deliveryMaxConcurrentPerEndpoint: number;
  private readonly productionMode: boolean;
  private readonly eventRetentionDays: number;
  private readonly deliveryRetentionDays: number;
  private readonly exhaustedDeliveryRetentionDays: number;
  private readonly cleanupIntervalMs: number;
  private cleanupTimer?: NodeJS.Timeout;
  private lastRetentionSweepAt?: string;
  private lastRetentionSweepDeletedCounts?: { events: number; deliveries: number };

  constructor(
    @InjectModel(PlatformEventDocument.name) private readonly platformEvents: Model<PlatformEventMongoDocument>,
    @InjectModel(WebhookEndpointDocument.name) private readonly webhookEndpoints: Model<WebhookEndpointMongoDocument>,
    @InjectModel(RedisStreamEndpointDocument.name) private readonly redisStreamEndpoints: Model<RedisStreamEndpointMongoDocument>,
    @InjectModel(WebhookDeliveryDocument.name) private readonly webhookDeliveries: Model<WebhookDeliveryMongoDocument>,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly adapterRegistry: EventDeliveryAdapterRegistry
  ) {
    this.webhookEnabled = this.config.get<boolean>('events.webhooks.enabled', true);
    this.productionMode = this.config.get<string>('app.nodeEnv', this.config.get<string>('NODE_ENV', 'development')) === 'production';
    this.defaultTimeoutMs = this.config.get<number>('events.webhooks.defaultTimeoutMs', 5000);
    this.defaultMaxAttempts = this.config.get<number>('events.webhooks.defaultMaxAttempts', 5);
    this.defaultInitialBackoffMs = this.config.get<number>('events.webhooks.defaultInitialBackoffMs', 2000);
    this.pollIntervalMs = this.config.get<number>('events.webhooks.pollIntervalMs', 1000);
    this.leaseMs = this.config.get<number>('events.webhooks.leaseMs', 30000);
    this.deliveryConcurrency = this.config.get<number>('events.webhooks.concurrency', 4);
    this.deliveryMaxBatchPerPump = this.config.get<number>('events.webhooks.maxBatchPerPump', 16);
    this.deliveryMaxConcurrentPerEndpoint = this.config.get<number>('events.webhooks.maxConcurrentPerEndpoint', 2);
    this.eventRetentionDays = this.config.get<number>('events.retention.eventRetentionDays', 30);
    this.deliveryRetentionDays = this.config.get<number>('events.retention.deliveryRetentionDays', 14);
    this.exhaustedDeliveryRetentionDays = this.config.get<number>('events.retention.exhaustedDeliveryRetentionDays', 30);
    this.cleanupIntervalMs = this.config.get<number>('events.retention.cleanupIntervalMs', 3_600_000);
    const secret = this.config.get<string>('events.webhooks.secretEncryptionKey', this.config.getOrThrow<string>('jwt.accessSecret'));
    this.secretKey = createHash('sha256').update(secret).digest();
  }

  onModuleInit(): void {
    if (this.webhookEnabled) {
      this.pumpTimer = setInterval(() => {
        void this.pumpDueDeliveries().catch((error) => {
          this.logger.warn(`Webhook delivery pump failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, this.pollIntervalMs);
    }
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredHistory().catch((error) => {
        this.logger.warn(`Event retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.cleanupIntervalMs);
    void this.refreshWebhookMetrics().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async appendEvent<TType extends PlatformEventType>(
    input: {
      type: TType;
      roomId?: string;
      actor?: PlatformEventActor;
      sourceNodeId?: string;
      timestamp?: string;
      payload: PlatformEventPayloadByType[TType];
    },
    options: AppendPlatformEventOptions = {}
  ): Promise<PlatformEventBase<TType>> {
    const event: Omit<PlatformEventBase<TType>, 'id'> = {
      schemaVersion: PLATFORM_EVENT_SCHEMA_VERSION,
      type: input.type,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.actor ? { actor: sanitizeActor(input.actor) } : {}),
      sourceNodeId: input.sourceNodeId ?? this.nodeRegistry.localNodeId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      payload: input.payload
    };
    const serializedEvent = stableStringify(event);
    const document = await this.platformEvents.create({
      schemaVersion: PLATFORM_EVENT_SCHEMA_VERSION,
      type: input.type,
      roomId: input.roomId,
      actorType: input.actor?.type,
      actorParticipantId: input.actor?.participantId,
      actorUserId: input.actor?.userId,
      actorLabel: input.actor?.label,
      actorNodeId: input.actor?.nodeId,
      actorWorkerId: input.actor?.workerId,
      sourceNodeId: event.sourceNodeId,
      occurredAt: new Date(event.timestamp),
      event,
      serializedEvent,
      createdAt: new Date()
    });
    const storedEvent = this.toPlatformEvent(document) as PlatformEventBase<TType>;
    this.metrics.platformEventsEmitted.labels(input.type).inc();
    if (options.deliverWebhook !== false) {
      await this.enqueueEventDeliveries(storedEvent as PlatformEvent);
    }
    void this.refreshWebhookMetrics().catch(() => undefined);
    return storedEvent;
  }

  async listEvents(query: PlatformEventQuery = {}): Promise<PlatformEventListResponse> {
    const filters = buildEventQueryFilter(query);
    const limit = normalizeLimit(query.limit, 100);
    const events = await this.platformEvents.find(filters).sort({ occurredAt: -1, createdAt: -1 }).limit(limit);
    this.metrics.platformEventQueries.labels(query.roomId ? 'room' : 'global').inc();
    return {
      events: events.map((event) => this.toPlatformEvent(event))
    };
  }

  async createWebhookEndpoint(
    request: CreateWebhookEndpointRequest,
    actor: PlatformEventActor = defaultOperatorActor()
  ): Promise<WebhookEndpointSecretResponse> {
    validateWebhookEndpointRequest(request, false, this.productionMode);
    const signingSecret = request.signingSecret?.trim() || randomSecret();
    validateWebhookSigningSecret(signingSecret);
    const encrypted = this.encryptSecret(signingSecret);
    const doc = await this.webhookEndpoints.create({
      name: request.name.trim(),
      url: request.url.trim(),
      enabled: request.enabled ?? true,
      subscribedEventTypes: dedupeEventTypes(request.subscribedEventTypes),
      roomFilterIds: dedupeStrings(request.roomFilterIds),
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
      maxAttempts: request.maxAttempts ?? this.defaultMaxAttempts,
      initialBackoffMs: request.initialBackoffMs ?? this.defaultInitialBackoffMs,
      signingAlgorithm: 'hmac-sha256',
      signingSecretCiphertext: encrypted.ciphertext,
      signingSecretIv: encrypted.iv,
      signingSecretAuthTag: encrypted.authTag,
      secretFingerprint: secretFingerprint(signingSecret),
      secretLastRotatedAt: new Date(),
      health: {
        status: request.enabled === false ? 'disabled' : 'healthy',
        consecutiveFailures: 0
      }
    });
    await this.refreshWebhookMetrics();
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        actor,
        payload: {
          action: 'webhook_endpoint_created',
          scope: 'webhook',
          endpointId: doc.id,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return {
      endpoint: this.toWebhookEndpoint(doc),
      signingSecret
    };
  }

  async listWebhookEndpoints(): Promise<WebhookEndpointListResponse> {
    const endpoints = await this.webhookEndpoints.find().sort({ createdAt: -1 });
    return {
      endpoints: endpoints.map((endpoint) => this.toWebhookEndpoint(endpoint))
    };
  }

  async getWebhookEndpoint(endpointId: string): Promise<WebhookEndpoint> {
    const endpoint = await this.webhookEndpoints.findById(endpointId);
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    return this.toWebhookEndpoint(endpoint);
  }

  async updateWebhookEndpoint(
    endpointId: string,
    request: UpdateWebhookEndpointRequest,
    actor: PlatformEventActor = defaultOperatorActor()
  ): Promise<WebhookEndpoint> {
    validateWebhookEndpointRequest(request, true, this.productionMode);
    const endpoint = await this.webhookEndpoints.findById(endpointId);
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    if (request.name !== undefined) {
      endpoint.name = request.name.trim();
    }
    if (request.url !== undefined) {
      endpoint.url = request.url.trim();
    }
    if (request.enabled !== undefined) {
      endpoint.enabled = request.enabled;
      endpoint.health.status = request.enabled ? deriveEndpointHealthStatus(endpoint.health.consecutiveFailures) : 'disabled';
      if (!request.enabled) {
        await this.webhookDeliveries.updateMany(
          {
            adapterKind: 'webhook',
            endpointId,
            status: { $in: ['queued', 'retrying'] }
          },
          {
            status: 'cancelled',
            cancelledAt: new Date(),
            lastError: 'endpoint_disabled',
            lastFailureCategory: 'endpoint_disabled',
            lockedBy: undefined,
            lockedUntil: undefined
          }
        );
      }
    }
    if (request.subscribedEventTypes !== undefined) {
      endpoint.subscribedEventTypes = dedupeEventTypes(request.subscribedEventTypes);
    }
    if (request.roomFilterIds !== undefined) {
      endpoint.roomFilterIds = dedupeStrings(request.roomFilterIds);
    }
    if (request.timeoutMs !== undefined) {
      endpoint.timeoutMs = request.timeoutMs;
    }
    if (request.maxAttempts !== undefined) {
      endpoint.maxAttempts = request.maxAttempts;
    }
    if (request.initialBackoffMs !== undefined) {
      endpoint.initialBackoffMs = request.initialBackoffMs;
    }
    await endpoint.save();
    await this.refreshWebhookMetrics();
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        actor,
        payload: {
          action: 'webhook_endpoint_updated',
          scope: 'webhook',
          endpointId,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return this.toWebhookEndpoint(endpoint);
  }

  async rotateWebhookEndpointSecret(
    endpointId: string,
    requestedSecret?: string,
    actor: PlatformEventActor = defaultOperatorActor()
  ): Promise<WebhookEndpointSecretResponse> {
    const endpoint = await this.webhookEndpoints.findById(endpointId).select('+signingSecretCiphertext +signingSecretIv +signingSecretAuthTag');
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    const signingSecret = requestedSecret?.trim() || randomSecret();
    validateWebhookSigningSecret(signingSecret);
    const encrypted = this.encryptSecret(signingSecret);
    endpoint.signingSecretCiphertext = encrypted.ciphertext;
    endpoint.signingSecretIv = encrypted.iv;
    endpoint.signingSecretAuthTag = encrypted.authTag;
    endpoint.secretFingerprint = secretFingerprint(signingSecret);
    endpoint.secretLastRotatedAt = new Date();
    await endpoint.save();
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        actor,
        payload: {
          action: 'webhook_endpoint_secret_rotated',
          scope: 'webhook',
          endpointId,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return {
      endpoint: this.toWebhookEndpoint(endpoint),
      signingSecret
    };
  }

  async createRedisStreamEndpoint(
    request: CreateRedisStreamEndpointRequest,
    actor: PlatformEventActor = defaultOperatorActor()
  ): Promise<RedisStreamEndpoint> {
    validateRedisStreamEndpointRequest(request, false);
    const doc = await this.redisStreamEndpoints.create({
      name: request.name.trim(),
      streamKey: request.streamKey.trim(),
      maxLen: request.maxLen,
      enabled: request.enabled ?? true,
      subscribedEventTypes: dedupeEventTypes(request.subscribedEventTypes),
      roomFilterIds: dedupeStrings(request.roomFilterIds),
      timeoutMs: request.timeoutMs ?? Math.min(this.defaultTimeoutMs, 2000),
      maxAttempts: request.maxAttempts ?? Math.min(this.defaultMaxAttempts, 3),
      initialBackoffMs: request.initialBackoffMs ?? Math.min(this.defaultInitialBackoffMs, 1000),
      health: {
        status: request.enabled === false ? 'disabled' : 'healthy',
        consecutiveFailures: 0
      }
    });
    await this.refreshWebhookMetrics();
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        actor,
        payload: {
          action: 'redis_stream_endpoint_created',
          scope: 'redis_stream',
          endpointId: doc.id,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return this.toRedisStreamEndpoint(doc);
  }

  async listRedisStreamEndpoints(): Promise<RedisStreamEndpointListResponse> {
    const endpoints = await this.redisStreamEndpoints.find().sort({ createdAt: -1 });
    return {
      endpoints: endpoints.map((endpoint) => this.toRedisStreamEndpoint(endpoint))
    };
  }

  async getRedisStreamEndpoint(endpointId: string): Promise<RedisStreamEndpoint> {
    const endpoint = await this.redisStreamEndpoints.findById(endpointId);
    if (!endpoint) {
      throw new NotFoundException('Redis stream endpoint not found');
    }
    return this.toRedisStreamEndpoint(endpoint);
  }

  async updateRedisStreamEndpoint(
    endpointId: string,
    request: UpdateRedisStreamEndpointRequest,
    actor: PlatformEventActor = defaultOperatorActor()
  ): Promise<RedisStreamEndpoint> {
    validateRedisStreamEndpointRequest(request, true);
    const endpoint = await this.redisStreamEndpoints.findById(endpointId);
    if (!endpoint) {
      throw new NotFoundException('Redis stream endpoint not found');
    }
    if (request.name !== undefined) {
      endpoint.name = request.name.trim();
    }
    if (request.streamKey !== undefined) {
      endpoint.streamKey = request.streamKey.trim();
    }
    if (request.maxLen !== undefined) {
      endpoint.maxLen = request.maxLen;
    }
    if (request.enabled !== undefined) {
      endpoint.enabled = request.enabled;
      endpoint.health.status = request.enabled ? deriveEndpointHealthStatus(endpoint.health.consecutiveFailures) : 'disabled';
      if (!request.enabled) {
        await this.webhookDeliveries.updateMany(
          {
            endpointId,
            adapterKind: 'redis-stream',
            status: { $in: ['queued', 'retrying'] }
          },
          {
            status: 'cancelled',
            cancelledAt: new Date(),
            lastError: 'endpoint_disabled',
            lastFailureCategory: 'endpoint_disabled',
            lockedBy: undefined,
            lockedUntil: undefined
          }
        );
      }
    }
    if (request.subscribedEventTypes !== undefined) {
      endpoint.subscribedEventTypes = dedupeEventTypes(request.subscribedEventTypes);
    }
    if (request.roomFilterIds !== undefined) {
      endpoint.roomFilterIds = dedupeStrings(request.roomFilterIds);
    }
    if (request.timeoutMs !== undefined) {
      endpoint.timeoutMs = request.timeoutMs;
    }
    if (request.maxAttempts !== undefined) {
      endpoint.maxAttempts = request.maxAttempts;
    }
    if (request.initialBackoffMs !== undefined) {
      endpoint.initialBackoffMs = request.initialBackoffMs;
    }
    await endpoint.save();
    await this.refreshWebhookMetrics();
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        actor,
        payload: {
          action: 'redis_stream_endpoint_updated',
          scope: 'redis_stream',
          endpointId,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return this.toRedisStreamEndpoint(endpoint);
  }

  async listWebhookDeliveries(query: WebhookDeliveryQuery = {}): Promise<WebhookDeliveryListResponse> {
    const filters = buildDeliveryQueryFilter(query);
    const limit = normalizeLimit(query.limit, 100);
    const deliveries = await this.webhookDeliveries.find(filters).sort({ createdAt: -1 }).limit(limit);
    return {
      deliveries: deliveries.map((delivery) => this.toWebhookDelivery(delivery))
    };
  }

  async getWebhookDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.webhookDeliveries.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Webhook delivery not found');
    }
    return this.toWebhookDelivery(delivery);
  }

  async replayWebhookDelivery(deliveryId: string, actor: PlatformEventActor): Promise<ReplayWebhookDeliveryResponse> {
    const delivery = await this.webhookDeliveries
      .findById(deliveryId)
      .select('+endpointSnapshot.signingSecretCiphertext +endpointSnapshot.signingSecretIv +endpointSnapshot.signingSecretAuthTag');
    if (!delivery) {
      throw new NotFoundException('Webhook delivery not found');
    }
    if (!isReplayableDeliveryStatus(delivery.status)) {
      throw new BadRequestException('Only cancelled or exhausted deliveries can be replayed');
    }
    const activeReplay = await this.webhookDeliveries.findOne({
      replayOfDeliveryId: delivery.id,
      status: { $in: ['queued', 'retrying', 'dispatching'] as WebhookDeliveryStatus[] }
    });
    if (activeReplay) {
      throw new BadRequestException('A replay is already queued for this delivery');
    }
    const replay = await this.enqueueSingleDelivery(delivery.endpointId, delivery.eventId, {
      replayOfDeliveryId: delivery.id,
      replayedBy: sanitizeActor(actor),
      snapshotSource: 'original_delivery_snapshot',
      endpointSnapshot: this.readDeliverySnapshot(delivery)
    });
    this.metrics.eventDeliveryReplays.labels(replay.adapterKind, 'delivery').inc();
    if (replay.adapterKind === 'webhook') {
      this.metrics.webhookReplays.labels('delivery').inc();
    }
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        roomId: delivery.roomId,
        actor,
        payload: {
          action: 'webhook_replayed',
          scope: 'delivery',
          roomId: delivery.roomId,
          endpointId: delivery.endpointId,
          deliveryId: replay.id,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return {
      delivery: this.toWebhookDelivery(replay)
    };
  }

  async replayEventToEndpoint(eventId: string, endpointId: string, actor: PlatformEventActor): Promise<ReplayWebhookDeliveryResponse> {
    const replay = await this.enqueueSingleDelivery(endpointId, eventId, {
      replayedBy: sanitizeActor(actor),
      snapshotSource: 'current_endpoint_state'
    });
    this.metrics.eventDeliveryReplays.labels(replay.adapterKind, 'event').inc();
    if (replay.adapterKind === 'webhook') {
      this.metrics.webhookReplays.labels('event').inc();
    }
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        roomId: replay.roomId,
        actor,
        payload: {
          action: 'event_replayed_to_endpoint',
          scope: replay.adapterKind === 'redis-stream' ? 'redis_stream' : 'webhook',
          roomId: replay.roomId,
          endpointId,
          deliveryId: replay.id,
          outcome: 'executed'
        }
      },
      { deliverWebhook: false }
    );
    return {
      delivery: this.toWebhookDelivery(replay)
    };
  }

  async diagnosticsSummary(): Promise<EventingDiagnosticsSummary> {
    const now = new Date();
    const [
      totalWebhookEndpoints,
      enabledWebhookEndpoints,
      unhealthyWebhookEndpoints,
      totalRedisStreamEndpoints,
      enabledRedisStreamEndpoints,
      unhealthyRedisStreamEndpoints,
      deliveryCountsByAdapterRows,
      failureCategoryRows,
      snapshotSourceRows,
      activeLeaseCount,
      expiredLeaseCount,
      recentEventCount,
      lastEvent,
      outstandingBacklogLanes
    ] = await Promise.all([
      this.webhookEndpoints.countDocuments(),
      this.webhookEndpoints.countDocuments({ enabled: true }),
      this.webhookEndpoints.countDocuments({ 'health.status': { $in: ['degraded', 'failing'] } }),
      this.redisStreamEndpoints.countDocuments(),
      this.redisStreamEndpoints.countDocuments({ enabled: true }),
      this.redisStreamEndpoints.countDocuments({ 'health.status': { $in: ['degraded', 'failing'] } }),
      this.webhookDeliveries.aggregate<{
        _id: { adapterKind: WebhookDelivery['adapterKind']; status: WebhookDeliveryStatus };
        count: number;
      }>([
        {
          $group: {
            _id: { adapterKind: '$adapterKind', status: '$status' },
            count: { $sum: 1 }
          }
        }
      ]),
      this.webhookDeliveries.aggregate<{ _id: EventDeliveryFailureCategory; count: number }>([
        {
          $match: {
            lastFailureCategory: { $in: [...EVENT_DELIVERY_FAILURE_CATEGORIES] }
          }
        },
        {
          $group: {
            _id: '$lastFailureCategory',
            count: { $sum: 1 }
          }
        }
      ]),
      this.webhookDeliveries.aggregate<{ _id: typeof DELIVERY_SNAPSHOT_SOURCES[number]; count: number }>([
        {
          $group: {
            _id: '$snapshotSource',
            count: { $sum: 1 }
          }
        }
      ]),
      this.webhookDeliveries.countDocuments({ status: 'dispatching', lockedUntil: { $gt: now } }),
      this.webhookDeliveries.countDocuments({ status: 'dispatching', lockedUntil: { $lte: now } }),
      this.platformEvents.countDocuments({ occurredAt: { $gte: new Date(Date.now() - 24 * 60 * 60_000) } }),
      this.platformEvents.findOne().sort({ occurredAt: -1, createdAt: -1 }),
      this.loadOutstandingBacklogLanes()
    ]);
    const backlogTelemetry = summarizeOutstandingBacklog(outstandingBacklogLanes, now);

    const endpointCountsByAdapter = zeroAdapterCountRecord();
    endpointCountsByAdapter.webhook = totalWebhookEndpoints;
    endpointCountsByAdapter['redis-stream'] = totalRedisStreamEndpoints;

    const deliveryCountsByAdapter = createEmptyDeliveryCountsByAdapter();
    for (const row of deliveryCountsByAdapterRows) {
      deliveryCountsByAdapter[row._id.adapterKind][row._id.status] = row.count;
    }

    const deliveryCounts = sumDeliveryCountsByAdapter(deliveryCountsByAdapter);
    const failureCategoryCounts = zeroFailureCategoryCounts();
    for (const row of failureCategoryRows) {
      failureCategoryCounts[row._id] = row.count;
    }

    const snapshotSourceCounts = zeroSnapshotSourceCounts();
    for (const row of snapshotSourceRows) {
      snapshotSourceCounts[row._id] = row.count;
    }

    const adapterCounts = zeroAdapterCountRecord();
    for (const adapterKind of EVENT_DELIVERY_ADAPTER_KINDS) {
      const counts = deliveryCountsByAdapter[adapterKind];
      adapterCounts[adapterKind] = counts.queued + counts.retrying + counts.dispatching;
    }

    const activeDispatchesByAdapter = zeroAdapterCountRecord();
    for (const adapterKind of EVENT_DELIVERY_ADAPTER_KINDS) {
      activeDispatchesByAdapter[adapterKind] = this.activeDispatchesByAdapter.get(adapterKind) ?? 0;
    }

    const totalEndpoints = totalWebhookEndpoints + totalRedisStreamEndpoints;
    const enabledEndpoints = enabledWebhookEndpoints + enabledRedisStreamEndpoints;
    const unhealthyEndpoints = unhealthyWebhookEndpoints + unhealthyRedisStreamEndpoints;
    return {
      observedAt: new Date().toISOString(),
      endpointCounts: {
        total: totalEndpoints,
        enabled: enabledEndpoints,
        disabled: Math.max(0, totalEndpoints - enabledEndpoints),
        unhealthy: unhealthyEndpoints
      },
      endpointCountsByAdapter,
      deliveryCounts,
      deliveryCountsByAdapter,
      failureCategoryCounts,
      snapshotSourceCounts,
      adapterCounts,
      dispatch: {
        concurrency: this.deliveryConcurrency,
        maxBatchPerPump: this.deliveryMaxBatchPerPump,
        maxConcurrentPerEndpoint: this.deliveryMaxConcurrentPerEndpoint,
        activeDispatches: this.activeDispatches,
        nextClaimPrefers: this.preferRetryLane ? 'retrying' : 'queued'
      },
      activeDispatchesByAdapter,
      leaseCounts: {
        active: activeLeaseCount,
        expired: expiredLeaseCount
      },
      backlogAging: backlogTelemetry.backlogAging,
      backlogAgingByAdapter: backlogTelemetry.backlogAgingByAdapter,
      fairness: backlogTelemetry.fairness,
      topBacklogEndpoints: backlogTelemetry.topBacklogEndpoints,
      retention: {
        eventRetentionDays: this.eventRetentionDays,
        deliveryRetentionDays: this.deliveryRetentionDays,
        exhaustedDeliveryRetentionDays: this.exhaustedDeliveryRetentionDays,
        cleanupIntervalMs: this.cleanupIntervalMs,
        ...(this.lastRetentionSweepAt ? { lastSweepAt: this.lastRetentionSweepAt } : {}),
        ...(this.lastRetentionSweepDeletedCounts ? { lastSweepDeletedCounts: this.lastRetentionSweepDeletedCounts } : {})
      },
      recentEventCount,
      lastEventAt: lastEvent?.occurredAt?.toISOString()
    };
  }

  private async enqueueEventDeliveries(event: PlatformEvent): Promise<void> {
    if (!this.webhookEnabled) {
      return;
    }
    const [webhookEndpoints, redisStreamEndpoints] = await Promise.all([
      this.webhookEndpoints
        .find({
          enabled: true,
          subscribedEventTypes: event.type
        })
        .select('+signingSecretCiphertext +signingSecretIv +signingSecretAuthTag'),
      this.redisStreamEndpoints.find({
        enabled: true,
        subscribedEventTypes: event.type
      })
    ]);
    if (webhookEndpoints.length === 0 && redisStreamEndpoints.length === 0) {
      return;
    }
    const deliveries = [
      ...webhookEndpoints
        .filter((endpoint) => this.endpointMatchesRoomFilter(endpoint, event.roomId))
        .map((endpoint) => ({
          adapterKind: 'webhook' as const,
          endpointId: endpoint.id,
          eventId: event.id,
          eventType: event.type,
          roomId: event.roomId,
          status: 'queued',
          snapshotSource: 'queued_endpoint_state',
          endpointSnapshot: this.createDeliverySnapshotFromEndpoint(endpoint),
          attemptCount: 0,
          nextAttemptAt: new Date(),
          attempts: []
        })),
      ...redisStreamEndpoints
        .filter((endpoint) => this.endpointMatchesRoomFilter(endpoint, event.roomId))
        .map((endpoint) => ({
          adapterKind: 'redis-stream' as const,
          endpointId: endpoint.id,
          eventId: event.id,
          eventType: event.type,
          roomId: event.roomId,
          status: 'queued',
          snapshotSource: 'queued_endpoint_state',
          endpointSnapshot: this.createDeliverySnapshotFromEndpoint(endpoint),
          attemptCount: 0,
          nextAttemptAt: new Date(),
          attempts: []
        }))
    ];
    if (deliveries.length === 0) {
      return;
    }
    await this.webhookDeliveries.insertMany(deliveries);
    for (const delivery of deliveries) {
      this.metrics.eventDeliverySnapshotSourceUsage.labels(delivery.adapterKind, delivery.snapshotSource).inc();
    }
  }

  private endpointMatchesRoomFilter(endpoint: { roomFilterIds?: string[] }, roomId?: string): boolean {
    if (!endpoint.roomFilterIds?.length) {
      return true;
    }
    return roomId !== undefined && endpoint.roomFilterIds.includes(roomId);
  }

  private async enqueueSingleDelivery(endpointId: string, eventId: string, replayContext: ReplayContext = {}): Promise<WebhookDeliveryMongoDocument> {
    const [endpoint, event] = await Promise.all([
      this.findEndpointById(endpointId),
      this.platformEvents.findById(eventId)
    ]);
    if (!endpoint) {
      throw new NotFoundException('Delivery endpoint not found');
    }
    if (!event) {
      throw new NotFoundException('Platform event not found');
    }
    if (!endpoint.enabled) {
      throw new BadRequestException('Delivery endpoint is disabled');
    }
    const snapshot = replayContext.endpointSnapshot ?? this.createDeliverySnapshotFromEndpoint(endpoint);
    const snapshotSource = replayContext.snapshotSource ?? 'current_endpoint_state';
    let delivery: WebhookDeliveryMongoDocument;
    try {
      delivery = await this.webhookDeliveries.create({
        adapterKind: snapshot.adapterKind,
        endpointId,
        eventId,
        eventType: event.type,
        roomId: event.roomId,
        status: 'queued',
        snapshotSource,
        endpointSnapshot: snapshot,
        attemptCount: 0,
        nextAttemptAt: new Date(),
        attempts: [],
        ...(replayContext.replayOfDeliveryId ? { replayOfDeliveryId: replayContext.replayOfDeliveryId } : {}),
        ...(replayContext.replayedBy ? { replayedBy: replayContext.replayedBy } : {})
      });
    } catch (error) {
      if (isMongoDuplicateKeyError(error)) {
        throw new BadRequestException(
          replayContext.replayOfDeliveryId
            ? 'A replay is already queued for this delivery'
            : 'A queued or in-flight delivery already exists for this endpoint and event'
        );
      }
      throw error;
    }
    this.metrics.eventDeliverySnapshotSourceUsage.labels(delivery.adapterKind, delivery.snapshotSource).inc();
    return delivery;
  }

  private async pumpDueDeliveries(): Promise<void> {
    if (this.pumpActive) {
      return;
    }
    this.pumpActive = true;
    try {
      const dispatches: Array<Promise<void>> = [];
      const reservedByEndpoint = new Map<string, number>();
      const reservedByAdapter = new Map<WebhookDelivery['adapterKind'], number>();
      let preferRetry = this.preferRetryLane;
      for (let iteration = 0; iteration < this.deliveryMaxBatchPerPump; iteration += 1) {
        if (this.activeDispatches + dispatches.length >= this.deliveryConcurrency) {
          break;
        }
        const delivery = await this.claimNextDueDelivery({
          preferRetry,
          excludedLaneKeys: this.endpointKeysAtDispatchLimit(reservedByEndpoint, reservedByAdapter)
        });
        if (!delivery) {
          break;
        }
        preferRetry = !preferRetry;
        reservedByEndpoint.set(this.deliveryEndpointKey(delivery.adapterKind, delivery.endpointId), (reservedByEndpoint.get(this.deliveryEndpointKey(delivery.adapterKind, delivery.endpointId)) ?? 0) + 1);
        reservedByAdapter.set(delivery.adapterKind, (reservedByAdapter.get(delivery.adapterKind) ?? 0) + 1);
        dispatches.push(this.dispatchWithAccounting(delivery));
      }
      this.preferRetryLane = preferRetry;
      if (dispatches.length > 0) {
        await Promise.all(dispatches);
      }
    } finally {
      this.pumpActive = false;
    }
  }

  private async claimNextDueDelivery(options: { preferRetry: boolean; excludedLaneKeys: string[] }): Promise<WebhookDeliveryMongoDocument | null> {
    const now = new Date();
    const lanes = await this.findEligibleDeliveryLanes(now, options.excludedLaneKeys);
    if (lanes.length === 0) {
      return null;
    }
    const adapterOrder = this.adapterOrder();
    const sortedLanes = lanes.sort((left, right) => compareEligibleLanes(left, right, {
      preferRetry: options.preferRetry,
      adapterOrder
    }));
    for (const lane of sortedLanes) {
      const reclaimed = lane.expiredDispatching > 0
        ? await this.claimDueDelivery(
            {
              adapterKind: lane.adapterKind,
              endpointId: lane.endpointId,
              status: 'dispatching',
              lockedUntil: { $lte: now }
            },
            now,
            { lockedUntil: 1, createdAt: 1 }
          )
        : null;
      if (reclaimed) {
        this.nextAdapterIndex = (adapterOrder.indexOf(lane.adapterKind) + 1) % adapterOrder.length;
        return reclaimed;
      }

      const preferredStatuses = options.preferRetry ? (['retrying', 'queued'] as WebhookDeliveryStatus[]) : (['queued', 'retrying'] as WebhookDeliveryStatus[]);
      for (const status of preferredStatuses) {
        const claim = await this.claimDueDelivery(
          {
            adapterKind: lane.adapterKind,
            endpointId: lane.endpointId,
            status,
            nextAttemptAt: { $lte: now },
            $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }]
          },
          now,
          {
            nextAttemptAt: 1,
            createdAt: 1
          }
        );
        if (claim) {
          this.nextAdapterIndex = (adapterOrder.indexOf(lane.adapterKind) + 1) % adapterOrder.length;
          return claim;
        }
      }
    }
    return null;
  }

  private async claimDueDelivery(
    filter: Record<string, unknown>,
    now: Date,
    sort: Record<string, 1 | -1>
  ): Promise<WebhookDeliveryMongoDocument | null> {
    return this.webhookDeliveries
      .findOneAndUpdate(
        filter,
        {
          $set: {
            status: 'dispatching',
            lockedBy: this.nodeRegistry.localNodeId(),
            lockedUntil: new Date(now.getTime() + this.leaseMs)
          }
        },
        {
          new: true,
          sort
        }
      )
      .select('+endpointSnapshot.signingSecretCiphertext +endpointSnapshot.signingSecretIv +endpointSnapshot.signingSecretAuthTag');
  }

  private async dispatchWithAccounting(delivery: WebhookDeliveryMongoDocument): Promise<void> {
    const endpointKey = this.deliveryEndpointKey(delivery.adapterKind, delivery.endpointId);
    this.activeDispatches += 1;
    this.metrics.webhookActiveDispatches.set(this.activeDispatches);
    this.activeDispatchesByAdapter.set(delivery.adapterKind, (this.activeDispatchesByAdapter.get(delivery.adapterKind) ?? 0) + 1);
    this.metrics.eventDeliveryActiveDispatchesByAdapter.labels(delivery.adapterKind).set(this.activeDispatchesByAdapter.get(delivery.adapterKind) ?? 0);
    this.activeDispatchesByEndpoint.set(endpointKey, (this.activeDispatchesByEndpoint.get(endpointKey) ?? 0) + 1);
    try {
      await this.dispatchDelivery(delivery);
    } finally {
      this.activeDispatches = Math.max(0, this.activeDispatches - 1);
      this.metrics.webhookActiveDispatches.set(this.activeDispatches);
      const remainingAdapter = Math.max(0, (this.activeDispatchesByAdapter.get(delivery.adapterKind) ?? 1) - 1);
      if (remainingAdapter === 0) {
        this.activeDispatchesByAdapter.delete(delivery.adapterKind);
      } else {
        this.activeDispatchesByAdapter.set(delivery.adapterKind, remainingAdapter);
      }
      this.metrics.eventDeliveryActiveDispatchesByAdapter.labels(delivery.adapterKind).set(this.activeDispatchesByAdapter.get(delivery.adapterKind) ?? 0);
      const remaining = Math.max(0, (this.activeDispatchesByEndpoint.get(endpointKey) ?? 1) - 1);
      if (remaining === 0) {
        this.activeDispatchesByEndpoint.delete(endpointKey);
      } else {
        this.activeDispatchesByEndpoint.set(endpointKey, remaining);
      }
    }
  }

  private endpointKeysAtDispatchLimit(
    reservedByEndpoint: Map<string, number>,
    reservedByAdapter: Map<WebhookDelivery['adapterKind'], number>
  ): string[] {
    const limited = new Set<string>();
    const maxConcurrentPerAdapter = Math.max(1, Math.ceil(this.deliveryConcurrency / Math.max(1, this.adapterRegistry.registeredKinds().length)));
    for (const [adapterKind, activeCount] of this.activeDispatchesByAdapter.entries()) {
      if (activeCount >= maxConcurrentPerAdapter) {
        limited.add(`adapter:${adapterKind}`);
      }
    }
    for (const [adapterKind, reservedCount] of reservedByAdapter.entries()) {
      const total = (this.activeDispatchesByAdapter.get(adapterKind) ?? 0) + reservedCount;
      if (total >= maxConcurrentPerAdapter) {
        limited.add(`adapter:${adapterKind}`);
      }
    }
    for (const [endpointKey, activeCount] of this.activeDispatchesByEndpoint.entries()) {
      if (activeCount >= this.deliveryMaxConcurrentPerEndpoint) {
        limited.add(endpointKey);
      }
    }
    for (const [endpointKey, reservedCount] of reservedByEndpoint.entries()) {
      const total = (this.activeDispatchesByEndpoint.get(endpointKey) ?? 0) + reservedCount;
      if (total >= this.deliveryMaxConcurrentPerEndpoint) {
        limited.add(endpointKey);
      }
    }
    return [...limited];
  }

  private createExecutionRequest(
    delivery: WebhookDeliveryMongoDocument,
    snapshot: InternalDeliverySnapshot,
    requestPayload: Record<string, unknown>,
    attemptTimestamp: string
  ): EventDeliveryExecutionRequest {
    if (snapshot.adapterKind === 'redis-stream') {
      return {
        adapterKind: 'redis-stream',
        timeoutMs: snapshot.timeoutMs,
        streamKey: snapshot.streamKey,
        maxLen: snapshot.maxLen,
        payload: requestPayload
      };
    }

    const requestBody = stableStringify(requestPayload);
    return {
      adapterKind: 'webhook',
      url: snapshot.url,
      method: 'POST',
      timeoutMs: snapshot.timeoutMs,
      headers: {
        'content-type': 'application/json',
        'x-native-sfu-delivery-id': delivery.id,
        'x-native-sfu-event-id': String(requestPayload.eventId),
        'x-native-sfu-event-type': delivery.eventType,
        'x-native-sfu-timestamp': attemptTimestamp,
        'x-native-sfu-signature': this.signPayload(attemptTimestamp, requestBody, snapshot)
      },
      body: requestBody
    };
  }

  private async dispatchDelivery(delivery: WebhookDeliveryMongoDocument): Promise<void> {
    const [eventDoc, endpointDoc] = await Promise.all([
      this.platformEvents.findById(delivery.eventId),
      this.findEndpointById(delivery.endpointId, delivery.adapterKind)
    ]);
    if (!eventDoc || !endpointDoc) {
      await this.cancelDelivery(delivery, !endpointDoc ? 'endpoint_missing' : 'event_missing', !endpointDoc ? 'endpoint_missing' : 'event_missing');
      return;
    }
    if (!endpointDoc.enabled) {
      await this.cancelDelivery(delivery, 'endpoint_disabled', 'endpoint_disabled');
      return;
    }

    const event = this.toPlatformEvent(eventDoc);
    const snapshot = this.readDeliverySnapshot(delivery);
    delivery.lockedUntil = new Date(Date.now() + Math.max(this.leaseMs, snapshot.timeoutMs + 1000));
    delivery.status = 'dispatching';
    await delivery.save();
    const attemptNumber = delivery.attemptCount + 1;
    const attemptTimestamp = new Date().toISOString();
    const requestPayload = {
      deliveryId: delivery.id,
      eventId: event.id,
      attemptNumber,
      timestamp: attemptTimestamp,
      event
    };
    const executionRequest = this.createExecutionRequest(delivery, snapshot, requestPayload, attemptTimestamp);
    const startedAt = Date.now();
    this.metrics.eventDeliveryAttempts.labels(delivery.adapterKind, event.type).inc();
    if (delivery.adapterKind === 'webhook') {
      this.metrics.webhookDeliveryAttempts.labels(event.type).inc();
    }

    const adapter = this.adapterRegistry.get(delivery.adapterKind);
    const executionResult = await adapter.execute(executionRequest);
    const outcome = executionResult.outcome;
    const responseStatusCode = executionResult.responseStatusCode;
    const errorMessage = executionResult.errorMessage;
    const failureCategory = executionResult.failureCategory;

    const durationMs = Date.now() - startedAt;
    this.metrics.eventDeliveryLatency.labels(delivery.adapterKind, outcome).observe(durationMs);
    if (delivery.adapterKind === 'webhook') {
      this.metrics.webhookDeliveryLatency.labels(outcome).observe(durationMs);
    }
    this.metrics.eventDeliveryAdapterExecutions.labels(delivery.adapterKind, outcome).inc();
    const updatedDelivery = await this.webhookDeliveries.findById(delivery.id);
    if (!updatedDelivery) {
      return;
    }
    if (updatedDelivery.status === 'cancelled') {
      updatedDelivery.lockedBy = undefined;
      updatedDelivery.lockedUntil = undefined;
      await updatedDelivery.save();
      await this.refreshWebhookMetrics();
      return;
    }
    updatedDelivery.attemptCount = attemptNumber;
    updatedDelivery.lastResponseStatusCode = responseStatusCode;
    updatedDelivery.lastError = errorMessage;
    updatedDelivery.lastFailureCategory = failureCategory;
    updatedDelivery.lastDeliveryReference = executionResult.deliveryReference;
    updatedDelivery.lockedBy = undefined;
    updatedDelivery.lockedUntil = undefined;
    updatedDelivery.attempts.push({
      attemptNumber,
      attemptedAt: new Date(attemptTimestamp),
      completedAt: new Date(),
      status: outcome,
      responseStatusCode,
      durationMs,
      ...(failureCategory ? { failureCategory } : {}),
      ...(executionResult.deliveryReference ? { deliveryReference: executionResult.deliveryReference } : {}),
      ...(errorMessage ? { error: errorMessage } : {})
    } as never);

    if (outcome === 'succeeded') {
      updatedDelivery.status = 'delivered';
      updatedDelivery.deliveredAt = new Date();
      updatedDelivery.lastFailureCategory = undefined;
      await updatedDelivery.save();
      endpointDoc.health.status = 'healthy';
      endpointDoc.health.lastDeliveryStatus = 'delivered';
      endpointDoc.health.lastDeliveryAt = new Date();
      endpointDoc.health.lastResponseStatusCode = responseStatusCode;
      endpointDoc.health.lastError = undefined;
      endpointDoc.health.lastFailureCategory = undefined;
      endpointDoc.health.lastDeliveryReference = executionResult.deliveryReference;
      endpointDoc.health.consecutiveFailures = 0;
      await endpointDoc.save();
      this.metrics.eventDeliveriesSucceeded.labels(delivery.adapterKind, event.type).inc();
      if (delivery.adapterKind === 'webhook') {
        this.metrics.webhookDeliveriesSucceeded.labels(event.type).inc();
      }
      await this.refreshWebhookMetrics();
      return;
    }

    const shouldRetry = executionResult.retryable !== false && attemptNumber < snapshot.maxAttempts;
    const nextAttemptAt = new Date(Date.now() + computeBackoffMs(snapshot.initialBackoffMs, attemptNumber));
    if (!shouldRetry) {
      updatedDelivery.status = 'exhausted';
      updatedDelivery.exhaustedAt = new Date();
      await updatedDelivery.save();
      endpointDoc.health.status = 'failing';
      endpointDoc.health.lastDeliveryStatus = 'exhausted';
      endpointDoc.health.lastDeliveryAt = new Date();
      endpointDoc.health.lastResponseStatusCode = responseStatusCode;
      endpointDoc.health.lastError = errorMessage;
      endpointDoc.health.lastFailureCategory = failureCategory;
      endpointDoc.health.lastDeliveryReference = executionResult.deliveryReference;
      endpointDoc.health.consecutiveFailures += 1;
      await endpointDoc.save();
      if (failureCategory) {
        this.metrics.eventDeliveryFailuresByCategory.labels(delivery.adapterKind, event.type, failureCategory).inc();
        if (delivery.adapterKind === 'webhook') {
          this.metrics.webhookDeliveryFailuresByCategory.labels(event.type, failureCategory).inc();
        }
      }
      this.metrics.eventDeliveriesExhausted.labels(delivery.adapterKind, event.type).inc();
      if (delivery.adapterKind === 'webhook') {
        this.metrics.webhookDeliveriesExhausted.labels(event.type).inc();
      }
    } else {
      updatedDelivery.status = 'retrying';
      updatedDelivery.nextAttemptAt = nextAttemptAt;
      const lastAttempt = updatedDelivery.attempts.at(-1);
      if (lastAttempt) {
        lastAttempt.nextAttemptAt = nextAttemptAt;
      }
      await updatedDelivery.save();
      endpointDoc.health.status = deriveEndpointHealthStatus(endpointDoc.health.consecutiveFailures + 1);
      endpointDoc.health.lastDeliveryStatus = 'retrying';
      endpointDoc.health.lastDeliveryAt = new Date();
      endpointDoc.health.lastResponseStatusCode = responseStatusCode;
      endpointDoc.health.lastError = errorMessage;
      endpointDoc.health.lastFailureCategory = failureCategory;
      endpointDoc.health.lastDeliveryReference = executionResult.deliveryReference;
      endpointDoc.health.consecutiveFailures += 1;
      await endpointDoc.save();
      if (failureCategory) {
        this.metrics.eventDeliveryFailuresByCategory.labels(delivery.adapterKind, event.type, failureCategory).inc();
        if (delivery.adapterKind === 'webhook') {
          this.metrics.webhookDeliveryFailuresByCategory.labels(event.type, failureCategory).inc();
        }
      }
      this.metrics.eventRetriesScheduled.labels(delivery.adapterKind, event.type).inc();
      this.metrics.eventDeliveriesFailed.labels(delivery.adapterKind, event.type).inc();
      if (delivery.adapterKind === 'webhook') {
        this.metrics.webhookRetriesScheduled.labels(event.type).inc();
        this.metrics.webhookDeliveriesFailed.labels(event.type).inc();
      }
    }
    await this.refreshWebhookMetrics();
  }

  private async cancelDelivery(
    delivery: WebhookDeliveryMongoDocument,
    reason: string,
    failureCategory: Extract<EventDeliveryFailureCategory, 'endpoint_disabled' | 'endpoint_missing' | 'event_missing'>
  ): Promise<void> {
    delivery.status = 'cancelled';
    delivery.cancelledAt = new Date();
    delivery.lastError = reason;
    delivery.lastFailureCategory = failureCategory;
    delivery.lockedBy = undefined;
    delivery.lockedUntil = undefined;
    await delivery.save();
    this.metrics.eventDeliveryFailuresByCategory.labels(delivery.adapterKind, delivery.eventType, failureCategory).inc();
    this.metrics.eventDeliveriesCancelled.labels(delivery.adapterKind, reason).inc();
    if (delivery.adapterKind === 'webhook') {
      this.metrics.webhookDeliveryFailuresByCategory.labels(delivery.eventType, failureCategory).inc();
      this.metrics.webhookDeliveriesCancelled.labels(reason).inc();
    }
    await this.refreshWebhookMetrics();
  }

  private async cleanupExpiredHistory(): Promise<void> {
    const now = Date.now();
    const deliveryCutoff = new Date(now - this.deliveryRetentionDays * 24 * 60 * 60_000);
    const exhaustedCutoff = new Date(now - this.exhaustedDeliveryRetentionDays * 24 * 60 * 60_000);
    const eventCutoff = new Date(now - this.eventRetentionDays * 24 * 60 * 60_000);
    const referencedEventIds = await this.webhookDeliveries.distinct('eventId');
    const [deliveryResult, exhaustedResult, eventResult] = await Promise.all([
      this.webhookDeliveries.deleteMany({
        status: { $in: ['delivered', 'cancelled'] as WebhookDeliveryStatus[] },
        updatedAt: { $lt: deliveryCutoff }
      }),
      this.webhookDeliveries.deleteMany({
        status: 'exhausted',
        exhaustedAt: { $lt: exhaustedCutoff }
      }),
      this.platformEvents.deleteMany({
        occurredAt: { $lt: eventCutoff },
        ...(referencedEventIds.length > 0 ? { _id: { $nin: referencedEventIds } } : {})
      })
    ]);
    this.lastRetentionSweepAt = new Date().toISOString();
    this.lastRetentionSweepDeletedCounts = {
      events: deletedCount(eventResult),
      deliveries: deletedCount(deliveryResult) + deletedCount(exhaustedResult)
    };
  }

  private toPlatformEvent(document: PlatformEventMongoDocument): PlatformEvent {
    const event = document.event as unknown as PlatformEvent;
    return {
      ...event,
      id: document.id,
      schemaVersion: PLATFORM_EVENT_SCHEMA_VERSION,
      type: document.type,
      roomId: document.roomId,
      ...(document.actorType
        ? {
            actor: {
              type: document.actorType,
              participantId: document.actorParticipantId,
              userId: document.actorUserId,
              label: document.actorLabel,
              nodeId: document.actorNodeId,
              workerId: document.actorWorkerId
            }
          }
        : {}),
      sourceNodeId: document.sourceNodeId,
      timestamp: document.occurredAt.toISOString()
    } as PlatformEvent;
  }

  private toWebhookEndpoint(document: WebhookEndpointMongoDocument): WebhookEndpoint {
    return {
      id: document.id,
      name: document.name,
      enabled: document.enabled,
      url: document.url,
      subscribedEventTypes: document.subscribedEventTypes,
      roomFilterIds: document.roomFilterIds,
      timeoutMs: document.timeoutMs,
      maxAttempts: document.maxAttempts,
      initialBackoffMs: document.initialBackoffMs,
      signingAlgorithm: document.signingAlgorithm,
      secretConfigured: Boolean(document.secretFingerprint),
      secretFingerprint: document.secretFingerprint,
      secretLastRotatedAt: document.secretLastRotatedAt?.toISOString(),
      health: {
        status: document.enabled ? document.health.status : 'disabled',
        lastDeliveryStatus: document.health.lastDeliveryStatus,
        lastDeliveryAt: document.health.lastDeliveryAt?.toISOString(),
        lastResponseStatusCode: document.health.lastResponseStatusCode,
        lastError: document.health.lastError,
        lastFailureCategory: document.health.lastFailureCategory,
        lastDeliveryReference: document.health.lastDeliveryReference,
        consecutiveFailures: document.health.consecutiveFailures
      },
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString()
    };
  }

  private toRedisStreamEndpoint(document: RedisStreamEndpointMongoDocument): RedisStreamEndpoint {
    return {
      id: document.id,
      adapterKind: 'redis-stream',
      name: document.name,
      enabled: document.enabled,
      streamKey: document.streamKey,
      maxLen: document.maxLen,
      subscribedEventTypes: document.subscribedEventTypes,
      roomFilterIds: document.roomFilterIds,
      timeoutMs: document.timeoutMs,
      maxAttempts: document.maxAttempts,
      initialBackoffMs: document.initialBackoffMs,
      health: {
        status: document.enabled ? document.health.status : 'disabled',
        lastDeliveryStatus: document.health.lastDeliveryStatus,
        lastDeliveryAt: document.health.lastDeliveryAt?.toISOString(),
        lastError: document.health.lastError,
        lastFailureCategory: document.health.lastFailureCategory,
        lastDeliveryReference: document.health.lastDeliveryReference,
        consecutiveFailures: document.health.consecutiveFailures
      },
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString()
    };
  }

  private toWebhookDelivery(document: WebhookDeliveryMongoDocument): WebhookDelivery {
    const snapshot = this.readDeliverySnapshot(document);
    return {
      id: document.id,
      adapterKind: document.adapterKind,
      endpointId: document.endpointId,
      eventId: document.eventId,
      eventType: document.eventType,
      roomId: document.roomId,
      status: document.status,
      snapshotSource: document.snapshotSource,
      endpointSnapshot: this.serializeDeliverySnapshot(snapshot),
      attemptCount: document.attemptCount,
      lastResponseStatusCode: document.lastResponseStatusCode,
      lastError: document.lastError,
      lastFailureCategory: document.lastFailureCategory,
      lastDeliveryReference: document.lastDeliveryReference,
      nextAttemptAt: document.nextAttemptAt?.toISOString(),
      deliveredAt: document.deliveredAt?.toISOString(),
      exhaustedAt: document.exhaustedAt?.toISOString(),
      cancelledAt: document.cancelledAt?.toISOString(),
      replayOfDeliveryId: document.replayOfDeliveryId,
      replayedBy: document.replayedBy
        ? {
            type: document.replayedBy.type!,
            participantId: document.replayedBy.participantId,
            userId: document.replayedBy.userId,
            label: document.replayedBy.label,
            nodeId: document.replayedBy.nodeId,
            workerId: document.replayedBy.workerId
          }
        : undefined,
      attempts: (document.attempts ?? []).map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        attemptedAt: attempt.attemptedAt.toISOString(),
        completedAt: attempt.completedAt.toISOString(),
        status: attempt.status,
        responseStatusCode: attempt.responseStatusCode,
        durationMs: attempt.durationMs,
        error: attempt.error,
        failureCategory: attempt.failureCategory,
        deliveryReference: attempt.deliveryReference,
        nextAttemptAt: attempt.nextAttemptAt?.toISOString()
      })),
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString()
    };
  }

  private encryptSecret(value: string): { ciphertext: string; iv: string; authTag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secretKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64')
    };
  }

  private decryptSnapshotSecret(snapshot: InternalWebhookEndpointSnapshot): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.secretKey,
      Buffer.from(snapshot.signingSecretIv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(snapshot.signingSecretAuthTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(snapshot.signingSecretCiphertext, 'base64')),
      decipher.final()
    ]);
    return plaintext.toString('utf8');
  }

  private signPayload(timestamp: string, body: string, snapshot: InternalWebhookEndpointSnapshot): string {
    const secret = this.decryptSnapshotSecret(snapshot);
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `sha256=${digest}`;
  }

  private createDeliverySnapshotFromEndpoint(endpoint: DeliveryEndpointDocument): InternalDeliverySnapshot {
    if (endpoint.adapterKind === 'webhook') {
      return {
        adapterKind: 'webhook',
        url: endpoint.url,
        signingAlgorithm: endpoint.signingAlgorithm,
        secretFingerprint: endpoint.secretFingerprint,
        timeoutMs: endpoint.timeoutMs,
        maxAttempts: endpoint.maxAttempts,
        initialBackoffMs: endpoint.initialBackoffMs,
        subscribedEventTypes: [...endpoint.subscribedEventTypes],
        roomFilterIds: [...(endpoint.roomFilterIds ?? [])],
        endpointUpdatedAt: endpoint.updatedAt,
        secretLastRotatedAt: endpoint.secretLastRotatedAt,
        signingSecretCiphertext: endpoint.signingSecretCiphertext,
        signingSecretIv: endpoint.signingSecretIv,
        signingSecretAuthTag: endpoint.signingSecretAuthTag
      };
    }
    return {
      adapterKind: 'redis-stream',
      streamKey: endpoint.streamKey,
      maxLen: endpoint.maxLen,
      timeoutMs: endpoint.timeoutMs,
      maxAttempts: endpoint.maxAttempts,
      initialBackoffMs: endpoint.initialBackoffMs,
      subscribedEventTypes: [...endpoint.subscribedEventTypes],
      roomFilterIds: [...(endpoint.roomFilterIds ?? [])],
      endpointUpdatedAt: endpoint.updatedAt
    };
  }

  private readDeliverySnapshot(document: WebhookDeliveryMongoDocument): InternalDeliverySnapshot {
    const snapshot = document.endpointSnapshot as unknown as Record<string, unknown> & {
      adapterKind?: WebhookDelivery['adapterKind'];
      endpointUpdatedAt?: Date | string;
      secretLastRotatedAt?: Date | string;
    };
    if (snapshot.adapterKind === 'redis-stream') {
      return {
        adapterKind: 'redis-stream',
        streamKey: String(snapshot.streamKey ?? ''),
        maxLen: snapshot.maxLen as number | undefined,
        timeoutMs: Number(snapshot.timeoutMs),
        maxAttempts: Number(snapshot.maxAttempts),
        initialBackoffMs: Number(snapshot.initialBackoffMs),
        subscribedEventTypes: [...((snapshot.subscribedEventTypes as PlatformEventType[] | undefined) ?? [])],
        roomFilterIds: [...((snapshot.roomFilterIds as string[] | undefined) ?? [])],
        endpointUpdatedAt: normalizeSnapshotDate(snapshot.endpointUpdatedAt)
      };
    }
    return {
      adapterKind: 'webhook',
      url: String(snapshot.url ?? ''),
      signingAlgorithm: 'hmac-sha256',
      secretFingerprint: snapshot.secretFingerprint as string | undefined,
      timeoutMs: Number(snapshot.timeoutMs),
      maxAttempts: Number(snapshot.maxAttempts),
      initialBackoffMs: Number(snapshot.initialBackoffMs),
      subscribedEventTypes: [...((snapshot.subscribedEventTypes as PlatformEventType[] | undefined) ?? [])],
      roomFilterIds: [...((snapshot.roomFilterIds as string[] | undefined) ?? [])],
      endpointUpdatedAt: normalizeSnapshotDate(snapshot.endpointUpdatedAt),
      secretLastRotatedAt: normalizeSnapshotDate(snapshot.secretLastRotatedAt),
      signingSecretCiphertext: snapshot.signingSecretCiphertext as string,
      signingSecretIv: snapshot.signingSecretIv as string,
      signingSecretAuthTag: snapshot.signingSecretAuthTag as string
    };
  }

  private serializeDeliverySnapshot(snapshot: InternalDeliverySnapshot): EventDeliverySnapshot {
    if (snapshot.adapterKind === 'redis-stream') {
      return {
        adapterKind: 'redis-stream',
        streamKey: snapshot.streamKey,
        maxLen: snapshot.maxLen,
        timeoutMs: snapshot.timeoutMs,
        maxAttempts: snapshot.maxAttempts,
        initialBackoffMs: snapshot.initialBackoffMs,
        subscribedEventTypes: snapshot.subscribedEventTypes,
        roomFilterIds: snapshot.roomFilterIds,
        endpointUpdatedAt: snapshot.endpointUpdatedAt?.toISOString()
      };
    }
    return {
      adapterKind: 'webhook',
      url: snapshot.url,
      signingAlgorithm: snapshot.signingAlgorithm,
      secretFingerprint: snapshot.secretFingerprint,
      timeoutMs: snapshot.timeoutMs,
      maxAttempts: snapshot.maxAttempts,
      initialBackoffMs: snapshot.initialBackoffMs,
      subscribedEventTypes: snapshot.subscribedEventTypes,
      roomFilterIds: snapshot.roomFilterIds,
      endpointUpdatedAt: snapshot.endpointUpdatedAt?.toISOString(),
      secretLastRotatedAt: snapshot.secretLastRotatedAt?.toISOString()
    };
  }

  private async loadOutstandingBacklogLanes(): Promise<OutstandingBacklogLane[]> {
    const maxAggregateDate = latestPossibleDate();
    const backlog = await this.webhookDeliveries.aggregate<{
      _id: { adapterKind: WebhookDelivery['adapterKind']; endpointId: string };
      total: number;
      queued: number;
      retrying: number;
      dispatching: number;
      oldestQueuedAt: Date;
      oldestRetryingAt: Date;
      oldestDispatchingAt: Date;
    }>([
      {
        $match: {
          status: { $in: ['queued', 'retrying', 'dispatching'] }
        }
      },
      {
        $group: {
          _id: { adapterKind: '$adapterKind', endpointId: '$endpointId' },
          total: { $sum: 1 },
          queued: { $sum: { $cond: [{ $eq: ['$status', 'queued'] }, 1, 0] } },
          retrying: { $sum: { $cond: [{ $eq: ['$status', 'retrying'] }, 1, 0] } },
          dispatching: { $sum: { $cond: [{ $eq: ['$status', 'dispatching'] }, 1, 0] } },
          oldestQueuedAt: {
            $min: {
              $cond: [{ $eq: ['$status', 'queued'] }, '$createdAt', maxAggregateDate]
            }
          },
          oldestRetryingAt: {
            $min: {
              $cond: [{ $eq: ['$status', 'retrying'] }, '$createdAt', maxAggregateDate]
            }
          },
          oldestDispatchingAt: {
            $min: {
              $cond: [{ $eq: ['$status', 'dispatching'] }, '$createdAt', maxAggregateDate]
            }
          }
        }
      },
      { $sort: { total: -1, '_id.adapterKind': 1, '_id.endpointId': 1 } }
    ]);
    return backlog.map((entry) => ({
      adapterKind: entry._id.adapterKind,
      endpointId: entry._id.endpointId,
      total: entry.total,
      queued: entry.queued,
      retrying: entry.retrying,
      dispatching: entry.dispatching,
      oldestQueuedAt: normalizeOutstandingAggregateDate(entry.oldestQueuedAt, maxAggregateDate),
      oldestRetryingAt: normalizeOutstandingAggregateDate(entry.oldestRetryingAt, maxAggregateDate),
      oldestDispatchingAt: normalizeOutstandingAggregateDate(entry.oldestDispatchingAt, maxAggregateDate)
    }));
  }

  private async findEligibleDeliveryLanes(now: Date, excludedLaneKeys: string[]): Promise<EligibleDeliveryLane[]> {
    const lanes = await this.webhookDeliveries.aggregate<{
      _id: { adapterKind: WebhookDelivery['adapterKind']; endpointId: string };
      liveDispatching: number;
      expiredDispatching: number;
      dueQueued: number;
      dueRetrying: number;
      oldestCreatedAt?: Date;
    }>([
      {
        $match: {
          status: { $in: ['queued', 'retrying', 'dispatching'] }
        }
      },
      {
        $group: {
          _id: { adapterKind: '$adapterKind', endpointId: '$endpointId' },
          liveDispatching: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'dispatching'] },
                    { $gt: ['$lockedUntil', now] }
                  ]
                },
                1,
                0
              ]
            }
          },
          expiredDispatching: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'dispatching'] },
                    { $lte: ['$lockedUntil', now] }
                  ]
                },
                1,
                0
              ]
            }
          },
          dueQueued: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'queued'] },
                    { $lte: ['$nextAttemptAt', now] },
                    {
                      $or: [
                        { $eq: ['$lockedUntil', null] },
                        { $lte: ['$lockedUntil', now] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          dueRetrying: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'retrying'] },
                    { $lte: ['$nextAttemptAt', now] },
                    {
                      $or: [
                        { $eq: ['$lockedUntil', null] },
                        { $lte: ['$lockedUntil', now] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          oldestCreatedAt: { $min: '$createdAt' }
        }
      }
    ]);
    const excluded = new Set(excludedLaneKeys);
    return lanes
      .map((lane) => ({
        adapterKind: lane._id.adapterKind,
        endpointId: lane._id.endpointId,
        liveDispatching: lane.liveDispatching,
        expiredDispatching: lane.expiredDispatching,
        dueQueued: lane.dueQueued,
        dueRetrying: lane.dueRetrying,
        nextDueAt: lane.oldestCreatedAt
      }))
      .filter((lane) => {
        if (lane.liveDispatching >= this.deliveryMaxConcurrentPerEndpoint) {
          return false;
        }
        const endpointKey = this.deliveryEndpointKey(lane.adapterKind, lane.endpointId);
        if (excluded.has(endpointKey) || excluded.has(`adapter:${lane.adapterKind}`)) {
          return false;
        }
        return lane.expiredDispatching > 0 || lane.dueQueued > 0 || lane.dueRetrying > 0;
      });
  }

  private adapterOrder(): WebhookDelivery['adapterKind'][] {
    const kinds = this.adapterRegistry.registeredKinds() as WebhookDelivery['adapterKind'][];
    if (kinds.length === 0) {
      return ['webhook'];
    }
    const offset = this.nextAdapterIndex % kinds.length;
    return [...kinds.slice(offset), ...kinds.slice(0, offset)];
  }

  private deliveryEndpointKey(adapterKind: WebhookDelivery['adapterKind'], endpointId: string): string {
    return `${adapterKind}:${endpointId}`;
  }

  private async findEndpointById(
    endpointId: string,
    adapterKind?: WebhookDelivery['adapterKind']
  ): Promise<DeliveryEndpointDocument | null> {
    if (adapterKind === 'webhook') {
      return this.webhookEndpoints.findById(endpointId).select(
        '+signingSecretCiphertext +signingSecretIv +signingSecretAuthTag'
      ) as Promise<DeliveryEndpointDocument | null>;
    }
    if (adapterKind === 'redis-stream') {
      return this.redisStreamEndpoints.findById(endpointId) as Promise<DeliveryEndpointDocument | null>;
    }
    const [webhookEndpoint, redisStreamEndpoint] = await Promise.all([
      this.webhookEndpoints.findById(endpointId).select('+signingSecretCiphertext +signingSecretIv +signingSecretAuthTag'),
      this.redisStreamEndpoints.findById(endpointId)
    ]);
    return webhookEndpoint ?? redisStreamEndpoint;
  }

  private async refreshWebhookMetrics(): Promise<void> {
    const [
      totalWebhookEndpoints,
      enabledWebhookEndpoints,
      disabledWebhookEndpoints,
      unhealthyWebhookEndpoints,
      totalRedisStreamEndpoints,
      enabledRedisStreamEndpoints,
      disabledRedisStreamEndpoints,
      unhealthyRedisStreamEndpoints,
      deliveryCountsByAdapterRows,
      outstandingBacklogLanes
    ] = await Promise.all([
      this.webhookEndpoints.countDocuments(),
      this.webhookEndpoints.countDocuments({ enabled: true }),
      this.webhookEndpoints.countDocuments({ enabled: false }),
      this.webhookEndpoints.countDocuments({ 'health.status': { $in: ['degraded', 'failing'] } }),
      this.redisStreamEndpoints.countDocuments(),
      this.redisStreamEndpoints.countDocuments({ enabled: true }),
      this.redisStreamEndpoints.countDocuments({ enabled: false }),
      this.redisStreamEndpoints.countDocuments({ 'health.status': { $in: ['degraded', 'failing'] } }),
      this.webhookDeliveries.aggregate<{
        _id: { adapterKind: WebhookDelivery['adapterKind']; status: WebhookDeliveryStatus };
        count: number;
      }>([
        {
          $group: {
            _id: { adapterKind: '$adapterKind', status: '$status' },
            count: { $sum: 1 }
          }
        }
      ]),
      this.loadOutstandingBacklogLanes()
    ]);
    const backlogTelemetry = summarizeOutstandingBacklog(outstandingBacklogLanes, new Date());
    const deliveryCountsByAdapter = createEmptyDeliveryCountsByAdapter();
    for (const row of deliveryCountsByAdapterRows) {
      deliveryCountsByAdapter[row._id.adapterKind][row._id.status] = row.count;
    }
    const webhookCounts = deliveryCountsByAdapter.webhook;
    this.metrics.webhookEndpointCounts.labels('total').set(totalWebhookEndpoints);
    this.metrics.webhookEndpointCounts.labels('enabled').set(enabledWebhookEndpoints);
    this.metrics.webhookEndpointCounts.labels('disabled').set(disabledWebhookEndpoints);
    this.metrics.webhookEndpointCounts.labels('unhealthy').set(unhealthyWebhookEndpoints);
    this.metrics.webhookDeliveryQueue.labels('queued').set(webhookCounts.queued);
    this.metrics.webhookDeliveryQueue.labels('retrying').set(webhookCounts.retrying);
    this.metrics.webhookDeliveryQueue.labels('dispatching').set(webhookCounts.dispatching);
    this.metrics.webhookDeliveryQueue.labels('exhausted').set(webhookCounts.exhausted);
    this.metrics.webhookActiveDispatches.set(this.activeDispatches);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('webhook', 'total').set(totalWebhookEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('webhook', 'enabled').set(enabledWebhookEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('webhook', 'disabled').set(disabledWebhookEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('webhook', 'unhealthy').set(unhealthyWebhookEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('redis-stream', 'total').set(totalRedisStreamEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('redis-stream', 'enabled').set(enabledRedisStreamEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('redis-stream', 'disabled').set(disabledRedisStreamEndpoints);
    this.metrics.eventDeliveryEndpointCountsByAdapter.labels('redis-stream', 'unhealthy').set(unhealthyRedisStreamEndpoints);
    for (const adapterKind of EVENT_DELIVERY_ADAPTER_KINDS) {
      const counts = deliveryCountsByAdapter[adapterKind];
      this.metrics.eventDeliveryQueueByAdapter.labels(adapterKind, 'queued').set(counts.queued);
      this.metrics.eventDeliveryQueueByAdapter.labels(adapterKind, 'retrying').set(counts.retrying);
      this.metrics.eventDeliveryQueueByAdapter.labels(adapterKind, 'dispatching').set(counts.dispatching);
      this.metrics.eventDeliveryQueueByAdapter.labels(adapterKind, 'delivered').set(counts.delivered);
      this.metrics.eventDeliveryQueueByAdapter.labels(adapterKind, 'exhausted').set(counts.exhausted);
      this.metrics.eventDeliveryQueueByAdapter.labels(adapterKind, 'cancelled').set(counts.cancelled);
      this.metrics.eventDeliveryActiveDispatchesByAdapter.labels(adapterKind).set(this.activeDispatchesByAdapter.get(adapterKind) ?? 0);
      const backlogAging = backlogTelemetry.backlogAgingByAdapter[adapterKind];
      this.metrics.eventDeliveryOldestAgeByAdapter.labels(adapterKind, 'queued').set(backlogAging.queued);
      this.metrics.eventDeliveryOldestAgeByAdapter.labels(adapterKind, 'retrying').set(backlogAging.retrying);
      this.metrics.eventDeliveryOldestAgeByAdapter.labels(adapterKind, 'dispatching').set(backlogAging.dispatching);
      const laneCounts = backlogTelemetry.laneCountsByAdapter[adapterKind];
      this.metrics.eventDeliveryLaneCounts.labels(adapterKind, 'queued').set(laneCounts.queued);
      this.metrics.eventDeliveryLaneCounts.labels(adapterKind, 'retrying').set(laneCounts.retrying);
      this.metrics.eventDeliveryLaneCounts.labels(adapterKind, 'dispatching').set(laneCounts.dispatching);
      this.metrics.eventDeliveryBacklogConcentration.labels(adapterKind).set(
        backlogTelemetry.fairness.largestBacklogEndpointShareByAdapter[adapterKind]
      );
    }
    this.metrics.eventDeliveryBacklogConcentration.labels('overall').set(backlogTelemetry.fairness.largestBacklogEndpointShare);
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(value), 200));
}

function buildEventQueryFilter(query: PlatformEventQuery): Record<string, unknown> {
  const occurredAt: Record<string, Date> = {};
  if (query.from) {
    occurredAt.$gte = parseQueryDate(query.from, 'from');
  }
  if (query.to) {
    occurredAt.$lte = parseQueryDate(query.to, 'to');
  }
  return {
    ...(query.roomId ? { roomId: query.roomId } : {}),
    ...(query.eventTypes?.length ? { type: { $in: dedupeEventTypes(query.eventTypes) } } : {}),
    ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    ...(query.actorParticipantId ? { actorParticipantId: query.actorParticipantId } : {}),
    ...(Object.keys(occurredAt).length > 0 ? { occurredAt } : {})
  };
}

function buildDeliveryQueryFilter(query: WebhookDeliveryQuery): Record<string, unknown> {
  const createdAt: Record<string, Date> = {};
  if (query.from) {
    createdAt.$gte = parseQueryDate(query.from, 'from');
  }
  if (query.to) {
    createdAt.$lte = parseQueryDate(query.to, 'to');
  }
  return {
    ...(query.endpointId ? { endpointId: query.endpointId } : {}),
    ...(query.eventId ? { eventId: query.eventId } : {}),
    ...(query.roomId ? { roomId: query.roomId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.eventTypes?.length ? { eventType: { $in: dedupeEventTypes(query.eventTypes) } } : {}),
    ...(Object.keys(createdAt).length > 0 ? { createdAt } : {})
  };
}

function sanitizeActor(actor: PlatformEventActor): PlatformEventActor {
  return {
    type: actor.type,
    ...(actor.participantId ? { participantId: actor.participantId } : {}),
    ...(actor.userId ? { userId: actor.userId } : {}),
    ...(actor.label ? { label: actor.label } : {}),
    ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
    ...(actor.workerId ? { workerId: actor.workerId } : {})
  };
}

function defaultOperatorActor(): PlatformEventActor {
  return {
    type: 'operator',
    label: 'operations-token'
  };
}

function validateWebhookEndpointRequest(
  request: Partial<Pick<CreateWebhookEndpointRequest, 'name' | 'url' | 'subscribedEventTypes' | 'timeoutMs' | 'maxAttempts' | 'initialBackoffMs'>>,
  partial = false,
  productionMode = false
): void {
  if (!partial || request.name !== undefined) {
    if (!request.name?.trim()) {
      throw new BadRequestException('Webhook endpoint name is required');
    }
  }
  if (!partial || request.url !== undefined) {
    validateWebhookUrl(request.url, productionMode);
  }
  if (!partial || request.subscribedEventTypes !== undefined) {
    if (!request.subscribedEventTypes?.length) {
      throw new BadRequestException('At least one subscribed event type is required');
    }
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 500 || request.timeoutMs > 30_000)) {
    throw new BadRequestException('Webhook timeout must be between 500ms and 30000ms');
  }
  if (request.maxAttempts !== undefined && (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 10)) {
    throw new BadRequestException('Webhook maxAttempts must be between 1 and 10');
  }
  if (
    request.initialBackoffMs !== undefined
    && (!Number.isFinite(request.initialBackoffMs) || request.initialBackoffMs < 250 || request.initialBackoffMs > 3_600_000)
  ) {
    throw new BadRequestException('Webhook initialBackoffMs must be between 250ms and 3600000ms');
  }
}

function validateRedisStreamEndpointRequest(
  request: Partial<Pick<CreateRedisStreamEndpointRequest, 'name' | 'streamKey' | 'subscribedEventTypes' | 'timeoutMs' | 'maxAttempts' | 'initialBackoffMs' | 'maxLen'>>,
  partial = false
): void {
  if (!partial || request.name !== undefined) {
    if (!request.name?.trim()) {
      throw new BadRequestException('Redis stream endpoint name is required');
    }
  }
  if (!partial || request.streamKey !== undefined) {
    if (!request.streamKey?.trim()) {
      throw new BadRequestException('Redis stream endpoint streamKey is required');
    }
  }
  if (!partial || request.subscribedEventTypes !== undefined) {
    if (!request.subscribedEventTypes?.length) {
      throw new BadRequestException('At least one subscribed event type is required');
    }
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 30_000)) {
    throw new BadRequestException('Redis stream timeout must be between 100ms and 30000ms');
  }
  if (request.maxAttempts !== undefined && (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 10)) {
    throw new BadRequestException('Redis stream maxAttempts must be between 1 and 10');
  }
  if (
    request.initialBackoffMs !== undefined
    && (!Number.isFinite(request.initialBackoffMs) || request.initialBackoffMs < 250 || request.initialBackoffMs > 3_600_000)
  ) {
    throw new BadRequestException('Redis stream initialBackoffMs must be between 250ms and 3600000ms');
  }
  if (request.maxLen !== undefined && (!Number.isInteger(request.maxLen) || request.maxLen < 1 || request.maxLen > 5_000_000)) {
    throw new BadRequestException('Redis stream maxLen must be between 1 and 5000000');
  }
}

function validateWebhookUrl(value: string | undefined, productionMode: boolean): void {
  if (!value?.trim()) {
    throw new BadRequestException('Webhook endpoint URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('Webhook endpoint URL must be a valid absolute URL');
  }
  if (productionMode && parsed.protocol !== 'https:') {
    throw new BadRequestException('Webhook endpoint URL must use https in production');
  }
  if (!productionMode && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('Webhook endpoint URL must use http or https');
  }
  if (productionMode && isBlockedWebhookHost(parsed.hostname)) {
    throw new BadRequestException('Webhook endpoint URL must not use localhost or wildcard addresses');
  }
}

function dedupeEventTypes<TType extends PlatformEventType>(types: TType[]): TType[] {
  return [...new Set(types)];
}

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function deriveEndpointHealthStatus(consecutiveFailures: number): 'healthy' | 'degraded' | 'failing' {
  if (consecutiveFailures >= 3) {
    return 'failing';
  }
  if (consecutiveFailures >= 1) {
    return 'degraded';
  }
  return 'healthy';
}

function computeBackoffMs(initialBackoffMs: number, attemptNumber: number): number {
  return Math.min(initialBackoffMs * 2 ** Math.max(0, attemptNumber - 1), 60_000);
}

function randomSecret(): string {
  return randomBytes(24).toString('base64url');
}

function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function validateWebhookSigningSecret(secret: string): void {
  if (secret.trim().length < 24) {
    throw new BadRequestException('Webhook signing secret must be at least 24 characters');
  }
}

function parseQueryDate(value: string, label: 'from' | 'to'): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid ${label} timestamp`);
  }
  return parsed;
}

function isReplayableDeliveryStatus(status: WebhookDeliveryStatus): boolean {
  return status === 'cancelled' || status === 'exhausted';
}

function deletedCount(result: { deletedCount?: number } | undefined): number {
  return result?.deletedCount ?? 0;
}

function normalizeSnapshotDate(value: Date | string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isBlockedWebhookHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (['localhost', '0.0.0.0', '::', '::1', '127.0.0.1'].includes(normalized)) {
    return true;
  }
  if (normalized.endsWith('.localhost')) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4 && normalized.startsWith('127.')) {
    return true;
  }
  return false;
}

function compareEligibleLanes(
  left: EligibleDeliveryLane,
  right: EligibleDeliveryLane,
  options: {
    preferRetry: boolean;
    adapterOrder: WebhookDelivery['adapterKind'][];
  }
): number {
  const adapterRank = new Map(options.adapterOrder.map((kind, index) => [kind, index]));
  const leftAdapterRank = adapterRank.get(left.adapterKind) ?? Number.MAX_SAFE_INTEGER;
  const rightAdapterRank = adapterRank.get(right.adapterKind) ?? Number.MAX_SAFE_INTEGER;
  if (leftAdapterRank !== rightAdapterRank) {
    return leftAdapterRank - rightAdapterRank;
  }

  const leftExpired = left.expiredDispatching > 0 ? 1 : 0;
  const rightExpired = right.expiredDispatching > 0 ? 1 : 0;
  if (leftExpired !== rightExpired) {
    return rightExpired - leftExpired;
  }

  const leftPreferred = options.preferRetry ? left.dueRetrying : left.dueQueued;
  const rightPreferred = options.preferRetry ? right.dueRetrying : right.dueQueued;
  if (leftPreferred !== rightPreferred) {
    return rightPreferred - leftPreferred;
  }

  const leftSecondary = options.preferRetry ? left.dueQueued : left.dueRetrying;
  const rightSecondary = options.preferRetry ? right.dueQueued : right.dueRetrying;
  if (leftSecondary !== rightSecondary) {
    return rightSecondary - leftSecondary;
  }

  if (left.liveDispatching !== right.liveDispatching) {
    return left.liveDispatching - right.liveDispatching;
  }

  const leftNextDue = left.nextDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightNextDue = right.nextDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftNextDue !== rightNextDue) {
    return leftNextDue - rightNextDue;
  }

  return left.endpointId.localeCompare(right.endpointId);
}

function isMongoDuplicateKeyError(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) {
          accumulator[key] = sortValue(entry);
        }
        return accumulator;
      }, {});
  }
  return value;
}

function zeroAdapterCountRecord(): Record<(typeof EVENT_DELIVERY_ADAPTER_KINDS)[number], number> {
  return Object.fromEntries(EVENT_DELIVERY_ADAPTER_KINDS.map((adapterKind) => [adapterKind, 0])) as Record<
    (typeof EVENT_DELIVERY_ADAPTER_KINDS)[number],
    number
  >;
}

function createEmptyDeliveryStatusCounts(): Record<WebhookDeliveryStatus, number> {
  return {
    queued: 0,
    retrying: 0,
    dispatching: 0,
    delivered: 0,
    exhausted: 0,
    cancelled: 0
  };
}

function createEmptyDeliveryCountsByAdapter(): Record<(typeof EVENT_DELIVERY_ADAPTER_KINDS)[number], Record<WebhookDeliveryStatus, number>> {
  return Object.fromEntries(
    EVENT_DELIVERY_ADAPTER_KINDS.map((adapterKind) => [adapterKind, createEmptyDeliveryStatusCounts()])
  ) as Record<(typeof EVENT_DELIVERY_ADAPTER_KINDS)[number], Record<WebhookDeliveryStatus, number>>;
}

function sumDeliveryCountsByAdapter(
  deliveryCountsByAdapter: Record<(typeof EVENT_DELIVERY_ADAPTER_KINDS)[number], Record<WebhookDeliveryStatus, number>>
): Record<WebhookDeliveryStatus, number> {
  const totals = createEmptyDeliveryStatusCounts();
  for (const adapterKind of EVENT_DELIVERY_ADAPTER_KINDS) {
    for (const status of Object.keys(totals) as WebhookDeliveryStatus[]) {
      totals[status] += deliveryCountsByAdapter[adapterKind][status];
    }
  }
  return totals;
}

function zeroFailureCategoryCounts(): Record<(typeof EVENT_DELIVERY_FAILURE_CATEGORIES)[number], number> {
  return Object.fromEntries(EVENT_DELIVERY_FAILURE_CATEGORIES.map((category) => [category, 0])) as Record<
    (typeof EVENT_DELIVERY_FAILURE_CATEGORIES)[number],
    number
  >;
}

function zeroSnapshotSourceCounts(): Record<(typeof DELIVERY_SNAPSHOT_SOURCES)[number], number> {
  return Object.fromEntries(DELIVERY_SNAPSHOT_SOURCES.map((source) => [source, 0])) as Record<
    (typeof DELIVERY_SNAPSHOT_SOURCES)[number],
    number
  >;
}

function createEmptyBacklogAgingSummary(): DeliveryBacklogAgingSummary {
  return {
    queued: 0,
    retrying: 0,
    dispatching: 0
  };
}

function createBacklogAgingByAdapter(): Record<(typeof EVENT_DELIVERY_ADAPTER_KINDS)[number], DeliveryBacklogAgingSummary> {
  return Object.fromEntries(
    EVENT_DELIVERY_ADAPTER_KINDS.map((adapterKind) => [adapterKind, createEmptyBacklogAgingSummary()])
  ) as Record<(typeof EVENT_DELIVERY_ADAPTER_KINDS)[number], DeliveryBacklogAgingSummary>;
}

function latestPossibleDate(): Date {
  return new Date('9999-12-31T23:59:59.999Z');
}

function normalizeOutstandingAggregateDate(value: Date | undefined, maxAggregateDate: Date): Date | undefined {
  if (!value) {
    return undefined;
  }
  return value.getTime() === maxAggregateDate.getTime() ? undefined : value;
}

function ageSince(value: Date | undefined, now: Date): number {
  if (!value) {
    return 0;
  }
  return Math.max(0, now.getTime() - value.getTime());
}

function summarizeOutstandingBacklog(lanes: OutstandingBacklogLane[], now: Date): OutstandingBacklogTelemetry {
  const backlogAging = createEmptyBacklogAgingSummary();
  const backlogAgingByAdapter = createBacklogAgingByAdapter();
  const laneCountsByAdapter = createBacklogAgingByAdapter();
  const largestBacklogShareByAdapter = zeroAdapterCountRecord();
  const totalOutstanding = lanes.reduce((sum, lane) => sum + lane.total, 0);
  const totalByAdapter = zeroAdapterCountRecord();
  let activeLaneCount = 0;
  let queuedLaneCount = 0;
  let retryingLaneCount = 0;
  let dispatchingLaneCount = 0;
  let largestOutstandingLane = 0;

  for (const lane of lanes) {
    activeLaneCount += 1;
    totalByAdapter[lane.adapterKind] += lane.total;
    largestOutstandingLane = Math.max(largestOutstandingLane, lane.total);

    if (lane.queued > 0) {
      queuedLaneCount += 1;
      laneCountsByAdapter[lane.adapterKind].queued += 1;
      const queuedAge = ageSince(lane.oldestQueuedAt, now);
      backlogAging.queued = Math.max(backlogAging.queued, queuedAge);
      backlogAgingByAdapter[lane.adapterKind].queued = Math.max(backlogAgingByAdapter[lane.adapterKind].queued, queuedAge);
    }
    if (lane.retrying > 0) {
      retryingLaneCount += 1;
      laneCountsByAdapter[lane.adapterKind].retrying += 1;
      const retryAge = ageSince(lane.oldestRetryingAt, now);
      backlogAging.retrying = Math.max(backlogAging.retrying, retryAge);
      backlogAgingByAdapter[lane.adapterKind].retrying = Math.max(backlogAgingByAdapter[lane.adapterKind].retrying, retryAge);
    }
    if (lane.dispatching > 0) {
      dispatchingLaneCount += 1;
      laneCountsByAdapter[lane.adapterKind].dispatching += 1;
      const dispatchAge = ageSince(lane.oldestDispatchingAt, now);
      backlogAging.dispatching = Math.max(backlogAging.dispatching, dispatchAge);
      backlogAgingByAdapter[lane.adapterKind].dispatching = Math.max(backlogAgingByAdapter[lane.adapterKind].dispatching, dispatchAge);
    }
  }

  for (const adapterKind of EVENT_DELIVERY_ADAPTER_KINDS) {
    const adapterTotal = totalByAdapter[adapterKind];
    if (adapterTotal === 0) {
      continue;
    }
    const largestLaneForAdapter = lanes
      .filter((lane) => lane.adapterKind === adapterKind)
      .reduce((max, lane) => Math.max(max, lane.total), 0);
    largestBacklogShareByAdapter[adapterKind] = largestLaneForAdapter / adapterTotal;
  }

  const topBacklogEndpoints = [...lanes]
    .sort((left, right) =>
      right.total - left.total
      || left.adapterKind.localeCompare(right.adapterKind)
      || left.endpointId.localeCompare(right.endpointId)
    )
    .slice(0, 5)
    .map<DeliveryBacklogEndpointSummary>((lane) => ({
      adapterKind: lane.adapterKind,
      endpointId: lane.endpointId,
      total: lane.total,
      queued: lane.queued,
      retrying: lane.retrying,
      dispatching: lane.dispatching
    }));

  return {
    backlogAging,
    backlogAgingByAdapter,
    laneCountsByAdapter,
    fairness: {
      activeLaneCount,
      queuedLaneCount,
      retryingLaneCount,
      dispatchingLaneCount,
      largestBacklogEndpointShare: totalOutstanding > 0 ? largestOutstandingLane / totalOutstanding : 0,
      largestBacklogEndpointShareByAdapter: largestBacklogShareByAdapter
    },
    topBacklogEndpoints
  };
}
