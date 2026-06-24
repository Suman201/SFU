import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  AdminRecordingDetail,
  AdminRecordingListItem,
  AdminRecordingListQuery,
  AdminRecordingListResponse,
  AdminRecordingPlaybackResponse,
  AdminRecordingStatus,
  AdminRecordingSummary,
  ClassSessionRecordingEvent,
  Recording,
  RecordingScope,
  RecordingStatus,
  RecordingTrackManifestEntry
} from '@native-sfu/contracts';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ParticipantDocument,
  ParticipantMongoDocument,
  ProducerDocument,
  ProducerMongoDocument,
  RecordingDocument,
  RecordingMongoDocument,
  RoomDocument,
  RoomMongoDocument
} from '../database/schemas';
import { PlatformEventsService } from '../events/platform-events.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';

type ClassSessionRecordingEventName = 'recording:started' | 'recording:updated' | 'recording:stopped' | 'recording:failed';

const ACTIVE_RECORDING_STATUSES: RecordingStatus[] = ['starting', 'recording', 'stopping'];
const CLASS_SESSION_RECORDING_MIME_TYPE = 'application/vnd.native-sfu.recording-manifest+json';
const CLASS_SESSION_RECORDING_CONTAINER = 'manifest-json';
const DEFAULT_RECORDING_RETENTION_DAYS = 90;
const ADMIN_RECORDING_EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

interface ClassSessionRecordingContext {
  session: ClassSessionMongoDocument;
  batch: BatchMongoDocument;
  actor: AuthenticatedUser;
  retentionDays?: number;
}

export interface RecordingDownload {
  recording: Recording;
  content: string;
  fileName: string;
}

interface AdminRecordingHydration {
  session?: ClassSessionMongoDocument;
  batch?: BatchMongoDocument;
}

@Injectable()
export class RecordingsService {
  private readonly classSessionRecordingEventListeners = new Set<
    (event: ClassSessionRecordingEventName, payload: ClassSessionRecordingEvent) => void
  >();

  constructor(
    @InjectModel(RoomDocument.name) private readonly rooms: Model<RoomMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(ParticipantDocument.name) private readonly participants: Model<ParticipantMongoDocument>,
    @InjectModel(ProducerDocument.name) private readonly producers: Model<ProducerMongoDocument>,
    @InjectModel(RecordingDocument.name) private readonly recordings: Model<RecordingMongoDocument>,
    private readonly config: ConfigService,
    private readonly platformEvents: PlatformEventsService,
    private readonly studentEnrollments: StudentEnrollmentsService,
    @Optional() private readonly auditLogs?: AuditLogsService
  ) {}

  onClassSessionRecordingEvent(
    listener: (event: ClassSessionRecordingEventName, payload: ClassSessionRecordingEvent) => void
  ): () => void {
    this.classSessionRecordingEventListeners.add(listener);
    return () => this.classSessionRecordingEventListeners.delete(listener);
  }

  async start(userId: string, roomId: string, scope: RecordingScope, participantId?: string): Promise<Recording> {
    const host = await this.assertHost(userId, roomId);
    const driver = this.config.get<'local' | 's3'>('recording.driver', 'local');
    const localPath = this.config.get<string>('recording.localPath', './recordings');
    if (driver === 'local') {
      await mkdir(localPath, { recursive: true });
    }
    const doc = await this.recordings.create({
      roomId,
      participantId,
      scope,
      status: 'recording',
      storageDriver: driver,
      path: driver === 'local' ? join(localPath, `${roomId}-${Date.now()}.webm`) : undefined,
      startedAt: new Date()
    });
    await this.platformEvents.appendEvent({
      type: 'recording.started',
      roomId,
      actor: {
        type: 'participant',
        participantId: host.participant.id,
        userId: host.participant.userId,
        label: host.participant.displayName,
        ...(host.participant.nodeId ? { nodeId: host.participant.nodeId } : {})
      },
      payload: {
        room: {
          roomId,
          ...(host.room.name ? { name: host.room.name } : {})
        },
        recordingId: doc.id,
        participantId: participantId ?? host.participant.id,
        scope,
        status: doc.status,
        path: doc.path,
        downloadUrl: doc.downloadUrl
      }
    });
    return this.toRecording(doc);
  }

  async stop(userId: string, recordingId: string): Promise<Recording> {
    const recording = await this.recordings.findById(recordingId);
    if (!recording) {
      throw new NotFoundException('Recording not found');
    }
    const host = await this.assertHost(userId, recording.roomId);
    recording.status = 'stopped';
    recording.stoppedAt = new Date();
    await recording.save();
    await this.platformEvents.appendEvent({
      type: 'recording.stopped',
      roomId: recording.roomId,
      actor: {
        type: 'participant',
        participantId: host.participant.id,
        userId: host.participant.userId,
        label: host.participant.displayName,
        ...(host.participant.nodeId ? { nodeId: host.participant.nodeId } : {})
      },
      payload: {
        room: {
          roomId: recording.roomId,
          ...(host.room.name ? { name: host.room.name } : {})
        },
        recordingId: recording.id,
        participantId: recording.participantId,
        scope: recording.scope,
        status: recording.status,
        path: recording.path,
        downloadUrl: recording.downloadUrl
      }
    });
    return this.toRecording(recording);
  }

  async listForRoom(userId: string, roomId: string): Promise<Recording[]> {
    await this.assertHost(userId, roomId);
    const docs = await this.recordings.find({ roomId }).sort({ startedAt: -1 });
    return docs.map((doc) => this.toRecording(doc));
  }

  async startClassSessionRecording(context: ClassSessionRecordingContext): Promise<Recording> {
    const { session, batch, actor } = context;
    this.assertCanManageBatch(batch, actor);
    if (session.status !== 'live') {
      throw new BadRequestException('Recording can only start after the class is live.');
    }
    if (!session.roomId) {
      throw new BadRequestException('This class session does not have an active media room.');
    }
    const existing = await this.recordings.findOne({
      sessionId: session.id,
      status: { $in: ACTIVE_RECORDING_STATUSES }
    });
    if (existing) {
      throw new ConflictException('This class session is already being recorded.');
    }

    const driver = this.config.get<'local' | 's3'>('recording.driver', 'local');
    if (driver !== 'local') {
      throw new BadRequestException('Class-session recording playback currently requires local recording storage.');
    }

    const now = new Date();
    const retentionDays = context.retentionDays ?? this.config.get<number>('recording.retentionDays', DEFAULT_RECORDING_RETENTION_DAYS);
    let recording: RecordingMongoDocument;
    try {
      recording = await this.recordings.create({
        sessionId: session.id,
        batchId: batch.id,
        roomId: session.roomId,
        scope: 'room',
        status: 'starting',
        storageDriver: driver,
        mimeType: CLASS_SESSION_RECORDING_MIME_TYPE,
        container: CLASS_SESSION_RECORDING_CONTAINER,
        startedBy: actor.sub,
        startedAt: now,
        retentionExpiresAt: new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000),
        consentRequired: true,
        consentVersion: 'class-session-recording-v1'
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('This class session is already being recorded.');
      }
      throw error;
    }

    try {
      const manifest = await this.writeClassSessionManifest(recording, session, batch);
      recording.status = 'recording';
      recording.path = manifest.path;
      recording.storageKey = manifest.storageKey;
      recording.downloadUrl = this.classSessionRecordingDownloadUrl(session.id, recording.recordingId);
      recording.playbackUrl = recording.downloadUrl;
      recording.size = manifest.size;
      recording.tracks = manifest.tracks as unknown as Record<string, unknown>[];
      await recording.save();
    } catch (error) {
      recording.status = 'failed';
      recording.failureReason = error instanceof Error ? error.message : 'Unable to prepare server-side recording manifest.';
      await recording.save().catch(() => undefined);
      await this.appendClassSessionRecordingPlatformEvent('recording.failed', recording, batch, actor, recording.failureReason);
      this.emitClassSessionRecordingEvent('recording:failed', recording, recording.failureReason);
      throw error;
    }

    await this.appendClassSessionRecordingPlatformEvent('recording.started', recording, batch, actor);
    this.emitClassSessionRecordingEvent('recording:started', recording);
    await this.auditLogs?.record({
      actor,
      action: 'class_sessions.recording.start',
      resourceType: 'recording',
      resourceId: recording.recordingId,
      resourceLabel: session.title,
      metadata: { summary: `Started recording for ${session.title}`, sessionId: session.id, batchId: batch.id, roomId: session.roomId },
      after: { status: recording.status, retentionExpiresAt: recording.retentionExpiresAt?.toISOString() }
    });
    return this.toRecording(recording);
  }

  async stopClassSessionRecording(sessionId: string, recordingId: string | undefined, actor: AuthenticatedUser): Promise<Recording> {
    const session = await this.classSessions.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    const batch = await this.findBatch(session.batchId);
    this.assertCanManageBatch(batch, actor);
    const recording = await this.findClassSessionRecording(session.id, recordingId);
    if (!recording) {
      throw new NotFoundException('Recording not found.');
    }
    return this.stopClassSessionRecordingDocument(recording, session, batch, actor, 'manual_stop');
  }

  async stopActiveClassSessionRecording(input: {
    sessionId: string;
    actorUserId: string;
    actorLabel?: string;
    reason?: string;
  }): Promise<Recording | null> {
    const recording = await this.recordings.findOne({
      sessionId: input.sessionId,
      status: { $in: ACTIVE_RECORDING_STATUSES }
    });
    if (!recording) {
      return null;
    }
    const session = await this.classSessions.findById(input.sessionId);
    if (!session) {
      return this.failRecording(recording, input.reason ?? 'class_session_missing');
    }
    const batch = await this.findBatch(session.batchId);
    const actor: AuthenticatedUser = {
      sub: input.actorUserId,
      email: input.actorLabel ?? 'Class session',
      roles: ['ADMIN'],
      permissions: [],
      tokenId: 'system'
    };
    return this.stopClassSessionRecordingDocument(recording, session, batch, actor, input.reason ?? 'session_ended');
  }

  async listClassSessionRecordings(sessionId: string, user: AuthenticatedUser): Promise<Recording[]> {
    const session = await this.classSessions.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    const batch = await this.findBatch(session.batchId);
    await this.assertCanReadClassSession(batch, user);
    const docs = await this.recordings.find({ sessionId }).sort({ startedAt: -1 });
    return docs.map((doc) => this.toRecording(doc));
  }

  async getClassSessionRecordingSummary(sessionId: string): Promise<{ active?: Recording; latest?: Recording }> {
    const [active, latest] = await Promise.all([
      this.recordings.findOne({ sessionId, status: { $in: ACTIVE_RECORDING_STATUSES } }).sort({ startedAt: -1 }),
      this.recordings.findOne({ sessionId }).sort({ startedAt: -1 })
    ]);
    return {
      ...(active ? { active: this.toRecording(active) } : {}),
      ...(latest ? { latest: this.toRecording(latest) } : {})
    };
  }

  async readClassSessionRecordingDownload(sessionId: string, recordingId: string, user: AuthenticatedUser): Promise<RecordingDownload> {
    const session = await this.classSessions.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    const batch = await this.findBatch(session.batchId);
    await this.assertCanReadClassSession(batch, user);
    const recording = await this.findClassSessionRecording(session.id, recordingId);
    if (!recording) {
      throw new NotFoundException('Recording not found.');
    }
    if (recording.status !== 'stopped') {
      throw new ConflictException('Recording is not ready for playback yet.');
    }
    if (recording.retentionExpiresAt && recording.retentionExpiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('Recording has expired.');
    }
    if (!recording.path) {
      throw new NotFoundException('Recording playback is not available yet.');
    }
    const content = await readFile(recording.path, 'utf8');
    return {
      recording: this.toRecording(recording),
      content,
      fileName: `class-session-${session.id}-recording-${recording.recordingId}.json`
    };
  }

  async listAdminRecordings(query: AdminRecordingListQuery, user: AuthenticatedUser): Promise<AdminRecordingListResponse> {
    this.assertAdmin(user);
    const page = this.clampPositiveInteger(query.page, 1, 10_000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const baseFilter = await this.adminRecordingFilter({ ...query, status: 'all' });
    const filter = await this.adminRecordingFilter(query);
    const skip = (page - 1) * limit;
    const [docs, total, summary] = await Promise.all([
      this.recordings.find(filter).sort(this.adminRecordingSort(query.sort)).skip(skip).limit(limit).exec(),
      this.recordings.countDocuments(filter).exec(),
      this.adminRecordingSummary(baseFilter)
    ]);
    const hydration = await this.hydrateAdminRecordings(docs);
    return {
      items: docs.map((doc) => this.toAdminRecordingListItem(doc, hydration.get(doc.id))),
      summary,
      page,
      limit,
      total
    };
  }

  async getAdminRecording(recordingId: string, user: AuthenticatedUser): Promise<AdminRecordingDetail> {
    this.assertAdmin(user);
    const recording = await this.findAdminRecording(recordingId);
    const hydration = await this.hydrateAdminRecording(recording);
    return this.toAdminRecordingDetail(recording, hydration);
  }

  async getAdminRecordingPlayback(recordingId: string, user: AuthenticatedUser): Promise<AdminRecordingPlaybackResponse> {
    this.assertAdmin(user);
    const recording = await this.findAdminRecording(recordingId);
    const status = this.adminRecordingStatus(recording);
    if (status === 'expired') {
      return { recordingId: recording.recordingId, status, playerMode: 'manifest', message: 'Recording retention has expired.' };
    }
    if (recording.status !== 'stopped') {
      return {
        recordingId: recording.recordingId,
        status,
        playerMode: 'manifest',
        message: status === 'failed' ? this.safeFailureReason(recording.failureReason) : 'Recording is not ready for playback yet.'
      };
    }
    const playerMode = recording.mimeType?.startsWith('video/') ? 'video' : 'manifest';
    const response: AdminRecordingPlaybackResponse = {
      recordingId: recording.recordingId,
      status,
      playerMode,
      playbackUrl: this.adminRecordingDownloadUrl(recording.recordingId),
      mimeType: recording.mimeType,
      container: recording.container,
      fileName: this.adminRecordingFileName(recording),
      ...(playerMode === 'manifest'
        ? { message: 'This deployment stores class-session recording playback as a server-owned manifest.' }
        : {})
    };
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.recordings.playback',
      resourceType: 'recording',
      resourceId: recording.recordingId,
      resourceLabel: recording.sessionId,
      metadata: { summary: `Accessed playback for recording ${recording.recordingId}`, sessionId: recording.sessionId, status }
    });
    return response;
  }

  async readAdminRecordingDownload(recordingId: string, user: AuthenticatedUser): Promise<RecordingDownload> {
    this.assertAdmin(user);
    const recording = await this.findAdminRecording(recordingId);
    if (!recording.sessionId) {
      throw new NotFoundException('Recording download is not available for this recording.');
    }
    const download = await this.readClassSessionRecordingDownload(recording.sessionId, recording.recordingId, user);
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.recordings.download',
      resourceType: 'recording',
      resourceId: recording.recordingId,
      resourceLabel: recording.sessionId,
      metadata: { summary: `Downloaded recording ${recording.recordingId}`, sessionId: recording.sessionId, fileName: download.fileName }
    });
    return download;
  }

  async updateAdminRecordingRetention(recordingId: string, retentionExpiresAt: string, user: AuthenticatedUser): Promise<AdminRecordingDetail> {
    this.assertAdmin(user);
    const expiresAt = new Date(retentionExpiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Retention expiry must be a valid date.');
    }
    const recording = await this.findAdminRecording(recordingId);
    recording.retentionExpiresAt = expiresAt;
    await recording.save();
    const hydration = await this.hydrateAdminRecording(recording);
    const detail = this.toAdminRecordingDetail(recording, hydration);
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.recordings.retention.update',
      resourceType: 'recording',
      resourceId: recording.recordingId,
      resourceLabel: detail.sessionTitle ?? recording.sessionId,
      metadata: { summary: `Updated retention for recording ${recording.recordingId}` },
      after: { retentionExpiresAt: detail.retentionExpiresAt }
    });
    return detail;
  }

  async expireAdminRecording(recordingId: string, user: AuthenticatedUser): Promise<AdminRecordingDetail> {
    this.assertAdmin(user);
    const recording = await this.findAdminRecording(recordingId);
    recording.retentionExpiresAt = new Date();
    await recording.save();
    const hydration = await this.hydrateAdminRecording(recording);
    const detail = this.toAdminRecordingDetail(recording, hydration);
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.recordings.archive',
      resourceType: 'recording',
      resourceId: recording.recordingId,
      resourceLabel: detail.sessionTitle ?? recording.sessionId,
      metadata: { summary: `Archived recording ${recording.recordingId}` },
      after: { retentionExpiresAt: detail.retentionExpiresAt }
    });
    return detail;
  }

  private async assertHost(
    userId: string,
    roomId: string
  ): Promise<{ room: RoomMongoDocument; participant: ParticipantMongoDocument }> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    const participant = await this.participants.findOne({ _id: room.hostId, userId, roomId });
    if (!participant) {
      throw new ForbiddenException('Host role required');
    }
    return { room, participant };
  }

  private async stopClassSessionRecordingDocument(
    recording: RecordingMongoDocument,
    session: ClassSessionMongoDocument,
    batch: BatchMongoDocument,
    actor: AuthenticatedUser,
    reason: string
  ): Promise<Recording> {
    if (recording.status === 'stopped' || recording.status === 'failed') {
      return this.toRecording(recording);
    }

    recording.status = 'stopping';
    await recording.save();
    this.emitClassSessionRecordingEvent('recording:updated', recording, reason);

    const stoppedAt = new Date();
    const effectiveStoppedAt = recording.stoppedAt ?? stoppedAt;
    recording.status = 'stopped';
    recording.stoppedAt = effectiveStoppedAt;
    recording.stoppedBy = actor.sub;
    recording.durationSeconds = Math.max(0, Math.round((effectiveStoppedAt.getTime() - recording.startedAt.getTime()) / 1000));
    try {
      const manifest = await this.writeClassSessionManifest(recording, session, batch);
      recording.path = manifest.path;
      recording.storageKey = manifest.storageKey;
      recording.downloadUrl = this.classSessionRecordingDownloadUrl(session.id, recording.recordingId);
      recording.playbackUrl = recording.downloadUrl;
      recording.size = manifest.size;
      recording.tracks = manifest.tracks as unknown as Record<string, unknown>[];
    } catch (error) {
      recording.status = 'failed';
      recording.failureReason = error instanceof Error ? error.message : 'Unable to finalize server-side recording manifest.';
      await recording.save().catch(() => undefined);
      await this.appendClassSessionRecordingPlatformEvent('recording.failed', recording, batch, actor, recording.failureReason);
      this.emitClassSessionRecordingEvent('recording:failed', recording, recording.failureReason);
      return this.toRecording(recording);
    }
    await recording.save();
    await this.appendClassSessionRecordingPlatformEvent('recording.stopped', recording, batch, actor, reason);
    this.emitClassSessionRecordingEvent('recording:stopped', recording, reason);
    await this.auditLogs?.record({
      actor,
      action: 'class_sessions.recording.stop',
      resourceType: 'recording',
      resourceId: recording.recordingId,
      resourceLabel: session.title,
      metadata: { summary: `Stopped recording for ${session.title}`, sessionId: session.id, batchId: batch.id, reason },
      after: { status: recording.status, stoppedAt: recording.stoppedAt?.toISOString(), durationSeconds: recording.durationSeconds }
    });
    return this.toRecording(recording);
  }

  private async failRecording(recording: RecordingMongoDocument, reason: string): Promise<Recording> {
    recording.status = 'failed';
    recording.failureReason = reason;
    recording.stoppedAt = recording.stoppedAt ?? new Date();
    await recording.save();
    this.emitClassSessionRecordingEvent('recording:failed', recording, reason);
    return this.toRecording(recording);
  }

  private async writeClassSessionManifest(
    recording: RecordingMongoDocument,
    session: ClassSessionMongoDocument,
    batch: BatchMongoDocument
  ): Promise<{ path: string; storageKey: string; size: number; tracks: RecordingTrackManifestEntry[] }> {
    const localPath = this.config.get<string>('recording.localPath', './recordings');
    const sessionKey = this.sanitizePathSegment(session.id);
    const recordingKey = this.sanitizePathSegment(recording.recordingId);
    const storageKey = `class-sessions/${sessionKey}/${recordingKey}.json`;
    const directory = join(localPath, 'class-sessions', sessionKey);
    const filePath = join(directory, `${recordingKey}.json`);
    await mkdir(directory, { recursive: true });

    const windowStartedAt = recording.startedAt;
    const windowEndedAt = recording.stoppedAt ?? new Date();
    const [participants, producers] = await Promise.all([
      this.participants.find({
        roomId: session.roomId,
        joinedAt: { $lte: windowEndedAt },
        $or: [{ leftAt: { $exists: false } }, { leftAt: { $gte: windowStartedAt } }]
      }),
      this.producers.find({
        roomId: session.roomId,
        createdAt: { $lte: windowEndedAt },
        $or: [{ closedAt: { $exists: false } }, { closedAt: { $gte: windowStartedAt } }]
      })
    ]);
    const tracks = producers.map((producer) => this.toManifestTrack(producer));
    const manifest = {
      version: 1,
      type: 'native-sfu.class-session.server-manifest',
      compositionMode: 'server-track-manifest',
      limitation:
        'This deployment does not yet include an RTP mux/composition worker. The recording is a server-owned manifest of class-session participants and SFU producers for the recording window.',
      recording: {
        id: recording.id,
        recordingId: recording.recordingId,
        sessionId: session.id,
        batchId: batch.id,
        roomId: session.roomId,
        status: recording.status,
        startedAt: recording.startedAt.toISOString(),
        stoppedAt: recording.stoppedAt?.toISOString(),
        durationSeconds: recording.durationSeconds,
        storageProvider: recording.storageDriver,
        storageKey
      },
      classSession: {
        title: session.title,
        sessionNumber: session.sessionNumber,
        scheduledAt: session.scheduledAt.toISOString(),
        startedAt: session.startedAt?.toISOString(),
        completedAt: session.completedAt?.toISOString()
      },
      participants: participants.map((participant) => ({
        participantId: participant.id,
        userId: participant.userId,
        displayName: participant.displayName,
        role: participant.role,
        admitted: participant.admitted,
        joinedAt: participant.joinedAt?.toISOString(),
        leftAt: participant.leftAt?.toISOString()
      })),
      tracks,
      generatedAt: new Date().toISOString()
    };
    await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const fileStat = await stat(filePath);
    return { path: filePath, storageKey, size: fileStat.size, tracks };
  }

  private toManifestTrack(producer: ProducerMongoDocument): RecordingTrackManifestEntry {
    return {
      producerId: producer.id,
      participantId: producer.participantId,
      kind: producer.kind,
      ...(producer.source ? { source: producer.source } : {}),
      status: producer.status,
      startedAt: producer.createdAt?.toISOString(),
      closedAt: producer.closedAt?.toISOString()
    };
  }

  private async findClassSessionRecording(sessionId: string, recordingId: string | undefined): Promise<RecordingMongoDocument | null> {
    if (!recordingId) {
      return this.recordings.findOne({ sessionId, status: { $in: ACTIVE_RECORDING_STATUSES } }).sort({ startedAt: -1 });
    }
    const filters: Record<string, unknown>[] = [{ recordingId }];
    if (Types.ObjectId.isValid(recordingId)) {
      filters.push({ _id: recordingId });
    }
    return this.recordings.findOne({ sessionId, $or: filters });
  }

  private async findBatch(batchId: string): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } });
    if (!batch) {
      throw new NotFoundException('Batch not found.');
    }
    return batch;
  }

  private assertCanManageBatch(batch: BatchMongoDocument, user: AuthenticatedUser): void {
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) {
      return;
    }
    throw new ForbiddenException('You are not allowed to manage this class session recording.');
  }

  private async assertCanReadClassSession(batch: BatchMongoDocument, user: AuthenticatedUser): Promise<void> {
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) {
      return;
    }
    if (user.roles.includes('STUDENT') && (await this.studentEnrollments.isStudentEnrolledInBatch(user.sub, batch.id))) {
      return;
    }
    throw new ForbiddenException('You are not allowed to access this class session recording.');
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN');
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!this.isAdmin(user)) {
      throw new ForbiddenException('Only administrators can manage recordings.');
    }
  }

  private classSessionRecordingDownloadUrl(sessionId: string, recordingId: string): string {
    return `/api/v1/class-sessions/${encodeURIComponent(sessionId)}/recordings/${encodeURIComponent(recordingId)}/download`;
  }

  private adminRecordingDownloadUrl(recordingId: string): string {
    return `/api/v1/admin/recordings/${encodeURIComponent(recordingId)}/download`;
  }

  private async findAdminRecording(recordingId: string): Promise<RecordingMongoDocument> {
    const filters: Record<string, unknown>[] = [{ recordingId }];
    if (Types.ObjectId.isValid(recordingId)) {
      filters.push({ _id: recordingId });
    }
    const recording = await this.recordings.findOne({ $or: filters }).exec();
    if (!recording) {
      throw new NotFoundException('Recording not found.');
    }
    return recording;
  }

  private async adminRecordingFilter(query: AdminRecordingListQuery): Promise<FilterQuery<RecordingDocument>> {
    const filter: FilterQuery<RecordingDocument> = {};
    if (query.sessionId?.trim()) filter.sessionId = query.sessionId.trim();
    if (query.batchId?.trim()) filter.batchId = query.batchId.trim();
    if (query.dateFrom || query.dateTo) {
      filter.startedAt = {
        ...(query.dateFrom ? { $gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
        ...(query.dateTo ? { $lte: new Date(`${query.dateTo}T23:59:59.999Z`) } : {})
      };
    }
    await this.applyAdminRecordingBatchFilters(filter, query);
    await this.applyAdminRecordingSearchFilter(filter, query.search);
    this.applyAdminRecordingStatusFilter(filter, query.status);
    return filter;
  }

  private async applyAdminRecordingBatchFilters(filter: FilterQuery<RecordingDocument>, query: AdminRecordingListQuery): Promise<void> {
    const batchFilter: FilterQuery<BatchDocument> = { deletedAt: { $exists: false } };
    if (query.courseId?.trim()) batchFilter.courseId = query.courseId.trim();
    if (query.teacherId?.trim()) batchFilter.teacherId = query.teacherId.trim();
    if (!query.courseId?.trim() && !query.teacherId?.trim()) {
      return;
    }
    const batches = await this.batches.find(batchFilter).exec();
    const batchIds = batches.map((batch) => batch.id);
    if (!batchIds.length) {
      filter.batchId = '__none__';
      return;
    }
    if (typeof filter.batchId === 'string') {
      filter.batchId = batchIds.includes(filter.batchId) ? filter.batchId : '__none__';
      return;
    }
    filter.batchId = { $in: batchIds };
  }

  private async applyAdminRecordingSearchFilter(filter: FilterQuery<RecordingDocument>, search: string | undefined): Promise<void> {
    const value = search?.trim();
    if (!value) {
      return;
    }
    const regex = new RegExp(this.escapeRegex(value), 'i');
    const [sessions, batches] = await Promise.all([
      this.classSessions.find({ title: regex }).exec(),
      this.batches.find({ deletedAt: { $exists: false }, $or: [{ name: regex }, { courseId: regex }, { courseName: regex }] }).exec()
    ]);
    filter.$or = [
      { recordingId: regex },
      { sessionId: regex },
      { batchId: regex },
      { roomId: regex },
      ...(sessions.length ? [{ sessionId: { $in: sessions.map((session) => session.id) } }] : []),
      ...(batches.length ? [{ batchId: { $in: batches.map((batch) => batch.id) } }] : [])
    ];
  }

  private applyAdminRecordingStatusFilter(filter: FilterQuery<RecordingDocument>, status: AdminRecordingListQuery['status']): void {
    if (!status || status === 'all') {
      return;
    }
    const now = new Date();
    if (status === 'expired') {
      filter.status = 'stopped';
      filter.retentionExpiresAt = { $lte: now };
      return;
    }
    filter.status = status;
    if (status === 'stopped') {
      filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), { $or: [{ retentionExpiresAt: { $exists: false } }, { retentionExpiresAt: { $gt: now } }] }];
    }
  }

  private async adminRecordingSummary(baseFilter: FilterQuery<RecordingDocument>): Promise<AdminRecordingSummary> {
    const now = new Date();
    const soon = new Date(now.getTime() + ADMIN_RECORDING_EXPIRING_SOON_MS);
    const notExpiredStoppedFilter = {
      ...baseFilter,
      status: 'stopped',
      $and: [
        ...(Array.isArray(baseFilter.$and) ? baseFilter.$and : []),
        { $or: [{ retentionExpiresAt: { $exists: false } }, { retentionExpiresAt: { $gt: now } }] }
      ]
    };
    const [totalRecordings, processingRecordings, readyRecordings, failedRecordings, expiredRecordings, expiringSoonRecordings] = await Promise.all([
      this.recordings.countDocuments(baseFilter).exec(),
      this.recordings.countDocuments({ ...baseFilter, status: { $in: ACTIVE_RECORDING_STATUSES } }).exec(),
      this.recordings.countDocuments(notExpiredStoppedFilter).exec(),
      this.recordings.countDocuments({ ...baseFilter, status: 'failed' }).exec(),
      this.recordings.countDocuments({ ...baseFilter, status: 'stopped', retentionExpiresAt: { $lte: now } }).exec(),
      this.recordings
        .countDocuments({
          ...baseFilter,
          status: 'stopped',
          retentionExpiresAt: { $gt: now, $lte: soon }
        })
        .exec()
    ]);
    return { totalRecordings, processingRecordings, readyRecordings, failedRecordings, expiredRecordings, expiringSoonRecordings };
  }

  private adminRecordingSort(sort: AdminRecordingListQuery['sort'] = 'started_desc'): Record<string, 1 | -1> {
    if (sort === 'started_asc') return { startedAt: 1 };
    if (sort === 'retention_asc') return { retentionExpiresAt: 1, startedAt: -1 };
    if (sort === 'retention_desc') return { retentionExpiresAt: -1, startedAt: -1 };
    if (sort === 'duration_desc') return { durationSeconds: -1, startedAt: -1 };
    return { startedAt: -1 };
  }

  private async hydrateAdminRecordings(docs: RecordingMongoDocument[]): Promise<Map<string, AdminRecordingHydration>> {
    const sessionIds = [...new Set(docs.map((doc) => doc.sessionId).filter(Boolean) as string[])];
    const batchIds = [...new Set(docs.map((doc) => doc.batchId).filter(Boolean) as string[])];
    const [sessions, directBatches] = await Promise.all([
      sessionIds.length ? this.classSessions.find({ _id: { $in: sessionIds } }).exec() : Promise.resolve([]),
      batchIds.length ? this.batches.find({ _id: { $in: batchIds }, deletedAt: { $exists: false } }).exec() : Promise.resolve([])
    ]);
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const allBatchIds = [...new Set([...batchIds, ...sessions.map((session) => session.batchId).filter(Boolean)])];
    const extraBatchIds = allBatchIds.filter((batchId) => !directBatches.some((batch) => batch.id === batchId));
    const extraBatches = extraBatchIds.length
      ? await this.batches.find({ _id: { $in: extraBatchIds }, deletedAt: { $exists: false } }).exec()
      : [];
    const batchMap = new Map([...directBatches, ...extraBatches].map((batch) => [batch.id, batch]));
    return docs.reduce((map, doc) => {
      const session = doc.sessionId ? sessionMap.get(doc.sessionId) : undefined;
      const batch = (doc.batchId ? batchMap.get(doc.batchId) : undefined) ?? (session?.batchId ? batchMap.get(session.batchId) : undefined);
      map.set(doc.id, { ...(session ? { session } : {}), ...(batch ? { batch } : {}) });
      return map;
    }, new Map<string, AdminRecordingHydration>());
  }

  private async hydrateAdminRecording(doc: RecordingMongoDocument): Promise<AdminRecordingHydration> {
    const map = await this.hydrateAdminRecordings([doc]);
    return map.get(doc.id) ?? {};
  }

  private toAdminRecordingListItem(doc: RecordingMongoDocument, hydration: AdminRecordingHydration = {}): AdminRecordingListItem {
    const status = this.adminRecordingStatus(doc);
    return {
      id: doc.id,
      recordingId: doc.recordingId,
      ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
      ...(doc.batchId ? { batchId: doc.batchId } : {}),
      roomId: doc.roomId,
      ...(hydration.session ? { sessionTitle: hydration.session.title, sessionNumber: hydration.session.sessionNumber } : {}),
      ...(hydration.batch
        ? {
            batchName: hydration.batch.name,
            ...(hydration.batch.courseId ? { courseId: hydration.batch.courseId } : {}),
            ...(hydration.batch.courseName ? { courseName: hydration.batch.courseName } : {}),
            teacherId: hydration.batch.teacherId
          }
        : {}),
      status,
      storageProvider: this.storageProviderLabel(doc.storageDriver),
      ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
      ...(doc.container ? { container: doc.container } : {}),
      ...(doc.size !== undefined ? { size: doc.size } : {}),
      ...(doc.durationSeconds !== undefined ? { durationSeconds: doc.durationSeconds } : {}),
      startedAt: doc.startedAt.toISOString(),
      ...(doc.stoppedAt ? { stoppedAt: doc.stoppedAt.toISOString() } : {}),
      ...(doc.retentionExpiresAt ? { retentionExpiresAt: doc.retentionExpiresAt.toISOString() } : {}),
      ...(doc.failureReason ? { failureReason: this.safeFailureReason(doc.failureReason) } : {}),
      canPlayback: this.canAccessRecordingContent(doc),
      canDownload: this.canAccessRecordingContent(doc),
      ...(doc.createdAt ? { createdAt: doc.createdAt.toISOString() } : {}),
      ...(doc.updatedAt ? { updatedAt: doc.updatedAt.toISOString() } : {})
    };
  }

  private toAdminRecordingDetail(doc: RecordingMongoDocument, hydration: AdminRecordingHydration = {}): AdminRecordingDetail {
    return {
      ...this.toAdminRecordingListItem(doc, hydration),
      scope: doc.scope,
      ...(doc.participantId ? { participantId: doc.participantId } : {}),
      ...(doc.startedBy ? { startedBy: doc.startedBy } : {}),
      ...(doc.stoppedBy ? { stoppedBy: doc.stoppedBy } : {}),
      ...(doc.consentRequired !== undefined ? { consentRequired: doc.consentRequired } : {}),
      ...(doc.consentVersion ? { consentVersion: doc.consentVersion } : {}),
      trackCount: doc.tracks?.length ?? 0
    };
  }

  private adminRecordingStatus(doc: RecordingMongoDocument): AdminRecordingStatus {
    if (doc.status === 'stopped' && doc.retentionExpiresAt && doc.retentionExpiresAt.getTime() <= Date.now()) {
      return 'expired';
    }
    return doc.status;
  }

  private canAccessRecordingContent(doc: RecordingMongoDocument): boolean {
    return doc.status === 'stopped' && this.adminRecordingStatus(doc) !== 'expired' && Boolean(doc.path);
  }

  private storageProviderLabel(driver: string): string {
    if (driver === 's3') return 'Object storage';
    return 'Server storage';
  }

  private adminRecordingFileName(doc: RecordingMongoDocument): string {
    return `class-session-${doc.sessionId ?? doc.roomId}-recording-${doc.recordingId}.json`;
  }

  private safeFailureReason(reason: string | undefined): string | undefined {
    return reason?.split('\n')[0]?.slice(0, 300);
  }

  private clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
    if (!Number.isFinite(value ?? NaN)) {
      return fallback;
    }
    return Math.min(max, Math.max(1, Math.floor(value as number)));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private emitClassSessionRecordingEvent(event: ClassSessionRecordingEventName, doc: RecordingMongoDocument, reason?: string): void {
    if (!doc.sessionId || !doc.batchId) {
      return;
    }
    const payload: ClassSessionRecordingEvent = {
      recording: this.toRecording(doc),
      sessionId: doc.sessionId,
      batchId: doc.batchId,
      roomId: doc.roomId,
      status: doc.status,
      ...(reason ? { reason } : {})
    };
    for (const listener of this.classSessionRecordingEventListeners) {
      listener(event, payload);
    }
  }

  private async appendClassSessionRecordingPlatformEvent(
    type: 'recording.started' | 'recording.stopped' | 'recording.failed',
    doc: RecordingMongoDocument,
    batch: BatchMongoDocument,
    actor: AuthenticatedUser,
    reason?: string
  ): Promise<void> {
    await this.platformEvents.appendEvent({
      type,
      roomId: doc.roomId,
      actor: {
        type: 'operator',
        userId: actor.sub,
        label: actor.email
      },
      payload: {
        room: {
          roomId: doc.roomId
        },
        recordingId: doc.recordingId,
        participantId: doc.participantId,
        scope: doc.scope,
        status: doc.status,
        path: doc.path,
        downloadUrl: doc.downloadUrl,
        ...(reason ? { reason } : {}),
        batchId: batch.id,
        sessionId: doc.sessionId
      }
    });
  }

  private sanitizePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'recording';
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
  }

  private toRecording(doc: RecordingMongoDocument): Recording {
    return {
      id: doc.id,
      recordingId: doc.recordingId,
      sessionId: doc.sessionId,
      batchId: doc.batchId,
      roomId: doc.roomId,
      participantId: doc.participantId,
      scope: doc.scope,
      status: doc.status,
      storageDriver: doc.storageDriver,
      storageKey: doc.storageKey,
      url: doc.url,
      downloadUrl: doc.downloadUrl,
      playbackUrl: doc.playbackUrl,
      mimeType: doc.mimeType,
      container: doc.container,
      size: doc.size,
      durationSeconds: doc.durationSeconds,
      startedBy: doc.startedBy,
      stoppedBy: doc.stoppedBy,
      failureReason: doc.failureReason,
      retentionExpiresAt: doc.retentionExpiresAt?.toISOString(),
      consentVersion: doc.consentVersion,
      consentRequired: doc.consentRequired,
      tracks: (doc.tracks ?? []) as unknown as RecordingTrackManifestEntry[],
      startedAt: doc.startedAt.toISOString(),
      stoppedAt: doc.stoppedAt?.toISOString()
    };
  }
}
