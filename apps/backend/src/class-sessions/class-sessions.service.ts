import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AdminAttendanceQuery,
  AdminAttendanceSessionStudentRow,
  AdminAttendanceSessionRow,
  AdminAttendanceSessionStudentsResponse,
  AdminAttendanceSessionsResponse,
  AdminAttendanceSource,
  AdminAttendanceStudentRow,
  AdminAttendanceStudentsResponse,
  AdminAttendanceSummary,
  AdminAttendanceTrendPoint,
  AdminAttendanceTrendsResponse,
  AdminClassSessionReportQuery,
  AdminClassSessionReportResponse,
  AdminClassSessionReportRow,
  AdminClassSessionReportSummary,
  ChatHistoryResponse,
  ChatAttachment,
  ChatMessageScope,
  ChatReadState,
  ChatThreadSummaryResponse,
  ClassSessionMaterial,
  ClassSessionMaterialEvent,
  ClassSessionMaterialKind,
  CreateWhiteboardMemoryCheckpointRequest,
  CreateClassSessionMaterialLinkRequest,
  ClassSessionLifecycleEvent,
  LiveClassSettings,
  PreviousWhiteboardMemoryListResponse,
  RestorePreviousWhiteboardMemoryRequest,
  RestoreWhiteboardMemoryVersionRequest,
  Recording,
  SaveWhiteboardMemoryRequest,
  WhiteboardMemoryPage,
  WhiteboardMemoryPageSearchResponse,
  WhiteboardMemorySaveReason,
  WhiteboardMemorySnapshot,
  WhiteboardMemoryState,
  WhiteboardMemorySummary,
  WhiteboardMemoryVersion,
  WhiteboardMemoryVersionListResponse
} from '@native-sfu/contracts';
import { Model, type AnyBulkWriteOperation } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ClassSessionDocument,
  ClassSessionAttendanceSnapshotDocument,
  ClassSessionAttendanceSnapshotMongoDocument,
  ClassSessionMaterialDocument,
  ClassSessionMaterialMongoDocument,
  ClassSessionWhiteboardStateDocument,
  ClassSessionWhiteboardStateMongoDocument,
  ClassSessionWhiteboardVersionDocument,
  ClassSessionWhiteboardVersionMongoDocument,
  ClassSessionMongoDocument,
  ClassSessionStatus,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { MetricsService } from '../metrics/metrics.service';
import { RecordingsService, type RecordingDownload } from '../recordings/recordings.service';
import {
  RoomsService,
  type ClassSessionAttendanceExportRequest,
  type ClassSessionAttendanceRow,
  type ClassSessionChatAttachmentDownload,
  type ClassSessionChatAttachmentUploadFile
} from '../rooms/rooms.service';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';
import { ProfilesService, SYSTEM_LIVE_CLASS_SETTINGS } from '../profiles/profiles.service';
import { classSessionChannelIds, PlannedClassSession, planClassSessions } from './class-session-planner';

const ADMIN_CLASS_SESSION_STATUSES = new Set<ClassSessionStatus>(['scheduled', 'live', 'completed', 'cancelled']);
const ADMIN_ATTENDANCE_DEFAULT_RANGE_DAYS = 90;
const ADMIN_ATTENDANCE_MAX_RANGE_DAYS = 370;
const ADMIN_ATTENDANCE_LATE_JOIN_MS = 10 * 60 * 1000;
const ADMIN_ATTENDANCE_EARLY_LEAVE_MS = 10 * 60 * 1000;
const CLASS_MATERIAL_MAX_COUNT = 5;
const CLASS_MATERIAL_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'
]);
const WHITEBOARD_MEMORY_SCHEMA_VERSION = 1;
const WHITEBOARD_MEMORY_MAX_BYTES = 1_500_000;
const WHITEBOARD_MEMORY_MAX_PAGES = 80;
const WHITEBOARD_MEMORY_MAX_ELEMENTS = 2_500;
const WHITEBOARD_MEMORY_MAX_VERSIONS = 25;

export interface ClassroomParticipantPayload {
  id: string;
  userId: string;
  displayName: string;
  role: 'teacher' | 'student' | 'admin';
}

export interface ClassroomPayload {
  sessionId: string;
  batchId: string;
  teacherId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  durationMinutes: number;
  status: ClassSessionStatus;
  roomId: string;
  chatChannelId: string;
  whiteboardChannelId: string;
  channels: {
    chat: string;
    whiteboard: string;
  };
  role: 'teacher' | 'student' | 'admin';
  canJoin: boolean;
  participants: ClassroomParticipantPayload[];
  activeRecording?: Recording;
  latestRecording?: Recording;
  startedAt?: string;
  completedAt?: string;
  resolvedLiveSettings: LiveClassSettings;
}

interface SessionResolution {
  batch: BatchMongoDocument;
  schedules: BatchScheduleMongoDocument[];
  planned: PlannedClassSession;
  persisted?: ClassSessionMongoDocument;
}

interface AttendanceRowsWithSource {
  rows: ClassSessionAttendanceRow[];
  source: AdminAttendanceSource;
}

export interface ClassSessionMaterialUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ClassSessionMaterialDownload {
  stream: ReadStream;
  fileName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class ClassSessionsService {
  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(ClassSessionAttendanceSnapshotDocument.name)
    private readonly attendanceSnapshots: Model<ClassSessionAttendanceSnapshotMongoDocument>,
    @InjectModel(ClassSessionMaterialDocument.name)
    private readonly materials: Model<ClassSessionMaterialMongoDocument>,
    @InjectModel(ClassSessionWhiteboardStateDocument.name)
    private readonly whiteboardStates: Model<ClassSessionWhiteboardStateMongoDocument>,
    @InjectModel(ClassSessionWhiteboardVersionDocument.name)
    private readonly whiteboardVersions: Model<ClassSessionWhiteboardVersionMongoDocument>,
    private readonly studentEnrollments: StudentEnrollmentsService,
    private readonly rooms: RoomsService,
    private readonly recordings: RecordingsService,
    private readonly profiles: ProfilesService,
    private readonly config: ConfigService,
    @Optional() @InjectModel(UserDocument.name) private readonly users?: Model<UserMongoDocument>,
    @Optional() private readonly auditLogs?: AuditLogsService,
    @Optional() private readonly metrics?: MetricsService
  ) {}

  async listAdminClassSessionReports(
    query: AdminClassSessionReportQuery,
    user: AuthenticatedUser
  ): Promise<AdminClassSessionReportResponse> {
    this.assertAdmin(user);
    const page = this.clampPositiveInteger(query.page, 1, 10000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const filters = await this.adminClassSessionFilters(query);
    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      this.classSessions.find(filters).sort({ scheduledAt: -1 }).skip(skip).limit(limit).exec(),
      this.classSessions.countDocuments(filters).exec()
    ]);
    const rows = await this.toAdminReportRows(sessions);
    const summary = await this.adminReportSummary(filters);
    return {
      items: rows,
      summary,
      page,
      limit,
      total
    };
  }

  async getAdminClassSessionReport(sessionId: string, user: AuthenticatedUser): Promise<AdminClassSessionReportRow> {
    this.assertAdmin(user);
    const session = await this.classSessions.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    const [row] = await this.toAdminReportRows([session]);
    if (!row) {
      throw new NotFoundException('Class session not found.');
    }
    return row;
  }

  async getAdminAttendanceSummary(query: AdminAttendanceQuery, user: AuthenticatedUser): Promise<AdminAttendanceSummary> {
    this.assertAdmin(user);
    const rows = await this.adminAttendanceSessionRows(query);
    return this.adminAttendanceSummary(rows);
  }

  async listAdminAttendanceSessions(query: AdminAttendanceQuery, user: AuthenticatedUser): Promise<AdminAttendanceSessionsResponse> {
    this.assertAdmin(user);
    const page = this.clampPositiveInteger(query.page, 1, 10_000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const rows = await this.adminAttendanceSessionRows(query);
    return {
      items: rows.slice((page - 1) * limit, page * limit),
      summary: this.adminAttendanceSummary(rows),
      page,
      limit,
      total: rows.length
    };
  }

  async listAdminAttendanceStudents(query: AdminAttendanceQuery, user: AuthenticatedUser): Promise<AdminAttendanceStudentsResponse> {
    this.assertAdmin(user);
    const page = this.clampPositiveInteger(query.page, 1, 10_000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const sessionRows = await this.adminAttendanceSessionRows(query);
    const studentRows = await this.adminAttendanceStudentRows(query);
    return {
      items: studentRows.slice((page - 1) * limit, page * limit),
      summary: this.adminAttendanceSummary(sessionRows),
      page,
      limit,
      total: studentRows.length
    };
  }

  async getAdminAttendanceTrends(query: AdminAttendanceQuery, user: AuthenticatedUser): Promise<AdminAttendanceTrendsResponse> {
    this.assertAdmin(user);
    const rows = await this.adminAttendanceSessionRows(query);
    const groups = new Map<string, AdminAttendanceSessionRow[]>();
    for (const row of rows) {
      const key = row.scheduledAt.slice(0, 10);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const items: AdminAttendanceTrendPoint[] = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, items]) => {
        const enrolled = items.reduce((total, row) => total + row.enrolled, 0);
        const present = items.reduce((total, row) => total + row.present, 0);
        const attended = items.filter((row) => row.present > 0);
        return {
          date,
          sessions: items.length,
          attendanceRate: enrolled ? Math.round((present / enrolled) * 100) : 0,
          averageDurationSeconds: attended.length
            ? Math.round(attended.reduce((total, row) => total + row.averageDurationSeconds, 0) / attended.length)
            : 0,
          present,
          enrolled
        };
      });
    return { items, summary: this.adminAttendanceSummary(rows) };
  }

  async exportAdminAttendanceCsv(query: AdminAttendanceQuery, user: AuthenticatedUser): Promise<string> {
    this.assertAdmin(user);
    const rows = await this.adminAttendanceSessionRows(query);
    const csvRows = [
      [
        'Session',
        'Session ID',
        'Course',
        'Batch',
        'Teacher ID',
        'Status',
        'Scheduled At',
        'Started At',
        'Completed At',
        'Enrolled',
        'Present',
        'Absent',
        'Attendance Rate',
        'Average Duration Seconds',
        'Reconnects',
        'Late Joins',
        'Early Leaves',
        'Attendance Source'
      ],
      ...rows.map((row) => [
        row.title,
        row.sessionId,
        row.courseName ?? row.courseId ?? '',
        row.batchName,
        row.teacherId,
        row.status,
        row.scheduledAt,
        row.startedAt ?? '',
        row.completedAt ?? '',
        String(row.enrolled),
        String(row.present),
        String(row.absent),
        String(row.attendanceRate),
        String(row.averageDurationSeconds),
        String(row.reconnects),
        String(row.lateJoins),
        String(row.earlyLeaves),
        row.attendanceSource
      ])
    ];
    const csv = `${csvRows.map((row) => row.map((value) => this.csvEscape(value)).join(',')).join('\n')}\n`;
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.attendance.export',
      resourceType: 'attendance',
      metadata: { summary: 'Exported attendance analytics CSV', filters: query, rowCount: rows.length }
    });
    return csv;
  }

  async listAdminAttendanceSessionStudents(sessionId: string, user: AuthenticatedUser): Promise<AdminAttendanceSessionStudentsResponse> {
    this.assertAdmin(user);
    const session = await this.classSessions.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    const [sessionRow] = await this.toAdminAttendanceSessionRows([session]);
    if (!sessionRow) {
      throw new NotFoundException('Class session not found.');
    }
    const attendance = await this.adminAttendanceRowsForSession(session);
    const items = attendance.rows
      .map((row) => this.toAdminAttendanceSessionStudentRow(session, row, attendance.source))
      .sort((left, right) => left.studentName.localeCompare(right.studentName));
    return {
      session: sessionRow,
      items,
      source: attendance.source,
      total: items.length
    };
  }

  async startSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    this.assertBatchCanHostSession(resolution.batch);

    if (resolution.persisted?.status === 'completed' || resolution.persisted?.status === 'cancelled') {
      throw new BadRequestException('Completed or cancelled sessions cannot be started.');
    }

    if (resolution.persisted?.status === 'live') {
      const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
      const room = await this.rooms.ensureClassSessionRoom({
        sessionId,
        batchId: resolution.batch.id,
        title: resolution.planned.title,
        teacherId: resolution.batch.teacherId,
        liveSettings
      });
      if (resolution.persisted.roomId === room.id) {
        return this.toPayload(resolution, user);
      }
      const persisted = await this.classSessions.findByIdAndUpdate(sessionId, { $set: { roomId: room.id, liveSettings } }, { new: true });
      return this.toPayload({ ...resolution, persisted: persisted ?? resolution.persisted }, user);
    }

    const otherLiveSession = await this.classSessions.exists({
      _id: { $ne: sessionId },
      batchId: resolution.batch.id,
      status: 'live'
    });
    if (otherLiveSession) {
      throw new ConflictException('Another session for this batch is already live. End it before starting a new one.');
    }

    const now = new Date();
    const channelIds = classSessionChannelIds(sessionId);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    const room = await this.rooms.ensureClassSessionRoom({
      sessionId,
      batchId: resolution.batch.id,
      title: resolution.planned.title,
      teacherId: resolution.batch.teacherId,
      liveSettings
    });
    let persisted: ClassSessionMongoDocument | null;
    try {
      persisted = await this.classSessions.findOneAndUpdate(
        { _id: sessionId, status: { $nin: ['live', 'completed', 'cancelled'] } },
        {
          $setOnInsert: {
            _id: sessionId,
            batchId: resolution.batch.id,
            teacherId: resolution.batch.teacherId,
            title: resolution.planned.title,
            sessionNumber: resolution.planned.sessionNumber,
            scheduledAt: resolution.planned.scheduledAt,
            durationMinutes: resolution.planned.durationMinutes
          },
          $set: {
            status: 'live',
            roomId: room.id,
            chatChannelId: resolution.persisted?.chatChannelId ?? channelIds.chatChannelId,
            whiteboardChannelId: resolution.persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId,
            liveSettings,
            startedAt: resolution.persisted?.startedAt ?? now
          },
          $unset: {
            completedAt: '',
            cancelledAt: '',
            teacherDisconnectedAt: '',
            teacherReconnectDeadlineAt: ''
          }
        },
        { new: true, upsert: true }
      );
    } catch (error) {
      await this.closeNewlyCreatedStartRoom(room.id, resolution, user);
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('Another session for this batch is already live. End it before starting a new one.');
      }
      throw error;
    }

    if (!persisted) {
      const latest = await this.classSessions.findById(sessionId);
      if (latest?.status === 'live') {
        return this.toPayload({ ...resolution, persisted: latest }, user);
      }
      if (latest?.status === 'completed' || latest?.status === 'cancelled') {
        throw new BadRequestException('Completed or cancelled sessions cannot be started.');
      }
      throw new ConflictException('Unable to start this class session. Please refresh and try again.');
    }

    await this.startAutoRecordingIfEnabled(persisted, resolution.batch, user, liveSettings);
    const payload = await this.toPayload({ ...resolution, persisted }, user);
    this.rooms.emitClassSessionLifecycleEvent('session:started', this.toLifecyclePayload(payload));
    await this.auditLogs?.record({
      actor: user,
      action: 'class_sessions.start',
      resourceType: 'class_session',
      resourceId: payload.sessionId,
      resourceLabel: payload.title,
      metadata: { summary: `Started class session ${payload.title}`, batchId: payload.batchId, roomId: payload.roomId },
      after: { status: payload.status, startedAt: payload.startedAt }
    });
    this.metrics?.classSessionLifecycleTransitions.labels('started', payload.status).inc();
    return payload;
  }

  async endSession(sessionId: string, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const persisted = await this.classSessions.findById(sessionId);
    if (!persisted) {
      throw new NotFoundException('Class session not found.');
    }
    const resolution = await this.resolveSession(sessionId, persisted.batchId);
    this.assertCanManageBatch(resolution.batch, user);

    if (persisted.status === 'completed') {
      await this.closeCompletedSessionRoom(persisted, user);
      return this.toPayload({ ...resolution, persisted }, user);
    }

    if (persisted.status !== 'live') {
      throw new BadRequestException('Only live sessions can be ended.');
    }

    const completedAt = new Date();
    const updated = await this.classSessions.findOneAndUpdate(
      { _id: sessionId, status: 'live' },
      {
        $set: {
          status: 'completed',
          completedAt
        },
        $unset: {
          teacherDisconnectedAt: '',
          teacherReconnectDeadlineAt: ''
        }
      },
      { new: true }
    );
    if (!updated) {
      const latest = await this.classSessions.findById(sessionId);
      if (latest?.status === 'completed') {
        return this.toPayload({ ...resolution, persisted: latest }, user);
      }
      throw new ConflictException('Class session could not be completed. Please refresh and try again.');
    }

    const payload = await this.toPayload({ ...resolution, persisted: updated }, user);
    try {
      await this.persistAttendanceSnapshot(updated, 'session_end');
    } catch {
      // Session completion is authoritative once persisted. Analytics can fall back to inferred rows.
    }
    await this.recordings
      .stopActiveClassSessionRecording({
        sessionId,
        actorUserId: user.sub,
        actorLabel: user.email,
        reason: 'session_ended'
      })
      .catch(() => undefined);
    await this.closeCompletedSessionRoom(updated, user);
    this.rooms.emitClassSessionLifecycleEvent('session:ended', this.toLifecyclePayload(payload));
    await this.auditLogs?.record({
      actor: user,
      action: 'class_sessions.end',
      resourceType: 'class_session',
      resourceId: payload.sessionId,
      resourceLabel: payload.title,
      metadata: { summary: `Ended class session ${payload.title}`, batchId: payload.batchId, roomId: payload.roomId },
      after: { status: payload.status, completedAt: payload.completedAt }
    });
    this.metrics?.classSessionLifecycleTransitions.labels('ended', payload.status).inc();
    return payload;
  }

  private async closeCompletedSessionRoom(session: ClassSessionMongoDocument, user: AuthenticatedUser): Promise<void> {
    if (!session.roomId) {
      return;
    }
    await this.rooms
      .closeClassSessionRoom({
        roomId: session.roomId,
        actorUserId: user.sub,
        actorLabel: user.email
      })
      .catch(() => undefined);
  }

  private async startAutoRecordingIfEnabled(
    session: ClassSessionMongoDocument,
    batch: BatchMongoDocument,
    user: AuthenticatedUser,
    liveSettings: LiveClassSettings
  ): Promise<void> {
    if (!liveSettings.recording.recordingEnabled || !liveSettings.recording.autoRecordOnStart) {
      return;
    }
    await this.recordings
      .startClassSessionRecording({
        session,
        batch,
        actor: user,
        retentionDays: liveSettings.recordingRetention.recordingRetentionDays
      })
      .catch(() => undefined);
  }

  async startRecording(sessionId: string, user: AuthenticatedUser): Promise<Recording> {
    const persisted = await this.classSessions.findById(sessionId);
    if (!persisted) {
      throw new NotFoundException('Class session not found.');
    }
    const resolution = await this.resolveSession(sessionId, persisted.batchId);
    this.assertCanManageBatch(resolution.batch, user);
    if (persisted.status !== 'live') {
      throw new BadRequestException('Recording can only start after the class is live.');
    }
    const liveSettings = await this.resolvedLiveSettingsForResolution({ ...resolution, persisted });
    if (!liveSettings.recording.recordingEnabled) {
      throw new ForbiddenException('Recording is disabled for this class.');
    }
    if (!liveSettings.recording.teacherManualRecordingControlEnabled) {
      throw new ForbiddenException('Manual recording control is disabled for this class.');
    }
    return this.recordings.startClassSessionRecording({
      session: persisted,
      batch: resolution.batch,
      actor: user,
      retentionDays: liveSettings.recordingRetention.recordingRetentionDays
    });
  }

  async stopRecording(sessionId: string, user: AuthenticatedUser): Promise<Recording> {
    return this.recordings.stopClassSessionRecording(sessionId, undefined, user);
  }

  async listRecordings(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<Recording[]> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!this.canViewRecordingContent(liveSettings, resolution.batch, user)) {
      return [];
    }
    return this.recordings.listClassSessionRecordings(resolution.planned.id, user);
  }

  async downloadRecording(
    sessionId: string,
    recordingId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<RecordingDownload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!this.canViewRecordingContent(liveSettings, resolution.batch, user)) {
      throw new ForbiddenException('Recording playback is not available for this class.');
    }
    this.assertExportWithinRetention(liveSettings, resolution.persisted?.completedAt);
    return this.recordings.readClassSessionRecordingDownload(resolution.planned.id, recordingId, user);
  }

  async joinSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    const role = this.classSessionMetricRole(user, resolution.batch);
    let deniedRecorded = false;
    try {
      await this.assertCanReadClassSession(resolution.batch, user);

      if (resolution.persisted?.status !== 'live') {
        deniedRecorded = true;
        await this.recordClassSessionJoinAudit(resolution, user, 'denied', resolution.persisted?.status ?? 'scheduled', role);
        throw new ConflictException(this.joinBlockedMessage(resolution.persisted?.status ?? 'scheduled'));
      }
      if (resolution.persisted.roomId) {
        await this.rooms.assertClassSessionRoomJoinAllowed(resolution.persisted.roomId, resolution.batch.teacherId, {
          id: user.sub,
          roles: user.roles
        });
      }

      const payload = await this.toPayload(resolution, user);
      await this.recordClassSessionJoinAudit(resolution, user, 'admitted', 'live', role);
      return payload;
    } catch (error) {
      if (!deniedRecorded) {
        await this.recordClassSessionJoinAudit(resolution, user, 'denied', this.auditErrorReason(error), role);
      }
      throw error;
    }
  }

  async getChatHistory(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    options: { participantId?: string; scope?: ChatMessageScope; before?: string; limit?: number } = {}
  ): Promise<ChatHistoryResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    return this.rooms.getClassSessionChatHistory({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted?.roomId ?? channelIds.roomId,
      channelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      requesterRole: this.payloadRole(user, resolution.batch),
      participantId: options.participantId,
      scope: options.scope,
      before: options.before,
      limit: options.limit
    });
  }

  async uploadChatAttachments(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    files: ClassSessionChatAttachmentUploadFile[]
  ): Promise<ChatAttachment[]> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    if (resolution.persisted?.status !== 'live' || !resolution.persisted.roomId) {
      throw new ConflictException('Chat attachments can only be uploaded while the class is live.');
    }
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!liveSettings.chat.chatAttachmentsEnabled) {
      throw new ForbiddenException('Chat attachments are disabled for this class.');
    }
    return this.rooms.createClassSessionChatAttachments({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: resolution.persisted.roomId,
      channelId: resolution.persisted.chatChannelId ?? classSessionChannelIds(resolution.planned.id).chatChannelId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      files
    });
  }

  async downloadChatAttachment(
    sessionId: string,
    attachmentId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ClassSessionChatAttachmentDownload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted?.roomId) {
      throw new NotFoundException('Chat attachment not found.');
    }
    return this.rooms.readClassSessionChatAttachment({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      requesterRole: this.payloadRole(user, resolution.batch),
      attachmentId
    });
  }

  async listMaterials(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassSessionMaterial[]> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertMaterialsEnabled(liveSettings);
    const role = this.payloadRole(user, resolution.batch);
    const materials = await this.materials
      .find({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      })
      .sort({ shared: -1, createdAt: -1 })
      .exec();
    return materials
      .filter((material) => this.canAccessMaterial(material, resolution, role, liveSettings))
      .map((material) => this.toMaterialPayload(material));
  }

  async uploadMaterials(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    files: ClassSessionMaterialUploadFile[]
  ): Promise<ClassSessionMaterial[]> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertCanManageMaterials(liveSettings);
    if (!files.length) {
      throw new BadRequestException('At least one material file is required.');
    }
    if (files.length > CLASS_MATERIAL_MAX_COUNT) {
      throw new BadRequestException(`You can upload up to ${CLASS_MATERIAL_MAX_COUNT} materials at once.`);
    }

    const roomId = resolution.persisted?.roomId ?? classSessionChannelIds(resolution.planned.id).roomId;
    const directory = join(this.classMaterialStorageRoot(), 'class-sessions', this.safeStorageSegment(resolution.planned.id));
    await mkdir(directory, { recursive: true });

    const created: ClassSessionMaterialMongoDocument[] = [];
    for (const file of files) {
      const mimeType = this.normalizeMaterialMimeType(file.mimetype);
      const kind = this.materialKindForMimeType(mimeType);
      this.assertMaterialKindAllowed(kind, liveSettings);
      const maxFileSizeBytes = this.classMaterialMaxFileSizeBytes(liveSettings);
      if (file.size > maxFileSizeBytes) {
        throw new BadRequestException(`Class materials cannot exceed ${liveSettings.materials.maxMaterialFileSizeMb} MB.`);
      }
      if (!file.buffer?.length) {
        throw new BadRequestException('Material upload is empty.');
      }
      const materialId = randomUUID();
      const fileName = this.safeMaterialFileName(file.originalname, kind);
      const storageKey = `class-sessions/${this.safeStorageSegment(resolution.planned.id)}/${materialId}/${fileName}`;
      const storagePath = join(directory, `${materialId}-${fileName}`);
      await writeFile(storagePath, file.buffer);
      const doc = await this.materials.create({
        materialId,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId,
        title: this.titleFromFileName(fileName),
        kind,
        source: 'upload',
        fileName,
        mimeType,
        size: file.size,
        storageProvider: 'local',
        storageKey,
        path: storagePath,
        uploadedByUserId: user.sub,
        shared: false
      });
      created.push(doc);
    }
    for (const material of created) {
      await this.recordClassSessionMaterialAudit('upload', resolution, material, user);
    }
    return created.map((material) => this.toMaterialPayload(material));
  }

  async attachMaterialLink(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: CreateClassSessionMaterialLinkRequest
  ): Promise<ClassSessionMaterial> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertCanManageMaterials(liveSettings);
    const url = this.normalizeMaterialUrl(request.url);
    const title = this.cleanMaterialText(request.title, 180);
    if (!title) {
      throw new BadRequestException('Material title is required.');
    }
    const kind = request.kind && ['document', 'slides', 'file', 'link'].includes(request.kind) ? request.kind : 'link';
    this.assertMaterialKindAllowed(kind, liveSettings);
    const roomId = resolution.persisted?.roomId ?? classSessionChannelIds(resolution.planned.id).roomId;
    const doc = await this.materials.create({
      materialId: randomUUID(),
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId,
      title,
      ...(request.description ? { description: this.cleanMaterialText(request.description, 1000) } : {}),
      kind,
      source: 'link',
      url,
      uploadedByUserId: user.sub,
      shared: false
    });
    await this.recordClassSessionMaterialAudit('link', resolution, doc, user);
    return this.toMaterialPayload(doc);
  }

  async deleteMaterial(sessionId: string, materialId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<void> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertMaterialsEnabled(liveSettings);
    const updated = await this.materials.findOneAndUpdate(
      {
        materialId,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      },
      {
        $set: {
          shared: false,
          deletedAt: new Date()
        },
        $unset: {
          sharedAt: '',
          sharedByUserId: ''
        }
      },
      { new: true }
    );
    if (!updated) {
      throw new NotFoundException('Class material not found.');
    }
    await this.emitMaterialEvent('material:updated', resolution, updated, user, false);
    await this.recordClassSessionMaterialAudit('delete', resolution, updated, user);
  }

  async downloadMaterial(
    sessionId: string,
    materialId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ClassSessionMaterialDownload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertMaterialsEnabled(liveSettings);
    const role = this.payloadRole(user, resolution.batch);
    if (role === 'student' && !liveSettings.materials.studentsCanDownloadMaterials) {
      throw new ForbiddenException('Material downloads are disabled for this class.');
    }
    const material = await this.materials.findOne({
      materialId,
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      deletedAt: { $exists: false }
    });
    if (!material || material.source !== 'upload' || !material.path || !material.fileName || !material.mimeType || !material.size) {
      throw new NotFoundException('Class material not found.');
    }
    if (!this.canAccessMaterial(material, resolution, role, liveSettings)) {
      throw new NotFoundException('Class material not found.');
    }
    await this.recordClassSessionMaterialAudit('download', resolution, material, user);
    return {
      stream: createReadStream(material.path),
      fileName: material.fileName,
      mimeType: material.mimeType,
      size: material.size
    };
  }

  async getWhiteboardMemory(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<WhiteboardMemoryState | null> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const state = await this.whiteboardStates.findOne({ sessionId: resolution.planned.id, batchId: resolution.batch.id });
    return state ? this.toWhiteboardMemoryState(state) : null;
  }

  async saveWhiteboardMemory(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: SaveWhiteboardMemoryRequest
  ): Promise<WhiteboardMemoryState> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const normalized = this.normalizeWhiteboardSnapshot(request.snapshot);
    const summary = this.whiteboardSnapshotSummary(normalized);
    const previous = await this.whiteboardStates.findOne({ sessionId: resolution.planned.id, batchId: resolution.batch.id });
    const snapshotVersion = (previous?.snapshotVersion ?? 0) + 1;
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const roomId = resolution.persisted?.roomId ?? channelIds.roomId;
    const reason = this.normalizeWhiteboardSaveReason(request.reason ?? 'autosave');
    const pages = summary.pages.map((page) => ({
      pageId: page.pageId,
      title: page.title,
      tags: page.tags,
      order: page.order,
      elementCount: page.elementCount
    }));
    const update = {
      $set: {
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId,
        whiteboardChannelId: resolution.persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId,
        schemaVersion: WHITEBOARD_MEMORY_SCHEMA_VERSION,
        snapshotVersion,
        currentSnapshot: normalized as unknown as Record<string, unknown>,
        pages,
        pageCount: summary.pageCount,
        elementCount: summary.elementCount,
        updatedByUserId: user.sub
      },
      $setOnInsert: {
        createdByUserId: user.sub
      }
    };
    const state = await this.whiteboardStates.findOneAndUpdate(
      { sessionId: resolution.planned.id, batchId: resolution.batch.id },
      update,
      { new: true, upsert: true }
    );
    if (!state) {
      throw new ConflictException('Whiteboard state could not be saved.');
    }
    if (request.createVersion || reason !== 'autosave') {
      const version = await this.createWhiteboardVersion(resolution, normalized, summary, snapshotVersion, reason, user.sub, roomId);
      state.latestVersionId = version.versionId;
      await state.save();
      await this.trimWhiteboardVersions(resolution.planned.id);
    }
    await this.recordWhiteboardMemoryAudit('save', resolution, user, { reason, snapshotVersion, pageCount: summary.pageCount, elementCount: summary.elementCount });
    return this.toWhiteboardMemoryState(state);
  }

  async createWhiteboardCheckpoint(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: CreateWhiteboardMemoryCheckpointRequest
  ): Promise<WhiteboardMemoryVersion> {
    const state = await this.saveWhiteboardMemory(sessionId, batchId ?? request.batchId, user, {
      batchId: request.batchId,
      snapshot: request.snapshot,
      reason: request.reason ?? 'manual-save',
      createVersion: true
    });
    const versionId = state.latestVersionId;
    if (!versionId) {
      throw new ConflictException('Whiteboard checkpoint could not be created.');
    }
    const version = await this.whiteboardVersions.findOne({ versionId, sessionId: state.sessionId, batchId: state.batchId });
    if (!version) {
      throw new ConflictException('Whiteboard checkpoint could not be loaded.');
    }
    return this.toWhiteboardMemoryVersion(version);
  }

  async listWhiteboardVersions(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<WhiteboardMemoryVersionListResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const versions = await this.whiteboardVersions
      .find({ sessionId: resolution.planned.id, batchId: resolution.batch.id })
      .sort({ createdAt: -1 })
      .limit(WHITEBOARD_MEMORY_MAX_VERSIONS)
      .exec();
    return { versions: versions.map((version) => this.toWhiteboardMemoryVersion(version)) };
  }

  async restoreWhiteboardVersion(
    sessionId: string,
    versionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: RestoreWhiteboardMemoryVersionRequest
  ): Promise<WhiteboardMemoryState> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const version = await this.whiteboardVersions.findOne({ versionId, sessionId: resolution.planned.id, batchId: resolution.batch.id });
    if (!version) {
      throw new NotFoundException('Whiteboard version not found.');
    }
    const snapshot = this.normalizeWhiteboardSnapshot(version.snapshot as unknown as WhiteboardMemorySnapshot);
    return this.saveWhiteboardMemory(sessionId, batchId ?? request.batchId, user, {
      batchId: request.batchId,
      snapshot,
      reason: 'restore',
      createVersion: true
    });
  }

  async listPreviousWhiteboardMemories(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<PreviousWhiteboardMemoryListResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const states = await this.whiteboardStates
      .find({ batchId: resolution.batch.id, sessionId: { $ne: resolution.planned.id } })
      .sort({ updatedAt: -1 })
      .limit(20)
      .exec();
    const sessionIds = states.map((state) => state.sessionId);
    const sessions = await this.classSessions.find({ _id: { $in: sessionIds } }).exec();
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    return {
      boards: states.map((state) => {
        const session = sessionById.get(state.sessionId);
        return {
          sessionId: state.sessionId,
          batchId: state.batchId,
          ...(session?.title ? { title: session.title } : {}),
          ...(session?.sessionNumber ? { sessionNumber: session.sessionNumber } : {}),
          ...(session?.scheduledAt ? { scheduledAt: session.scheduledAt.toISOString() } : {}),
          updatedAt: state.updatedAt.toISOString(),
          snapshotVersion: state.snapshotVersion,
          summary: this.whiteboardDocumentSummary(state)
        };
      })
    };
  }

  async restorePreviousWhiteboardMemory(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: RestorePreviousWhiteboardMemoryRequest
  ): Promise<WhiteboardMemoryState> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const source = await this.whiteboardStates.findOne({ sessionId: request.sourceSessionId, batchId: resolution.batch.id });
    if (!source) {
      throw new NotFoundException('Previous whiteboard state not found.');
    }
    const snapshot = this.normalizeWhiteboardSnapshot(source.currentSnapshot as unknown as WhiteboardMemorySnapshot);
    return this.saveWhiteboardMemory(sessionId, batchId ?? request.batchId, user, {
      batchId: request.batchId,
      snapshot,
      reason: 'restore',
      createVersion: true
    });
  }

  async searchWhiteboardPages(
    sessionId: string,
    batchId: string | undefined,
    query: string | undefined,
    user: AuthenticatedUser
  ): Promise<WhiteboardMemoryPageSearchResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const search = this.cleanWhiteboardText(query ?? '', 80).toLowerCase();
    const states = await this.whiteboardStates.find({ batchId: resolution.batch.id }).sort({ updatedAt: -1 }).limit(50).exec();
    const results = states.flatMap((state) =>
      state.pages
        .filter((page) => !search || page.title.toLowerCase().includes(search) || page.tags.some((tag) => tag.toLowerCase().includes(search)))
        .map((page) => ({
          sessionId: state.sessionId,
          batchId: state.batchId,
          pageId: page.pageId,
          title: page.title,
          tags: page.tags,
          order: page.order,
          updatedAt: state.updatedAt.toISOString()
        }))
    );
    return { results: results.slice(0, 100) };
  }

  async shareMaterial(sessionId: string, materialId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassSessionMaterial> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertMaterialsEnabled(liveSettings);
    const live = this.requireLivePersistedSession(resolution);
    await this.materials.updateMany(
      {
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        shared: true,
        deletedAt: { $exists: false },
        materialId: { $ne: materialId }
      },
      {
        $set: { shared: false },
        $unset: { sharedAt: '', sharedByUserId: '' }
      }
    );
    const sharedAt = new Date();
    const material = await this.materials.findOneAndUpdate(
      {
        materialId,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      },
      {
        $set: {
          roomId: live.roomId,
          shared: true,
          sharedAt,
          sharedByUserId: user.sub
        }
      },
      { new: true }
    );
    if (!material) {
      throw new NotFoundException('Class material not found.');
    }
    await this.emitMaterialEvent('material:shared', resolution, material, user, true);
    await this.recordClassSessionMaterialAudit('share', resolution, material, user);
    return this.toMaterialPayload(material);
  }

  async unshareMaterial(sessionId: string, materialId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassSessionMaterial> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertMaterialsEnabled(liveSettings);
    this.requireLivePersistedSession(resolution);
    const material = await this.materials.findOneAndUpdate(
      {
        materialId,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      },
      {
        $set: { shared: false },
        $unset: { sharedAt: '', sharedByUserId: '' }
      },
      { new: true }
    );
    if (!material) {
      throw new NotFoundException('Class material not found.');
    }
    await this.emitMaterialEvent('material:unshared', resolution, material, user, false);
    await this.recordClassSessionMaterialAudit('unshare', resolution, material, user);
    return this.toMaterialPayload(material);
  }

  async getChatSummary(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ChatThreadSummaryResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    return this.rooms.getClassSessionChatSummary({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted?.roomId ?? channelIds.roomId,
      channelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      requesterRole: this.payloadRole(user, resolution.batch)
    });
  }

  async markChatRead(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    options: { roomId?: string; participantId?: string; scope?: ChatMessageScope; readAt?: string } = {}
  ): Promise<ChatReadState> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    const roomId = persisted?.roomId ?? channelIds.roomId;
    if (options.roomId && options.roomId !== roomId) {
      throw new BadRequestException('Chat read room does not match this class session.');
    }
    try {
      return await this.rooms.markClassSessionChatRead({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId,
        channelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
        teacherId: resolution.batch.teacherId,
        requesterUserId: user.sub,
        requesterRole: this.payloadRole(user, resolution.batch),
        participantId: options.participantId,
        scope: options.scope,
        readAt: options.readAt
      });
    } catch (error) {
      this.metrics?.classSessionChatFailures
        .labels('read', this.chatMetricScope(options.scope, options.participantId, this.payloadRole(user, resolution.batch)), this.auditErrorReason(error))
        .inc();
      throw error;
    }
  }

  async exportAttendanceCsv(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<string> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    if (!resolution.persisted?.roomId) {
      throw new BadRequestException('Attendance is available after a session has started.');
    }
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!liveSettings.attendance.teacherAttendanceExportEnabled) {
      throw new ForbiddenException('Attendance export is disabled for this class.');
    }
    if (liveSettings.exportControls.exportControlsEnabled && !liveSettings.exportControls.allowAttendanceExport) {
      throw new ForbiddenException('Attendance export is disabled by class export controls.');
    }
    this.assertExportWithinRetention(liveSettings, resolution.persisted.completedAt);
    const csv = await this.rooms.exportClassSessionAttendanceCsv({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: resolution.persisted.roomId,
      ...(resolution.persisted.completedAt ? { completedAt: resolution.persisted.completedAt } : {}),
      ...this.attendancePolicy(liveSettings, resolution.planned.durationMinutes),
      anonymizeStudentExports: liveSettings.exportControls.exportControlsEnabled && liveSettings.exportControls.anonymizeStudentExports
    });
    await this.auditLogs?.record({
      actor: user,
      action: 'class_sessions.attendance.export',
      resourceType: 'class_session',
      resourceId: resolution.planned.id,
      resourceLabel: resolution.planned.title,
      metadata: { summary: `Exported attendance for ${resolution.planned.title}`, batchId: resolution.batch.id, roomId: resolution.persisted.roomId }
    });
    return csv;
  }

  async getSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    return this.toPayload(resolution, user);
  }

  async getCurrentForBatch(batchId: string, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const batch = await this.findBatch(batchId);
    await this.assertCanReadClassSession(batch, user);
    const schedules = await this.findSchedules(batch.id);
    const persistedSessions = await this.classSessions.find({ batchId: batch.id }).sort({ scheduledAt: 1 }).exec();
    const sessions = this.mergeSessions(batch, schedules, persistedSessions);
    const live = sessions.find((session) => session.status === 'live');
    const nextScheduled = sessions.find((session) => session.status === 'scheduled');
    const lastFinished = [...sessions].reverse().find((session) => session.status === 'completed' || session.status === 'cancelled');
    const selected = live ?? nextScheduled ?? lastFinished;
    if (!selected) {
      throw new NotFoundException('No class sessions are available for this batch.');
    }
    return this.toPayload(
      {
        batch,
        schedules,
        planned: selected.planned,
        persisted: selected.persisted
      },
      user
    );
  }

  private async resolveSession(sessionId: string, batchId?: string): Promise<SessionResolution> {
    const persisted = await this.classSessions.findById(sessionId);
    const resolvedBatchId = persisted?.batchId ?? batchId;
    if (!resolvedBatchId) {
      throw new NotFoundException('Class session not found.');
    }

    const batch = await this.findBatch(resolvedBatchId);
    const schedules = await this.findSchedules(batch.id);
    const planned =
      planClassSessions(batch, schedules).find((session) => session.id === sessionId) ??
      (persisted
        ? {
            id: persisted.id,
            batchId: persisted.batchId,
            title: persisted.title,
            sessionNumber: persisted.sessionNumber,
            scheduledAt: persisted.scheduledAt,
            durationMinutes: persisted.durationMinutes
          }
        : undefined);

    if (!planned) {
      throw new NotFoundException('Class session not found in this batch schedule.');
    }

    return { batch, schedules, planned, ...(persisted ? { persisted } : {}) };
  }

  private async findBatch(batchId: string): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } }).exec();
    if (!batch) {
      throw new NotFoundException('Batch not found.');
    }
    return batch;
  }

  private async recordClassSessionJoinAudit(
    resolution: SessionResolution,
    user: AuthenticatedUser,
    result: 'admitted' | 'denied',
    reason: string,
    role: string
  ): Promise<void> {
    const safeReason = this.safeMetricLabel(reason);
    this.metrics?.classSessionJoinAttempts.labels(result, safeReason, role).inc();
    await this.auditLogs?.record({
      actor: user,
      action: `class_sessions.join.${result}`,
      resourceType: 'class_session',
      resourceId: resolution.planned.id,
      resourceLabel: resolution.planned.title,
      metadata: {
        summary:
          result === 'admitted'
            ? `Admitted ${role} to class session ${resolution.planned.title}`
            : `Denied ${role} class-session join for ${resolution.planned.title}`,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: resolution.persisted?.roomId ?? classSessionChannelIds(resolution.planned.id).roomId,
        actorRole: role,
        result,
        reason: safeReason
      }
    });
  }

  private async recordClassSessionMaterialAudit(
    action: 'upload' | 'link' | 'share' | 'unshare' | 'download' | 'delete',
    resolution: SessionResolution,
    material: ClassSessionMaterialMongoDocument,
    user: AuthenticatedUser
  ): Promise<void> {
    const kind = this.safeMetricLabel(material.kind ?? 'unknown');
    this.metrics?.classSessionMaterialActions.labels(action, 'success', kind).inc();
    await this.auditLogs?.record({
      actor: user,
      action: `class_sessions.material.${action}`,
      resourceType: 'class_session_material',
      resourceId: material.materialId,
      resourceLabel: material.title,
      metadata: {
        summary: `${action} class-session material`,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: material.roomId,
        materialId: material.materialId,
        kind,
        source: material.source,
        size: material.size ?? 0
      }
    });
  }

  private classSessionMetricRole(user: AuthenticatedUser, batch: BatchMongoDocument): string {
    if (this.isAdmin(user)) {
      return 'admin';
    }
    if (user.roles.includes('TEACHER') && batch.teacherId === user.sub) {
      return 'teacher';
    }
    if (user.roles.includes('TEACHER')) {
      return 'teacher';
    }
    if (user.roles.includes('STUDENT')) {
      return 'student';
    }
    return 'other';
  }

  private chatMetricScope(scope: ChatMessageScope | undefined, participantId: string | undefined, requesterRole: 'teacher' | 'student' | 'admin'): string {
    if (scope) {
      return scope;
    }
    if (requesterRole === 'student' || participantId) {
      return 'private';
    }
    return 'broadcast';
  }

  private auditErrorReason(error: unknown): string {
    const status = typeof (error as { getStatus?: () => number })?.getStatus === 'function'
      ? (error as { getStatus: () => number }).getStatus()
      : undefined;
    if (status === 400) {
      return 'bad_request';
    }
    if (status === 403) {
      return 'forbidden';
    }
    if (status === 404) {
      return 'not_found';
    }
    if (status === 409) {
      return 'conflict';
    }
    if (status === 503) {
      return 'service_unavailable';
    }
    if (error instanceof Error && error.name) {
      return this.safeMetricLabel(error.name);
    }
    return 'unknown';
  }

  private safeMetricLabel(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized.slice(0, 64) || 'unknown';
  }

  private findSchedules(batchId: string): Promise<BatchScheduleMongoDocument[]> {
    return this.schedules.find({ batchId }).sort({ dayOfWeek: 1 }).exec();
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!this.isAdmin(user)) {
      throw new ForbiddenException('Admin access required.');
    }
  }

  private clampPositiveInteger(value: unknown, fallback: number, max: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return fallback;
    }
    return Math.min(Math.floor(parsed), max);
  }

  private async adminClassSessionFilters(query: AdminClassSessionReportQuery): Promise<Record<string, unknown>> {
    const filters: Record<string, unknown> = {};
    if (query.status && query.status !== 'all') {
      if (!ADMIN_CLASS_SESSION_STATUSES.has(query.status)) {
        throw new BadRequestException('Invalid class session status filter.');
      }
      filters.status = query.status;
    }
    if (query.teacherId?.trim()) {
      filters.teacherId = query.teacherId.trim();
    }
    if (query.batchId?.trim()) {
      filters.batchId = query.batchId.trim();
    }
    if (query.courseId?.trim()) {
      const requestedBatchId = query.batchId?.trim();
      const batches = await this.batches
        .find({ courseId: query.courseId.trim(), deletedAt: { $exists: false } })
        .select('_id')
        .exec();
      const batchIds = batches.map((batch) => batch.id);
      filters.batchId = requestedBatchId
        ? batchIds.includes(requestedBatchId)
          ? requestedBatchId
          : '__none__'
        : { $in: batchIds.length ? batchIds : ['__none__'] };
    }
    const scheduledAt: Record<string, Date> = {};
    if (query.dateFrom?.trim()) {
      scheduledAt.$gte = this.parseAdminDate(query.dateFrom, 'dateFrom');
    }
    if (query.dateTo?.trim()) {
      scheduledAt.$lte = this.parseAdminDate(query.dateTo, 'dateTo');
    }
    if (scheduledAt.$gte || scheduledAt.$lte) {
      filters.scheduledAt = scheduledAt;
    }
    return filters;
  }

  private parseAdminDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid ${field} filter.`);
    }
    return date;
  }

  private boundedAdminAttendanceQuery(query: AdminAttendanceQuery): AdminAttendanceQuery {
    const now = new Date();
    const dateTo = query.dateTo?.trim() ? this.parseAdminDate(query.dateTo, 'dateTo') : now;
    const dateFrom = query.dateFrom?.trim()
      ? this.parseAdminDate(query.dateFrom, 'dateFrom')
      : new Date(dateTo.getTime() - ADMIN_ATTENDANCE_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    if (dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException('dateFrom must be before dateTo.');
    }
    if (dateTo.getTime() - dateFrom.getTime() > ADMIN_ATTENDANCE_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      throw new BadRequestException(`Attendance analytics date range cannot exceed ${ADMIN_ATTENDANCE_MAX_RANGE_DAYS} days.`);
    }
    return {
      ...query,
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString()
    };
  }

  private async adminAttendanceSessionRows(query: AdminAttendanceQuery): Promise<AdminAttendanceSessionRow[]> {
    const bounded = this.boundedAdminAttendanceQuery(query);
    const filters = await this.adminClassSessionFilters(bounded);
    const sessions = await this.classSessions.find(filters).sort({ scheduledAt: -1 }).exec();
    return this.toAdminAttendanceSessionRows(sessions);
  }

  private async toAdminAttendanceSessionRows(sessions: ClassSessionMongoDocument[]): Promise<AdminAttendanceSessionRow[]> {
    if (!sessions.length) {
      return [];
    }
    const batchMap = await this.adminBatchMap(sessions.map((session) => session.batchId));
    const teacherMap = await this.adminTeacherMap(sessions.map((session) => session.teacherId));
    return Promise.all(
      sessions.map(async (session) => {
        const batch = batchMap.get(session.batchId);
        const teacher = teacherMap.get(session.teacherId);
        const attendance = await this.adminAttendanceRowsForSession(session);
        const attendanceRows = attendance.rows;
        const presentRows = attendanceRows.filter((row) => row.status === 'present');
        const enrolled = attendanceRows.length;
        const present = presentRows.length;
        const lateJoinThresholdMs = this.lateJoinThresholdMs(session);
        const lateJoins = presentRows.filter(
          (row) => row.firstJoinAt && row.firstJoinAt.getTime() > session.scheduledAt.getTime() + lateJoinThresholdMs
        ).length;
        const earlyLeaves =
          session.completedAt || session.status === 'completed'
            ? presentRows.filter(
                (row) =>
                  row.lastLeaveAt &&
                  session.completedAt &&
                  row.lastLeaveAt.getTime() < session.completedAt.getTime() - ADMIN_ATTENDANCE_EARLY_LEAVE_MS
              ).length
            : 0;
        const totalDurationSeconds = presentRows.reduce((total, row) => total + row.totalDurationSeconds, 0);
        return {
          sessionId: session.id,
          batchId: session.batchId,
          batchName: batch?.name ?? 'Unknown batch',
          ...(batch?.courseId ? { courseId: batch.courseId } : {}),
          ...(batch?.courseName ? { courseName: batch.courseName } : {}),
          teacherId: session.teacherId,
          ...(teacher?.displayName ? { teacherName: teacher.displayName } : {}),
          title: session.title,
          status: session.status,
          scheduledAt: session.scheduledAt.toISOString(),
          ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
          ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {}),
          enrolled,
          present,
          absent: Math.max(0, enrolled - present),
          attendanceRate: enrolled ? Math.round((present / enrolled) * 100) : 0,
          averageDurationSeconds: present ? Math.round(totalDurationSeconds / present) : 0,
          reconnects: presentRows.reduce((total, row) => total + row.reconnectCount, 0),
          lateJoins,
          earlyLeaves,
          attendanceSource: attendance.source
        };
      })
    );
  }

  private async adminAttendanceStudentRows(query: AdminAttendanceQuery): Promise<AdminAttendanceStudentRow[]> {
    const bounded = this.boundedAdminAttendanceQuery(query);
    const filters = await this.adminClassSessionFilters(bounded);
    const sessions = await this.classSessions.find(filters).sort({ scheduledAt: -1 }).exec();
    if (!sessions.length) {
      return [];
    }
    const batchMap = await this.adminBatchMap(sessions.map((session) => session.batchId));
    const rows = new Map<
      string,
      AdminAttendanceStudentRow & { totalDurationSeconds: number; attendedDurationRows: number }
    >();
    for (const session of sessions) {
      const batch = batchMap.get(session.batchId);
      const attendance = await this.adminAttendanceRowsForSession(session);
      const attendanceRows = attendance.rows;
      for (const row of attendanceRows) {
        const key = `${session.batchId}:${row.studentId}`;
        const existing = rows.get(key) ?? {
          studentId: row.studentId,
          studentName: row.displayName,
          ...(row.email ? { studentEmail: row.email } : {}),
          batchId: session.batchId,
          batchName: batch?.name ?? 'Unknown batch',
          ...(batch?.courseId ? { courseId: batch.courseId } : {}),
          ...(batch?.courseName ? { courseName: batch.courseName } : {}),
          sessionsEnrolled: 0,
          sessionsAttended: 0,
          absentCount: 0,
          attendanceRate: 0,
          averageDurationSeconds: 0,
          reconnects: 0,
          snapshottedSessions: 0,
          inferredSessions: 0,
          totalDurationSeconds: 0,
          attendedDurationRows: 0
        };
        existing.sessionsEnrolled += 1;
        if (attendance.source === 'snapshot') {
          existing.snapshottedSessions += 1;
        } else {
          existing.inferredSessions += 1;
        }
        if (row.status === 'present') {
          existing.sessionsAttended += 1;
          existing.totalDurationSeconds += row.totalDurationSeconds;
          existing.attendedDurationRows += 1;
          existing.reconnects += row.reconnectCount;
          if (row.firstJoinAt && (!existing.lastAttendedAt || row.firstJoinAt.toISOString() > existing.lastAttendedAt)) {
            existing.lastAttendedAt = row.firstJoinAt.toISOString();
          }
        } else {
          existing.absentCount += 1;
        }
        rows.set(key, existing);
      }
    }
    return [...rows.values()]
      .map(({ totalDurationSeconds, attendedDurationRows, ...row }) => ({
        ...row,
        attendanceRate: row.sessionsEnrolled ? Math.round((row.sessionsAttended / row.sessionsEnrolled) * 100) : 0,
        averageDurationSeconds: attendedDurationRows ? Math.round(totalDurationSeconds / attendedDurationRows) : 0
      }))
      .sort((left, right) => left.studentName.localeCompare(right.studentName));
  }

  private async adminAttendanceRowsForSession(session: ClassSessionMongoDocument): Promise<AttendanceRowsWithSource> {
    const snapshots = await this.attendanceSnapshots.find({ sessionId: session.id }).sort({ studentName: 1 }).exec();
    if (snapshots.length) {
      return {
        rows: snapshots.map((snapshot) => this.attendanceSnapshotToRow(snapshot)),
        source: 'snapshot'
      };
    }
    if (session.roomId) {
      return {
        rows: await this.rooms.classSessionAttendanceRows({
          sessionId: session.id,
          batchId: session.batchId,
          roomId: session.roomId,
          ...(session.completedAt ? { completedAt: session.completedAt } : {}),
          ...this.attendancePolicy(this.persistedLiveSettings(session), session.durationMinutes)
        }),
        source: 'inferred'
      };
    }
    const roster = await this.studentEnrollments.listBatchRoster(session.batchId, { includeInactive: true });
    return {
      rows: roster.map((student) => ({
        studentId: student.userId,
        displayName: student.displayName,
        email: student.email,
        enrolledAt: student.joinedAt ? new Date(student.joinedAt) : undefined,
        rosterSource: 'roster',
        totalDurationSeconds: 0,
        reconnectCount: 0,
        status: 'absent'
      })),
      source: 'inferred'
    };
  }

  private attendanceSnapshotToRow(snapshot: ClassSessionAttendanceSnapshotMongoDocument): ClassSessionAttendanceRow {
    return {
      studentId: snapshot.studentId,
      displayName: snapshot.studentName,
      email: snapshot.studentEmail ?? '',
      ...(snapshot.enrolledAt ? { enrolledAt: snapshot.enrolledAt } : {}),
      rosterSource: snapshot.rosterSource,
      ...(snapshot.firstJoinAt ? { firstJoinAt: snapshot.firstJoinAt } : {}),
      ...(snapshot.lastLeaveAt ? { lastLeaveAt: snapshot.lastLeaveAt } : {}),
      totalDurationSeconds: snapshot.totalDurationSeconds,
      reconnectCount: snapshot.reconnectCount,
      status: snapshot.status
    };
  }

  private toAdminAttendanceSessionStudentRow(
    session: ClassSessionMongoDocument,
    row: ClassSessionAttendanceRow,
    source: AdminAttendanceSource
  ): AdminAttendanceSessionStudentRow {
    return {
      sessionId: session.id,
      batchId: session.batchId,
      ...(session.roomId ? { roomId: session.roomId } : {}),
      studentId: row.studentId,
      studentName: row.displayName,
      ...(row.email ? { studentEmail: row.email } : {}),
      ...(row.enrolledAt ? { enrolledAt: row.enrolledAt.toISOString() } : {}),
      rosterSource: row.rosterSource ?? 'roster',
      ...(row.firstJoinAt ? { firstJoinAt: row.firstJoinAt.toISOString() } : {}),
      ...(row.lastLeaveAt ? { lastLeaveAt: row.lastLeaveAt.toISOString() } : {}),
      totalDurationSeconds: row.totalDurationSeconds,
      reconnectCount: row.reconnectCount,
      status: row.status,
      attendanceSource: source
    };
  }

  private async persistAttendanceSnapshot(
    session: ClassSessionMongoDocument,
    snapshotSource: 'session_end' | 'backfill'
  ): Promise<void> {
    if (!session.roomId) {
      return;
    }
    const existing = await this.attendanceSnapshots.exists({ sessionId: session.id });
    if (existing) {
      return;
    }
    const rows = await this.rooms.classSessionAttendanceRows({
      sessionId: session.id,
      batchId: session.batchId,
      roomId: session.roomId,
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      ...this.attendancePolicy(this.persistedLiveSettings(session), session.durationMinutes)
    });
    if (!rows.length) {
      return;
    }
    const now = new Date();
    const operations: AnyBulkWriteOperation<ClassSessionAttendanceSnapshotDocument>[] = rows.map((row) => ({
      updateOne: {
        filter: {
          sessionId: session.id,
          studentId: row.studentId
        },
        update: {
          $setOnInsert: {
            _id: `${session.id}:attendance:${row.studentId}`,
            sessionId: session.id,
            batchId: session.batchId,
            roomId: session.roomId,
            studentId: row.studentId,
            studentName: row.displayName,
            ...(row.email ? { studentEmail: row.email } : {}),
            ...(row.enrolledAt ? { enrolledAt: row.enrolledAt } : {}),
            rosterSource: row.rosterSource ?? 'roster',
            ...(row.firstJoinAt ? { firstJoinAt: row.firstJoinAt } : {}),
            ...(row.lastLeaveAt ? { lastLeaveAt: row.lastLeaveAt } : {}),
            totalDurationSeconds: row.totalDurationSeconds,
            reconnectCount: row.reconnectCount,
            status: row.status,
            snapshotSource,
            createdAt: now,
            updatedAt: now
          }
        },
        upsert: true
      }
    }));
    await this.attendanceSnapshots.bulkWrite(operations, { ordered: false });
  }

  private adminAttendanceSummary(rows: AdminAttendanceSessionRow[]): AdminAttendanceSummary {
    const totalEnrolledStudents = rows.reduce((total, row) => total + row.enrolled, 0);
    const totalPresent = rows.reduce((total, row) => total + row.present, 0);
    const attendedRows = rows.filter((row) => row.present > 0);
    return {
      totalSessions: rows.length,
      completedSessions: rows.filter((row) => row.status === 'completed').length,
      totalEnrolledStudents,
      averageAttendanceRate: totalEnrolledStudents ? Math.round((totalPresent / totalEnrolledStudents) * 100) : 0,
      averageDurationSeconds: attendedRows.length
        ? Math.round(attendedRows.reduce((total, row) => total + row.averageDurationSeconds, 0) / attendedRows.length)
        : 0,
      absentCount: rows.reduce((total, row) => total + row.absent, 0),
      lateJoinCount: rows.reduce((total, row) => total + row.lateJoins, 0),
      earlyLeaveCount: rows.reduce((total, row) => total + row.earlyLeaves, 0),
      reconnectCount: rows.reduce((total, row) => total + row.reconnects, 0)
    };
  }

  private csvEscape(value: string): string {
    if (!/[",\n\r]/.test(value)) {
      return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
  }

  private async toAdminReportRows(sessions: ClassSessionMongoDocument[]): Promise<AdminClassSessionReportRow[]> {
    if (!sessions.length) {
      return [];
    }
    const batchMap = await this.adminBatchMap(sessions.map((session) => session.batchId));
    const teacherMap = await this.adminTeacherMap(sessions.map((session) => session.teacherId));

    return Promise.all(
      sessions.map(async (session) => {
        const batch = batchMap.get(session.batchId);
        const teacher = teacherMap.get(session.teacherId);
        const attendance = session.roomId
          ? await this.rooms.summarizeClassSessionAttendance({
              sessionId: session.id,
              batchId: session.batchId,
              roomId: session.roomId,
              ...(session.completedAt ? { completedAt: session.completedAt } : {}),
              ...this.attendancePolicy(this.persistedLiveSettings(session), session.durationMinutes)
            })
          : await this.adminAttendanceFallback(session.batchId);

        return {
          sessionId: session.id,
          batchId: session.batchId,
          batchName: batch?.name ?? 'Unknown batch',
          ...(batch?.courseId ? { courseId: batch.courseId } : {}),
          ...(batch?.courseName ? { courseName: batch.courseName } : {}),
          teacherId: session.teacherId,
          ...(teacher?.displayName ? { teacherName: teacher.displayName } : {}),
          ...(teacher?.email ? { teacherEmail: teacher.email } : {}),
          title: session.title,
          sessionNumber: session.sessionNumber,
          scheduledAt: session.scheduledAt.toISOString(),
          ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
          ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {}),
          status: session.status,
          ...(session.roomId ? { roomId: session.roomId } : {}),
          attendance
        };
      })
    );
  }

  private async adminReportSummary(filters: Record<string, unknown>): Promise<AdminClassSessionReportSummary> {
    const sessions = await this.classSessions.find(filters).exec();
    if (!sessions.length) {
      return {
        totalSessions: 0,
        liveSessions: 0,
        completedSessions: 0,
        averageAttendancePercent: 0
      };
    }
    const rows = await this.toAdminReportRows(sessions);
    const attendanceRows = rows.filter((row) => row.attendance.enrolled > 0);
    const averageAttendancePercent = attendanceRows.length
      ? Math.round(
          attendanceRows.reduce((total, row) => total + (row.attendance.present / row.attendance.enrolled) * 100, 0) /
            attendanceRows.length
        )
      : 0;
    return {
      totalSessions: sessions.length,
      liveSessions: sessions.filter((session) => session.status === 'live').length,
      completedSessions: sessions.filter((session) => session.status === 'completed').length,
      averageAttendancePercent
    };
  }

  private async adminBatchMap(batchIds: string[]): Promise<Map<string, BatchMongoDocument>> {
    const ids = [...new Set(batchIds.filter(Boolean))];
    if (!ids.length) {
      return new Map();
    }
    const batches = await this.batches.find({ _id: { $in: ids } }).exec();
    return new Map(batches.map((batch) => [batch.id, batch]));
  }

  private async adminTeacherMap(teacherIds: string[]): Promise<Map<string, UserMongoDocument>> {
    const ids = [...new Set(teacherIds.filter(Boolean))];
    if (!ids.length || !this.users) {
      return new Map();
    }
    const teachers = await this.users.find({ _id: { $in: ids }, deletedAt: { $exists: false } }).exec();
    return new Map(teachers.map((teacher) => [teacher.id, teacher]));
  }

  private async adminAttendanceFallback(batchId: string): Promise<AdminClassSessionReportRow['attendance']> {
    const roster = await this.studentEnrollments.listBatchRoster(batchId, { includeInactive: true });
    return {
      enrolled: roster.length,
      present: 0,
      absent: roster.length,
      reconnects: 0,
      averageDurationSeconds: 0
    };
  }

  private mergeSessions(
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    persistedSessions: ClassSessionMongoDocument[]
  ): Array<{ planned: PlannedClassSession; persisted?: ClassSessionMongoDocument; status: ClassSessionStatus }> {
    const persistedById = new Map(persistedSessions.map((session) => [session.id, session]));
    const plannedSessions = planClassSessions(batch, schedules).map((planned) => {
      const persisted = persistedById.get(planned.id);
      return {
        planned,
        ...(persisted ? { persisted } : {}),
        status: persisted?.status ?? 'scheduled'
      };
    });
    const plannedIds = new Set(plannedSessions.map((session) => session.planned.id));
    const orphanedPersistedSessions = persistedSessions
      .filter((session) => !plannedIds.has(session.id))
      .map((session) => ({
        planned: {
          id: session.id,
          batchId: session.batchId,
          title: session.title,
          sessionNumber: session.sessionNumber,
          scheduledAt: session.scheduledAt,
          durationMinutes: session.durationMinutes
        },
        persisted: session,
        status: session.status
      }));
    return [...plannedSessions, ...orphanedPersistedSessions].sort(
      (left, right) => left.planned.scheduledAt.getTime() - right.planned.scheduledAt.getTime()
    );
  }

  private assertCanManageBatch(batch: BatchMongoDocument, user: AuthenticatedUser): void {
    if (this.isAdmin(user)) {
      return;
    }
    if (user.roles.includes('TEACHER') && batch.teacherId === user.sub) {
      return;
    }
    throw new ForbiddenException('You are not allowed to manage this class session.');
  }

  private async assertCanReadClassSession(batch: BatchMongoDocument, user: AuthenticatedUser): Promise<void> {
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) {
      return;
    }
    if (user.roles.includes('STUDENT') && (await this.studentEnrollments.isStudentEnrolledInBatch(user.sub, batch.id))) {
      return;
    }
    throw new ForbiddenException('You are not allowed to open this class session.');
  }

  private assertBatchCanHostSession(batch: BatchMongoDocument): void {
    if (batch.status === 'CANCELLED' || batch.status === 'COMPLETED') {
      throw new BadRequestException('Sessions cannot be started for completed or cancelled batches.');
    }
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN');
  }

  private async resolvedLiveSettingsForResolution(resolution: SessionResolution): Promise<LiveClassSettings> {
    if (resolution.persisted?.liveSettings) {
      return this.completeLiveSettings(this.profiles.resolveLiveSettings(resolution.persisted.liveSettings, undefined));
    }
    return this.completeLiveSettings((await this.profiles.resolveBatchLiveSettings(resolution.batch)).resolved);
  }

  private persistedLiveSettings(session: Pick<ClassSessionMongoDocument, 'liveSettings'>): LiveClassSettings | undefined {
    return session.liveSettings ? this.completeLiveSettings(this.profiles.resolveLiveSettings(session.liveSettings, undefined)) : undefined;
  }

  private completeLiveSettings(settings: LiveClassSettings): LiveClassSettings {
    return {
      media: { ...SYSTEM_LIVE_CLASS_SETTINGS.media, ...settings.media },
      chat: { ...SYSTEM_LIVE_CLASS_SETTINGS.chat, ...settings.chat },
      whiteboard: { ...SYSTEM_LIVE_CLASS_SETTINGS.whiteboard, ...settings.whiteboard },
      speaking: { ...SYSTEM_LIVE_CLASS_SETTINGS.speaking, ...settings.speaking },
      recording: { ...SYSTEM_LIVE_CLASS_SETTINGS.recording, ...settings.recording },
      attendance: { ...SYSTEM_LIVE_CLASS_SETTINGS.attendance, ...settings.attendance },
      access: { ...SYSTEM_LIVE_CLASS_SETTINGS.access, ...settings.access },
      materials: { ...SYSTEM_LIVE_CLASS_SETTINGS.materials, ...settings.materials },
      notifications: { ...SYSTEM_LIVE_CLASS_SETTINGS.notifications, ...settings.notifications },
      questionQueue: { ...SYSTEM_LIVE_CLASS_SETTINGS.questionQueue, ...settings.questionQueue },
      recordingRetention: { ...SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention, ...settings.recordingRetention },
      studentScreenShare: { ...SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare, ...settings.studentScreenShare },
      advancedAnalytics: { ...SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics, ...settings.advancedAnalytics },
      inactiveDetection: { ...SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection, ...settings.inactiveDetection },
      bandwidthPolicy: { ...SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy, ...settings.bandwidthPolicy },
      exportControls: { ...SYSTEM_LIVE_CLASS_SETTINGS.exportControls, ...settings.exportControls }
    };
  }

  private attendancePolicy(settings: LiveClassSettings | undefined, sessionDurationMinutes: number): Partial<ClassSessionAttendanceExportRequest> {
    if (!settings) {
      return {};
    }
    return {
      sessionDurationMinutes,
      presentThresholdMinutes: settings.attendance.presentThresholdMinutes,
      presentThresholdPercentage: settings.attendance.presentThresholdPercentage,
      countReconnects: settings.attendance.countReconnects
    };
  }

  private lateJoinThresholdMs(session: Pick<ClassSessionMongoDocument, 'liveSettings'>): number {
    return (this.persistedLiveSettings(session)?.attendance.lateJoinThresholdMinutes ?? ADMIN_ATTENDANCE_LATE_JOIN_MS / 60_000) * 60_000;
  }

  private async toPayload(resolution: SessionResolution, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    const status = persisted?.status ?? 'scheduled';
    const roomId = persisted?.roomId ?? channelIds.roomId;
    const chatChannelId = persisted?.chatChannelId ?? channelIds.chatChannelId;
    const whiteboardChannelId = persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId;
    const role = this.payloadRole(user, resolution.batch);

    const resolvedLiveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    const recordingSummary = persisted && resolvedLiveSettings.recording.recordingEnabled
      ? await this.recordings.getClassSessionRecordingSummary(resolution.planned.id)
      : {};
    const canViewRecordingContent = this.canViewRecordingContent(resolvedLiveSettings, resolution.batch, user);

    return {
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      teacherId: resolution.batch.teacherId,
      title: resolution.planned.title,
      sessionNumber: resolution.planned.sessionNumber,
      scheduledAt: resolution.planned.scheduledAt.toISOString(),
      durationMinutes: resolution.planned.durationMinutes,
      status,
      roomId,
      chatChannelId,
      whiteboardChannelId,
      channels: {
        chat: chatChannelId,
        whiteboard: whiteboardChannelId
      },
      role,
      canJoin: status === 'live',
      resolvedLiveSettings,
      participants: await this.payloadParticipants(resolution.batch, user, role),
      ...(recordingSummary.active ? { activeRecording: recordingSummary.active } : {}),
      ...(canViewRecordingContent && recordingSummary.latest ? { latestRecording: recordingSummary.latest } : {}),
      ...(persisted?.startedAt ? { startedAt: persisted.startedAt.toISOString() } : {}),
      ...(persisted?.completedAt ? { completedAt: persisted.completedAt.toISOString() } : {})
    };
  }

  private canViewRecordingContent(settings: LiveClassSettings, batch: BatchMongoDocument, user: AuthenticatedUser): boolean {
    if (!settings.recording.recordingEnabled) {
      return false;
    }
    if (this.isAdmin(user)) {
      return true;
    }
    if (settings.exportControls.exportControlsEnabled && !settings.exportControls.allowRecordingDownload) {
      return false;
    }
    if (user.roles.includes('TEACHER') && batch.teacherId === user.sub) {
      return true;
    }
    if (!settings.recordingRetention.allowStudentsDownloadRecording) {
      return false;
    }
    return settings.recording.visibility === 'enrolled_students';
  }

  private assertExportWithinRetention(settings: LiveClassSettings, completedAt: Date | undefined): void {
    if (!settings.exportControls.exportControlsEnabled || !completedAt) {
      return;
    }
    const expiresAt = completedAt.getTime() + settings.exportControls.exportRetentionDays * 24 * 60 * 60 * 1000;
    if (expiresAt <= Date.now()) {
      throw new ForbiddenException('This class export is outside the configured retention window.');
    }
  }

  private async payloadParticipants(
    batch: BatchMongoDocument,
    user: AuthenticatedUser,
    role: 'teacher' | 'student' | 'admin'
  ): Promise<ClassroomParticipantPayload[]> {
    const current = this.currentParticipant(user, role);
    if (role === 'student') {
      return [current];
    }
    const roster = await this.studentEnrollments.listBatchRoster(batch.id);
    const participants = [current];
    for (const student of roster) {
      if (participants.some((participant) => participant.userId === student.userId)) {
        continue;
      }
      participants.push({
        id: student.userId,
        userId: student.userId,
        displayName: student.displayName,
        role: 'student'
      });
    }
    return participants;
  }

  private toLifecyclePayload(payload: ClassroomPayload): ClassSessionLifecycleEvent {
    if (payload.status !== 'live' && payload.status !== 'completed') {
      throw new Error(`Unsupported class session lifecycle status: ${payload.status}`);
    }
    return {
      sessionId: payload.sessionId,
      batchId: payload.batchId,
      roomId: payload.roomId,
      status: payload.status,
      ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
      ...(payload.completedAt ? { completedAt: payload.completedAt } : {})
    };
  }

  private payloadRole(user: AuthenticatedUser, batch: BatchMongoDocument): 'teacher' | 'student' | 'admin' {
    if (this.isAdmin(user)) {
      return 'admin';
    }
    if (user.roles.includes('TEACHER') && batch.teacherId === user.sub) {
      return 'teacher';
    }
    return 'student';
  }

  private currentParticipant(user: AuthenticatedUser, role: 'teacher' | 'student' | 'admin'): ClassroomParticipantPayload {
    return {
      id: user.sub,
      userId: user.sub,
      displayName: user.email?.split('@')[0] || (role === 'student' ? 'Student' : 'Teacher'),
      role
    };
  }

  private joinBlockedMessage(status: ClassSessionStatus): string {
    if (status === 'completed') {
      return 'This class session has ended.';
    }
    if (status === 'cancelled') {
      return 'This class session was cancelled.';
    }
    return 'The teacher has not started this class session yet.';
  }

  private requireLivePersistedSession(resolution: SessionResolution): ClassSessionMongoDocument {
    if (resolution.persisted?.status === 'live' && resolution.persisted.roomId) {
      return resolution.persisted;
    }
    throw new ConflictException('Materials can only be shared while the class is live.');
  }

  private assertMaterialsEnabled(settings: LiveClassSettings): void {
    if (!settings.materials.materialsEnabled) {
      throw new ForbiddenException('Class materials are disabled for this class.');
    }
  }

  private assertCanManageMaterials(settings: LiveClassSettings): void {
    this.assertMaterialsEnabled(settings);
    if (!settings.materials.teacherCanUploadMaterials) {
      throw new ForbiddenException('Material uploads are disabled for this class.');
    }
  }

  private assertMaterialKindAllowed(kind: ClassSessionMaterialKind, settings: LiveClassSettings): void {
    if (!settings.materials.allowedMaterialTypes.includes(kind)) {
      throw new BadRequestException('This material type is disabled for this class.');
    }
  }

  private canAccessMaterial(
    material: ClassSessionMaterialMongoDocument,
    resolution: SessionResolution,
    role: 'teacher' | 'student' | 'admin',
    settings: LiveClassSettings
  ): boolean {
    if (role === 'teacher' || role === 'admin') {
      return true;
    }
    const status = resolution.persisted?.status ?? 'scheduled';
    if (status === 'live') {
      return Boolean(material.shared || settings.materials.publishMaterialsBeforeClass);
    }
    if (status === 'completed' || status === 'cancelled') {
      return settings.materials.publishMaterialsAfterClass;
    }
    return settings.materials.publishMaterialsBeforeClass;
  }

  private normalizeWhiteboardSnapshot(snapshot: WhiteboardMemorySnapshot): WhiteboardMemorySnapshot {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== WHITEBOARD_MEMORY_SCHEMA_VERSION || !Array.isArray(snapshot.pages)) {
      throw new BadRequestException('Whiteboard snapshot is invalid.');
    }
    if (!snapshot.pages.length) {
      throw new BadRequestException('Whiteboard snapshot must include at least one page.');
    }
    if (snapshot.pages.length > WHITEBOARD_MEMORY_MAX_PAGES) {
      throw new BadRequestException(`Whiteboard snapshot cannot exceed ${WHITEBOARD_MEMORY_MAX_PAGES} pages.`);
    }
    const normalizedPages: WhiteboardMemoryPage[] = snapshot.pages.map((page, index) => this.normalizeWhiteboardPage(page, index));
    const activePageId =
      typeof snapshot.activePageId === 'string' && normalizedPages.some((page) => page.id === snapshot.activePageId)
        ? snapshot.activePageId
        : normalizedPages[0]!.id;
    const normalized: WhiteboardMemorySnapshot = {
      schemaVersion: WHITEBOARD_MEMORY_SCHEMA_VERSION,
      activePageId,
      pages: normalizedPages
    };
    const summary = this.whiteboardSnapshotSummary(normalized);
    if (summary.elementCount > WHITEBOARD_MEMORY_MAX_ELEMENTS) {
      throw new BadRequestException(`Whiteboard snapshot cannot exceed ${WHITEBOARD_MEMORY_MAX_ELEMENTS} elements.`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    if (bytes > WHITEBOARD_MEMORY_MAX_BYTES) {
      throw new BadRequestException('Whiteboard snapshot is too large.');
    }
    return normalized;
  }

  private normalizeWhiteboardPage(page: WhiteboardMemoryPage, index: number): WhiteboardMemoryPage {
    if (!page || typeof page !== 'object') {
      throw new BadRequestException('Whiteboard page is invalid.');
    }
    const id = this.cleanWhiteboardText(page.id, 128);
    if (!id) {
      throw new BadRequestException('Whiteboard page id is required.');
    }
    if (!Array.isArray(page.elements)) {
      throw new BadRequestException('Whiteboard page elements are invalid.');
    }
    const elements = page.elements.map((element) => this.normalizeWhiteboardElement(element));
    return {
      id,
      title: this.cleanWhiteboardText(page.title, 180) || `Board ${index + 1}`,
      tags: this.normalizeWhiteboardTags(page.tags),
      order: Number.isFinite(Number(page.order)) ? Math.max(0, Math.floor(Number(page.order))) : index,
      ...(typeof page.template === 'string' ? { template: this.cleanWhiteboardText(page.template, 64) } : {}),
      ...(this.isPlainRecord(page.view) ? { view: this.safeWhiteboardPayload(page.view) } : {}),
      ...(page.background === null
        ? { background: null }
        : this.isPlainRecord(page.background)
          ? { background: this.safeWhiteboardPayload(page.background) }
          : {}),
      elements
    };
  }

  private normalizeWhiteboardElement(element: Record<string, unknown>): Record<string, unknown> {
    if (!this.isPlainRecord(element)) {
      throw new BadRequestException('Whiteboard element is invalid.');
    }
    if (typeof element.id !== 'string' || typeof element.type !== 'string' || !element.id.trim() || !element.type.trim()) {
      throw new BadRequestException('Whiteboard element id and type are required.');
    }
    return this.safeWhiteboardPayload(element);
  }

  private normalizeWhiteboardTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) {
      return [];
    }
    return [
      ...new Set(
        tags
          .map((tag) => (typeof tag === 'string' ? this.cleanWhiteboardText(tag, 40).toLowerCase() : ''))
          .filter(Boolean)
      )
    ].slice(0, 12);
  }

  private whiteboardSnapshotSummary(snapshot: WhiteboardMemorySnapshot): WhiteboardMemorySummary {
    const pages = snapshot.pages
      .map((page, index) => ({
        pageId: page.id,
        title: page.title,
        tags: page.tags,
        order: Number.isFinite(page.order) ? page.order : index,
        elementCount: page.elements.length
      }))
      .sort((left, right) => left.order - right.order);
    return {
      pageCount: pages.length,
      elementCount: pages.reduce((total, page) => total + page.elementCount, 0),
      pages
    };
  }

  private whiteboardDocumentSummary(
    doc: Pick<ClassSessionWhiteboardStateMongoDocument | ClassSessionWhiteboardVersionMongoDocument, 'pageCount' | 'elementCount' | 'pages'>
  ): WhiteboardMemorySummary {
    const pages = doc.pages
      .map((page) => ({
        pageId: page.pageId,
        title: page.title,
        tags: page.tags ?? [],
        order: page.order,
        elementCount: page.elementCount
      }))
      .sort((left, right) => left.order - right.order);
    return {
      pageCount: doc.pageCount ?? pages.length,
      elementCount: doc.elementCount ?? pages.reduce((total, page) => total + page.elementCount, 0),
      pages
    };
  }

  private async createWhiteboardVersion(
    resolution: SessionResolution,
    snapshot: WhiteboardMemorySnapshot,
    summary: WhiteboardMemorySummary,
    snapshotVersion: number,
    reason: WhiteboardMemorySaveReason,
    createdByUserId: string,
    roomId: string
  ): Promise<ClassSessionWhiteboardVersionMongoDocument> {
    const channelIds = classSessionChannelIds(resolution.planned.id);
    return this.whiteboardVersions.create({
      versionId: randomUUID(),
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId,
      whiteboardChannelId: resolution.persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId,
      reason,
      schemaVersion: WHITEBOARD_MEMORY_SCHEMA_VERSION,
      snapshotVersion,
      snapshot: snapshot as unknown as Record<string, unknown>,
      pages: summary.pages.map((page) => ({
        pageId: page.pageId,
        title: page.title,
        tags: page.tags,
        order: page.order,
        elementCount: page.elementCount
      })),
      pageCount: summary.pageCount,
      elementCount: summary.elementCount,
      createdByUserId
    });
  }

  private async trimWhiteboardVersions(sessionId: string): Promise<void> {
    const excess = await this.whiteboardVersions
      .find({ sessionId })
      .sort({ createdAt: -1 })
      .skip(WHITEBOARD_MEMORY_MAX_VERSIONS)
      .select({ versionId: 1 })
      .lean()
      .exec();
    const versionIds = excess.map((version) => version.versionId).filter(Boolean);
    if (versionIds.length) {
      await this.whiteboardVersions.deleteMany({ versionId: { $in: versionIds } });
    }
  }

  private toWhiteboardMemoryState(state: ClassSessionWhiteboardStateMongoDocument): WhiteboardMemoryState {
    return {
      sessionId: state.sessionId,
      batchId: state.batchId,
      ...(state.roomId ? { roomId: state.roomId } : {}),
      whiteboardChannelId: state.whiteboardChannelId,
      schemaVersion: WHITEBOARD_MEMORY_SCHEMA_VERSION,
      snapshotVersion: state.snapshotVersion,
      snapshot: state.currentSnapshot as unknown as WhiteboardMemorySnapshot,
      summary: this.whiteboardDocumentSummary(state),
      ...(state.latestVersionId ? { latestVersionId: state.latestVersionId } : {}),
      ...(state.createdByUserId ? { createdByUserId: state.createdByUserId } : {}),
      ...(state.updatedByUserId ? { updatedByUserId: state.updatedByUserId } : {}),
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString()
    };
  }

  private toWhiteboardMemoryVersion(version: ClassSessionWhiteboardVersionMongoDocument): WhiteboardMemoryVersion {
    return {
      versionId: version.versionId,
      sessionId: version.sessionId,
      batchId: version.batchId,
      createdAt: version.createdAt.toISOString(),
      ...(version.createdByUserId ? { createdByUserId: version.createdByUserId } : {}),
      reason: this.normalizeWhiteboardSaveReason(version.reason),
      snapshotVersion: version.snapshotVersion,
      summary: this.whiteboardDocumentSummary(version)
    };
  }

  private normalizeWhiteboardSaveReason(reason: string): WhiteboardMemorySaveReason {
    if (reason === 'manual-save' || reason === 'export' || reason === 'restore' || reason === 'session-end') {
      return reason;
    }
    return 'autosave';
  }

  private cleanWhiteboardText(value: string, maxLength: number): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  private safeWhiteboardPayload<T extends Record<string, unknown>>(value: T): T {
    return this.scrubWhiteboardPayload(JSON.parse(JSON.stringify(value))) as T;
  }

  private scrubWhiteboardPayload(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.scrubWhiteboardPayload(item));
    }
    if (!this.isPlainRecord(value)) {
      return value;
    }
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'string' && key.toLowerCase().includes('url') && /x-amz-signature|signature=|token=/i.test(raw)) {
        continue;
      }
      next[key] = this.scrubWhiteboardPayload(raw);
    }
    return next;
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private async recordWhiteboardMemoryAudit(
    action: 'save' | 'restore',
    resolution: SessionResolution,
    user: AuthenticatedUser,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.auditLogs?.record({
      actor: user,
      action: `class_sessions.whiteboard_memory.${action}`,
      resourceType: 'class_session',
      resourceId: resolution.planned.id,
      resourceLabel: resolution.planned.title,
      metadata: {
        summary: `${action} class-session whiteboard memory`,
        batchId: resolution.batch.id,
        roomId: resolution.persisted?.roomId,
        ...metadata
      }
    });
  }

  private async emitMaterialEvent(
    event: 'material:shared' | 'material:unshared' | 'material:updated',
    resolution: SessionResolution,
    material: ClassSessionMaterialMongoDocument,
    user: AuthenticatedUser,
    shared: boolean
  ): Promise<void> {
    const roomId = resolution.persisted?.roomId ?? material.roomId;
    if (!roomId) {
      return;
    }
    const payload: ClassSessionMaterialEvent = {
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId,
      materialId: material.materialId,
      material: this.toMaterialPayload(material),
      shared,
      actorUserId: user.sub,
      createdAt: new Date().toISOString()
    };
    this.rooms.emitClassSessionMaterialEvent(event, payload);
  }

  private toMaterialPayload(material: ClassSessionMaterialMongoDocument): ClassSessionMaterial {
    return {
      id: material.materialId,
      materialId: material.materialId,
      sessionId: material.sessionId,
      batchId: material.batchId,
      ...(material.roomId ? { roomId: material.roomId } : {}),
      title: material.title,
      ...(material.description ? { description: material.description } : {}),
      kind: material.kind,
      source: material.source,
      ...(material.fileName ? { fileName: material.fileName } : {}),
      ...(material.mimeType ? { mimeType: material.mimeType } : {}),
      ...(typeof material.size === 'number' ? { size: material.size } : {}),
      ...(material.storageProvider ? { storageProvider: material.storageProvider } : {}),
      ...(material.source === 'upload' ? { downloadUrl: this.classSessionMaterialDownloadUrl(material.sessionId, material.materialId) } : {}),
      ...(material.url ? { url: material.url } : {}),
      shared: Boolean(material.shared),
      ...(material.sharedAt ? { sharedAt: this.dateToIso(material.sharedAt) } : {}),
      ...(material.sharedByUserId ? { sharedByUserId: material.sharedByUserId } : {}),
      uploadedByUserId: material.uploadedByUserId,
      createdAt: this.dateToIso(material.createdAt),
      updatedAt: this.dateToIso(material.updatedAt),
      ...(material.deletedAt ? { deletedAt: this.dateToIso(material.deletedAt) } : {})
    };
  }

  private normalizeMaterialMimeType(value: string | undefined): string {
    const mimeType = (value ?? '').split(';')[0]?.trim().toLowerCase();
    if (!mimeType || !CLASS_MATERIAL_ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException('Unsupported class material file type.');
    }
    return mimeType;
  }

  private materialKindForMimeType(mimeType: string): Exclude<ClassSessionMaterialKind, 'link'> {
    if (mimeType === 'application/pdf') {
      return 'pdf';
    }
    if (mimeType.startsWith('image/')) {
      return 'image';
    }
    if (mimeType.includes('word')) {
      return 'document';
    }
    if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) {
      return 'slides';
    }
    return 'file';
  }

  private safeMaterialFileName(value: string | undefined, kind: ClassSessionMaterialKind): string {
    const fallback = kind === 'pdf' ? 'material.pdf' : 'material';
    const cleaned = this.cleanMaterialText(value ?? fallback, 180)
      .replace(/[\\/]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+/, '')
      .trim();
    return cleaned || fallback;
  }

  private titleFromFileName(fileName: string): string {
    const withoutExtension = fileName.replace(/\.[a-z0-9]{1,8}$/i, '');
    return this.cleanMaterialText(withoutExtension.replace(/[_-]+/g, ' '), 180) || fileName;
  }

  private normalizeMaterialUrl(value: string | undefined): string {
    const raw = value?.trim();
    if (!raw) {
      throw new BadRequestException('Material URL is required.');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BadRequestException('Material URL is invalid.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException('Material URL must use http or https.');
    }
    return parsed.toString();
  }

  private cleanMaterialText(value: string | undefined, maxLength: number): string {
    return (value ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  private safeStorageSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'class-session';
  }

  private classMaterialStorageRoot(): string {
    return this.config.get<string>('classMaterials.localPath', './class-materials');
  }

  private classMaterialMaxFileSizeBytes(settings?: LiveClassSettings): number {
    const configured = this.config.get<number>('classMaterials.maxFileSizeBytes', 10 * 1024 * 1024);
    const policy = settings ? settings.materials.maxMaterialFileSizeMb * 1024 * 1024 : configured;
    return Math.min(100 * 1024 * 1024, policy);
  }

  private classSessionMaterialDownloadUrl(sessionId: string, materialId: string): string {
    return `/api/v1/class-sessions/${encodeURIComponent(sessionId)}/materials/${encodeURIComponent(materialId)}/download`;
  }

  private dateToIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
  }

  private async closeNewlyCreatedStartRoom(roomId: string, resolution: SessionResolution, user: AuthenticatedUser): Promise<void> {
    if (resolution.persisted?.roomId === roomId) {
      return;
    }
    await this.rooms
      .closeClassSessionRoom({
        roomId,
        actorUserId: user.sub,
        actorLabel: user.email ?? 'Class session start rollback'
      })
      .catch(() => undefined);
  }
}
