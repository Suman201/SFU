import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  AttachIngestRequest,
  CreateIngestRequest,
  IngestAuthConfig,
  IngestSourceType,
  IngestJob,
  IngestListQuery,
  IngestListResponse,
  IngestListSummary,
  IngestRestartPolicy,
  IngestRuntimeState,
  PlatformEventActor,
  RtpParameters,
  UpdateIngestRequest
} from '@native-sfu/contracts';
import { type MediaProbeResult, type MediaIngestRuntimeConfig, type MediaIngestOutputTarget, type MediaIngestSource, type ResolvedIngestAuthConfig, FfprobeClient, MediaIngestSupervisor } from '@native-sfu/media-ingest';
import { IngestTransportService, type TrustedIngestTransportOptions } from '@native-sfu/nest-sfu';
import { FilterQuery, Model } from 'mongoose';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { NodeRegistryService } from '../cluster/node-registry.service';
import {
  IngestJobDocument,
  type IngestJobMongoDocument,
  RoomDocument,
  type RoomMongoDocument
} from '../database/schemas';
import { PlatformEventsService } from '../events/platform-events.service';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { RoomsService } from '../rooms/rooms.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { IngestPolicyService } from './ingest-policy.service';
import { IngestSupervisorService } from './ingest-supervisor.service';

interface PlannedIngestStream {
  kind: 'audio' | 'video';
  rtpParameters: RtpParameters;
  output: MediaIngestOutputTarget;
}

interface ManagedIngestRuntime {
  jobId: string;
  roomId: string;
  participantId: string;
  sourceType: IngestSourceType;
  transport: TrustedIngestTransportOptions;
  producerIds: string[];
  supervisor: MediaIngestSupervisor;
  stopping: boolean;
  closingRoom: boolean;
  lastForwardedRtpPackets: number;
  lastForwardedRtpSampledAt: number;
  lastRuntimePersistenceAt: number;
  lastObservedRestartCount: number;
}

type IngestLifecycleEventType =
  | 'ingest.created'
  | 'ingest.started'
  | 'ingest.stopped'
  | 'ingest.attached'
  | 'ingest.detached'
  | 'ingest.restarting'
  | 'ingest.failed';

type IngestFailureCategory =
  | 'policy'
  | 'auth'
  | 'probe'
  | 'runtime'
  | 'transport'
  | 'coordination'
  | 'room_owner'
  | 'conflict'
  | 'not_found'
  | 'unknown';

interface IngestStartCommand {
  type: 'ingest:start';
  ingestId: string;
  roomId: string;
}

interface IngestStopCommand {
  type: 'ingest:stop';
  ingestId: string;
  roomId: string;
}

interface IngestDetachCommand {
  type: 'ingest:detach';
  ingestId: string;
  roomId: string;
}

interface IngestAckCommand {
  type: 'ingest:ack';
  ingestId: string;
  roomId?: string;
  ok: boolean;
  job?: IngestJob;
  error?: {
    message: string;
    statusCode: number;
  };
}

type IngestCoordinationCommand = IngestStartCommand | IngestStopCommand | IngestDetachCommand | IngestAckCommand;

interface IngestCoordinationEnvelope<T extends IngestCoordinationCommand = IngestCoordinationCommand> {
  eventId: string;
  correlationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  payload: T;
}

interface PendingIngestCoordinationRequest {
  resolve: (ack: IngestAckCommand) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface RoomOwnerEventPayload {
  type: 'claimed' | 'released' | 'node-draining' | 'node-undrained';
  owner?: {
    roomId: string;
    nodeId: string;
  };
  nodeId?: string;
}

const ACTIVE_ATTACHED_INGEST_STATUSES = new Set<IngestJob['status']>(['starting', 'live', 'restarting']);
const INGEST_COORDINATION_STREAM = 'sfu:ingest-coordination';
const ROOM_OWNER_EVENTS_CHANNEL = 'sfu:room-owner-events';
const OWNER_RECONCILE_DELAY_MS = 250;
const INGEST_CONFIGURED_SECRET_MASK = '[configured]';

@Injectable()
export class IngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestService.name);
  private readonly enabled: boolean;
  private readonly runtimes = new Map<string, ManagedIngestRuntime>();
  private readonly pendingCoordinationRequests = new Map<string, PendingIngestCoordinationRequest>();
  private readonly pendingOwnershipReconciliations = new Map<string, NodeJS.Timeout>();
  private readonly trackedActiveIngestRooms = new Set<string>();
  private readonly unsubscribeRoomClosed: () => void;

  constructor(
    @InjectModel(IngestJobDocument.name) private readonly ingests: Model<IngestJobMongoDocument>,
    @InjectModel(RoomDocument.name) private readonly rooms: Model<RoomMongoDocument>,
    private readonly policy: IngestPolicyService,
    private readonly supervisor: IngestSupervisorService,
    private readonly roomsService: RoomsService,
    private readonly ingestTransports: IngestTransportService,
    private readonly redis: RedisService,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly platformEvents: PlatformEventsService,
    private readonly auditLogs: AuditLogsService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService
  ) {
    this.enabled = this.config.get<boolean>('ingest.enabled', true);
    this.unsubscribeRoomClosed = this.roomsService.onRoomClosed((roomId) => {
      void this.handleRoomClosed(roomId);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.consumeDurable<IngestCoordinationEnvelope>(
      INGEST_COORDINATION_STREAM,
      `ingest-coordination:${this.nodeRegistry.localNodeId()}`,
      async (envelope) => {
        if (envelope.targetNodeId !== this.nodeRegistry.localNodeId()) {
          return;
        }
        await this.handleCoordinationEnvelope(envelope);
      }
    );
    await this.redis.subscribe<RoomOwnerEventPayload>(ROOM_OWNER_EVENTS_CHANNEL, async (event) => {
      const roomId = event.owner?.roomId;
      if (!roomId) {
        return;
      }
      this.scheduleOwnershipReconcile(roomId);
    });
    if (this.enabled) {
      await this.reconcileAttachedIngestsOnStartup();
    }
    await this.refreshIngestAggregateMetrics();
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribeRoomClosed();
    for (const timer of this.pendingOwnershipReconciliations.values()) {
      clearTimeout(timer);
    }
    this.pendingOwnershipReconciliations.clear();
    for (const [correlationId, pending] of this.pendingCoordinationRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new ServiceUnavailableException('Ingest coordination shut down before the owner node acknowledged the request.'));
      this.pendingCoordinationRequests.delete(correlationId);
    }
    await Promise.all(
      [...this.runtimes.keys()].map(async (jobId) => {
        const job = await this.ingests.findById(jobId).exec();
        if (job) {
          await this.stopRoomRuntime(job, { clearRoom: false, roomClosed: false }).catch(() => undefined);
        }
      })
    );
  }

  async createAdminIngest(user: AuthenticatedUser, request: CreateIngestRequest): Promise<IngestJob> {
    this.assertAdmin(user);
    this.assertFeatureEnabled();
    try {
      const normalized = this.policy.normalizeCreateRequest(request);
      const doc = await this.ingests.create({
        ...(normalized.name ? { name: normalized.name } : {}),
        ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
        sourceType: normalized.sourceType,
        sourceUrl: normalized.sourceUrl,
        transportProtocol: 'trusted-rtp-local',
        status: 'idle',
        ...(normalized.auth ? { auth: normalized.auth } : {}),
        ...(normalized.restartPolicy ? { restartPolicy: normalized.restartPolicy } : {})
      });
      await this.refreshIngestAggregateMetrics();
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.create',
        status: 'success',
        job: doc,
        after: this.auditIngestState(doc),
        metadata: {
          summary: `Created ingest ${this.ingestDisplayName(doc)}`,
          sourceType: doc.sourceType,
          sourceUrl: doc.sourceUrl,
          auth: this.auditAuthMetadata(doc.auth as IngestAuthConfig | undefined),
          restartPolicy: this.copyRestartPolicy(doc.restartPolicy as IngestRestartPolicy | undefined)
        }
      });
      await this.emitIngestLifecycleEvent('ingest.created', doc, {
        actor: this.operatorActor(user),
        reason: 'manual_operator'
      });
      return this.toIngestJob(doc);
    } catch (error) {
      this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(request.sourceType));
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.create',
        status: 'failure',
        resourceLabel: request.displayName?.trim() || request.name?.trim(),
        metadata: {
          summary: 'Ingest creation rejected',
          sourceType: this.metricSourceType(request.sourceType),
          sourceUrl: request.sourceUrl,
          auth: this.auditAuthMetadata(request.auth),
          failureCategory: this.classifyIngestFailure(error),
          error: this.errorMessage(error)
        }
      });
      throw error;
    }
  }

  async listAdminIngests(user: AuthenticatedUser, query: IngestListQuery = {}): Promise<IngestListResponse> {
    this.assertAdmin(user);
    const page = this.clamp(query.page, 1, 10_000, 1);
    const limit = this.clamp(query.limit, 1, 100, 25);
    const filter = this.buildFilter(query);
    const [items, total, summary] = await Promise.all([
      this.ingests.find(filter).sort({ updatedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.ingests.countDocuments(filter).exec(),
      this.buildSummary(query)
    ]);
    return {
      items: items.map((item) => this.toIngestJob(item)),
      page,
      limit,
      total,
      summary
    };
  }

  async getAdminIngest(user: AuthenticatedUser, ingestId: string): Promise<IngestJob> {
    this.assertAdmin(user);
    return this.toIngestJob(await this.findIngest(ingestId));
  }

  async updateAdminIngest(user: AuthenticatedUser, ingestId: string, request: UpdateIngestRequest): Promise<IngestJob> {
    this.assertAdmin(user);
    this.assertFeatureEnabled();
    let job: IngestJobMongoDocument | undefined;
    try {
      job = await this.findIngest(ingestId);
      const before = this.auditIngestState(job);
      if (this.runtimes.has(job.id) || this.isAttachedRuntimeActive(job)) {
        throw new ConflictException('Stop the active ingest before updating runtime properties.');
      }
      const normalized = this.policy.normalizeUpdateRequest({
        ...request,
        ...(request.auth !== undefined ? { auth: this.resolveMaskedAuthUpdate(request.auth, job.auth as IngestAuthConfig | undefined) } : {})
      });
      if (normalized.name !== undefined) {
        job.name = normalized.name;
      }
      if (normalized.displayName !== undefined) {
        job.displayName = normalized.displayName;
      }
      if (normalized.sourceUrl !== undefined) {
        job.sourceUrl = this.policy.normalizeSourceUrl(job.sourceType, normalized.sourceUrl);
      }
      if (normalized.auth !== undefined) {
        job.auth = Object.keys(normalized.auth).length > 0 ? normalized.auth : undefined;
      }
      if (normalized.restartPolicy !== undefined) {
        job.restartPolicy = normalized.restartPolicy;
      }
      await job.save();
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.update',
        status: 'success',
        job,
        before,
        after: this.auditIngestState(job),
        metadata: {
          summary: `Updated ingest ${this.ingestDisplayName(job)}`,
          auth: this.auditAuthMetadata(job.auth as IngestAuthConfig | undefined),
          restartPolicy: this.copyRestartPolicy(job.restartPolicy as IngestRestartPolicy | undefined)
        }
      });
      return this.toIngestJob(job);
    } catch (error) {
      this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(job?.sourceType));
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.update',
        status: 'failure',
        job,
        metadata: {
          summary: 'Ingest update rejected',
          failureCategory: this.classifyIngestFailure(error),
          error: this.errorMessage(error),
          auth: this.auditAuthMetadata(request.auth)
        }
      });
      throw error;
    }
  }

  async startAdminIngest(user: AuthenticatedUser, ingestId: string): Promise<IngestJob> {
    this.assertAdmin(user);
    this.assertFeatureEnabled();
    const job = await this.findIngest(ingestId);
    const before = this.auditIngestState(job);
    try {
      if (!job.roomId) {
        this.supervisor.requestStart(job);
        await job.save();
        await this.recordIngestAudit({
          actor: user,
          action: 'ingests.start',
          status: 'success',
          job,
          before,
          after: this.auditIngestState(job),
          metadata: {
            summary: `Requested detached ingest start for ${this.ingestDisplayName(job)}`,
            mode: 'detached_control_plane'
          }
        });
        await this.emitIngestLifecycleEvent('ingest.started', job, {
          actor: this.operatorActor(user),
          reason: 'manual_operator_detached'
        });
        await this.refreshIngestAggregateMetrics();
        return this.toIngestJob(job);
      }
      const started = await this.startAttachedRuntimeOnOwner(job);
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.start',
        status: 'success',
        job,
        before,
        after: this.auditIngestState(started),
        metadata: {
          summary: `Started ingest ${this.ingestDisplayName(job)}`,
          roomId: job.roomId
        }
      });
      await this.emitIngestLifecycleEvent('ingest.started', started, {
        actor: this.operatorActor(user),
        reason: 'manual_operator'
      });
      await this.refreshIngestAggregateMetrics();
      return started;
    } catch (error) {
      this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(job.sourceType));
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.start',
        status: 'failure',
        job,
        metadata: {
          summary: 'Ingest start failed',
          roomId: job.roomId,
          failureCategory: this.classifyIngestFailure(error),
          error: this.errorMessage(error)
        }
      });
      throw error;
    }
  }

  async stopAdminIngest(user: AuthenticatedUser, ingestId: string): Promise<IngestJob> {
    this.assertAdmin(user);
    const job = await this.findIngest(ingestId);
    const before = this.auditIngestState(job);
    try {
      if (!job.roomId) {
        this.supervisor.requestStop(job);
        job.participantId = undefined;
        job.nodeId = undefined;
        job.runtimeState = this.clearRuntimeIdentity(job.runtimeState, new Date().toISOString());
        await job.save();
        await this.recordIngestAudit({
          actor: user,
          action: 'ingests.stop',
          status: 'success',
          job,
          before,
          after: this.auditIngestState(job),
          metadata: {
            summary: `Requested detached ingest stop for ${this.ingestDisplayName(job)}`,
            mode: 'detached_control_plane'
          }
        });
        await this.emitIngestLifecycleEvent('ingest.stopped', job, {
          actor: this.operatorActor(user),
          reason: 'manual_operator_detached'
        });
        await this.refreshIngestAggregateMetrics();
        return this.toIngestJob(job);
      }
      const stopped = await this.stopAttachedRuntimeOnOwner(job);
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.stop',
        status: 'success',
        job,
        before,
        after: this.auditIngestState(stopped),
        metadata: {
          summary: `Stopped ingest ${this.ingestDisplayName(job)}`,
          roomId: job.roomId
        }
      });
      await this.emitIngestLifecycleEvent('ingest.stopped', stopped, {
        actor: this.operatorActor(user),
        reason: 'manual_operator',
        roomId: job.roomId
      });
      await this.refreshIngestAggregateMetrics();
      return stopped;
    } catch (error) {
      this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(job.sourceType));
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.stop',
        status: 'failure',
        job,
        before,
        metadata: {
          summary: 'Ingest stop failed',
          roomId: job.roomId,
          failureCategory: this.classifyIngestFailure(error),
          error: this.errorMessage(error)
        }
      });
      throw error;
    }
  }

  async attachAdminIngest(user: AuthenticatedUser, ingestId: string, roomId: string, request: Omit<AttachIngestRequest, 'roomId'>): Promise<IngestJob> {
    this.assertAdmin(user);
    this.assertFeatureEnabled();
    const job = await this.findIngest(ingestId);
    const before = this.auditIngestState(job);
    let normalizedRoomId = '';
    try {
      const normalized = this.policy.normalizeAttachRequest(roomId, request);
      normalizedRoomId = normalized.roomId;
      await this.assertAttachableRoom(normalized.roomId);
      if (job.roomId && job.roomId !== normalized.roomId) {
        throw new ConflictException('Ingest job is already attached to a different room.');
      }
      job.roomId = normalized.roomId;
      if (normalized.displayName !== undefined) {
        job.displayName = normalized.displayName;
      }
      await job.save();
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.attach',
        status: 'success',
        job,
        before,
        after: this.auditIngestState(job),
        metadata: {
          summary: `Attached ingest ${this.ingestDisplayName(job)} to room ${normalized.roomId}`,
          roomId: normalized.roomId,
          startIfStopped: Boolean(normalized.startIfStopped)
        }
      });
      await this.emitIngestLifecycleEvent('ingest.attached', job, {
        actor: this.operatorActor(user),
        reason: 'manual_operator',
        roomId: normalized.roomId
      });
      await this.refreshIngestAggregateMetrics();
      if (!normalized.startIfStopped) {
        return this.toIngestJob(job);
      }
      try {
        const started = await this.startAttachedRuntimeOnOwner(job);
        await this.recordIngestAudit({
          actor: user,
          action: 'ingests.start',
          status: 'success',
          job,
          after: this.auditIngestState(started),
          metadata: {
            summary: `Started ingest ${this.ingestDisplayName(job)} during attach`,
            roomId: normalized.roomId,
            trigger: 'attach'
          }
        });
        await this.emitIngestLifecycleEvent('ingest.started', started, {
          actor: this.operatorActor(user),
          reason: 'manual_operator_attach',
          roomId: normalized.roomId
        });
        await this.refreshIngestAggregateMetrics();
        return started;
      } catch (error) {
        this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(job.sourceType));
        await this.recordIngestAudit({
          actor: user,
          action: 'ingests.start',
          status: 'failure',
          job,
          metadata: {
            summary: 'Attached ingest failed to start',
            roomId: normalized.roomId,
            trigger: 'attach',
            failureCategory: this.classifyIngestFailure(error),
            error: this.errorMessage(error)
          }
        });
        throw error;
      }
    } catch (error) {
      if (!job.roomId || job.roomId !== normalizedRoomId) {
        this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(job.sourceType));
        await this.recordIngestAudit({
          actor: user,
          action: 'ingests.attach',
          status: 'failure',
          job,
          before,
          metadata: {
            summary: 'Ingest attach failed',
            roomId: normalizedRoomId || roomId,
            failureCategory: this.classifyIngestFailure(error),
            error: this.errorMessage(error)
          }
        });
      }
      throw error;
    }
  }

  async detachAdminIngest(user: AuthenticatedUser, ingestId: string, roomId: string): Promise<IngestJob> {
    this.assertAdmin(user);
    const job = await this.findIngest(ingestId);
    const normalizedRoomId = String(roomId ?? '').trim();
    if (!normalizedRoomId) {
      throw new BadRequestException('Room id is required.');
    }
    if (job.roomId && job.roomId !== normalizedRoomId) {
      throw new ConflictException('Ingest job is attached to a different room.');
    }
    const before = this.auditIngestState(job);
    try {
      const wasActive = this.isAttachedRuntimeActive(job) || this.runtimes.has(job.id);
      const detached = await this.detachAttachedRuntimeFromOwner(job, normalizedRoomId);
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.detach',
        status: 'success',
        job,
        before,
        after: this.auditIngestState(detached),
        metadata: {
          summary: `Detached ingest ${this.ingestDisplayName(job)} from room ${normalizedRoomId}`,
          roomId: normalizedRoomId
        }
      });
      if (wasActive) {
        await this.emitIngestLifecycleEvent('ingest.stopped', detached, {
          actor: this.operatorActor(user),
          reason: 'manual_operator_detach',
          roomId: normalizedRoomId
        });
      }
      await this.emitIngestLifecycleEvent('ingest.detached', detached, {
        actor: this.operatorActor(user),
        reason: 'manual_operator',
        roomId: normalizedRoomId
      });
      await this.refreshIngestAggregateMetrics();
      return detached;
    } catch (error) {
      this.recordIngestFailureMetric(this.classifyIngestFailure(error), this.metricSourceType(job.sourceType));
      await this.recordIngestAudit({
        actor: user,
        action: 'ingests.detach',
        status: 'failure',
        job,
        before,
        metadata: {
          summary: 'Ingest detach failed',
          roomId: normalizedRoomId,
          failureCategory: this.classifyIngestFailure(error),
          error: this.errorMessage(error)
        }
      });
      throw error;
    }
  }

  private async startAttachedRuntime(job: IngestJobMongoDocument): Promise<IngestJob> {
    this.assertFeatureEnabled();
    if (!job.roomId) {
      throw new ConflictException('Attach the ingest job to a room before starting live media.');
    }
    const existing = this.runtimes.get(job.id);
    if (existing) {
      await this.persistManagedRuntimeState(job, existing, existing.supervisor.snapshot());
      return this.toIngestJob(job);
    }
    await this.nodeRegistry.assertLocalRoomOwner(job.roomId);
    const source = this.resolveRuntimeSource(job);
    const probe = await this.probeSource(source);
    if (!probe.hasAudio && !probe.hasVideo) {
      throw new BadRequestException('Ingest source does not expose a supported audio or video stream.');
    }
    if (job.participantId) {
      await this.roomsService.removeIngestParticipant(job.roomId, job.participantId).catch(() => undefined);
      job.participantId = undefined;
    }

    const participant = await this.roomsService.createIngestParticipant({
      roomId: job.roomId,
      displayName: this.ingestDisplayName(job)
    });
    let transport: TrustedIngestTransportOptions | undefined;
    let managed: ManagedIngestRuntime | undefined;
    try {
      transport = await this.ingestTransports.createTransport({
        roomId: job.roomId,
        participantId: participant.id,
        allowPrivateAddresses: this.config.get<boolean>('ingest.allowPrivateHandoff', false)
      });
      const plannedStreams = this.buildPlannedStreams(job, probe, transport);
      const producers = [];
      for (const stream of plannedStreams) {
        producers.push(
          await this.roomsService.createIngestProducer({
            roomId: job.roomId,
            participantId: participant.id,
            transportId: transport.id,
            kind: stream.kind,
            rtpParameters: stream.rtpParameters
          })
        );
      }

      managed = {
        jobId: job.id,
        roomId: job.roomId,
        participantId: participant.id,
        sourceType: job.sourceType,
        transport,
        producerIds: producers.map((producer) => producer.id),
        supervisor: this.createSupervisor(this.buildRuntimeConfig(job, source, plannedStreams)),
        stopping: false,
        closingRoom: false,
        lastForwardedRtpPackets: 0,
        lastForwardedRtpSampledAt: Date.now(),
        lastRuntimePersistenceAt: 0,
        lastObservedRestartCount: 0
      };
      this.bindRuntimeEvents(managed);
      this.runtimes.set(job.id, managed);
      job.participantId = participant.id;
      job.nodeId = this.nodeRegistry.localNodeId();
      job.status = 'starting';
      job.runtimeState = this.mergeRuntimeState(job.runtimeState, managed, managed.supervisor.snapshot());
      await job.save();

      try {
        await managed.supervisor.start();
        await managed.supervisor.waitForState('live', this.startupTimeoutMs());
        await this.persistManagedRuntimeState(job, managed, managed.supervisor.snapshot());
        return this.toIngestJob(job);
      } catch (error) {
        await this.handleStartupFailure(job, managed, error);
        throw error;
      }
    } catch (error) {
      if (managed) {
        throw error;
      }
      if (transport) {
        await this.ingestTransports.closeTransport(transport.id).catch(() => undefined);
      }
      if (job.roomId && participant.id) {
        await this.roomsService.removeIngestParticipant(job.roomId, participant.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async stopRoomRuntime(
    job: IngestJobMongoDocument,
    options: {
      clearRoom: boolean;
      roomClosed: boolean;
      nextStatus?: IngestJob['status'];
    }
  ): Promise<void> {
    const managed = this.runtimes.get(job.id);
    if (managed) {
      managed.stopping = true;
      managed.closingRoom = options.roomClosed;
      this.runtimes.delete(job.id);
      await managed.supervisor.stop().catch(() => undefined);
      await this.ingestTransports.closeTransport(managed.transport.id).catch(() => undefined);
      this.clearRuntimeMetrics(managed);
    }
    if (!options.roomClosed && job.roomId && job.participantId) {
      await this.roomsService.removeIngestParticipant(job.roomId, job.participantId).catch(() => undefined);
    }
    const stoppedAt = new Date().toISOString();
    job.status = options.nextStatus ?? 'stopped';
    if (options.clearRoom) {
      job.roomId = undefined;
    }
    job.participantId = undefined;
    job.nodeId = undefined;
    job.runtimeState = this.clearRuntimeIdentity(job.runtimeState, stoppedAt);
    await job.save();
  }

  private bindRuntimeEvents(managed: ManagedIngestRuntime): void {
    managed.supervisor.on('state', (_state, snapshot) => {
      void this.handleRuntimeStateChange(managed, snapshot);
    });
    managed.supervisor.on('progress', () => {
      void this.handleRuntimeProgress(managed);
    });
  }

  private async handleRuntimeStateChange(managed: ManagedIngestRuntime, snapshot: ReturnType<MediaIngestSupervisor['snapshot']>): Promise<void> {
    const current = this.runtimes.get(managed.jobId);
    if (!current || current !== managed) {
      return;
    }
    const job = await this.ingests.findById(managed.jobId).exec();
    if (!job) {
      return;
    }
    const previousStatus = job.status;
    await this.persistManagedRuntimeState(job, managed, snapshot);
    this.updateRuntimeMetrics(managed, snapshot);
    if (snapshot.metrics.restarts > managed.lastObservedRestartCount) {
      const delta = snapshot.metrics.restarts - managed.lastObservedRestartCount;
      this.metrics.ingestRestarts.labels(this.metricSourceType(managed.sourceType)).inc(delta);
      managed.lastObservedRestartCount = snapshot.metrics.restarts;
    }
    if (snapshot.state === 'restarting' && previousStatus !== 'restarting') {
      await this.emitIngestLifecycleEvent('ingest.restarting', job, {
        actor: this.nodeActor(),
        reason: 'runtime_restart',
        restartCount: snapshot.metrics.restarts
      });
    }
    if ((snapshot.state === 'failed' || snapshot.state === 'stopped') && !managed.stopping) {
      managed.stopping = true;
      this.runtimes.delete(managed.jobId);
      await this.ingestTransports.closeTransport(managed.transport.id).catch(() => undefined);
      this.clearRuntimeMetrics(managed);
      if (job.roomId && job.participantId) {
        await this.roomsService.removeIngestParticipant(job.roomId, job.participantId).catch(() => undefined);
      }
      job.participantId = undefined;
      job.nodeId = undefined;
      job.runtimeState = this.clearRuntimeIdentity(job.runtimeState, new Date().toISOString(), snapshot.metrics.lastError);
      await job.save();
      if (snapshot.state === 'failed') {
        const failureCategory = this.classifyIngestFailure(snapshot.metrics.lastError ?? snapshot.lastError);
        this.recordIngestFailureMetric(failureCategory, this.metricSourceType(job.sourceType));
        await this.emitIngestLifecycleEvent('ingest.failed', job, {
          actor: this.nodeActor(),
          reason: 'runtime_failed',
          failureCategory,
          restartCount: snapshot.metrics.restarts
        });
      } else {
        await this.emitIngestLifecycleEvent('ingest.stopped', job, {
          actor: this.nodeActor(),
          reason: 'runtime_stopped'
        });
      }
    }
    if (previousStatus !== snapshot.state) {
      await this.refreshIngestAggregateMetrics();
    }
  }

  private async handleRuntimeProgress(managed: ManagedIngestRuntime): Promise<void> {
    const current = this.runtimes.get(managed.jobId);
    if (!current || current !== managed) {
      return;
    }
    const snapshot = managed.supervisor.snapshot();
    this.updateRuntimeMetrics(managed, snapshot);
    const now = Date.now();
    const persistIntervalMs = this.config.get<number>('ingest.runtimeMetricsPersistIntervalMs', 5000);
    if (now - managed.lastRuntimePersistenceAt < persistIntervalMs) {
      return;
    }
    const job = await this.ingests.findById(managed.jobId).exec();
    if (!job || this.runtimes.get(managed.jobId) !== managed) {
      return;
    }
    job.runtimeState = this.mergeRuntimeState(job.runtimeState, managed, snapshot);
    await job.save();
    managed.lastRuntimePersistenceAt = now;
  }

  private async handleStartupFailure(job: IngestJobMongoDocument, managed: ManagedIngestRuntime, error: unknown): Promise<void> {
    managed.stopping = true;
    this.runtimes.delete(job.id);
    await managed.supervisor.stop().catch(() => undefined);
    await this.ingestTransports.closeTransport(managed.transport.id).catch(() => undefined);
    this.clearRuntimeMetrics(managed);
    if (job.roomId && job.participantId) {
      await this.roomsService.removeIngestParticipant(job.roomId, job.participantId).catch(() => undefined);
    }
    job.status = 'failed';
    job.participantId = undefined;
    job.nodeId = undefined;
    job.runtimeState = this.clearRuntimeIdentity(
      this.mergeRuntimeState(job.runtimeState, managed, managed.supervisor.snapshot()),
      new Date().toISOString(),
      error instanceof Error ? error.message : String(error)
    );
    await job.save();
    const failureCategory = this.classifyIngestFailure(error);
    this.recordIngestFailureMetric(failureCategory, this.metricSourceType(job.sourceType));
    await this.emitIngestLifecycleEvent('ingest.failed', job, {
      actor: this.nodeActor(),
      reason: 'startup_failed',
      failureCategory,
      restartCount: managed.supervisor.snapshot().metrics.restarts
    });
    await this.refreshIngestAggregateMetrics();
  }

  private async handleRoomClosed(roomId: string): Promise<void> {
    const jobs = await this.ingests.find({ roomId }).exec();
    await Promise.all(
      jobs.map(async (job) => {
        const managed = this.runtimes.get(job.id);
        const roomReference = job.roomId;
        const wasActive = this.isAttachedRuntimeActive(job) || Boolean(managed);
        if (managed) {
          managed.closingRoom = true;
        }
        await this.stopRoomRuntime(job, { clearRoom: true, roomClosed: true }).catch(() => undefined);
        if (wasActive) {
          await this.emitIngestLifecycleEvent('ingest.stopped', job, {
            actor: this.systemActor(),
            reason: 'room_closed',
            roomId: roomReference
          });
        }
        await this.emitIngestLifecycleEvent('ingest.detached', job, {
          actor: this.systemActor(),
          reason: 'room_closed',
          roomId: roomReference
        });
      })
    );
    await this.refreshIngestAggregateMetrics();
  }

  private async startAttachedRuntimeOnOwner(job: IngestJobMongoDocument): Promise<IngestJob> {
    if (!job.roomId) {
      throw new ConflictException('Attach the ingest job to a room before starting live media.');
    }
    const owner = await this.requireRoomOwner(job.roomId);
    if (owner.local) {
      return this.startAttachedRuntime(job);
    }
    return this.dispatchCoordinationCommand(owner.owner.nodeId, {
      type: 'ingest:start',
      ingestId: job.id,
      roomId: job.roomId
    });
  }

  private async stopAttachedRuntimeOnOwner(job: IngestJobMongoDocument): Promise<IngestJob> {
    if (!job.roomId) {
      return this.toIngestJob(job);
    }
    const owner = await this.requireRoomOwner(job.roomId);
    if (owner.local) {
      await this.stopRoomRuntime(job, { clearRoom: false, roomClosed: false });
      return this.toIngestJob(job);
    }
    return this.dispatchCoordinationCommand(owner.owner.nodeId, {
      type: 'ingest:stop',
      ingestId: job.id,
      roomId: job.roomId
    });
  }

  private async detachAttachedRuntimeFromOwner(job: IngestJobMongoDocument, roomId: string): Promise<IngestJob> {
    if (!job.roomId) {
      job.roomId = undefined;
      await job.save();
      return this.toIngestJob(job);
    }
    const owner = await this.requireRoomOwner(roomId);
    if (owner.local) {
      await this.stopRoomRuntime(job, { clearRoom: true, roomClosed: false });
      return this.toIngestJob(job);
    }
    return this.dispatchCoordinationCommand(owner.owner.nodeId, {
      type: 'ingest:detach',
      ingestId: job.id,
      roomId
    });
  }

  private async requireRoomOwner(roomId: string): Promise<{
    local: boolean;
    owner: {
      nodeId: string;
    };
  }> {
    const lookup = await this.nodeRegistry.lookupRoomOwner(roomId);
    if (!lookup.owner || !lookup.available) {
      throw new ServiceUnavailableException(`Room owner is unavailable for ingest coordination (${lookup.reason ?? 'missing'}).`);
    }
    return {
      local: lookup.local,
      owner: {
        nodeId: lookup.owner.nodeId
      }
    };
  }

  private async dispatchCoordinationCommand(
    targetNodeId: string,
    command: IngestStartCommand | IngestStopCommand | IngestDetachCommand
  ): Promise<IngestJob> {
    const correlationId = randomUUID();
    const envelope: IngestCoordinationEnvelope<typeof command> = {
      eventId: randomUUID(),
      correlationId,
      sourceNodeId: this.nodeRegistry.localNodeId(),
      targetNodeId,
      payload: command
    };
    const ackPromise = new Promise<IngestAckCommand>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCoordinationRequests.delete(correlationId);
        reject(new ServiceUnavailableException('Timed out waiting for the room owner to complete the ingest operation.'));
      }, this.config.get<number>('ingest.coordinationTimeoutMs', 5000));
      timer.unref?.();
      this.pendingCoordinationRequests.set(correlationId, { resolve, reject, timer });
    });
    try {
      await this.redis.publishDurable(INGEST_COORDINATION_STREAM, envelope);
    } catch (error) {
      const pending = this.pendingCoordinationRequests.get(correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCoordinationRequests.delete(correlationId);
      }
      throw error;
    }
    const ack = await ackPromise;
    if (!ack.ok) {
      throw this.errorFromCoordinationAck(ack);
    }
    if (ack.job) {
      return ack.job;
    }
    return this.toIngestJob(await this.findIngest(command.ingestId));
  }

  private async handleCoordinationEnvelope(envelope: IngestCoordinationEnvelope): Promise<void> {
    if (envelope.payload.type === 'ingest:ack') {
      this.resolveCoordinationRequest(envelope.correlationId, envelope.payload);
      return;
    }
    try {
      const job = await this.handleInboundCommand(envelope.payload);
      await this.redis.publishDurable(INGEST_COORDINATION_STREAM, {
        eventId: randomUUID(),
        correlationId: envelope.correlationId,
        sourceNodeId: this.nodeRegistry.localNodeId(),
        targetNodeId: envelope.sourceNodeId,
        payload: {
          type: 'ingest:ack',
          ingestId: envelope.payload.ingestId,
          roomId: envelope.payload.roomId,
          ok: true,
          job
        } satisfies IngestAckCommand
      } satisfies IngestCoordinationEnvelope<IngestAckCommand>);
    } catch (error) {
      await this.redis.publishDurable(INGEST_COORDINATION_STREAM, {
        eventId: randomUUID(),
        correlationId: envelope.correlationId,
        sourceNodeId: this.nodeRegistry.localNodeId(),
        targetNodeId: envelope.sourceNodeId,
        payload: {
          type: 'ingest:ack',
          ingestId: envelope.payload.ingestId,
          roomId: envelope.payload.roomId,
          ok: false,
          error: this.serializeCoordinationError(error)
        } satisfies IngestAckCommand
      } satisfies IngestCoordinationEnvelope<IngestAckCommand>);
    }
  }

  private resolveCoordinationRequest(correlationId: string, ack: IngestAckCommand): void {
    const pending = this.pendingCoordinationRequests.get(correlationId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCoordinationRequests.delete(correlationId);
    pending.resolve(ack);
  }

  private async handleInboundCommand(command: IngestStartCommand | IngestStopCommand | IngestDetachCommand): Promise<IngestJob> {
    const job = await this.findIngest(command.ingestId);
    if (!job.roomId || job.roomId !== command.roomId) {
      throw new ConflictException('Ingest job room attachment changed before the owner node handled the request.');
    }
    if (command.type === 'ingest:start') {
      return this.startAttachedRuntime(job);
    }
    if (command.type === 'ingest:stop') {
      await this.stopRoomRuntime(job, { clearRoom: false, roomClosed: false });
      return this.toIngestJob(job);
    }
    await this.stopRoomRuntime(job, { clearRoom: true, roomClosed: false });
    return this.toIngestJob(job);
  }

  private serializeCoordinationError(error: unknown): { message: string; statusCode: number } {
    if (error instanceof NotFoundException) {
      return { message: error.message, statusCode: 404 };
    }
    if (error instanceof ConflictException) {
      return { message: error.message, statusCode: 409 };
    }
    if (error instanceof ForbiddenException) {
      return { message: error.message, statusCode: 403 };
    }
    if (error instanceof BadRequestException) {
      return { message: error.message, statusCode: 400 };
    }
    if (error instanceof ServiceUnavailableException) {
      return { message: error.message, statusCode: 503 };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      statusCode: 500
    };
  }

  private errorFromCoordinationAck(ack: IngestAckCommand): Error {
    const statusCode = ack.error?.statusCode ?? 503;
    const message = ack.error?.message ?? 'Ingest coordination failed on the room owner node.';
    if (statusCode === 404) {
      return new NotFoundException(message);
    }
    if (statusCode === 409) {
      return new ConflictException(message);
    }
    if (statusCode === 403) {
      return new ForbiddenException(message);
    }
    if (statusCode === 400) {
      return new BadRequestException(message);
    }
    return new ServiceUnavailableException(message);
  }

  private async reconcileAttachedIngestsOnStartup(): Promise<void> {
    const jobs = await this.ingests.find({
      roomId: { $exists: true, $nin: ['', null] },
      status: { $in: [...ACTIVE_ATTACHED_INGEST_STATUSES] }
    }).exec();
    const roomIds = new Set(jobs.map((job) => job.roomId).filter((roomId): roomId is string => Boolean(roomId)));
    for (const roomId of roomIds) {
      this.scheduleOwnershipReconcile(roomId, 0);
    }
  }

  private scheduleOwnershipReconcile(roomId: string, delayMs = OWNER_RECONCILE_DELAY_MS): void {
    const existing = this.pendingOwnershipReconciliations.get(roomId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingOwnershipReconciliations.delete(roomId);
      void this.reconcileRoomOwnership(roomId);
    }, delayMs);
    timer.unref?.();
    this.pendingOwnershipReconciliations.set(roomId, timer);
  }

  private async reconcileRoomOwnership(roomId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const jobs = await this.ingests.find({ roomId }).exec();
    if (jobs.length === 0) {
      return;
    }
    const lookup = await this.nodeRegistry.lookupRoomOwner(roomId).catch(() => undefined);
    const localOwner = Boolean(lookup?.owner && lookup.available && lookup.local);
    if (localOwner) {
      await Promise.all(
        jobs.map(async (job) => {
          if (!this.shouldRunAttachedRuntime(job) || this.runtimes.has(job.id)) {
            return;
          }
          await this.startAttachedRuntime(job).catch((error) => {
            this.logger.warn(
              `Failed to resume attached ingest ${job.id} after owner reconciliation for room ${roomId}: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        })
      );
      await this.refreshIngestAggregateMetrics();
      return;
    }
    await Promise.all(
      jobs.map(async (job) => {
        if (!this.runtimes.has(job.id)) {
          return;
        }
        await this.stopRoomRuntime(job, {
          clearRoom: false,
          roomClosed: false,
          nextStatus: this.shouldRunAttachedRuntime(job) ? 'restarting' : 'stopped'
        }).catch((error) => {
          this.logger.warn(
            `Failed to re-home attached ingest ${job.id} after owner reconciliation for room ${roomId}: ${error instanceof Error ? error.message : String(error)}`
          );
        });
        if (this.shouldRunAttachedRuntime(job)) {
          await this.emitIngestLifecycleEvent('ingest.restarting', job, {
            actor: this.nodeActor(),
            reason: 'owner_reconciled',
            roomId
          });
        }
      })
    );
    await this.refreshIngestAggregateMetrics();
  }

  private shouldRunAttachedRuntime(job: Pick<IngestJobMongoDocument, 'roomId' | 'status'>): boolean {
    return Boolean(job.roomId) && ACTIVE_ATTACHED_INGEST_STATUSES.has(job.status);
  }

  private isAttachedRuntimeActive(job: Pick<IngestJobMongoDocument, 'roomId' | 'status'>): boolean {
    return this.shouldRunAttachedRuntime(job);
  }

  private updateRuntimeMetrics(managed: ManagedIngestRuntime, snapshot: ReturnType<MediaIngestSupervisor['snapshot']>): void {
    const sourceType = this.metricSourceType(managed.sourceType);
    const inputBitrate = snapshot.probe?.bitrateBps ?? 0;
    const outputBitrate = outputBitrateForSnapshot(snapshot) ?? 0;
    this.metrics.ingestInputBitrate.labels(managed.jobId, sourceType).set(inputBitrate);
    this.metrics.ingestOutputBitrate.labels(managed.jobId, sourceType).set(outputBitrate);

    const transportSnapshot = this.ingestTransports.snapshot(managed.transport.id);
    if (transportSnapshot) {
      const now = Date.now();
      const elapsedMs = Math.max(1, now - managed.lastForwardedRtpSampledAt);
      const forwardedPackets = transportSnapshot.counters.forwardedRtpPackets;
      const deltaPackets = Math.max(0, forwardedPackets - managed.lastForwardedRtpPackets);
      const packetsPerSecond = (deltaPackets * 1000) / elapsedMs;
      this.metrics.ingestOutputRtpPacketRate.labels(managed.jobId, sourceType).set(packetsPerSecond);
      managed.lastForwardedRtpPackets = forwardedPackets;
      managed.lastForwardedRtpSampledAt = now;
    } else {
      this.metrics.ingestOutputRtpPacketRate.labels(managed.jobId, sourceType).set(0);
    }

    const pid = snapshot.runner?.health.pid;
    if (pid && process.platform === 'linux') {
      void this.updateRuntimeProcessResourceMetrics(managed, pid);
      return;
    }
    this.metrics.ingestRuntimeRssBytes.remove(managed.jobId, sourceType);
    this.metrics.ingestRuntimeCpuUserMicros.remove(managed.jobId, sourceType);
    this.metrics.ingestRuntimeCpuSystemMicros.remove(managed.jobId, sourceType);
  }

  private clearRuntimeMetrics(managed: ManagedIngestRuntime): void {
    const sourceType = this.metricSourceType(managed.sourceType);
    this.metrics.ingestInputBitrate.remove(managed.jobId, sourceType);
    this.metrics.ingestOutputBitrate.remove(managed.jobId, sourceType);
    this.metrics.ingestOutputRtpPacketRate.remove(managed.jobId, sourceType);
    this.metrics.ingestRuntimeRssBytes.remove(managed.jobId, sourceType);
    this.metrics.ingestRuntimeCpuUserMicros.remove(managed.jobId, sourceType);
    this.metrics.ingestRuntimeCpuSystemMicros.remove(managed.jobId, sourceType);
  }

  private async updateRuntimeProcessResourceMetrics(managed: ManagedIngestRuntime, pid: number): Promise<void> {
    try {
      const usage = await sampleLinuxProcessUsage(pid);
      if (!usage) {
        return;
      }
      const sourceType = this.metricSourceType(managed.sourceType);
      if (usage.rssBytes !== undefined) {
        this.metrics.ingestRuntimeRssBytes.labels(managed.jobId, sourceType).set(usage.rssBytes);
      }
      if (usage.cpuUserMicros !== undefined) {
        this.metrics.ingestRuntimeCpuUserMicros.labels(managed.jobId, sourceType).set(usage.cpuUserMicros);
      }
      if (usage.cpuSystemMicros !== undefined) {
        this.metrics.ingestRuntimeCpuSystemMicros.labels(managed.jobId, sourceType).set(usage.cpuSystemMicros);
      }
    } catch {
      // Best-effort only. Host process metrics should not affect ingest control flow.
    }
  }

  private async refreshIngestAggregateMetrics(): Promise<void> {
    try {
      const states: IngestJob['status'][] = ['idle', 'starting', 'live', 'restarting', 'stopping', 'stopped', 'failed'];
      const [stateCounts, activeByRoom] = await Promise.all([
        this.ingests.aggregate<{ _id: IngestJob['status']; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),
        this.ingests.aggregate<{ _id: string; count: number }>([
          {
            $match: {
              roomId: { $exists: true, $nin: ['', null] },
              status: { $in: [...ACTIVE_ATTACHED_INGEST_STATUSES] }
            }
          },
          { $group: { _id: '$roomId', count: { $sum: 1 } } }
        ])
      ]);
      const countsByState = new Map(stateCounts.map((entry) => [entry._id, entry.count] as const));
      for (const state of states) {
        this.metrics.ingestJobsByState.labels(state).set(countsByState.get(state) ?? 0);
      }

      const nextRooms = new Set<string>();
      for (const entry of activeByRoom) {
        if (!entry._id) {
          continue;
        }
        nextRooms.add(entry._id);
        this.metrics.activeIngestsByRoom.labels(entry._id).set(entry.count);
      }
      for (const roomId of this.trackedActiveIngestRooms) {
        if (!nextRooms.has(roomId)) {
          this.metrics.activeIngestsByRoom.remove(roomId);
        }
      }
      this.trackedActiveIngestRooms.clear();
      for (const roomId of nextRooms) {
        this.trackedActiveIngestRooms.add(roomId);
      }
    } catch (error) {
      this.logger.warn(`Failed to refresh ingest metrics: ${this.errorMessage(error)}`);
    }
  }

  private async recordIngestAudit(input: {
    actor?: AuthenticatedUser;
    action: string;
    status: 'success' | 'failure';
    job?: Pick<IngestJobMongoDocument, 'id' | 'name' | 'displayName'>;
    resourceLabel?: string;
    metadata?: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }): Promise<void> {
    await this.auditLogs.record({
      actor: input.actor,
      action: input.action,
      status: input.status,
      resourceType: 'ingest',
      ...(input.job?.id ? { resourceId: input.job.id } : {}),
      ...((input.resourceLabel ?? input.job)
        ? {
            resourceLabel: input.resourceLabel ?? this.ingestDisplayName(input.job as IngestJobMongoDocument)
          }
        : {}),
      metadata: input.metadata,
      before: input.before,
      after: input.after
    });
  }

  private async emitIngestLifecycleEvent(
    type: IngestLifecycleEventType,
    job: Pick<IngestJobMongoDocument, 'id' | 'name' | 'displayName' | 'sourceType' | 'transportProtocol' | 'status' | 'roomId' | 'participantId' | 'nodeId'>,
    options: {
      actor?: PlatformEventActor;
      reason?: string;
      roomId?: string;
      failureCategory?: string;
      restartCount?: number;
      statusOverride?: IngestJob['status'];
    } = {}
  ): Promise<void> {
    try {
      const roomId = options.roomId ?? job.roomId;
      await this.platformEvents.appendEvent({
        type,
        ...(roomId ? { roomId } : {}),
        ...(options.actor ? { actor: options.actor } : {}),
        payload: {
          ingest: {
            ingestId: job.id,
            ...(job.name ? { name: job.name } : {}),
            ...(job.displayName ? { displayName: job.displayName } : {}),
            sourceType: job.sourceType,
            transportProtocol: job.transportProtocol,
            status: options.statusOverride ?? job.status,
            ...(roomId ? { roomId } : {}),
            ...(job.participantId ? { participantId: job.participantId } : {}),
            ...(job.nodeId ? { nodeId: job.nodeId } : {})
          },
          ...(roomId ? { room: { roomId } } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
          ...(options.failureCategory ? { failureCategory: options.failureCategory } : {}),
          ...(options.restartCount !== undefined ? { restartCount: options.restartCount } : {})
        }
      });
    } catch (error) {
      this.logger.warn(`Failed to append ingest platform event ${type}: ${this.errorMessage(error)}`);
    }
  }

  private operatorActor(user: AuthenticatedUser): PlatformEventActor {
    return {
      type: 'operator',
      userId: user.sub,
      ...(user.email ? { label: user.email } : {}),
      nodeId: this.nodeRegistry.localNodeId()
    };
  }

  private systemActor(): PlatformEventActor {
    return {
      type: 'system',
      label: 'ingest-service',
      nodeId: this.nodeRegistry.localNodeId()
    };
  }

  private nodeActor(): PlatformEventActor {
    return {
      type: 'node',
      nodeId: this.nodeRegistry.localNodeId(),
      label: this.nodeRegistry.localNodeId()
    };
  }

  private auditIngestState(
    job: Pick<IngestJobMongoDocument, 'status' | 'roomId' | 'participantId' | 'nodeId' | 'transportProtocol'>
  ): Record<string, unknown> {
    return {
      status: job.status,
      ...(job.roomId ? { roomId: job.roomId } : {}),
      ...(job.participantId ? { participantId: job.participantId } : {}),
      ...(job.nodeId ? { nodeId: job.nodeId } : {}),
      transportProtocol: job.transportProtocol
    };
  }

  private auditAuthMetadata(auth: IngestAuthConfig | undefined): Record<string, unknown> | undefined {
    if (!auth || Object.keys(auth).length === 0) {
      return undefined;
    }
    return {
      basicAuthConfigured: Boolean(auth.basicUsername && auth.basicPasswordSecretRef),
      bearerTokenConfigured: Boolean(auth.bearerTokenSecretRef),
      headerNames: auth.headers?.map((header) => header.name) ?? []
    };
  }

  private metricSourceType(sourceType: unknown): string {
    return typeof sourceType === 'string' && sourceType.trim() ? sourceType.trim().toLowerCase() : 'unknown';
  }

  private classifyIngestFailure(error: unknown): IngestFailureCategory {
    if (error instanceof BadRequestException) {
      return 'policy';
    }
    if (error instanceof ConflictException) {
      return 'conflict';
    }
    if (error instanceof NotFoundException) {
      return 'not_found';
    }
    const message = this.errorMessage(error).toLowerCase();
    if (message.includes('secret') || message.includes('authentication') || message.includes('auth')) {
      return 'auth';
    }
    if (message.includes('coordination')) {
      return 'coordination';
    }
    if (message.includes('room owner') || message.includes('owner reconciliation')) {
      return 'room_owner';
    }
    if (message.includes('ffprobe') || message.includes('probe')) {
      return 'probe';
    }
    if (message.includes('transport')) {
      return 'transport';
    }
    if (message.includes('runtime') || message.includes('ffmpeg') || message.includes('process')) {
      return 'runtime';
    }
    return 'unknown';
  }

  private recordIngestFailureMetric(category: IngestFailureCategory, sourceType: string): void {
    this.metrics.ingestFailureCategories.labels(category, sourceType).inc();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private buildPlannedStreams(job: IngestJobMongoDocument, probe: MediaProbeResult, transport: TrustedIngestTransportOptions): PlannedIngestStream[] {
    const cname = `ingest-${job.id}`;
    const streams: PlannedIngestStream[] = [];
    if (probe.hasVideo) {
      const videoSsrc = randomSsrc();
      streams.push({
        kind: 'video',
        rtpParameters: {
          codecs: [
            {
              mimeType: 'video/H264',
              payloadType: 102,
              clockRate: 90000,
              parameters: {
                'packetization-mode': 1,
                'profile-level-id': '42e01f',
                'level-asymmetry-allowed': 1
              },
              rtcpFeedback: ['nack', 'nack pli', 'ccm fir', 'goog-remb', 'transport-cc']
            }
          ],
          encodings: [{ ssrc: videoSsrc }],
          rtcp: { cname, reducedSize: true }
        },
        output: {
          id: `${job.id}-video`,
          kind: 'video',
          codec: 'h264',
          host: transport.listenAddress,
          rtpPort: transport.rtpPort,
          rtcpPort: transport.rtcpPort,
          payloadType: 102,
          ssrc: videoSsrc,
          clockRate: 90000,
          bitrateKbps: this.config.get<number>('ingest.videoBitrateKbps', 1800)
        }
      });
    }
    if (probe.hasAudio) {
      const audioSsrc = randomSsrc();
      streams.push({
        kind: 'audio',
        rtpParameters: {
          codecs: [
            {
              mimeType: 'audio/opus',
              payloadType: 111,
              clockRate: 48000,
              channels: 2,
              rtcpFeedback: ['transport-cc']
            }
          ],
          encodings: [{ ssrc: audioSsrc }],
          rtcp: { cname, reducedSize: true }
        },
        output: {
          id: `${job.id}-audio`,
          kind: 'audio',
          codec: 'opus',
          host: transport.listenAddress,
          rtpPort: transport.rtpPort,
          rtcpPort: transport.rtcpPort,
          payloadType: 111,
          ssrc: audioSsrc,
          clockRate: 48000,
          bitrateKbps: this.config.get<number>('ingest.audioBitrateKbps', 96)
        }
      });
    }
    return streams;
  }

  private buildRuntimeConfig(
    job: IngestJobMongoDocument,
    source: MediaIngestSource,
    streams: PlannedIngestStream[]
  ): MediaIngestRuntimeConfig {
    return {
      ingestId: job.id,
      source,
      outputs: streams.map((stream) => ({ ...stream.output })),
      restartPolicy: this.copyRestartPolicy(job.restartPolicy as IngestRestartPolicy | undefined),
      ffmpegPath: this.config.get<string>('ingest.ffmpegPath') ?? process.env.FFMPEG_PATH,
      ffprobePath: this.config.get<string>('ingest.ffprobePath') ?? process.env.FFPROBE_PATH,
      userAgent: this.config.get<string>('ingest.userAgent', 'NativeSFU-Ingest/0.1'),
      probeTimeoutMs: this.config.get<number>('ingest.probeTimeoutMs', 8_000),
      startupTimeoutMs: this.startupTimeoutMs(),
      healthTimeoutMs: this.config.get<number>('ingest.healthTimeoutMs', 15_000),
      stopTimeoutMs: this.config.get<number>('ingest.stopTimeoutMs', 5_000)
    };
  }

  private mergeRuntimeState(
    existing: IngestRuntimeState | undefined,
    managed: ManagedIngestRuntime,
    snapshot: ReturnType<MediaIngestSupervisor['snapshot']>
  ): IngestRuntimeState {
    return {
      ...(existing ?? {}),
      nodeId: this.nodeRegistry.localNodeId(),
      participantId: managed.participantId,
      transportProtocol: 'trusted-rtp-local',
      listenAddress: managed.transport.listenAddress,
      rtpPort: managed.transport.rtpPort,
      rtcpPort: managed.transport.rtcpPort,
      ...(snapshot.runner?.health.pid !== undefined ? { processId: snapshot.runner.health.pid } : {}),
      ...(snapshot.metrics.lastStartAt ? { lastStartedAt: snapshot.metrics.lastStartAt } : {}),
      ...(snapshot.state === 'restarting' ? { lastRestartedAt: new Date().toISOString() } : {}),
      ...(snapshot.metrics.lastStopAt ? { lastStoppedAt: snapshot.metrics.lastStopAt } : {}),
      ...(snapshot.metrics.lastExitCode !== undefined ? { lastExitCode: snapshot.metrics.lastExitCode ?? undefined } : {}),
      ...(snapshot.metrics.lastError ? { lastError: snapshot.metrics.lastError } : {}),
      restartCount: snapshot.metrics.restarts,
      inputBitrateBps: snapshot.probe?.bitrateBps,
      outputBitrateBps: outputBitrateForSnapshot(snapshot)
    };
  }

  private clearRuntimeIdentity(
    existing: IngestRuntimeState | undefined,
    stoppedAt: string,
    lastError?: string
  ): IngestRuntimeState | undefined {
    if (!existing && !lastError) {
      return {
        lastStoppedAt: stoppedAt,
        ...(lastError ? { lastError } : {})
      };
    }
    const next: IngestRuntimeState = {
      ...(existing ?? {}),
      lastStoppedAt: stoppedAt
    };
    delete next.nodeId;
    delete next.participantId;
    delete next.listenAddress;
    delete next.rtpPort;
    delete next.rtcpPort;
    delete next.processId;
    if (lastError) {
      next.lastError = lastError;
    }
    return next;
  }

  private async persistManagedRuntimeState(
    job: IngestJobMongoDocument,
    managed: ManagedIngestRuntime,
    snapshot: ReturnType<MediaIngestSupervisor['snapshot']>
  ): Promise<void> {
    if (this.runtimes.get(managed.jobId) !== managed && !managed.stopping) {
      return;
    }
    job.status = snapshot.state;
    job.nodeId = this.nodeRegistry.localNodeId();
    job.participantId = managed.participantId;
    job.runtimeState = this.mergeRuntimeState(job.runtimeState, managed, snapshot);
    await job.save();
    managed.lastRuntimePersistenceAt = Date.now();
  }

  private resolveRuntimeSource(job: IngestJobMongoDocument): MediaIngestSource {
    const auth = this.resolveRuntimeAuth(job.auth as IngestAuthConfig | undefined);
    return {
      type: job.sourceType as MediaIngestSource['type'],
      url: job.sourceUrl,
      ...(auth ? { auth } : {})
    };
  }

  private resolveRuntimeAuth(auth: IngestAuthConfig | undefined): ResolvedIngestAuthConfig | undefined {
    if (!auth || Object.keys(auth).length === 0) {
      return undefined;
    }
    const resolved: ResolvedIngestAuthConfig = {
      ...(auth.basicUsername ? { basicUsername: auth.basicUsername } : {}),
      ...(auth.basicPasswordSecretRef ? { basicPassword: this.resolveSecretRef(auth.basicPasswordSecretRef) } : {}),
      ...(auth.bearerTokenSecretRef ? { bearerToken: this.resolveSecretRef(auth.bearerTokenSecretRef) } : {}),
      ...(auth.headers?.length
        ? {
            headers: auth.headers.map((header) => ({
              name: header.name,
              value: this.resolveSecretRef(header.valueSecretRef)
            }))
          }
        : {})
    };
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  private async probeSource(source: MediaIngestSource): Promise<MediaProbeResult> {
    const client = new FfprobeClient({
      ffprobePath: this.config.get<string>('ingest.ffprobePath') ?? process.env.FFPROBE_PATH,
      userAgent: this.config.get<string>('ingest.userAgent', 'NativeSFU-Ingest/0.1')
    });
    return client.probeSource(source, this.config.get<number>('ingest.probeTimeoutMs', 8_000));
  }

  private createSupervisor(config: MediaIngestRuntimeConfig): MediaIngestSupervisor {
    return new MediaIngestSupervisor(config);
  }

  private ingestDisplayName(job: IngestJobMongoDocument): string {
    return job.displayName?.trim() || job.name?.trim() || `Ingest ${job.id}`;
  }

  private startupTimeoutMs(): number {
    return this.config.get<number>('ingest.startupTimeoutMs', 15_000);
  }

  private async findIngest(ingestId: string): Promise<IngestJobMongoDocument> {
    const normalized = String(ingestId ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('Ingest id is required.');
    }
    const job = await this.ingests.findById(normalized).exec();
    if (!job) {
      throw new NotFoundException('Ingest job not found.');
    }
    return job;
  }

  private async assertAttachableRoom(roomId: string): Promise<void> {
    const room = await this.rooms.findOne({ _id: roomId, closedAt: { $exists: false } }).exec();
    if (!room) {
      throw new NotFoundException('Room not found.');
    }
  }

  private buildFilter(query: IngestListQuery): FilterQuery<IngestJobMongoDocument> {
    const filter: FilterQuery<IngestJobMongoDocument> = {};
    const andConditions: Array<Record<string, unknown>> = [];
    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.sourceType && query.sourceType !== 'all') {
      filter.sourceType = query.sourceType;
    }
    if (query.roomId) {
      andConditions.push({ roomId: String(query.roomId).trim() });
    }
    if (query.nodeId) {
      andConditions.push({ nodeId: String(query.nodeId).trim() });
    }
    if (query.attached === 'attached') {
      andConditions.push({ roomId: { $exists: true, $nin: ['', null] } });
    }
    if (query.attached === 'detached') {
      andConditions.push({ $or: [{ roomId: { $exists: false } }, { roomId: '' }, { roomId: null }] });
    }
    const search = query.search?.trim();
    if (search) {
      const expression = new RegExp(this.escapeRegex(search.slice(0, 120)), 'i');
      andConditions.push({
        $or: [
          { name: expression },
          { displayName: expression },
          { sourceUrl: expression },
          { roomId: expression },
          { participantId: expression },
          { nodeId: expression }
        ]
      });
    }
    if (andConditions.length) {
      filter.$and = andConditions;
    }
    return filter;
  }

  private async buildSummary(query: IngestListQuery): Promise<IngestListSummary> {
    const base = this.buildFilter({
      ...query,
      status: 'all',
      attached: 'all'
    });
    const attachedFilter = this.buildFilter({
      ...query,
      status: 'all',
      attached: 'attached'
    });
    const detachedFilter = this.buildFilter({
      ...query,
      status: 'all',
      attached: 'detached'
    });
    const [idle, starting, live, restarting, stopping, stopped, failed, attached, detached] = await Promise.all([
      this.ingests.countDocuments({ ...base, status: 'idle' }).exec(),
      this.ingests.countDocuments({ ...base, status: 'starting' }).exec(),
      this.ingests.countDocuments({ ...base, status: 'live' }).exec(),
      this.ingests.countDocuments({ ...base, status: 'restarting' }).exec(),
      this.ingests.countDocuments({ ...base, status: 'stopping' }).exec(),
      this.ingests.countDocuments({ ...base, status: 'stopped' }).exec(),
      this.ingests.countDocuments({ ...base, status: 'failed' }).exec(),
      this.ingests.countDocuments(attachedFilter).exec(),
      this.ingests.countDocuments(detachedFilter).exec()
    ]);
    return { idle, starting, live, restarting, stopping, stopped, failed, attached, detached };
  }

  private toIngestJob(doc: IngestJobMongoDocument): IngestJob {
    const auth = this.copyAuth(doc.auth as IngestAuthConfig | undefined);
    const restartPolicy = this.copyRestartPolicy(doc.restartPolicy as IngestRestartPolicy | undefined);
    const runtime = this.copyRuntime(doc.runtimeState as IngestRuntimeState | undefined);
    return {
      id: doc.id,
      ...(doc.name ? { name: doc.name } : {}),
      ...(doc.roomId ? { roomId: doc.roomId } : {}),
      ...(doc.participantId ? { participantId: doc.participantId } : {}),
      ...(doc.nodeId ? { nodeId: doc.nodeId } : {}),
      ...(doc.displayName ? { displayName: doc.displayName } : {}),
      sourceType: doc.sourceType,
      sourceUrl: doc.sourceUrl,
      transportProtocol: doc.transportProtocol,
      status: doc.status,
      ...(auth ? { auth } : {}),
      ...(restartPolicy ? { restartPolicy } : {}),
      ...(runtime ? { runtime } : {}),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString()
    };
  }

  private copyAuth(auth: IngestAuthConfig | undefined): IngestAuthConfig | undefined {
    if (!auth || Object.keys(auth).length === 0) {
      return undefined;
    }
    return {
      ...(auth.basicUsername ? { basicUsername: auth.basicUsername } : {}),
      ...(auth.basicPasswordSecretRef ? { basicPasswordSecretRef: INGEST_CONFIGURED_SECRET_MASK } : {}),
      ...(auth.bearerTokenSecretRef ? { bearerTokenSecretRef: INGEST_CONFIGURED_SECRET_MASK } : {}),
      ...(auth.headers?.length
        ? {
            headers: auth.headers.map((header) => ({
              name: header.name,
              valueSecretRef: INGEST_CONFIGURED_SECRET_MASK
            }))
          }
        : {})
    };
  }

  private resolveMaskedAuthUpdate(next: IngestAuthConfig, existing: IngestAuthConfig | undefined): IngestAuthConfig {
    const resolved: IngestAuthConfig = {
      ...(next.basicUsername !== undefined ? { basicUsername: next.basicUsername } : {})
    };
    if (next.basicPasswordSecretRef !== undefined) {
      resolved.basicPasswordSecretRef = this.resolveMaskedSecretRef(next.basicPasswordSecretRef, existing?.basicPasswordSecretRef, 'basicPasswordSecretRef');
    }
    if (next.bearerTokenSecretRef !== undefined) {
      resolved.bearerTokenSecretRef = this.resolveMaskedSecretRef(next.bearerTokenSecretRef, existing?.bearerTokenSecretRef, 'bearerTokenSecretRef');
    }
    if (next.headers !== undefined) {
      const existingHeaders = new Map(
        (existing?.headers ?? []).map((header) => [header.name.trim().toLowerCase(), header.valueSecretRef] as const)
      );
      resolved.headers = next.headers.map((header) => ({
        name: header.name,
        valueSecretRef: this.resolveMaskedSecretRef(
          header.valueSecretRef,
          existingHeaders.get(header.name.trim().toLowerCase()),
          `auth header ${header.name}`
        )
      }));
    }
    return resolved;
  }

  private resolveMaskedSecretRef(value: string, existing: string | undefined, label: string): string {
    if (value !== INGEST_CONFIGURED_SECRET_MASK) {
      return value;
    }
    if (existing) {
      return existing;
    }
    throw new BadRequestException(`${label} cannot use the configured placeholder without an existing secret reference.`);
  }

  private resolveSecretRef(secretRef: string): string {
    const normalizedRef = String(secretRef ?? '').trim();
    if (!normalizedRef) {
      throw new ServiceUnavailableException('Ingest auth secret reference is missing.');
    }
    const directEnvVar = parseDirectEnvSecretRef(normalizedRef);
    const envVarName = directEnvVar ?? `${this.secretEnvPrefix()}${normalizeSecretRefForEnv(normalizedRef)}`;
    const value = process.env[envVarName] ?? this.config.get<string>(envVarName);
    if (!value?.trim()) {
      throw new ServiceUnavailableException(
        `Ingest auth secret reference ${normalizedRef} could not be resolved from environment variable ${envVarName}.`
      );
    }
    return value;
  }

  private secretEnvPrefix(): string {
    const prefix = this.config.get<string>('ingest.secretEnvPrefix') ?? process.env.INGEST_SECRET_ENV_PREFIX;
    return prefix?.trim() || 'INGEST_SECRET_';
  }

  private copyRestartPolicy(policy: IngestRestartPolicy | undefined): IngestRestartPolicy | undefined {
    if (!policy) {
      return undefined;
    }
    return {
      mode: policy.mode,
      ...(policy.maxAttempts !== undefined ? { maxAttempts: policy.maxAttempts } : {}),
      ...(policy.initialBackoffMs !== undefined ? { initialBackoffMs: policy.initialBackoffMs } : {}),
      ...(policy.maxBackoffMs !== undefined ? { maxBackoffMs: policy.maxBackoffMs } : {})
    };
  }

  private copyRuntime(runtime: IngestRuntimeState | undefined): IngestRuntimeState | undefined {
    if (!runtime) {
      return undefined;
    }
    return { ...runtime };
  }

  private clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(normalized)));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!user.roles?.includes('ADMIN') && !user.roles?.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Administrator access is required.');
    }
  }

  private assertFeatureEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Media URL ingest is disabled by configuration.');
    }
  }
}

function randomSsrc(): number {
  let value = Math.floor(Math.random() * 0xffffffff) >>> 0;
  if (value === 0) {
    value = 1;
  }
  return value;
}

function outputBitrateForSnapshot(snapshot: ReturnType<MediaIngestSupervisor['snapshot']>): number | undefined {
  const bitrateKbps = snapshot.runner?.health.lastProgress?.bitrateKbps;
  if (typeof bitrateKbps === 'number' && Number.isFinite(bitrateKbps) && bitrateKbps > 0) {
    return Math.round(bitrateKbps * 1000);
  }
  const probeBitrate = snapshot.probe?.bitrateBps;
  return probeBitrate !== undefined ? probeBitrate : undefined;
}

function parseDirectEnvSecretRef(secretRef: string): string | undefined {
  if (secretRef.startsWith('env://')) {
    return secretRef.slice('env://'.length).trim() || undefined;
  }
  if (secretRef.startsWith('env:')) {
    return secretRef.slice('env:'.length).trim() || undefined;
  }
  return undefined;
}

function normalizeSecretRefForEnv(secretRef: string): string {
  return secretRef
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toUpperCase();
}

async function sampleLinuxProcessUsage(
  pid: number
): Promise<
  | {
      rssBytes?: number;
      cpuUserMicros?: number;
      cpuSystemMicros?: number;
    }
  | undefined
> {
  const statusPath = `/proc/${pid}/status`;
  const statPath = `/proc/${pid}/stat`;
  const [statusContent, statContent] = await Promise.all([
    readFile(statusPath, 'utf8').catch(() => undefined),
    readFile(statPath, 'utf8').catch(() => undefined)
  ]);
  if (!statusContent && !statContent) {
    return undefined;
  }

  const usage: {
    rssBytes?: number;
    cpuUserMicros?: number;
    cpuSystemMicros?: number;
  } = {};

  if (statusContent) {
    const rssMatch = statusContent.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (rssMatch) {
      usage.rssBytes = Number(rssMatch[1]) * 1024;
    }
  }

  if (statContent) {
    const closingParenIndex = statContent.lastIndexOf(')');
    const statTail = closingParenIndex >= 0 ? statContent.slice(closingParenIndex + 2) : statContent;
    const fields = statTail.trim().split(/\s+/);
    const utimeTicks = Number(fields[11]);
    const stimeTicks = Number(fields[12]);
    const ticksPerSecond = 100;
    if (Number.isFinite(utimeTicks)) {
      usage.cpuUserMicros = Math.round((utimeTicks / ticksPerSecond) * 1_000_000);
    }
    if (Number.isFinite(stimeTicks)) {
      usage.cpuSystemMicros = Math.round((stimeTicks / ticksPerSecond) * 1_000_000);
    }
  }

  return usage;
}
