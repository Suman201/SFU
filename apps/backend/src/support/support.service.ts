import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type {
  CreateSupportRequestRequest,
  SupportIssueType,
  SupportRequest,
  SupportRequestDiagnostics,
  SupportRequestListQuery,
  SupportRequestListResponse,
  SupportRequestStatus,
  UpdateSupportRequestRequest
} from '@native-sfu/contracts';
import { FilterQuery, Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ClassSessionActivityService } from '../class-session-activity/class-session-activity.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  RecordingDocument,
  RecordingMongoDocument,
  RoomDocument,
  RoomMongoDocument,
  SupportRequestDocument,
  SupportRequestMongoDocument,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { MetricsService } from '../metrics/metrics.service';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';

const SUPPORT_ISSUE_TYPES: SupportIssueType[] = [
  'access',
  'class_issue',
  'recording_access',
  'recording_problem',
  'audio_video',
  'assignment',
  'other'
];
const SUPPORT_STATUSES: SupportRequestStatus[] = ['open', 'in_review', 'waiting_for_student', 'resolved', 'closed'];
const PERMISSION_STATES = new Set(['granted', 'denied', 'prompt', 'unknown']);

interface SupportContextResolution {
  batch?: BatchMongoDocument;
  session?: ClassSessionMongoDocument;
  recording?: RecordingMongoDocument;
  batchId?: string;
  batchName?: string;
  teacherId?: string;
  sessionId?: string;
  sessionTitle?: string;
  roomId?: string;
  recordingId?: string;
}

@Injectable()
export class SupportService {
  constructor(
    @InjectModel(SupportRequestDocument.name) private readonly supportRequests: Model<SupportRequestMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(RecordingDocument.name) private readonly recordings: Model<RecordingMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly enrollments: StudentEnrollmentsService,
    @Optional() private readonly activity?: ClassSessionActivityService,
    @Optional() private readonly auditLogs?: AuditLogsService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @InjectModel(RoomDocument.name) private readonly rooms?: Model<RoomMongoDocument>
  ) {}

  async createStudentRequest(user: AuthenticatedUser, request: CreateSupportRequestRequest): Promise<SupportRequest> {
    this.assertStudent(user);
    const context = await this.resolveStudentContext(user, request);
    const profile = await this.userProfile(user.sub);
    const doc = await this.supportRequests.create({
      studentId: user.sub,
      studentName: profile.name,
      studentEmail: profile.email,
      ...this.persistedContext(context),
      issueType: this.issueType(request.issueType),
      status: 'open',
      subject: this.requiredText(request.subject, 'Subject', 180),
      message: this.requiredText(request.message, 'Message', 5000),
      diagnostics: await this.supportDiagnostics(request.diagnostics, context),
      comments: []
    });
    await this.recordCreated(doc, user);
    return this.toSupportRequest(doc, 'student');
  }

  async listStudentRequests(user: AuthenticatedUser, query: SupportRequestListQuery = {}): Promise<SupportRequestListResponse> {
    this.assertStudent(user);
    return this.listRequests({ ...query, studentId: user.sub }, 'student', { requesterRole: { $ne: 'teacher' } });
  }

  async getStudentRequest(user: AuthenticatedUser, requestId: string): Promise<SupportRequest> {
    this.assertStudent(user);
    const doc = await this.findByRequestId(requestId);
    if (doc.studentId !== user.sub || doc.requesterRole === 'teacher') {
      throw new ForbiddenException('You are not allowed to view this support request.');
    }
    return this.toSupportRequest(doc, 'student');
  }

  async createTeacherRequest(user: AuthenticatedUser, request: CreateSupportRequestRequest): Promise<SupportRequest> {
    this.assertTeacher(user);
    const context = await this.resolveStudentContext(user, request, true);
    const profile = await this.userProfile(user.sub);
    const doc = await this.supportRequests.create({ requesterRole: 'teacher', studentId: user.sub, studentName: profile.name, studentEmail: profile.email, ...this.persistedContext(context), issueType: this.issueType(request.issueType), status: 'open', subject: this.requiredText(request.subject, 'Subject', 180), message: this.requiredText(request.message, 'Message', 5000), diagnostics: await this.supportDiagnostics(request.diagnostics, context), comments: [] });
    await this.recordCreated(doc, user); return this.toSupportRequest(doc, 'teacher');
  }

  async listTeacherRequests(user: AuthenticatedUser, query: SupportRequestListQuery, view: 'mine' | 'class'): Promise<SupportRequestListResponse> {
    this.assertTeacher(user);
    if (view === 'mine') return this.listRequests({ ...query, studentId: user.sub }, 'teacher', { requesterRole: 'teacher' });
    const batches = await this.batches.find({ teacherId: user.sub, deletedAt: { $exists: false } }).select('_id').lean();
    return this.listRequests(query, 'teacher_related', { $and: [{ batchId: { $in: batches.map(batch => String(batch._id)) } }, { requesterRole: { $ne: 'teacher' } }] });
  }

  async getTeacherRequest(user: AuthenticatedUser, requestId: string): Promise<SupportRequest> {
    const { doc, mine } = await this.teacherRequest(user, requestId);
    return this.toSupportRequest(doc, mine ? 'teacher' : 'teacher_related');
  }

  async replyTeacherRequest(user: AuthenticatedUser, requestId: string, input: { message?: string; status?: SupportRequestStatus; expectedUpdatedAt: string }): Promise<SupportRequest> {
    const { doc, mine } = await this.teacherRequest(user, requestId);
    if (mine && input.status) throw new ForbiddenException('Support staff manage the status of your platform requests.');
    if (input.status && !['in_review', 'waiting_for_student', 'resolved'].includes(input.status)) throw new BadRequestException('Choose a supported class-request status.');
    return this.appendReply(user, doc, input, mine ? 'teacher' : 'teacher_related');
  }

  async replyStudentRequest(user: AuthenticatedUser, requestId: string, input: { message: string; expectedUpdatedAt: string }): Promise<SupportRequest> {
    this.assertStudent(user); const doc = await this.findByRequestId(requestId);
    if (doc.studentId !== user.sub || doc.requesterRole === 'teacher') throw new NotFoundException('Support request not found.');
    return this.appendReply(user, doc, input, 'student');
  }

  private assertTeacher(user: AuthenticatedUser): void { if (!user.roles.includes('TEACHER')) throw new ForbiddenException('Teacher access required.'); }
  private async teacherRequest(user: AuthenticatedUser, requestId: string) {
    this.assertTeacher(user); const doc = await this.findByRequestId(requestId), mine = doc.requesterRole === 'teacher' && doc.studentId === user.sub;
    if (!mine) {
      if (doc.requesterRole === 'teacher' || !doc.batchId || !await this.batches.exists({ _id: doc.batchId, teacherId: user.sub, deletedAt: { $exists: false } })) throw new NotFoundException('Support request not found.');
    }
    return { doc, mine };
  }
  private async appendReply(user: AuthenticatedUser, doc: SupportRequestMongoDocument, input: { message?: string; status?: SupportRequestStatus; expectedUpdatedAt: string }, audience: 'student' | 'teacher' | 'teacher_related'): Promise<SupportRequest> {
    const message = input.message === undefined ? undefined : this.requiredText(input.message, 'Reply', 5000);
    if (!message && !input.status) throw new BadRequestException('Add a reply or choose a status.');
    const timestamp = new Date(input.expectedUpdatedAt); if (!Number.isFinite(timestamp.getTime())) throw new BadRequestException('Reload the support conversation before replying.');
    const now = new Date(Math.max(Date.now(), (doc.updatedAt?.getTime() ?? 0) + 1));
    const updated = await this.supportRequests.findOneAndUpdate({ _id: doc.id, deletedAt: { $exists: false }, status: { $ne: 'closed' }, updatedAt: timestamp }, {
      ...(message ? { $push: { comments: { commentId: randomUUID(), authorId: user.sub, authorName: await this.actorName(user), authorRoles: user.roles, message, visibleToStudent: true, createdAt: now } } } : {}),
      $set: { updatedAt: now, ...(input.status ? { status: input.status, ...(input.status === 'resolved' ? { resolvedAt: now } : {}) } : {}) },
    }, { new: true, timestamps: false });
    if (!updated) throw new ConflictException('The conversation changed or was closed. Reload it before replying.');
    await this.auditLogs?.record({ actor: user, action: 'support.request.reply', resourceType: 'support_request', resourceId: doc.requestId, metadata: { status: updated.status, requesterRole: doc.requesterRole ?? 'student' } });
    return this.toSupportRequest(updated, audience);
  }

  async listAdminRequests(user: AuthenticatedUser, query: SupportRequestListQuery = {}): Promise<SupportRequestListResponse> {
    this.assertAdmin(user);
    return this.listRequests(query, 'admin');
  }

  async getAdminRequest(user: AuthenticatedUser, requestId: string): Promise<SupportRequest> {
    this.assertAdmin(user);
    return this.toSupportRequest(await this.findByRequestId(requestId), 'admin');
  }

  async updateAdminRequest(user: AuthenticatedUser, requestId: string, request: UpdateSupportRequestRequest): Promise<SupportRequest> {
    this.assertAdmin(user);
    const doc = await this.findByRequestId(requestId);
    const now = new Date();
    const beforeStatus = doc.status;
    if (request.status !== undefined) {
      doc.status = this.status(request.status);
      if (doc.status === 'resolved') {
        doc.resolvedAt = doc.resolvedAt ?? now;
      }
      if (doc.status === 'closed') {
        doc.closedAt = doc.closedAt ?? now;
      }
    }
    if (request.assignedToUserId !== undefined) {
      doc.assignedToUserId = this.optionalText(request.assignedToUserId, 120);
    }
    if (request.assignedToName !== undefined) {
      doc.assignedToName = this.optionalText(request.assignedToName, 160);
    }
    const response = this.optionalText(request.response, 5000);
    if (response) {
      doc.comments.push({
        commentId: randomUUID(),
        authorId: user.sub,
        authorName: await this.actorName(user),
        authorRoles: user.roles,
        message: response,
        visibleToStudent: true,
        createdAt: now
      });
    }
    const internalNote = this.optionalText(request.internalNote, 5000);
    if (internalNote) {
      doc.comments.push({
        commentId: randomUUID(),
        authorId: user.sub,
        authorName: await this.actorName(user),
        authorRoles: user.roles,
        message: internalNote,
        visibleToStudent: false,
        createdAt: now
      });
    }
    const updatedAt = new Date(Math.max(Date.now(), (doc.updatedAt?.getTime() ?? 0) + 1));
    const fields: Record<string, unknown> = { status: doc.status, comments: doc.comments, updatedAt };
    const unset: Record<string, 1> = {};
    for (const key of ['assignedToUserId', 'assignedToName', 'resolvedAt', 'closedAt'] as const) {
      if (doc[key] === undefined) unset[key] = 1;
      else fields[key] = doc[key];
    }
    const changed = await this.supportRequests.updateOne({ _id: doc.id, updatedAt: doc.updatedAt }, { $set: fields, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { timestamps: false });
    if (changed.modifiedCount !== 1) throw new ConflictException('The conversation changed. Reload before saving a staff reply.');
    doc.updatedAt = updatedAt;
    if (beforeStatus !== doc.status) {
      this.metrics?.classSessionSupportRequests.labels('status_changed', doc.status, doc.issueType).inc();
    }
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.support.update',
      resourceType: 'support_request',
      resourceId: doc.requestId,
      targetUserId: doc.studentId,
      metadata: {
        status: doc.status,
        previousStatus: beforeStatus,
        issueType: doc.issueType,
        batchId: doc.batchId,
        sessionId: doc.sessionId,
        recordingId: doc.recordingId
      }
    });
    return this.toSupportRequest(doc, 'admin');
  }

  private async listRequests(query: SupportRequestListQuery, audience: 'student' | 'admin' | 'teacher' | 'teacher_related', scope: FilterQuery<SupportRequestMongoDocument> = {}): Promise<SupportRequestListResponse> {
    const page = this.clamp(query.page, 1, 10000, 1);
    const limit = this.clamp(query.limit, 1, 100, 25);
    const filter = { ...this.requestFilter(query, audience !== 'teacher_related'), ...scope };
    const [items, total, summary] = await Promise.all([
      this.supportRequests
        .find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.supportRequests.countDocuments(filter).exec(),
      this.summary(filter)
    ]);
    return {
      items: items.map((item) => this.toSupportRequest(item, audience)),
      page,
      limit,
      total,
      summary
    };
  }

  private async resolveStudentContext(user: AuthenticatedUser, request: CreateSupportRequestRequest, teacher = false): Promise<SupportContextResolution> {
    let session = request.sessionId ? await this.findSession(request.sessionId) : undefined;
    const recording = request.recordingId ? await this.findRecording(request.recordingId) : undefined;
    if (!session && recording?.sessionId) session = await this.findSession(recording.sessionId);
    const batchId = request.batchId ?? session?.batchId ?? recording?.batchId;
    if ((session || recording) && !batchId) throw new ForbiddenException('This support context is not available.');
    const batch = batchId ? await this.findBatch(batchId) : undefined;
    if (request.roomId && request.roomId !== (session?.roomId ?? recording?.roomId)) throw new BadRequestException('Choose the class session associated with this room.');

    if (session && batch && session.batchId !== batch.id) {
      throw new BadRequestException('Support request session does not belong to the selected batch.');
    }
    if (recording && batch && recording.batchId && recording.batchId !== batch.id) {
      throw new BadRequestException('Support request recording does not belong to the selected batch.');
    }
    if (recording && session && recording.sessionId && recording.sessionId !== session.id) {
      throw new BadRequestException('Support request recording does not belong to the selected session.');
    }
    if (batch && (teacher ? batch.teacherId !== user.sub : !(await this.enrollments.isStudentHistoricallyEnrolledInBatch(user.sub, batch.id)))) {
      throw new ForbiddenException('You are not allowed to file support for this class context.');
    }

    return {
      batch,
      session,
      recording,
      batchId: batch?.id,
      batchName: batch?.name,
      teacherId: session?.teacherId ?? batch?.teacherId ?? recording?.startedBy,
      sessionId: session?.id ?? recording?.sessionId ?? this.optionalText(request.sessionId, 160),
      sessionTitle: session?.title,
      roomId: session?.roomId ?? recording?.roomId ?? this.optionalText(request.roomId, 160),
      recordingId: recording?.recordingId
    };
  }

  private async findSession(sessionId: string): Promise<ClassSessionMongoDocument> {
    const session = await this.classSessions.findById(sessionId).exec();
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    return session;
  }

  private async findRecording(recordingId: string): Promise<RecordingMongoDocument> {
    const recording = await this.recordings.findOne({ recordingId }).exec();
    if (!recording) {
      throw new NotFoundException('Recording not found.');
    }
    return recording;
  }

  private async findBatch(batchId: string): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } }).exec();
    if (!batch) {
      throw new NotFoundException('Batch not found.');
    }
    return batch;
  }

  private async findByRequestId(requestId: string): Promise<SupportRequestMongoDocument> {
    const cleanId = this.requiredText(requestId, 'Support request id', 160);
    const doc = await this.supportRequests.findOne({ requestId: cleanId, deletedAt: { $exists: false } }).exec();
    if (!doc) {
      throw new NotFoundException('Support request not found.');
    }
    return doc;
  }

  private requestFilter(query: SupportRequestListQuery, includeEmail = true): FilterQuery<SupportRequestMongoDocument> {
    const filter: FilterQuery<SupportRequestMongoDocument> = { deletedAt: { $exists: false } };
    if (query.studentId) filter.studentId = this.requiredText(query.studentId, 'studentId', 160);
    if (query.batchId) filter.batchId = this.requiredText(query.batchId, 'batchId', 160);
    if (query.sessionId) filter.sessionId = this.requiredText(query.sessionId, 'sessionId', 160);
    if (query.status && query.status !== 'all') filter.status = this.status(query.status);
    if (query.issueType && query.issueType !== 'all') filter.issueType = this.issueType(query.issueType);
    const search = query.search?.trim();
    if (search) {
      const expression = new RegExp(this.escapeRegex(search.slice(0, 120)), 'i');
      filter.$or = [
        { subject: expression },
        { requestId: expression },
        { studentName: expression },
        ...(includeEmail ? [{ studentEmail: expression }] : []),
        { batchName: expression },
        { sessionTitle: expression }
      ];
    }
    return filter;
  }

  private async summary(baseFilter: FilterQuery<SupportRequestMongoDocument>): Promise<SupportRequestListResponse['summary']> {
    const filter = { ...baseFilter };
    delete (filter as { status?: unknown }).status;
    const [open, inReview, waitingForStudent, resolved, closed] = await Promise.all([
      this.supportRequests.countDocuments({ ...filter, status: 'open' }).exec(),
      this.supportRequests.countDocuments({ ...filter, status: 'in_review' }).exec(),
      this.supportRequests.countDocuments({ ...filter, status: 'waiting_for_student' }).exec(),
      this.supportRequests.countDocuments({ ...filter, status: 'resolved' }).exec(),
      this.supportRequests.countDocuments({ ...filter, status: 'closed' }).exec()
    ]);
    return { open, inReview, waitingForStudent, resolved, closed };
  }

  private async userProfile(userId: string): Promise<{ name: string; email?: string }> {
    const user = await this.users.findById(userId).exec();
    return {
      name: this.optionalText(user?.displayName || user?.name, 160) || 'Student',
      ...(user?.email ? { email: user.email } : {})
    };
  }

  private async actorName(user: AuthenticatedUser): Promise<string> {
    const profile = await this.userProfile(user.sub);
    return profile.name || user.email || 'Support';
  }

  private persistedContext(context: SupportContextResolution): Record<string, unknown> {
    return {
      ...(context.batchId ? { batchId: context.batchId } : {}),
      ...(context.batchName ? { batchName: context.batchName } : {}),
      ...(context.teacherId ? { teacherId: context.teacherId } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.sessionTitle ? { sessionTitle: context.sessionTitle } : {}),
      ...(context.roomId ? { roomId: context.roomId } : {}),
      ...(context.recordingId ? { recordingId: context.recordingId } : {})
    };
  }

  private async recordCreated(doc: SupportRequestMongoDocument, user: AuthenticatedUser): Promise<void> {
    await this.auditLogs?.record({
      actor: user,
      action: 'support.request.create',
      resourceType: 'support_request',
      resourceId: doc.requestId,
      targetUserId: doc.studentId,
      metadata: {
        issueType: doc.issueType,
        status: doc.status,
        batchId: doc.batchId,
        sessionId: doc.sessionId,
        recordingId: doc.recordingId
      }
    });
    if (doc.sessionId && doc.batchId) {
      await this.activity?.record({
        sessionId: doc.sessionId,
        batchId: doc.batchId,
        roomId: doc.roomId,
        eventType: 'support.request.created',
        category: 'support',
        summary: `Support request opened: ${doc.subject}`,
        actor: { id: doc.studentId, name: doc.studentName, email: doc.studentEmail, roles: user.roles },
        source: { collection: 'class_session_support_requests', id: doc.requestId },
        visibility: 'actor_only',
        metadata: {
          issueType: doc.issueType,
          status: doc.status
        }
      });
    }
    this.metrics?.classSessionSupportRequests.labels('created', doc.status, doc.issueType).inc();
  }

  private toSupportRequest(doc: SupportRequestMongoDocument, audience: 'student' | 'admin' | 'teacher' | 'teacher_related'): SupportRequest {
    const timestamps = doc as SupportRequestMongoDocument & { createdAt?: Date; updatedAt?: Date };
    return {
      id: doc.id,
      requestId: doc.requestId,
      requesterRole: doc.requesterRole ?? 'student',
      studentId: doc.studentId,
      studentName: doc.studentName,
      ...(audience !== 'teacher_related' && doc.studentEmail ? { studentEmail: doc.studentEmail } : {}),
      ...(doc.batchId ? { batchId: doc.batchId } : {}),
      ...(doc.batchName ? { batchName: doc.batchName } : {}),
      ...(doc.teacherId ? { teacherId: doc.teacherId } : {}),
      ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
      ...(doc.sessionTitle ? { sessionTitle: doc.sessionTitle } : {}),
      ...(doc.roomId ? { roomId: doc.roomId } : {}),
      ...(doc.recordingId ? { recordingId: doc.recordingId } : {}),
      issueType: doc.issueType,
      status: doc.status,
      subject: doc.subject,
      message: doc.message,
      ...(audience !== 'teacher_related' && doc.diagnostics ? { diagnostics: this.toDiagnostics(doc.diagnostics) } : {}),
      ...(audience !== 'teacher_related' && doc.assignedToUserId ? { assignedToUserId: doc.assignedToUserId } : {}),
      ...(audience !== 'teacher_related' && doc.assignedToName ? { assignedToName: doc.assignedToName } : {}),
      comments: (doc.comments ?? [])
        .filter((comment) => audience === 'admin' || comment.visibleToStudent)
        .map((comment) => ({
          id: comment.commentId,
          authorId: comment.authorId,
          authorName: comment.authorName,
          authorRoles: comment.authorRoles ?? [],
          message: comment.message,
          createdAt: comment.createdAt.toISOString(),
          visibleToStudent: comment.visibleToStudent
        })),
      createdAt: (timestamps.createdAt ?? new Date()).toISOString(),
      updatedAt: (timestamps.updatedAt ?? timestamps.createdAt ?? new Date()).toISOString(),
      ...(doc.resolvedAt ? { resolvedAt: doc.resolvedAt.toISOString() } : {}),
      ...(doc.closedAt ? { closedAt: doc.closedAt.toISOString() } : {})
    };
  }

  private toDiagnostics(diagnostics: SupportRequestDiagnostics): SupportRequestDiagnostics {
    return this.sanitizeDiagnostics(diagnostics) ?? {};
  }

  private async supportDiagnostics(
    input: SupportRequestDiagnostics | undefined,
    context: SupportContextResolution
  ): Promise<SupportRequestDiagnostics | undefined> {
    const diagnostics = this.sanitizeDiagnostics(input) ?? {};
    if (context.session?.status) {
      diagnostics.classSessionStatus = context.session.status;
      diagnostics.teacherConnectionState = this.teacherConnectionState(context.session);
    }
    const roomStatus = await this.safeRoomStatus(context.roomId);
    if (roomStatus) {
      diagnostics.roomStatus = roomStatus;
    }
    if (context.recording?.status) {
      diagnostics.recordingStatus = context.recording.status;
    }
    return Object.keys(diagnostics).length ? diagnostics : undefined;
  }

  private sanitizeDiagnostics(input?: SupportRequestDiagnostics): SupportRequestDiagnostics | undefined {
    if (!input) return undefined;
    const diagnostics: SupportRequestDiagnostics = {};
    const userAgent = this.optionalText(input.userAgent, 500);
    const route = this.optionalText(input.route, 500);
    const timestamp = this.optionalText(input.timestamp, 40);
    const browser = this.optionalText(input.browser, 160);
    const platform = this.optionalText(input.platform, 160);
    if (userAgent) diagnostics.userAgent = this.redactUrlSecrets(userAgent);
    if (route) diagnostics.route = this.redactUrlSecrets(route);
    if (timestamp) diagnostics.timestamp = timestamp;
    if (browser) diagnostics.browser = browser;
    if (platform) diagnostics.platform = platform;
    if (input.microphonePermission && PERMISSION_STATES.has(input.microphonePermission)) diagnostics.microphonePermission = input.microphonePermission;
    if (input.cameraPermission && PERMISSION_STATES.has(input.cameraPermission)) diagnostics.cameraPermission = input.cameraPermission;
    const classSessionStatus = this.optionalText(input.classSessionStatus, 40);
    const recordingStatus = this.optionalText(input.recordingStatus, 40);
    if (classSessionStatus) diagnostics.classSessionStatus = classSessionStatus;
    if (input.roomStatus && ['active', 'closed', 'unknown'].includes(input.roomStatus)) diagnostics.roomStatus = input.roomStatus;
    if (
      input.teacherConnectionState &&
      ['connected', 'reconnecting', 'absent', 'not_started', 'ended'].includes(input.teacherConnectionState)
    ) {
      diagnostics.teacherConnectionState = input.teacherConnectionState;
    }
    if (recordingStatus) diagnostics.recordingStatus = recordingStatus;
    return Object.keys(diagnostics).length ? diagnostics : undefined;
  }

  private async safeRoomStatus(roomId: string | undefined): Promise<SupportRequestDiagnostics['roomStatus'] | undefined> {
    if (!roomId) {
      return undefined;
    }
    if (!this.rooms) {
      return 'unknown';
    }
    try {
      const room = await this.rooms.findById(roomId).exec();
      if (!room) {
        return 'unknown';
      }
      return room.closedAt ? 'closed' : 'active';
    } catch {
      return 'unknown';
    }
  }

  private teacherConnectionState(session: ClassSessionMongoDocument): NonNullable<SupportRequestDiagnostics['teacherConnectionState']> {
    if (session.status === 'scheduled') {
      return 'not_started';
    }
    if (session.status === 'completed' || session.status === 'cancelled') {
      return 'ended';
    }
    if (session.teacherReconnectDeadlineAt) {
      return 'reconnecting';
    }
    return 'connected';
  }

  private issueType(value: unknown): SupportIssueType {
    if (typeof value === 'string' && SUPPORT_ISSUE_TYPES.includes(value as SupportIssueType)) {
      return value as SupportIssueType;
    }
    throw new BadRequestException('Unsupported support issue type.');
  }

  private status(value: unknown): SupportRequestStatus {
    if (typeof value === 'string' && SUPPORT_STATUSES.includes(value as SupportRequestStatus)) {
      return value as SupportRequestStatus;
    }
    throw new BadRequestException('Unsupported support status.');
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    const text = this.optionalText(value, maxLength);
    if (!text) {
      throw new BadRequestException(`${field} is required.`);
    }
    return text;
  }

  private optionalText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().slice(0, maxLength);
    return text || undefined;
  }

  private redactUrlSecrets(value: string): string {
    return value.replace(/([?&](?:token|access_token|refresh_token|authorization|password|secret|key)=)[^&\s]+/gi, '$1[redacted]');
  }

  private clamp(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private assertStudent(user: AuthenticatedUser): void {
    if (!user.roles.includes('STUDENT')) {
      throw new ForbiddenException('Student support access required.');
    }
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!user.roles.includes('ADMIN') && !user.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Admin support access required.');
    }
  }
}
