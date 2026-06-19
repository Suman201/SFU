import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  CreateWebhookEndpointRequest,
  EventingDiagnosticsSummary,
  PLATFORM_EVENT_SCHEMA_VERSION,
  PlatformEvent,
  PlatformEventActor,
  PlatformEventBase,
  PlatformEventListResponse,
  PlatformEventPayloadByType,
  PlatformEventQuery,
  PlatformEventType,
  ReplayWebhookDeliveryResponse,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  WebhookDeliveryListResponse,
  WebhookDeliveryQuery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointListResponse,
  WebhookEndpointSecretResponse
} from '@native-sfu/contracts';
import { Model } from 'mongoose';
import { NodeRegistryService } from '../cluster/node-registry.service';
import {
  PlatformEventDocument,
  PlatformEventMongoDocument,
  WebhookDeliveryDocument,
  WebhookDeliveryMongoDocument,
  WebhookEndpointDocument,
  WebhookEndpointMongoDocument
} from '../database/schemas';
import { MetricsService } from '../metrics/metrics.service';

type AppendPlatformEventOptions = {
  deliverWebhook?: boolean;
};

type ReplayContext = {
  replayOfDeliveryId?: string;
  replayedBy?: PlatformEventActor;
};

@Injectable()
export class PlatformEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformEventsService.name);
  private pumpTimer?: NodeJS.Timeout;
  private pumpActive = false;
  private readonly webhookEnabled: boolean;
  private readonly secretKey: Buffer;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultInitialBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;

  constructor(
    @InjectModel(PlatformEventDocument.name) private readonly platformEvents: Model<PlatformEventMongoDocument>,
    @InjectModel(WebhookEndpointDocument.name) private readonly webhookEndpoints: Model<WebhookEndpointMongoDocument>,
    @InjectModel(WebhookDeliveryDocument.name) private readonly webhookDeliveries: Model<WebhookDeliveryMongoDocument>,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly nodeRegistry: NodeRegistryService
  ) {
    this.webhookEnabled = this.config.get<boolean>('events.webhooks.enabled', true);
    this.defaultTimeoutMs = this.config.get<number>('events.webhooks.defaultTimeoutMs', 5000);
    this.defaultMaxAttempts = this.config.get<number>('events.webhooks.defaultMaxAttempts', 5);
    this.defaultInitialBackoffMs = this.config.get<number>('events.webhooks.defaultInitialBackoffMs', 2000);
    this.pollIntervalMs = this.config.get<number>('events.webhooks.pollIntervalMs', 1000);
    this.leaseMs = this.config.get<number>('events.webhooks.leaseMs', 30000);
    const secret = this.config.get<string>('events.webhooks.secretEncryptionKey', this.config.getOrThrow<string>('jwt.accessSecret'));
    this.secretKey = createHash('sha256').update(secret).digest();
  }

  onModuleInit(): void {
    if (!this.webhookEnabled) {
      return;
    }
    this.pumpTimer = setInterval(() => {
      void this.pumpDueDeliveries().catch((error) => {
        this.logger.warn(`Webhook delivery pump failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.pollIntervalMs);
    void this.refreshWebhookMetrics().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
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
      await this.enqueueWebhookDeliveries(storedEvent as PlatformEvent);
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
    validateWebhookEndpointRequest(request);
    const signingSecret = request.signingSecret?.trim() || randomSecret();
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
    validateWebhookEndpointRequest(request, true);
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
            endpointId,
            status: { $in: ['queued', 'retrying'] }
          },
          {
            status: 'cancelled',
            cancelledAt: new Date(),
            lastError: 'endpoint_disabled'
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
    const delivery = await this.webhookDeliveries.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Webhook delivery not found');
    }
    const replay = await this.enqueueSingleDelivery(delivery.endpointId, delivery.eventId, {
      replayOfDeliveryId: delivery.id,
      replayedBy: sanitizeActor(actor)
    });
    this.metrics.webhookReplays.labels('delivery').inc();
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
      replayedBy: sanitizeActor(actor)
    });
    this.metrics.webhookReplays.labels('event').inc();
    await this.appendEvent(
      {
        type: 'operator.action.executed',
        roomId: replay.roomId,
        actor,
        payload: {
          action: 'event_replayed_to_endpoint',
          scope: 'webhook',
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
    const [totalEndpoints, enabledEndpoints, unhealthyEndpoints, queued, retrying, delivered, exhausted, cancelled, recentEventCount, lastEvent] =
      await Promise.all([
        this.webhookEndpoints.countDocuments(),
        this.webhookEndpoints.countDocuments({ enabled: true }),
        this.webhookEndpoints.countDocuments({ 'health.status': { $in: ['degraded', 'failing'] } }),
        this.webhookDeliveries.countDocuments({ status: 'queued' }),
        this.webhookDeliveries.countDocuments({ status: 'retrying' }),
        this.webhookDeliveries.countDocuments({ status: 'delivered' }),
        this.webhookDeliveries.countDocuments({ status: 'exhausted' }),
        this.webhookDeliveries.countDocuments({ status: 'cancelled' }),
        this.platformEvents.countDocuments({ occurredAt: { $gte: new Date(Date.now() - 24 * 60 * 60_000) } }),
        this.platformEvents.findOne().sort({ occurredAt: -1, createdAt: -1 })
      ]);
    return {
      observedAt: new Date().toISOString(),
      endpointCounts: {
        total: totalEndpoints,
        enabled: enabledEndpoints,
        disabled: Math.max(0, totalEndpoints - enabledEndpoints),
        unhealthy: unhealthyEndpoints
      },
      deliveryCounts: {
        queued,
        retrying,
        delivered,
        exhausted,
        cancelled
      },
      recentEventCount,
      lastEventAt: lastEvent?.occurredAt?.toISOString()
    };
  }

  private async enqueueWebhookDeliveries(event: PlatformEvent): Promise<void> {
    if (!this.webhookEnabled) {
      return;
    }
    const endpoints = await this.webhookEndpoints.find({
      enabled: true,
      subscribedEventTypes: event.type
    });
    if (endpoints.length === 0) {
      return;
    }
    const deliveries = endpoints
      .filter((endpoint) => this.endpointMatchesRoomFilter(endpoint, event.roomId))
      .map((endpoint) => ({
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: event.type,
        roomId: event.roomId,
        status: 'queued',
        attemptCount: 0,
        nextAttemptAt: new Date(),
        attempts: []
      }));
    if (deliveries.length === 0) {
      return;
    }
    await this.webhookDeliveries.insertMany(deliveries);
  }

  private endpointMatchesRoomFilter(endpoint: WebhookEndpointMongoDocument, roomId?: string): boolean {
    if (!endpoint.roomFilterIds?.length) {
      return true;
    }
    return roomId !== undefined && endpoint.roomFilterIds.includes(roomId);
  }

  private async enqueueSingleDelivery(endpointId: string, eventId: string, replayContext: ReplayContext = {}): Promise<WebhookDeliveryMongoDocument> {
    const [endpoint, event] = await Promise.all([this.webhookEndpoints.findById(endpointId), this.platformEvents.findById(eventId)]);
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    if (!event) {
      throw new NotFoundException('Platform event not found');
    }
    if (!endpoint.enabled) {
      throw new BadRequestException('Webhook endpoint is disabled');
    }
    const delivery = await this.webhookDeliveries.create({
      endpointId,
      eventId,
      eventType: event.type,
      roomId: event.roomId,
      status: 'queued',
      attemptCount: 0,
      nextAttemptAt: new Date(),
      attempts: [],
      ...(replayContext.replayOfDeliveryId ? { replayOfDeliveryId: replayContext.replayOfDeliveryId } : {}),
      ...(replayContext.replayedBy ? { replayedBy: replayContext.replayedBy } : {})
    });
    return delivery;
  }

  private async pumpDueDeliveries(): Promise<void> {
    if (this.pumpActive) {
      return;
    }
    this.pumpActive = true;
    try {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const delivery = await this.claimNextDueDelivery();
        if (!delivery) {
          break;
        }
        await this.dispatchDelivery(delivery);
      }
    } finally {
      this.pumpActive = false;
    }
  }

  private async claimNextDueDelivery(): Promise<WebhookDeliveryMongoDocument | null> {
    const now = new Date();
    return this.webhookDeliveries.findOneAndUpdate(
      {
        status: { $in: ['queued', 'retrying'] as WebhookDeliveryStatus[] },
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }]
      },
      {
        $set: {
          lockedBy: this.nodeRegistry.localNodeId(),
          lockedUntil: new Date(now.getTime() + this.leaseMs)
        }
      },
      {
        new: true,
        sort: {
          nextAttemptAt: 1,
          createdAt: 1
        }
      }
    );
  }

  private async dispatchDelivery(delivery: WebhookDeliveryMongoDocument): Promise<void> {
    const [eventDoc, endpointDoc] = await Promise.all([
      this.platformEvents.findById(delivery.eventId),
      this.webhookEndpoints.findById(delivery.endpointId).select('+signingSecretCiphertext +signingSecretIv +signingSecretAuthTag')
    ]);
    if (!eventDoc || !endpointDoc) {
      await this.cancelDelivery(delivery, !endpointDoc ? 'endpoint_missing' : 'event_missing');
      return;
    }
    if (!endpointDoc.enabled) {
      await this.cancelDelivery(delivery, 'endpoint_disabled');
      return;
    }

    const event = this.toPlatformEvent(eventDoc);
    const attemptNumber = delivery.attemptCount + 1;
    const attemptTimestamp = new Date().toISOString();
    const requestBody = stableStringify({
      deliveryId: delivery.id,
      eventId: event.id,
      attemptNumber,
      timestamp: attemptTimestamp,
      event
    });
    const signature = this.signPayload(attemptTimestamp, requestBody, endpointDoc);
    const startedAt = Date.now();
    this.metrics.webhookDeliveryAttempts.labels(event.type).inc();

    let outcome: 'succeeded' | 'failed' | 'timeout' = 'failed';
    let responseStatusCode: number | undefined;
    let errorMessage: string | undefined;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), endpointDoc.timeoutMs);
      try {
        const response = await fetch(endpointDoc.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-native-sfu-delivery-id': delivery.id,
            'x-native-sfu-event-id': event.id,
            'x-native-sfu-event-type': event.type,
            'x-native-sfu-timestamp': attemptTimestamp,
            'x-native-sfu-signature': signature
          },
          body: requestBody,
          signal: controller.signal
        });
        responseStatusCode = response.status;
        if (!response.ok) {
          throw new Error(`Received HTTP ${response.status}`);
        }
        outcome = 'succeeded';
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      outcome = isAbortError(error) ? 'timeout' : 'failed';
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const durationMs = Date.now() - startedAt;
    this.metrics.webhookDeliveryLatency.labels(outcome).observe(durationMs);
    const updatedDelivery = await this.webhookDeliveries.findById(delivery.id);
    if (!updatedDelivery) {
      return;
    }
    updatedDelivery.attemptCount = attemptNumber;
    updatedDelivery.lastResponseStatusCode = responseStatusCode;
    updatedDelivery.lastError = errorMessage;
    updatedDelivery.lockedBy = undefined;
    updatedDelivery.lockedUntil = undefined;
    updatedDelivery.attempts.push({
      attemptNumber,
      attemptedAt: new Date(attemptTimestamp),
      completedAt: new Date(),
      status: outcome,
      responseStatusCode,
      durationMs,
      ...(errorMessage ? { error: errorMessage } : {})
    } as never);

    if (outcome === 'succeeded') {
      updatedDelivery.status = 'delivered';
      updatedDelivery.deliveredAt = new Date();
      await updatedDelivery.save();
      endpointDoc.health.status = 'healthy';
      endpointDoc.health.lastDeliveryStatus = 'delivered';
      endpointDoc.health.lastDeliveryAt = new Date();
      endpointDoc.health.lastResponseStatusCode = responseStatusCode;
      endpointDoc.health.lastError = undefined;
      endpointDoc.health.consecutiveFailures = 0;
      await endpointDoc.save();
      this.metrics.webhookDeliveriesSucceeded.labels(event.type).inc();
      await this.refreshWebhookMetrics();
      return;
    }

    const nextAttemptAt = new Date(Date.now() + computeBackoffMs(endpointDoc.initialBackoffMs, attemptNumber));
    if (attemptNumber >= endpointDoc.maxAttempts) {
      updatedDelivery.status = 'exhausted';
      updatedDelivery.exhaustedAt = new Date();
      await updatedDelivery.save();
      endpointDoc.health.status = 'failing';
      endpointDoc.health.lastDeliveryStatus = 'exhausted';
      endpointDoc.health.lastDeliveryAt = new Date();
      endpointDoc.health.lastResponseStatusCode = responseStatusCode;
      endpointDoc.health.lastError = errorMessage;
      endpointDoc.health.consecutiveFailures += 1;
      await endpointDoc.save();
      this.metrics.webhookDeliveriesExhausted.labels(event.type).inc();
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
      endpointDoc.health.consecutiveFailures += 1;
      await endpointDoc.save();
      this.metrics.webhookRetriesScheduled.labels(event.type).inc();
      this.metrics.webhookDeliveriesFailed.labels(event.type).inc();
    }
    await this.refreshWebhookMetrics();
  }

  private async cancelDelivery(delivery: WebhookDeliveryMongoDocument, reason: string): Promise<void> {
    delivery.status = 'cancelled';
    delivery.cancelledAt = new Date();
    delivery.lastError = reason;
    delivery.lockedBy = undefined;
    delivery.lockedUntil = undefined;
    await delivery.save();
    this.metrics.webhookDeliveriesCancelled.labels(reason).inc();
    await this.refreshWebhookMetrics();
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
        consecutiveFailures: document.health.consecutiveFailures
      },
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString()
    };
  }

  private toWebhookDelivery(document: WebhookDeliveryMongoDocument): WebhookDelivery {
    return {
      id: document.id,
      endpointId: document.endpointId,
      eventId: document.eventId,
      eventType: document.eventType,
      roomId: document.roomId,
      status: document.status,
      attemptCount: document.attemptCount,
      lastResponseStatusCode: document.lastResponseStatusCode,
      lastError: document.lastError,
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

  private decryptSecret(endpoint: WebhookEndpointMongoDocument): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.secretKey,
      Buffer.from(endpoint.signingSecretIv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(endpoint.signingSecretAuthTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(endpoint.signingSecretCiphertext, 'base64')),
      decipher.final()
    ]);
    return plaintext.toString('utf8');
  }

  private signPayload(timestamp: string, body: string, endpoint: WebhookEndpointMongoDocument): string {
    const secret = this.decryptSecret(endpoint);
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `sha256=${digest}`;
  }

  private async refreshWebhookMetrics(): Promise<void> {
    const [totalEndpoints, enabledEndpoints, disabledEndpoints, unhealthyEndpoints, queued, retrying, exhausted] = await Promise.all([
      this.webhookEndpoints.countDocuments(),
      this.webhookEndpoints.countDocuments({ enabled: true }),
      this.webhookEndpoints.countDocuments({ enabled: false }),
      this.webhookEndpoints.countDocuments({ 'health.status': { $in: ['degraded', 'failing'] } }),
      this.webhookDeliveries.countDocuments({ status: 'queued' }),
      this.webhookDeliveries.countDocuments({ status: 'retrying' }),
      this.webhookDeliveries.countDocuments({ status: 'exhausted' })
    ]);
    this.metrics.webhookEndpointCounts.labels('total').set(totalEndpoints);
    this.metrics.webhookEndpointCounts.labels('enabled').set(enabledEndpoints);
    this.metrics.webhookEndpointCounts.labels('disabled').set(disabledEndpoints);
    this.metrics.webhookEndpointCounts.labels('unhealthy').set(unhealthyEndpoints);
    this.metrics.webhookDeliveryQueue.labels('queued').set(queued);
    this.metrics.webhookDeliveryQueue.labels('retrying').set(retrying);
    this.metrics.webhookDeliveryQueue.labels('exhausted').set(exhausted);
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(value ?? fallback, 200));
}

function buildEventQueryFilter(query: PlatformEventQuery): Record<string, unknown> {
  const occurredAt: Record<string, Date> = {};
  if (query.from) {
    occurredAt.$gte = new Date(query.from);
  }
  if (query.to) {
    occurredAt.$lte = new Date(query.to);
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
    createdAt.$gte = new Date(query.from);
  }
  if (query.to) {
    createdAt.$lte = new Date(query.to);
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
  partial = false
): void {
  if (!partial || request.name !== undefined) {
    if (!request.name?.trim()) {
      throw new BadRequestException('Webhook endpoint name is required');
    }
  }
  if (!partial || request.url !== undefined) {
    validateWebhookUrl(request.url);
  }
  if (!partial || request.subscribedEventTypes !== undefined) {
    if (!request.subscribedEventTypes?.length) {
      throw new BadRequestException('At least one subscribed event type is required');
    }
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 250 || request.timeoutMs > 60_000)) {
    throw new BadRequestException('Webhook timeout must be between 250ms and 60000ms');
  }
  if (request.maxAttempts !== undefined && (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 20)) {
    throw new BadRequestException('Webhook maxAttempts must be between 1 and 20');
  }
  if (
    request.initialBackoffMs !== undefined
    && (!Number.isFinite(request.initialBackoffMs) || request.initialBackoffMs < 100 || request.initialBackoffMs > 60_000)
  ) {
    throw new BadRequestException('Webhook initialBackoffMs must be between 100ms and 60000ms');
  }
}

function validateWebhookUrl(value: string | undefined): void {
  if (!value?.trim()) {
    throw new BadRequestException('Webhook endpoint URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('Webhook endpoint URL must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('Webhook endpoint URL must use http or https');
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
