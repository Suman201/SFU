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
import type {
  AttachIngestRequest,
  CreateIngestRequest,
  IngestAuthConfig,
  IngestJob,
  IngestListQuery,
  IngestListResponse,
  IngestListSummary,
  IngestRestartPolicy,
  IngestRuntimeState,
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
import { RedisService } from '../redis/redis.service';
import { RoomsService } from '../rooms/rooms.service';
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
  transport: TrustedIngestTransportOptions;
  producerIds: string[];
  supervisor: MediaIngestSupervisor;
  stopping: boolean;
  closingRoom: boolean;
}

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

@Injectable()
export class IngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestService.name);
  private readonly runtimes = new Map<string, ManagedIngestRuntime>();
  private readonly pendingCoordinationRequests = new Map<string, PendingIngestCoordinationRequest>();
  private readonly pendingOwnershipReconciliations = new Map<string, NodeJS.Timeout>();
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
    private readonly config: ConfigService
  ) {
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
    await this.reconcileAttachedIngestsOnStartup();
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
    return this.toIngestJob(doc);
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
    const job = await this.findIngest(ingestId);
    if (this.runtimes.has(job.id) || this.isAttachedRuntimeActive(job)) {
      throw new ConflictException('Stop the active ingest before updating runtime properties.');
    }
    const normalized = this.policy.normalizeUpdateRequest(request);
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
    return this.toIngestJob(job);
  }

  async startAdminIngest(user: AuthenticatedUser, ingestId: string): Promise<IngestJob> {
    this.assertAdmin(user);
    const job = await this.findIngest(ingestId);
    if (!job.roomId) {
      this.supervisor.requestStart(job);
      await job.save();
      return this.toIngestJob(job);
    }
    return this.startAttachedRuntimeOnOwner(job);
  }

  async stopAdminIngest(user: AuthenticatedUser, ingestId: string): Promise<IngestJob> {
    this.assertAdmin(user);
    const job = await this.findIngest(ingestId);
    if (!job.roomId) {
      this.supervisor.requestStop(job);
      job.participantId = undefined;
      job.nodeId = undefined;
      job.runtimeState = this.clearRuntimeIdentity(job.runtimeState, new Date().toISOString());
      await job.save();
      return this.toIngestJob(job);
    }
    return this.stopAttachedRuntimeOnOwner(job);
  }

  async attachAdminIngest(user: AuthenticatedUser, ingestId: string, roomId: string, request: Omit<AttachIngestRequest, 'roomId'>): Promise<IngestJob> {
    this.assertAdmin(user);
    const job = await this.findIngest(ingestId);
    const normalized = this.policy.normalizeAttachRequest(roomId, request);
    await this.assertAttachableRoom(normalized.roomId);
    if (job.roomId && job.roomId !== normalized.roomId) {
      throw new ConflictException('Ingest job is already attached to a different room.');
    }
    job.roomId = normalized.roomId;
    if (normalized.displayName !== undefined) {
      job.displayName = normalized.displayName;
    }
    await job.save();
    if (!normalized.startIfStopped) {
      return this.toIngestJob(job);
    }
    return this.startAttachedRuntimeOnOwner(job);
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
    return this.detachAttachedRuntimeFromOwner(job, normalizedRoomId);
  }

  private async startAttachedRuntime(job: IngestJobMongoDocument): Promise<IngestJob> {
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
        participantId: participant.id
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
        transport,
        producerIds: producers.map((producer) => producer.id),
        supervisor: this.createSupervisor(this.buildRuntimeConfig(job, source, plannedStreams)),
        stopping: false,
        closingRoom: false
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
    await this.persistManagedRuntimeState(job, managed, snapshot);
    if ((snapshot.state === 'failed' || snapshot.state === 'stopped') && !managed.stopping) {
      managed.stopping = true;
      this.runtimes.delete(managed.jobId);
      await this.ingestTransports.closeTransport(managed.transport.id).catch(() => undefined);
      if (job.roomId && job.participantId) {
        await this.roomsService.removeIngestParticipant(job.roomId, job.participantId).catch(() => undefined);
      }
      job.participantId = undefined;
      job.nodeId = undefined;
      job.runtimeState = this.clearRuntimeIdentity(job.runtimeState, new Date().toISOString(), snapshot.metrics.lastError);
      await job.save();
    }
  }

  private async handleStartupFailure(job: IngestJobMongoDocument, managed: ManagedIngestRuntime, error: unknown): Promise<void> {
    managed.stopping = true;
    this.runtimes.delete(job.id);
    await managed.supervisor.stop().catch(() => undefined);
    await this.ingestTransports.closeTransport(managed.transport.id).catch(() => undefined);
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
  }

  private async handleRoomClosed(roomId: string): Promise<void> {
    const jobs = await this.ingests.find({ roomId }).exec();
    await Promise.all(
      jobs.map(async (job) => {
        const managed = this.runtimes.get(job.id);
        if (managed) {
          managed.closingRoom = true;
        }
        await this.stopRoomRuntime(job, { clearRoom: true, roomClosed: true }).catch(() => undefined);
      })
    );
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
      })
    );
  }

  private shouldRunAttachedRuntime(job: Pick<IngestJobMongoDocument, 'roomId' | 'status'>): boolean {
    return Boolean(job.roomId) && ACTIVE_ATTACHED_INGEST_STATUSES.has(job.status);
  }

  private isAttachedRuntimeActive(job: Pick<IngestJobMongoDocument, 'roomId' | 'status'>): boolean {
    return this.shouldRunAttachedRuntime(job);
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
    throw new ServiceUnavailableException(
      'Secret-backed ingest source authentication is not wired yet for the Phase 4 room lifecycle.'
    );
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
      ...(this.copyAuth(doc.auth as IngestAuthConfig | undefined) ? { auth: this.copyAuth(doc.auth as IngestAuthConfig | undefined)! } : {}),
      ...(this.copyRestartPolicy(doc.restartPolicy as IngestRestartPolicy | undefined)
        ? { restartPolicy: this.copyRestartPolicy(doc.restartPolicy as IngestRestartPolicy | undefined)! }
        : {}),
      ...(this.copyRuntime(doc.runtimeState as IngestRuntimeState | undefined)
        ? { runtime: this.copyRuntime(doc.runtimeState as IngestRuntimeState | undefined)! }
        : {}),
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
      ...(auth.basicPasswordSecretRef ? { basicPasswordSecretRef: auth.basicPasswordSecretRef } : {}),
      ...(auth.bearerTokenSecretRef ? { bearerTokenSecretRef: auth.bearerTokenSecretRef } : {}),
      ...(auth.headers?.length ? { headers: auth.headers.map((header) => ({ ...header })) } : {})
    };
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
}

function randomSsrc(): number {
  let value = Math.floor(Math.random() * 0xffffffff) >>> 0;
  if (value === 0) {
    value = 1;
  }
  return value;
}

function outputBitrateForSnapshot(snapshot: ReturnType<MediaIngestSupervisor['snapshot']>): number | undefined {
  const outputTargets = snapshot.runner?.command?.args.filter((entry) => typeof entry === 'string').length;
  if (!outputTargets) {
    return undefined;
  }
  const probeBitrate = snapshot.probe?.bitrateBps;
  return probeBitrate !== undefined ? probeBitrate : undefined;
}
