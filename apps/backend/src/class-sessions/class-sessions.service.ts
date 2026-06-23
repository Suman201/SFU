import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type {
  AdminAttendanceQuery,
  AdminAttendanceSessionRow,
  AdminAttendanceSessionsResponse,
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
  ClassSessionLifecycleEvent,
  Recording
} from '@native-sfu/contracts';
import { Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ClassSessionStatus,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { RecordingsService, type RecordingDownload } from '../recordings/recordings.service';
import {
  RoomsService,
  type ClassSessionAttendanceRow,
  type ClassSessionChatAttachmentDownload,
  type ClassSessionChatAttachmentUploadFile
} from '../rooms/rooms.service';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';
import { classSessionChannelIds, PlannedClassSession, planClassSessions } from './class-session-planner';

const ADMIN_CLASS_SESSION_STATUSES = new Set<ClassSessionStatus>(['scheduled', 'live', 'completed', 'cancelled']);
const ADMIN_ATTENDANCE_DEFAULT_RANGE_DAYS = 90;
const ADMIN_ATTENDANCE_MAX_RANGE_DAYS = 370;
const ADMIN_ATTENDANCE_LATE_JOIN_MS = 10 * 60 * 1000;
const ADMIN_ATTENDANCE_EARLY_LEAVE_MS = 10 * 60 * 1000;

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
}

interface SessionResolution {
  batch: BatchMongoDocument;
  schedules: BatchScheduleMongoDocument[];
  planned: PlannedClassSession;
  persisted?: ClassSessionMongoDocument;
}

@Injectable()
export class ClassSessionsService {
  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    private readonly studentEnrollments: StudentEnrollmentsService,
    private readonly rooms: RoomsService,
    private readonly recordings: RecordingsService,
    @Optional() @InjectModel(UserDocument.name) private readonly users?: Model<UserMongoDocument>
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
        'Early Leaves'
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
        String(row.earlyLeaves)
      ])
    ];
    return `${csvRows.map((row) => row.map((value) => this.csvEscape(value)).join(',')).join('\n')}\n`;
  }

  async startSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    this.assertBatchCanHostSession(resolution.batch);

    if (resolution.persisted?.status === 'completed' || resolution.persisted?.status === 'cancelled') {
      throw new BadRequestException('Completed or cancelled sessions cannot be started.');
    }

    if (resolution.persisted?.status === 'live') {
      const room = await this.rooms.ensureClassSessionRoom({
        sessionId,
        batchId: resolution.batch.id,
        title: resolution.planned.title,
        teacherId: resolution.batch.teacherId
      });
      if (resolution.persisted.roomId === room.id) {
        return this.toPayload(resolution, user);
      }
      const persisted = await this.classSessions.findByIdAndUpdate(sessionId, { $set: { roomId: room.id } }, { new: true });
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
    const room = await this.rooms.ensureClassSessionRoom({
      sessionId,
      batchId: resolution.batch.id,
      title: resolution.planned.title,
      teacherId: resolution.batch.teacherId
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
      if (this.isDuplicateKeyError(error)) {
        await this.closeNewlyCreatedStartRoom(room.id, resolution, user);
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

    const payload = await this.toPayload({ ...resolution, persisted }, user);
    this.rooms.emitClassSessionLifecycleEvent('session:started', this.toLifecyclePayload(payload));
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
    let closeError: unknown;
    await this.recordings
      .stopActiveClassSessionRecording({
        sessionId,
        actorUserId: user.sub,
        actorLabel: user.email,
        reason: 'session_ended'
      })
      .catch(() => undefined);
    if (updated.roomId) {
      try {
        await this.rooms.closeClassSessionRoom({
          roomId: updated.roomId,
          actorUserId: user.sub,
          actorLabel: user.email
        });
      } catch (error) {
        closeError = error;
      }
    }
    this.rooms.emitClassSessionLifecycleEvent('session:ended', this.toLifecyclePayload(payload));
    if (closeError) {
      throw closeError;
    }
    return payload;
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
    return this.recordings.startClassSessionRecording({
      session: persisted,
      batch: resolution.batch,
      actor: user
    });
  }

  async stopRecording(sessionId: string, user: AuthenticatedUser): Promise<Recording> {
    return this.recordings.stopClassSessionRecording(sessionId, undefined, user);
  }

  async listRecordings(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<Recording[]> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
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
    return this.recordings.readClassSessionRecordingDownload(resolution.planned.id, recordingId, user);
  }

  async joinSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);

    if (resolution.persisted?.status !== 'live') {
      throw new ConflictException(this.joinBlockedMessage(resolution.persisted?.status ?? 'scheduled'));
    }
    if (resolution.persisted.roomId) {
      await this.rooms.assertClassSessionRoomJoinAllowed(resolution.persisted.roomId, resolution.batch.teacherId, {
        id: user.sub,
        roles: user.roles
      });
    }

    return this.toPayload(resolution, user);
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
    return this.rooms.markClassSessionChatRead({
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
  }

  async exportAttendanceCsv(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<string> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    if (!resolution.persisted?.roomId) {
      throw new BadRequestException('Attendance is available after a session has started.');
    }
    return this.rooms.exportClassSessionAttendanceCsv({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: resolution.persisted.roomId,
      ...(resolution.persisted.completedAt ? { completedAt: resolution.persisted.completedAt } : {})
    });
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
        const attendanceRows = await this.adminAttendanceRowsForSession(session);
        const presentRows = attendanceRows.filter((row) => row.status === 'present');
        const enrolled = attendanceRows.length;
        const present = presentRows.length;
        const lateJoins = presentRows.filter(
          (row) => row.firstJoinAt && row.firstJoinAt.getTime() > session.scheduledAt.getTime() + ADMIN_ATTENDANCE_LATE_JOIN_MS
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
          earlyLeaves
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
      const attendanceRows = await this.adminAttendanceRowsForSession(session);
      for (const attendance of attendanceRows) {
        const key = `${session.batchId}:${attendance.studentId}`;
        const existing = rows.get(key) ?? {
          studentId: attendance.studentId,
          studentName: attendance.displayName,
          ...(attendance.email ? { studentEmail: attendance.email } : {}),
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
          totalDurationSeconds: 0,
          attendedDurationRows: 0
        };
        existing.sessionsEnrolled += 1;
        if (attendance.status === 'present') {
          existing.sessionsAttended += 1;
          existing.totalDurationSeconds += attendance.totalDurationSeconds;
          existing.attendedDurationRows += 1;
          existing.reconnects += attendance.reconnectCount;
          if (attendance.firstJoinAt && (!existing.lastAttendedAt || attendance.firstJoinAt.toISOString() > existing.lastAttendedAt)) {
            existing.lastAttendedAt = attendance.firstJoinAt.toISOString();
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

  private async adminAttendanceRowsForSession(session: ClassSessionMongoDocument): Promise<ClassSessionAttendanceRow[]> {
    if (session.roomId) {
      return this.rooms.classSessionAttendanceRows({
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        ...(session.completedAt ? { completedAt: session.completedAt } : {})
      });
    }
    const roster = await this.studentEnrollments.listBatchRoster(session.batchId, { includeInactive: true });
    return roster.map((student) => ({
      studentId: student.userId,
      displayName: student.displayName,
      email: student.email,
      totalDurationSeconds: 0,
      reconnectCount: 0,
      status: 'absent'
    }));
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
              ...(session.completedAt ? { completedAt: session.completedAt } : {})
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

  private async toPayload(resolution: SessionResolution, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    const status = persisted?.status ?? 'scheduled';
    const roomId = persisted?.roomId ?? channelIds.roomId;
    const chatChannelId = persisted?.chatChannelId ?? channelIds.chatChannelId;
    const whiteboardChannelId = persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId;
    const role = this.payloadRole(user, resolution.batch);

    const recordingSummary = persisted ? await this.recordings.getClassSessionRecordingSummary(resolution.planned.id) : {};

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
      participants: await this.payloadParticipants(resolution.batch, user, role),
      ...(recordingSummary.active ? { activeRecording: recordingSummary.active } : {}),
      ...(recordingSummary.latest ? { latestRecording: recordingSummary.latest } : {}),
      ...(persisted?.startedAt ? { startedAt: persisted.startedAt.toISOString() } : {}),
      ...(persisted?.completedAt ? { completedAt: persisted.completedAt.toISOString() } : {})
    };
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
