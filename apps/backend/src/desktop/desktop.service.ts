import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Model } from 'mongoose';
import { RecordingsService } from '../recordings/recordings.service';
import { planClassSessions } from '../class-sessions/class-session-planner';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument, BatchMongoDocument, BatchScheduleDocument, BatchScheduleMongoDocument, ClassSessionDocument, ClassSessionMongoDocument,
  ClassSessionMaterialDocument, ClassSessionMaterialMongoDocument,
  ClassSessionWhiteboardStateDocument, ClassSessionWhiteboardStateMongoDocument,
  RecordingDocument, RecordingMongoDocument, RecordingPlaybackProgressDocument, RecordingPlaybackProgressMongoDocument,
  SessionDocument, SessionMongoDocument, StudentEnrollmentDocument, StudentEnrollmentMongoDocument,
  UserDocument, UserMongoDocument
} from '../database/schemas';

const runFile = promisify(execFile);
const MAX_RECORDING_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CHUNKS = 7200;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MEDIA_TICKET_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-zA-Z0-9_-]{16,100}$/;
export interface FinalizeRecordingRequest { chunkCount: number; durationSeconds: number; mimeType: string; }
export interface PlaybackProgressRequest { positionSeconds: number; durationSeconds?: number; event?: 'play' | 'pause' | 'seek' | 'timeupdate' | 'ended'; }
interface PlaybackTicket { recordingId: string; sub: string; tokenId: string; expiresAt: number; }
type Role = 'teacher' | 'student';
type DesktopSession = Pick<ClassSessionMongoDocument, 'id' | 'batchId' | 'title' | 'scheduledAt' | 'durationMinutes' | 'status'> & { updatedAt?: Date; rescheduledAt?: Date; originalScheduledAt?: Date };

export function parseMediaRange(range: string | undefined, size: number): { start: number; end: number; partial: boolean } {
  if (!range) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) throw new BadRequestException('Unsupported byte range.');
  const suffix = match[1] === '';
  const first = Number(match[1] || 0);
  const last = Number(match[2] || 0);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || (suffix && last <= 0)) throw new BadRequestException('Invalid byte range.');
  const start = suffix ? Math.max(0, size - last) : first;
  const end = suffix || !match[2] ? size - 1 : Math.min(last, size - 1);
  if (start >= size || end < start || start < 0) throw new BadRequestException('Byte range is outside the recording.');
  return { start, end, partial: true };
}

@Injectable()
export class DesktopService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DesktopService.name);
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly sessions: Model<ClassSessionMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(StudentEnrollmentDocument.name) private readonly enrollments: Model<StudentEnrollmentMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(RecordingDocument.name) private readonly recordings: Model<RecordingMongoDocument>,
    @InjectModel(RecordingPlaybackProgressDocument.name) private readonly progress: Model<RecordingPlaybackProgressMongoDocument>,
    @InjectModel(ClassSessionMaterialDocument.name) private readonly materials: Model<ClassSessionMaterialMongoDocument>,
    @InjectModel(ClassSessionWhiteboardStateDocument.name) private readonly whiteboards: Model<ClassSessionWhiteboardStateMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly logins: Model<SessionMongoDocument>,
    private readonly config: ConfigService,
    private readonly recordingLifecycle: RecordingsService
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => { void this.cleanupExpiredMedia().catch(() => this.logger.warn('Expired lesson media cleanup will retry.')); }, 5 * 60 * 1000);
    this.cleanupTimer.unref();
    void this.cleanupExpiredMedia().catch(() => this.logger.warn('Expired lesson media cleanup will retry.'));
  }

  onModuleDestroy(): void { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }

  async cleanupExpiredMedia(): Promise<number> {
    const now = new Date();
    const expired = await this.recordings.find({ retentionExpiresAt: { $lte: now }, mediaPurgedAt: { $exists: false }, mediaArchivePreserved: { $ne: true },
      $and: [{ $or: [{ mediaPath: { $exists: true } }, { mediaCaptureId: { $exists: true } }] },
        { $or: [{ mediaProcessingUntil: { $exists: false } }, { mediaProcessingUntil: { $lt: now } }] }]
    }).limit(100).exec();
    let purged = 0;
    for (const recording of expired) {
      await this.lock(recording.recordingId, async () => {
        // Derive both paths from a validated recording ID; never unlink arbitrary database paths.
        await rm(this.finalPath(recording.recordingId), { force: true });
        await rm(this.chunkDirectory(recording.recordingId), { recursive: true, force: true });
        await this.recordings.updateOne({ recordingId: recording.recordingId, retentionExpiresAt: { $lte: now } }, {
          $set: { mediaPurgedAt: new Date() }, $unset: { mediaPath: 1, mediaReadyAt: 1 }
        }).exec();
        purged++;
      });
    }
    return purged;
  }

  async classes(user: AuthenticatedUser) {
    const batches = await this.accessibleBatches(user, false);
    if (!batches.length) return { items: [], total: 0 };
    const ids = batches.map((batch) => batch.id);
    const [persisted, schedules, teachers] = await Promise.all([
      this.sessions.find({ batchId: { $in: ids } }).exec(),
      this.schedules.find({ batchId: { $in: ids } }).exec(),
      this.teacherNames(batches)
    ]);
    const byId = new Map(batches.map((batch) => [batch.id, batch]));
    const merged = new Map<string, DesktopSession>();
    for (const batch of batches) for (const session of this.plannedSessions(batch, schedules.filter((schedule) => schedule.batchId === batch.id))) merged.set(session.id, session);
    for (const session of persisted) merged.set(session.id, session);
    const items = [...merged.values()].filter((session) => session.status === 'live' ||
      (['scheduled', 'cancelled'].includes(session.status) && session.scheduledAt.getTime() >= Date.now() - DAY_MS))
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()).slice(0, 500)
      .map((session) => this.classItem(session, byId.get(session.batchId)!, user, teachers));
    return { items, total: items.length };
  }

  async classroom(user: AuthenticatedUser, sessionId: string) {
    const persisted = await this.sessions.findById(sessionId).exec();
    if (persisted) {
      const batch = await this.batchFor(persisted.batchId);
      await this.assertBatchAccess(user, batch, false);
      return this.classItem(persisted, batch, user, await this.teacherNames([batch]));
    }
    const batches = await this.accessibleBatches(user, false);
    const schedules = await this.schedules.find({ batchId: { $in: batches.map((batch) => batch.id) } }).exec();
    for (const batch of batches) {
      const session = this.plannedSessions(batch, schedules.filter((schedule) => schedule.batchId === batch.id)).find((item) => item.id === sessionId);
      if (session) return this.classItem(session, batch, user, await this.teacherNames([batch]));
    }
    throw new NotFoundException('Class not found or you do not have access.');
  }

  async listRecordings(user: AuthenticatedUser, search = '', courseId = '') {
    if (typeof search !== 'string' || typeof courseId !== 'string') throw new BadRequestException('Recording filters must be text.');
    let batches = await this.accessibleBatches(user, true);
    if (courseId.trim()) batches = batches.filter((batch) => batch.courseId === courseId.trim());
    if (!batches.length) return { items: [], total: 0 };
    const docs = await this.recordings.find({ batchId: { $in: batches.map((batch) => batch.id) }, sessionId: { $exists: true } }).sort({ startedAt: -1 }).limit(1000).exec();
    const classIds = [...new Set(docs.map((doc) => doc.sessionId))];
    const [sessions, progress, teachers] = await Promise.all([
      this.sessions.find({ _id: { $in: classIds } }).exec(),
      this.progress.find({ recordingId: { $in: docs.map((doc) => doc.recordingId) }, studentId: user.sub }).exec(),
      this.teacherNames(batches)
    ]);
    const byBatch = new Map(batches.map((batch) => [batch.id, batch]));
    const bySession = new Map(sessions.map((session) => [session.id, session]));
    const byProgress = new Map(progress.map((row) => [row.recordingId, row]));
    const q = search.trim().toLocaleLowerCase().slice(0, 200);
    const items = docs.flatMap((doc) => {
      const batch = byBatch.get(doc.batchId!);
      const session = bySession.get(doc.sessionId!);
      if (!batch || !session || session.batchId !== batch.id) return [];
      const role = this.role(user, batch);
      if (role === 'student' && !this.published(doc)) return [];
      const title = session.title;
      if (q && ![title, batch.name, batch.courseName, teachers.get(batch.teacherId)].some((value) => value?.toLocaleLowerCase().includes(q))) return [];
      return [{
        recordingId: doc.recordingId, sessionId: session.id, batchId: batch.id, title, sessionTitle: title,
        batchName: batch.name, courseId: batch.courseId, courseName: batch.courseName,
        teacherName: teachers.get(batch.teacherId) ?? 'Teacher', startedAt: doc.startedAt.toISOString(),
        durationSeconds: doc.mediaDurationSeconds ?? doc.durationSeconds ?? 0, status: this.mediaStatus(doc), role,
        published: this.published(doc), lastPositionSeconds: byProgress.get(doc.recordingId)?.lastPositionSeconds ?? 0
      }];
    });
    return { items, total: items.length };
  }

  async playback(user: AuthenticatedUser, recordingId: string) {
    const { recording, batch, role } = await this.readableRecording(user, recordingId);
    this.assertPlayable(recording);
    await this.mediaFile(recording);
    const [progress, materials, board] = await Promise.all([
      this.progress.findOne({ recordingId, studentId: user.sub }).exec(),
      this.materials.find({ sessionId: recording.sessionId, deletedAt: { $exists: false }, ...(role === 'student' ? { publishedAt: { $exists: true }, unpublishedAt: { $exists: false } } : {}) }).sort({ createdAt: 1 }).exec(),
      this.whiteboards.findOne({ sessionId: recording.sessionId, ...(role === 'student' ? { publishedAt: { $exists: true }, unpublishedAt: { $exists: false } } : {}) }).select({ sessionId: 1 }).exec()
    ]);
    const expiresAt = Date.now() + MEDIA_TICKET_MS;
    const ticket = this.signTicket({ recordingId, sub: user.sub, tokenId: user.tokenId, expiresAt });
    return {
      recordingId, playbackUrl: `/api/v1/desktop/recordings/${encodeURIComponent(recordingId)}/content?ticket=${encodeURIComponent(ticket)}`,
      mimeType: recording.mediaMimeType ?? 'video/webm', durationSeconds: recording.mediaDurationSeconds ?? recording.durationSeconds ?? 0,
      lastPositionSeconds: progress?.lastPositionSeconds ?? 0, expiresAt: new Date(expiresAt).toISOString(),
      ...(board ? { notesUrl: `/api/v1/desktop/recordings/${encodeURIComponent(recordingId)}/notes` } : {}),
      materials: materials.map((material) => ({
        materialId: material.materialId, title: material.title, kind: material.kind,
        ...(material.source === 'link' ? { url: material.url } : { downloadUrl: `/api/v1/class-sessions/${encodeURIComponent(recording.sessionId!)}/materials/${encodeURIComponent(material.materialId)}/download?batchId=${encodeURIComponent(batch.id)}` })
      }))
    };
  }

  async notes(user: AuthenticatedUser, id: string) {
    const { recording, role } = await this.readableRecording(user, id);
    const board = await this.whiteboards.findOne({ sessionId: recording.sessionId,
      ...(role === 'student' ? { publishedAt: { $exists: true }, unpublishedAt: { $exists: false } } : {}) }).exec();
    if (!board) throw new NotFoundException('Shared lesson notes are not available.');
    return { sessionId: recording.sessionId, snapshot: board.currentSnapshot, pages: board.pages };
  }

  async saveProgress(user: AuthenticatedUser, id: string, request: PlaybackProgressRequest) {
    const { recording } = await this.readableRecording(user, id);
    this.assertPlayable(recording);
    if (typeof request?.positionSeconds !== 'number' || !Number.isFinite(request.positionSeconds) || request.positionSeconds < 0) {
      throw new BadRequestException('Playback position must be a finite non-negative number.');
    }
    if (request.event && !['play', 'pause', 'seek', 'timeupdate', 'ended'].includes(request.event)) throw new BadRequestException('Invalid playback event.');
    const durationSeconds = recording.mediaDurationSeconds ?? recording.durationSeconds ?? 0;
    const position = Math.min(request.positionSeconds, durationSeconds || DAY_MS / 1000);
    const now = new Date();
    const row = await this.progress.findOneAndUpdate({ recordingId: id, studentId: user.sub }, {
      $set: { sessionId: recording.sessionId, batchId: recording.batchId, userId: user.sub, lastPositionSeconds: position, lastPlayedAt: now, durationSeconds },
      $setOnInsert: { firstPlayedAt: now },
      $inc: { playCount: request.event === 'play' ? 1 : 0, pauseCount: request.event === 'pause' ? 1 : 0, seekCount: request.event === 'seek' ? 1 : 0 }
    }, { upsert: true, new: true, setDefaultsOnInsert: true }).exec();
    return { recordingId: id, lastPositionSeconds: row?.lastPositionSeconds ?? position, durationSeconds };
  }

  async stream(recordingId: string, ticketValue: string, range: string | undefined, response: any): Promise<void> {
    const ticket = this.verifyTicket(recordingId, ticketValue);
    const [account, login] = await Promise.all([
      this.users.findOne({ _id: ticket.sub, status: 'active', disabled: { $ne: true } }).exec(),
      this.logins.exists({ userId: ticket.sub, refreshTokenJti: ticket.tokenId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } })
    ]);
    if (!account || !login) throw new UnauthorizedException('Playback session expired. Reopen the recording.');
    const { recording } = await this.readableRecording({ sub: account.id, email: account.email, roles: account.roles, permissions: account.permissions, tokenId: ticket.tokenId }, recordingId);
    this.assertPlayable(recording);
    const file = await this.mediaFile(recording);
    let selected: ReturnType<typeof parseMediaRange>;
    try { selected = parseMediaRange(range, file.size); }
    catch {
      response.status(416).set({ 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'private, no-store' }).end();
      return;
    }
    response.status(selected.partial ? 206 : 200).set({
      'Content-Type': recording.mediaMimeType ?? 'video/webm', 'Accept-Ranges': 'bytes',
      'Content-Length': String(selected.end - selected.start + 1), 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
      ...(selected.partial ? { 'Content-Range': `bytes ${selected.start}-${selected.end}/${file.size}` } : {})
    });
    await pipeline(createReadStream(file.path, { start: selected.start, end: selected.end }), response).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE' && error.code !== 'ECONNRESET') throw error;
    });
  }

  async claimCapture(user: AuthenticatedUser, id: string, captureId: string) {
    this.validCaptureId(captureId);
    const recording = await this.writableRecording(user, id);
    if (recording.mediaCaptureId && recording.mediaCaptureId !== captureId) throw new ConflictException('This recording is already being captured in another classroom window.');
    const claimed = await this.recordings.findOneAndUpdate({ recordingId: id, $or: [{ mediaCaptureId: { $exists: false } }, { mediaCaptureId: captureId }] },
      { $set: { mediaCaptureId: captureId, mediaUploadState: recording.mediaReadyAt ? 'ready' : 'uploading' } }, { new: true }).exec();
    if (!claimed) throw new ConflictException('Another classroom window claimed this recording.');
    return { recordingId: id, captureId, finalized: Boolean(claimed.mediaReadyAt) };
  }

  async captureFailed(user: AuthenticatedUser, id: string, captureId: string) {
    this.validCaptureId(captureId);
    return this.lock(id, async () => {
      const recording = await this.writableRecording(user, id, undefined, true);
      if (recording.mediaCaptureId && recording.mediaCaptureId !== captureId) throw new ConflictException('This recording belongs to another capture.');
      if (recording.mediaReadyAt || (recording.mediaUploadBytes ?? 0) > 0 || (await this.chunkIndices(id)).length) return { recordingId: id, status: recording.status, preserved: true };
      const claimed = await this.recordings.findOneAndUpdate({ recordingId: id, $or: [{ mediaCaptureId: { $exists: false } }, { mediaCaptureId: captureId }] },
        { $set: { mediaCaptureId: captureId, mediaUploadState: 'failed', mediaFailureReason: 'Lesson recording could not start on the teacher device.' } }, { new: true }).exec();
      if (!claimed) throw new ConflictException('Another capture claimed this recording.');
      await this.recordingLifecycle.failClassSessionCapture(recording.sessionId!, id, user);
      return { recordingId: id, status: 'failed', preserved: false };
    });
  }

  async uploadStatus(user: AuthenticatedUser, id: string) {
    const recording = await this.writableRecording(user, id);
    const indices = await this.chunkIndices(id);
    return { recordingId: id, captureId: recording.mediaCaptureId, indices, chunkCount: indices.length, finalized: Boolean(recording.mediaReadyAt) };
  }

  async uploadChunk(user: AuthenticatedUser, id: string, rawIndex: string, captureId: string, bytes?: Buffer) {
    this.validCaptureId(captureId);
    if (!/^\d+$/.test(rawIndex)) throw new BadRequestException('Invalid chunk index.');
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CHUNKS) throw new BadRequestException('Invalid chunk index.');
    if (!bytes?.length || bytes.length > MAX_CHUNK_BYTES) throw new BadRequestException('A recording chunk must contain 1 byte to 16 MiB.');
    return this.lock(id, async () => {
      const recording = await this.writableRecording(user, id, captureId);
      if (recording.mediaReadyAt) {
        if (index < (recording.mediaChunkCount ?? 0)) return { recordingId: id, index, received: true };
        throw new ConflictException('Recording has already been finalized.');
      }
      const directory = this.chunkDirectory(id);
      await mkdir(directory, { recursive: true });
      const target = join(directory, `${index}.part`);
      try {
        const existing = await readFile(target);
        if (!existing.equals(bytes)) throw new ConflictException('This chunk index already contains different media.');
        return { recordingId: id, index, received: true };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (recording.mediaReadyAt) throw new ConflictException('Recording has already been finalized.');
      const indices = await this.chunkIndices(id);
      if (index !== indices.length) throw new ConflictException(`Upload chunk ${indices.length} before chunk ${index}.`);
      if ((recording.mediaUploadBytes ?? 0) + bytes.length > MAX_RECORDING_BYTES) throw new BadRequestException('Recording exceeds the 4 GiB storage limit.');
      const temp = join(directory, `${index}.${randomUUID()}.tmp`);
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      try { await link(temp, target); } finally { await rm(temp, { force: true }); }
      await this.recordings.updateOne({ recordingId: id }, { $inc: { mediaUploadBytes: bytes.length }, $set: { mediaUploadState: 'uploading' } }).exec();
      return { recordingId: id, index, received: true };
    });
  }

  async finalize(user: AuthenticatedUser, id: string, captureId: string, request: FinalizeRecordingRequest) {
    this.validCaptureId(captureId);
    if (!Number.isInteger(request?.chunkCount) || request.chunkCount < 1 || request.chunkCount > MAX_CHUNKS) throw new BadRequestException('Invalid recording chunk count.');
    if (request.mimeType !== 'video/webm') throw new BadRequestException('Only WebM lesson recordings are supported.');
    if (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0 || request.durationSeconds > DAY_MS / 1000) throw new BadRequestException('Invalid recording duration.');
    return this.lock(id, async () => {
      const recording = await this.writableRecording(user, id, captureId);
      if (recording.mediaReadyAt) {
        if (recording.mediaChunkCount !== request.chunkCount) throw new ConflictException('Recording was finalized with a different chunk count.');
        await this.recordingLifecycle.stopClassSessionRecording(recording.sessionId!, id, user);
        await this.recordings.updateOne({ recordingId: id }, { $set: { mediaUploadState: 'ready' }, $unset: { mediaFailureReason: 1 } }).exec();
        return { recordingId: id, finalized: true, durationSeconds: recording.mediaDurationSeconds };
      }
      const indices = await this.chunkIndices(id);
      if (indices.length !== request.chunkCount || indices.some((index, position) => index !== position)) throw new ConflictException('Upload all recording chunks before finalizing.');
      const leaseId = randomUUID();
      const lease = await this.recordings.findOneAndUpdate({ recordingId: id, mediaCaptureId: captureId, mediaReadyAt: { $exists: false },
        $or: [{ mediaProcessingUntil: { $exists: false } }, { mediaProcessingUntil: { $lt: new Date() } }]
      }, { $set: { mediaProcessingToken: leaseId, mediaProcessingUntil: new Date(Date.now() + 11 * 60 * 1000) } }, { new: true }).exec();
      if (!lease) throw new ConflictException('Recording processing is already running. Retry shortly.');
      try {
      const directory = this.chunkDirectory(id);
      const first = await open(join(directory, '0.part'), 'r');
      const header = Buffer.alloc(4);
      try { await first.read(header, 0, 4, 0); } finally { await first.close(); }
      if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new BadRequestException('Recording does not contain a WebM container.');
      const raw = join(directory, 'joined.webm');
      const output = await open(raw, 'w', 0o600);
      let total = 0;
      try {
        for (const index of indices) {
          for await (const chunk of createReadStream(join(directory, `${index}.part`))) {
            total += chunk.length;
            if (total > MAX_RECORDING_BYTES) throw new BadRequestException('Recording exceeds the 4 GiB storage limit.');
            await output.write(chunk);
          }
        }
      } finally { await output.close(); }
      const temp = join(directory, 'seekable.webm');
      const mediaPath = this.finalPath(id);
      await this.recordings.updateOne({ recordingId: id }, { $set: { mediaUploadState: 'processing' } }).exec();
      try {
        // Remux to add a duration and seek index. No shell, transcoding, or complete-file buffering.
        await runFile(this.config.get<string>('recording.ffmpegPath', process.env.FFMPEG_PATH || 'ffmpeg'),
          ['-nostdin', '-y', '-v', 'error', '-i', raw, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-f', 'webm', temp],
          { timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 });
        const details = await stat(temp);
        if (!details.size) throw new Error('Media finalization produced an empty recording.');
        const probe = await runFile(this.config.get<string>('recording.ffprobePath', process.env.FFPROBE_PATH || 'ffprobe'),
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', temp], { timeout: 30_000, maxBuffer: 8192 });
        const durationSeconds = Number(probe.stdout.trim());
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > DAY_MS / 1000) throw new Error('Invalid finalized media duration.');
        await rename(temp, mediaPath);
        await this.recordings.updateOne({ recordingId: id, mediaCaptureId: captureId }, { $set: {
          mediaPath, mediaMimeType: 'video/webm', mediaSize: details.size, mediaDurationSeconds: durationSeconds,
          mediaChunkCount: request.chunkCount, mediaReadyAt: new Date(), mediaUploadState: 'ready'
        }, $unset: { mediaFailureReason: 1 } }).exec();
        // Complete exactly this recording; a recovered older capture must never stop a newer class recording.
        await this.recordingLifecycle.stopClassSessionRecording(recording.sessionId!, id, user);
        // The immutable finalized file is the retry authority; remove temporary duplicate media.
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        return { recordingId: id, finalized: true, durationSeconds };
      } catch (error) {
        await this.recordings.updateOne({ recordingId: id }, { $set: { mediaUploadState: 'failed', mediaFailureReason: 'Unable to prepare video playback. Retry finalization or contact support.' } }).exec();
        throw new ConflictException((error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Recording processing requires FFmpeg on the backend server. Uploaded lesson media is retained.'
          : 'Recording processing failed. Uploaded lesson media is retained; retry finalization.');
      }
      } finally {
        await this.recordings.updateOne({ recordingId: id, mediaProcessingToken: leaseId }, { $unset: { mediaProcessingToken: 1, mediaProcessingUntil: 1 } }).exec();
      }
    });
  }

  private async accessibleBatches(user: AuthenticatedUser, historical: boolean) {
    const allowed = user.roles.includes('STUDENT') ? await this.enrollments.find({ studentId: user.sub, deletedAt: { $exists: false }, status: historical ? { $in: ['active', 'completed'] } : 'active' }).select({ batchId: 1 }).exec() : [];
    const alternatives: Record<string, unknown>[] = [{ _id: { $in: allowed.map((row) => row.batchId) } }];
    if (this.canTeach(user)) alternatives.push({ teacherId: user.sub });
    return this.batches.find({ deletedAt: { $exists: false }, $or: alternatives }).exec();
  }
  private async batchFor(batchId: string) {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } }).exec();
    if (!batch) throw new NotFoundException('Class not found.');
    return batch;
  }
  private canTeach(user: AuthenticatedUser) { return user.roles.some((role) => ['TEACHER', 'ADMIN', 'SUPER_ADMIN'].includes(role)); }
  private role(user: AuthenticatedUser, batch: BatchMongoDocument): Role { return this.canTeach(user) && batch.teacherId === user.sub ? 'teacher' : 'student'; }
  private async assertBatchAccess(user: AuthenticatedUser, batch: BatchMongoDocument, historical: boolean) {
    if (this.role(user, batch) === 'teacher') return;
    if (user.roles.includes('STUDENT') && await this.enrollments.exists({ studentId: user.sub, batchId: batch.id, deletedAt: { $exists: false }, status: historical ? { $in: ['active', 'completed'] } : 'active' })) return;
    throw new ForbiddenException('You do not have access to this class.');
  }
  private plannedSessions(batch: BatchMongoDocument, schedules: BatchScheduleMongoDocument[]): DesktopSession[] {
    return planClassSessions(batch, schedules).map((planned) => {
      const schedule = schedules.find((item) => planned.id.includes(`-${item.dayOfWeek}-`));
      let originalScheduledAt: Date | undefined;
      if (schedule?.originalStartTime) {
        originalScheduledAt = new Date(planned.scheduledAt);
        const [hours, minutes] = schedule.originalStartTime.split(':').map(Number);
        originalScheduledAt.setHours(hours!, minutes!, 0, 0);
      }
      return { ...planned, status: 'scheduled' as const, updatedAt: batch.updatedAt,
        ...(schedule?.rescheduledAt ? { rescheduledAt: schedule.rescheduledAt } : {}), ...(originalScheduledAt ? { originalScheduledAt } : {}) };
    });
  }
  private async teacherNames(batches: BatchMongoDocument[]) {
    const docs = await this.users.find({ _id: { $in: [...new Set(batches.map((batch) => batch.teacherId))] } }).select({ displayName: 1 }).exec();
    return new Map(docs.map((user) => [user.id, user.displayName]));
  }
  private classItem(session: DesktopSession, batch: BatchMongoDocument, user: AuthenticatedUser, teachers: Map<string, string>) {
    const role = this.role(user, batch);
    return { sessionId: session.id, batchId: batch.id, title: session.title, batchName: batch.name, courseId: batch.courseId, courseName: batch.courseName,
      teacherName: teachers.get(batch.teacherId) ?? 'Teacher', scheduledAt: session.scheduledAt.toISOString(), durationMinutes: session.durationMinutes,
      status: session.status, role, canJoin: session.status === 'live' || session.status === 'scheduled', updatedAt: session.updatedAt?.toISOString(),
      ...(session.rescheduledAt ? { rescheduledAt: session.rescheduledAt.toISOString() } : {}),
      ...(session.originalScheduledAt ? { originalScheduledAt: session.originalScheduledAt.toISOString() } : {}) };
  }
  private published(recording: RecordingMongoDocument) { return Boolean(recording.publishedAt && !recording.unpublishedAt); }
  private mediaStatus(recording: RecordingMongoDocument) {
    if (recording.retentionExpiresAt && recording.retentionExpiresAt.getTime() <= Date.now()) return 'expired';
    if (recording.status === 'failed' || recording.mediaUploadState === 'failed') return 'failed';
    if (recording.status !== 'stopped' || (recording.mediaCaptureId && !recording.mediaReadyAt)) return 'processing';
    return recording.mediaReadyAt && recording.mediaPath ? 'available' : 'unavailable';
  }
  private assertPlayable(recording: RecordingMongoDocument) {
    const status = this.mediaStatus(recording);
    if (status === 'expired') throw new NotFoundException('Recording has expired.');
    if (status !== 'available') throw new ConflictException(status === 'unavailable' ? 'This older recording contains lesson metadata only, not playable video.' : 'Recording is not available for playback yet.');
  }
  private async readableRecording(user: AuthenticatedUser, id: string) {
    const recording = await this.recordings.findOne({ recordingId: id }).exec();
    if (!recording?.sessionId || !recording.batchId) throw new NotFoundException('Recording not found.');
    const batch = await this.batchFor(recording.batchId);
    await this.assertBatchAccess(user, batch, true);
    const role = this.role(user, batch);
    if (role === 'student' && !this.published(recording)) throw new NotFoundException('Recording is not published.');
    return { recording, batch, role };
  }
  private async writableRecording(user: AuthenticatedUser, id: string, captureId?: string, allowFailed = false) {
    const recording = await this.recordings.findOne({ recordingId: id }).exec();
    if (!recording?.sessionId || !recording.batchId) throw new NotFoundException('Recording not found.');
    const batch = await this.batchFor(recording.batchId);
    if (this.role(user, batch) !== 'teacher' || recording.startedBy !== user.sub) throw new ForbiddenException('Only the recording teacher can upload this lesson.');
    if (recording.storageDriver !== 'local') throw new BadRequestException('Desktop lesson recording requires the backend local or shared recording filesystem.');
    if ((!allowFailed && recording.status === 'failed') || (recording.retentionExpiresAt && recording.retentionExpiresAt.getTime() <= Date.now())) throw new ConflictException('This recording no longer accepts uploads.');
    if (captureId !== undefined) {
      this.validCaptureId(captureId);
      if (recording.mediaCaptureId !== captureId) throw new ConflictException('Claim this recording before uploading, using the original capture identifier.');
    }
    return recording;
  }
  private validCaptureId(id: string) { if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException('Invalid recording capture identifier.'); }
  private rootPath() { return resolve(this.config.get<string>('recording.localPath', './recordings'), 'desktop-media'); }
  private chunkDirectory(id: string) { this.validCaptureId(id); return join(this.rootPath(), `${id}.chunks`); }
  private finalPath(id: string) { this.validCaptureId(id); return join(this.rootPath(), `${id}.webm`); }
  private async chunkIndices(id: string): Promise<number[]> {
    try { return (await readdir(this.chunkDirectory(id))).filter((name) => /^\d+\.part$/.test(name)).map((name) => Number(name.split('.')[0])).sort((a, b) => a - b); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async mediaFile(recording: RecordingMongoDocument) {
    const path = this.finalPath(recording.recordingId);
    if (!recording.mediaPath || resolve(recording.mediaPath) !== path) throw new NotFoundException('Recording media is not available.');
    try { const details = await stat(path); if (!details.isFile() || details.size <= 0) throw new Error(); return { path, size: details.size }; }
    catch { throw new NotFoundException('Recording media is not available.'); }
  }
  private signTicket(ticket: PlaybackTicket) {
    const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
    const signature = createHmac('sha256', this.config.getOrThrow<string>('jwt.accessSecret')).update(`desktop-playback:${payload}`).digest('base64url');
    return `${payload}.${signature}`;
  }
  private verifyTicket(id: string, value: string): PlaybackTicket {
    try {
      if (typeof value !== 'string' || value.length > 2048) throw new Error();
      const [payload, signature, extra] = value.split('.');
      if (extra || !payload || !signature) throw new Error();
      const expected = createHmac('sha256', this.config.getOrThrow<string>('jwt.accessSecret')).update(`desktop-playback:${payload}`).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PlaybackTicket;
      if (ticket.recordingId !== id || !ticket.sub || !ticket.tokenId || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + MEDIA_TICKET_MS + 1000) throw new Error();
      return ticket;
    } catch { throw new UnauthorizedException('Playback link expired. Reopen the recording.'); }
  }
  private async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
}
