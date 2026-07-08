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
  Assignment,
  AssignmentAttachment,
  AssignmentSubmissionSummary,
  ChatHistoryResponse,
  ChatAttachment,
  ChatMessage,
  ChatMessageScope,
  ChatReadState,
  ChatThreadSummaryResponse,
  ClassSessionReport,
  ClassSessionPostClassQuestionThread,
  ClassSessionPostClassThreadWorkflow,
  ClassSessionPostClassWorkspace,
  ClassSessionMaterial,
  ClassSessionMaterialEvent,
  ClassSessionMaterialKind,
  ClassSessionTimelineEvent,
  ClassSessionTimelineCategory,
  ClassSessionTimelineResponse,
  CreateWhiteboardMemoryCheckpointRequest,
  CreateClassSessionMaterialLinkRequest,
  CreatePostClassAnnouncementRequest,
  ClassSessionLifecycleEvent,
  LiveClassSettings,
  PreviousWhiteboardMemoryListResponse,
  RestorePreviousWhiteboardMemoryRequest,
  RestoreWhiteboardMemoryVersionRequest,
  UpdatePostClassQuestionStateRequest,
  Recording,
  RecordingPlaybackProgress,
  RecommendationSource,
  SaveWhiteboardMemoryRequest,
  SendPostClassQuestionRequest,
  StudentClassAttendanceSummary,
  StudentCompletedClassDetailResponse,
  StudentCompletedClassSessionListItem,
  StudentCompletedClassSessionListResponse,
  StudentCompletedClassWhiteboardSummary,
  StudentProgressAssignmentSummary,
  StudentProgressAttendancePoint,
  StudentProgressBatchSummary,
  StudentProgressParticipationSummary,
  StudentProgressRecordingSummary,
  StudentProgressResponse,
  StudentProgressReviewSignal,
  StudentProgressSummary,
  TeacherAnalyticsAssignmentSummary,
  TeacherAnalyticsAttendanceSummary,
  TeacherAnalyticsBatchSummary,
  TeacherAnalyticsMaterialSummary,
  TeacherAnalyticsParticipationSummary,
  TeacherAnalyticsQuery,
  TeacherAnalyticsRecordingSummary,
  TeacherAnalyticsResponse,
  TeacherAnalyticsRiskIndicator,
  TeacherAnalyticsRiskLevel,
  TeacherAnalyticsSummary,
  TeacherWeakTopicSignal,
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
import { ClassSessionActivityService } from '../class-session-activity/class-session-activity.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  AssignmentDocument,
  AssignmentMongoDocument,
  AssignmentSubmissionDocument,
  AssignmentSubmissionMongoDocument,
  ClassSessionDocument,
  ClassSessionAttendanceSnapshotDocument,
  ClassSessionAttendanceSnapshotMongoDocument,
  ClassSessionMaterialDocument,
  ClassSessionMaterialMongoDocument,
  ClassSessionPostClassThreadStateDocument,
  ClassSessionPostClassThreadStateMongoDocument,
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
import { RecordingsService, type RecordingDownload, type RecordingPlaybackProgressRecord } from '../recordings/recordings.service';
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
const ASSIGNMENT_SUBMISSION_STATUS_KEYS: Array<keyof AssignmentSubmissionSummary> = [
  'assigned',
  'viewed',
  'submitted',
  'late',
  'reviewed',
  'returned',
  'completed'
];

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

interface AdminAttendanceExportRow {
  sessionId: string;
  title: string;
  sessionStatus: ClassSessionStatus;
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  teacherName?: string;
  studentId: string;
  studentName: string;
  studentEmail?: string;
  attendanceStatus: 'present' | 'absent';
  rosterSource: 'roster' | 'participant';
  firstJoinAt?: string;
  lastLeaveAt?: string;
  totalDurationSeconds: number;
  reconnectCount: number;
  attendanceSource: AdminAttendanceSource;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface StudentCompletedClassQuery {
  page?: number | string;
  limit?: number | string;
  batchId?: string;
  courseId?: string;
}

interface BoundedTeacherAnalyticsQuery extends TeacherAnalyticsQuery {
  dateFrom: string;
  dateTo: string;
}

interface TeacherAnalyticsStudentAccumulator {
  studentId: string;
  studentName?: string;
  studentEmail?: string;
  batchId: string;
  batchName: string;
  sessionsEnrolled: number;
  sessionsAttended: number;
  missedClasses: number;
  reconnects: number;
  handRaises: number;
  allowedSpeakingTurns: number;
  questionsAsked: number;
  unansweredQuestions: number;
  assignmentsAssigned: number;
  assignmentsSubmitted: number;
  assignmentsReviewed: number;
  assignmentsMissing: number;
  sourceSessionIds: Set<string>;
  sourceAssignmentIds: Set<string>;
}

interface WhiteboardTopicSignalSource {
  tag: string;
  sessionId: string;
  batchId: string;
  pageId: string;
  pageTitle: string;
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
    @InjectModel(ClassSessionPostClassThreadStateDocument.name)
    private readonly postClassThreadStates: Model<ClassSessionPostClassThreadStateMongoDocument>,
    @InjectModel(ClassSessionWhiteboardStateDocument.name)
    private readonly whiteboardStates: Model<ClassSessionWhiteboardStateMongoDocument>,
    @InjectModel(ClassSessionWhiteboardVersionDocument.name)
    private readonly whiteboardVersions: Model<ClassSessionWhiteboardVersionMongoDocument>,
    @InjectModel(AssignmentDocument.name)
    private readonly assignments: Model<AssignmentMongoDocument>,
    @InjectModel(AssignmentSubmissionDocument.name)
    private readonly assignmentSubmissions: Model<AssignmentSubmissionMongoDocument>,
    private readonly studentEnrollments: StudentEnrollmentsService,
    private readonly rooms: RoomsService,
    private readonly recordings: RecordingsService,
    private readonly profiles: ProfilesService,
    private readonly config: ConfigService,
    @Optional() @InjectModel(UserDocument.name) private readonly users?: Model<UserMongoDocument>,
    @Optional() private readonly auditLogs?: AuditLogsService,
    @Optional() private readonly activity?: ClassSessionActivityService,
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

  async getTeacherAnalytics(query: TeacherAnalyticsQuery, user: AuthenticatedUser): Promise<TeacherAnalyticsResponse> {
    if (!this.isAdmin(user) && !user.roles.includes('TEACHER')) {
      throw new ForbiddenException('Teacher analytics are available to teachers and administrators only.');
    }
    const bounded = this.boundedTeacherAnalyticsQuery(query);
    const batchFilter = this.teacherAnalyticsBatchFilter(bounded, user);
    const batches = await this.batches.find(batchFilter).exec();
    if (bounded.batchId && !batches.length && !this.isAdmin(user)) {
      throw new ForbiddenException('You are not allowed to view analytics for this batch.');
    }
    if (!batches.length) {
      return this.emptyTeacherAnalyticsResponse(bounded, this.isAdmin(user) ? 'admin' : 'teacher');
    }

    const batchIds = batches.map((batch) => batch.id);
    const dateFrom = this.parseAdminDate(bounded.dateFrom, 'dateFrom');
    const dateTo = this.parseAdminDate(bounded.dateTo, 'dateTo');
    const sessionFilter: Record<string, unknown> = {
      batchId: { $in: batchIds },
      scheduledAt: { $gte: dateFrom, $lte: dateTo }
    };
    const [sessions, assignments, materials, rosterEntries] = await Promise.all([
      this.classSessions.find(sessionFilter).sort({ scheduledAt: -1 }).exec(),
      this.assignments.find(this.teacherAnalyticsAssignmentFilter(batchIds, bounded, dateFrom, dateTo)).exec(),
      this.materials
        .find({
          batchId: { $in: batchIds },
          deletedAt: { $exists: false },
          createdAt: { $gte: dateFrom, $lte: dateTo }
        })
        .exec(),
      Promise.all(batches.map((batch) => this.studentEnrollments.listBatchRoster(batch.id, { includeInactive: true })))
    ]);
    const filteredStudentId = bounded.studentId?.trim();
    const rosterByBatch = new Map<string, Awaited<ReturnType<StudentEnrollmentsService['listBatchRoster']>>>();
    batches.forEach((batch, index) => {
      const roster = rosterEntries[index] ?? [];
      rosterByBatch.set(batch.id, filteredStudentId ? roster.filter((student) => student.userId === filteredStudentId) : roster);
    });

    const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
    const sessionsByBatch = this.groupBy(sessions, (session) => session.batchId);
    const sessionIds = sessions.map((session) => session.id);
    const [activityEvents, recordings, postClassStates, whiteboardStates] = await Promise.all([
      this.activity?.listEventsForAnalytics({ sessionIds, batchIds, dateFrom, dateTo }) ?? Promise.resolve([]),
      this.recordings.listClassSessionRecordingsForAnalytics(sessionIds, batchIds),
      this.postClassThreadStates
        .find({
          batchId: { $in: batchIds },
          updatedAt: { $gte: dateFrom, $lte: dateTo },
          ...(filteredStudentId ? { studentId: filteredStudentId } : {})
        })
        .exec(),
      sessionIds.length
        ? this.whiteboardStates
            .find({
              sessionId: { $in: sessionIds },
              batchId: { $in: batchIds }
            })
            .exec()
        : Promise.resolve([])
    ]);
    const activityByBatch = this.groupBy(activityEvents, (event) => event.batchId ?? '');
    const recordingsByBatch = this.groupBy(recordings, (recording) => recording.batchId ?? '');
    const recordingProgress = await this.recordings.listPlaybackProgressForAnalytics(
      recordings.map((recording) => recording.recordingId ?? recording.id).filter(Boolean)
    );
    const recordingProgressByBatch = this.groupBy(recordingProgress, (progress) => progress.batchId);
    const materialsByBatch = this.groupBy(materials, (material) => material.batchId);
    const whiteboardTopicsByBatch = this.groupBy(this.whiteboardTopicSources(whiteboardStates), (source) => source.batchId);
    const assignmentsByBatch = this.groupBy(assignments, (assignment) => assignment.batchId);
    const assignmentIds = assignments.map((assignment) => assignment.assignmentId);
    const submissions = assignmentIds.length
      ? await this.assignmentSubmissions
          .find({
            assignmentId: { $in: assignmentIds },
            deletedAt: { $exists: false },
            ...(filteredStudentId ? { studentId: filteredStudentId } : {})
          })
          .exec()
      : [];
    const submissionsByAssignment = this.groupBy(submissions, (submission) => submission.assignmentId);
    const submissionsByBatch = this.groupBy(submissions, (submission) => submission.batchId);
    const qnaStatesByBatch = this.groupBy(postClassStates, (state) => state.batchId);

    const batchesPayload: TeacherAnalyticsBatchSummary[] = [];
    const allRisks: TeacherAnalyticsRiskIndicator[] = [];
    const allWeakTopicSignals: TeacherWeakTopicSignal[] = [];

    for (const batch of batches) {
      const batchSessions = sessionsByBatch.get(batch.id) ?? [];
      const completedSessions = batchSessions.filter((session) => session.status === 'completed');
      const roster = rosterByBatch.get(batch.id) ?? [];
      const batchEvents = activityByBatch.get(batch.id) ?? [];
      const batchAssignments = assignmentsByBatch.get(batch.id) ?? [];
      const batchSubmissions = submissionsByBatch.get(batch.id) ?? [];
      const batchRecordings = recordingsByBatch.get(batch.id) ?? [];
      const batchRecordingProgress = recordingProgressByBatch.get(batch.id) ?? [];
      const batchMaterials = materialsByBatch.get(batch.id) ?? [];
      const batchWhiteboardTopics = whiteboardTopicsByBatch.get(batch.id) ?? [];
      const batchQnaStates = qnaStatesByBatch.get(batch.id) ?? [];
      const studentAccumulators = new Map<string, TeacherAnalyticsStudentAccumulator>();
      for (const student of roster) {
        studentAccumulators.set(student.userId, {
          studentId: student.userId,
          studentName: student.displayName,
          ...(student.email ? { studentEmail: student.email } : {}),
          batchId: batch.id,
          batchName: batch.name,
          sessionsEnrolled: 0,
          sessionsAttended: 0,
          missedClasses: 0,
          reconnects: 0,
          handRaises: 0,
          allowedSpeakingTurns: 0,
          questionsAsked: 0,
          unansweredQuestions: 0,
          assignmentsAssigned: 0,
          assignmentsSubmitted: 0,
          assignmentsReviewed: 0,
          assignmentsMissing: 0,
          sourceSessionIds: new Set<string>(),
          sourceAssignmentIds: new Set<string>()
        });
      }

      const attendance = await this.teacherAnalyticsAttendance(completedSessions, filteredStudentId, studentAccumulators);
      const participation = this.teacherAnalyticsParticipation(batchEvents, filteredStudentId, studentAccumulators, batchQnaStates);
      const assignmentSummary = this.teacherAnalyticsAssignments(batchAssignments, batchSubmissions, roster.length, filteredStudentId, studentAccumulators);
      const recordingsSummary = this.teacherAnalyticsRecordings(batchRecordings, batchRecordingProgress, roster.length);
      const materialSummary = this.teacherAnalyticsMaterials(batchMaterials, batchEvents);
      const risks = [...studentAccumulators.values()]
        .map((student) => this.teacherAnalyticsRisk(student))
        .filter((risk): risk is TeacherAnalyticsRiskIndicator => Boolean(risk));
      const weakTopicSignals = this.teacherWeakTopicSignals({
        batch,
        attendance,
        participation,
        assignments: assignmentSummary,
        recordings: recordingsSummary,
        materials: materialSummary,
        risks,
        whiteboardTopics: batchWhiteboardTopics,
        sourceSessionIds: batchSessions.map((session) => session.id),
        sourceAssignmentIds: batchAssignments.map((assignment) => assignment.assignmentId),
        generatedAt: new Date()
      });
      allRisks.push(...risks);
      batchesPayload.push({
        batchId: batch.id,
        batchName: batch.name,
        ...(batch.courseId ? { courseId: batch.courseId } : {}),
        ...(batch.courseName ? { courseName: batch.courseName } : {}),
        teacherId: batch.teacherId,
        enrolledStudents: roster.length,
        totalSessions: batchSessions.length,
        completedSessions: completedSessions.length,
        liveSessions: batchSessions.filter((session) => session.status === 'live').length,
        upcomingSessions: batchSessions.filter((session) => session.status === 'scheduled').length,
        attendance,
        participation,
        assignments: assignmentSummary,
        recordings: recordingsSummary,
        materials: materialSummary,
        riskIndicators: risks,
        weakTopicSignals,
        sourceSessionIds: batchSessions.map((session) => session.id),
        sourceAssignmentIds: batchAssignments.map((assignment) => assignment.assignmentId)
      });
      allWeakTopicSignals.push(...weakTopicSignals);
    }

    return {
      generatedAt: new Date().toISOString(),
      query: bounded,
      audience: this.isAdmin(user) ? 'admin' : 'teacher',
      summary: this.teacherAnalyticsSummary(batchesPayload),
      batches: batchesPayload.sort((left, right) => right.riskIndicators.length - left.riskIndicators.length || left.batchName.localeCompare(right.batchName)),
      risks: allRisks.sort((left, right) => this.riskRank(right.riskLevel) - this.riskRank(left.riskLevel)),
      weakTopicSignals: allWeakTopicSignals.sort((left, right) => this.signalRank(right.severity) - this.signalRank(left.severity)),
      availability: {
        attendance: {
          available: batchesPayload.some((batch) => batch.attendance.source !== 'none'),
          source: batchesPayload.some((batch) => batch.attendance.source === 'snapshot') ? 'snapshot' : 'inferred',
          reason: batchesPayload.some((batch) => batch.attendance.source !== 'none')
            ? 'Attendance uses final snapshots when present and existing inferred attendance rows otherwise.'
            : 'No completed session attendance records are available for the selected range.'
        },
        participation: {
          available: activityEvents.length > 0,
          source: activityEvents.length > 0 ? 'activity' : 'not_tracked',
          reason: activityEvents.length > 0 ? 'Participation counts are derived from class-session activity events.' : 'No participation events are recorded for the selected range.'
        },
        qna: {
          available: activityEvents.some((event) => event.eventType.startsWith('post_class.question')) || postClassStates.length > 0,
          source: 'activity',
          reason: 'Q&A analytics use post-class question activity and workflow state only; message bodies are excluded.'
        },
        assignments: {
          available: assignments.length > 0,
          source: assignments.length > 0 ? 'metadata' : 'not_tracked',
          reason: assignments.length > 0 ? 'Assignment counts are derived from assignment and submission records.' : 'No assignments are available for the selected range.'
        },
        recordings: {
          available: recordings.length > 0,
          source: recordings.length > 0 ? 'progress' : 'not_tracked',
          reason: recordings.length > 0
            ? 'Recording readiness and student playback engagement use recording metadata plus persisted playback progress.'
            : 'No recordings are available for the selected range.'
        },
        materials: {
          available: materials.length > 0 || activityEvents.some((event) => event.eventType === 'material.downloaded'),
          source: activityEvents.some((event) => event.eventType === 'material.downloaded') ? 'activity' : 'metadata',
          reason: 'Material counts use material metadata, and downloads use material.downloaded activity events where present.'
        }
      }
    };
  }

  async getClassSessionReport(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ClassSessionReport> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    const teacherMap = await this.adminTeacherMap([persisted.teacherId]);
    const teacher = teacherMap.get(persisted.teacherId);
    const [attendance, timelineEvents, broadcastHistory, materials, recordings, whiteboard, assignments, qna] = await Promise.all([
      this.adminAttendanceRowsForSession(persisted),
      this.classSessionReportTimelineEvents(resolution, user),
      persisted.roomId
        ? this.rooms.getClassSessionChatHistory({
            sessionId: resolution.planned.id,
            batchId: resolution.batch.id,
            roomId: persisted.roomId,
            channelId: persisted.chatChannelId,
            teacherId: resolution.batch.teacherId,
            requesterUserId: user.sub,
            requesterRole: this.isAdmin(user) ? 'admin' : 'teacher',
            scope: 'broadcast',
            limit: 100
          })
        : Promise.resolve({ messages: [] }),
      this.classSessionReportMaterials(resolution),
      this.recordings.listAuthorizedClassSessionRecordings(resolution.planned.id),
      this.studentCompletedWhiteboardSummary(resolution, { includeUnpublished: true }),
      this.classSessionReportAssignments(resolution.planned.id, resolution.batch.id),
      persisted.roomId
        ? this.rooms.getClassSessionPostClassTeacherChatSummary({
            sessionId: resolution.planned.id,
            batchId: resolution.batch.id,
            roomId: persisted.roomId,
            teacherId: resolution.batch.teacherId,
            requesterUserId: user.sub
          })
        : Promise.resolve({ sessionId: resolution.planned.id, roomId: '', threads: [] })
    ]);
    return {
      audience: this.isAdmin(user) ? 'admin' : 'teacher',
      generatedAt: new Date().toISOString(),
      session: {
        sessionId: persisted.id,
        batchId: resolution.batch.id,
        batchName: resolution.batch.name,
        ...(resolution.batch.courseId ? { courseId: resolution.batch.courseId } : {}),
        ...(resolution.batch.courseName ? { courseName: resolution.batch.courseName } : {}),
        teacherId: persisted.teacherId,
        ...(teacher?.displayName || teacher?.name ? { teacherName: teacher.displayName ?? teacher.name } : {}),
        ...(teacher?.email ? { teacherEmail: teacher.email } : {}),
        title: persisted.title,
        sessionNumber: persisted.sessionNumber,
        scheduledAt: persisted.scheduledAt.toISOString(),
        ...(persisted.startedAt ? { startedAt: persisted.startedAt.toISOString() } : {}),
        ...(persisted.completedAt ? { completedAt: persisted.completedAt.toISOString() } : {}),
        durationMinutes: persisted.durationMinutes,
        status: 'completed',
        ...(persisted.roomId ? { roomId: persisted.roomId } : {}),
        ...(persisted.chatChannelId ? { chatChannelId: persisted.chatChannelId } : {}),
        ...(persisted.whiteboardChannelId ? { whiteboardChannelId: persisted.whiteboardChannelId } : {})
      },
      attendance: this.classSessionReportAttendance(persisted, attendance),
      participation: this.classSessionReportParticipation(timelineEvents),
      broadcasts: this.classSessionReportBroadcasts(broadcastHistory.messages),
      artifacts: {
        recordings,
        materials,
        whiteboard
      },
      assignments,
      qna: this.classSessionReportQna(qna),
      incidents: this.classSessionReportIncidents(timelineEvents)
    };
  }

  async exportClassSessionReportCsv(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<string> {
    const report = await this.getClassSessionReport(sessionId, batchId, user);
    return this.classSessionReportCsv(report);
  }

  async getPostClassWorkspace(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ClassSessionPostClassWorkspace> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    const [report, qnaSummary, states, assignments] = await Promise.all([
      this.getClassSessionReport(sessionId, batchId, user),
      this.rooms.getClassSessionPostClassTeacherChatSummary({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: persisted.roomId,
        teacherId: resolution.batch.teacherId,
        requesterUserId: user.sub
      }),
      this.postClassThreadStates.find({ sessionId: resolution.planned.id, batchId: resolution.batch.id }).exec(),
      this.classSessionWorkspaceAssignments(resolution.planned.id, resolution.batch.id)
    ]);
    return {
      generatedAt: new Date().toISOString(),
      session: report.session,
      report,
      qna: {
        threads: this.postClassQuestionThreads(qnaSummary, states, resolution)
      },
      materials: report.artifacts.materials,
      recordings: report.artifacts.recordings,
      whiteboard: report.artifacts.whiteboard,
      assignments
    };
  }

  async updatePostClassQuestionState(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: UpdatePostClassQuestionStateRequest
  ): Promise<ClassSessionPostClassThreadWorkflow> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const studentId = this.cleanParticipantId(request.participantId);
    if (!studentId) {
      throw new BadRequestException('Student participant id is required.');
    }
    if (!(await this.studentEnrollments.isStudentHistoricallyEnrolledInBatch(studentId, resolution.batch.id))) {
      throw new BadRequestException('Target student is not enrolled in this class history.');
    }
    const updates: Partial<Pick<ClassSessionPostClassThreadStateDocument, 'important' | 'answered' | 'followUp' | 'updatedByUserId'>> = {
      updatedByUserId: user.sub
    };
    if (typeof request.important === 'boolean') {
      updates.important = request.important;
    }
    if (typeof request.answered === 'boolean') {
      updates.answered = request.answered;
    }
    if (typeof request.followUp === 'boolean') {
      updates.followUp = request.followUp;
    }
    if (Object.keys(updates).length === 1) {
      throw new BadRequestException('At least one Q&A workflow flag is required.');
    }
    const threadKey = this.postClassThreadKey(resolution.planned.id, resolution.batch.teacherId, studentId);
    const state = await this.postClassThreadStates.findOneAndUpdate(
      { sessionId: resolution.planned.id, batchId: resolution.batch.id, studentId },
      {
        $set: updates,
        $setOnInsert: {
          sessionId: resolution.planned.id,
          batchId: resolution.batch.id,
          teacherId: resolution.batch.teacherId,
          studentId,
          threadKey
        }
      },
      { new: true, upsert: true }
    );
    if (!state) {
      throw new ConflictException('Post-class question state could not be saved.');
    }
    await this.activity?.record({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: resolution.persisted?.roomId,
      eventType: 'post_class.question_state_updated',
      category: 'chat',
      summary: 'Teacher updated post-class Q&A workflow state',
      actor: { id: user.sub, email: user.email, roles: user.roles },
      target: { userId: studentId, type: 'student' },
      visibility: 'full',
      metadata: {
        important: state.important,
        answered: state.answered,
        followUp: state.followUp
      }
    });
    return this.postClassWorkflowFromState(state, resolution, studentId);
  }

  async createPostClassAnnouncement(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: CreatePostClassAnnouncementRequest
  ): Promise<ChatMessage> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!liveSettings.chat.teacherBroadcastEnabled) {
      throw new ForbiddenException('Teacher announcements are disabled for this class.');
    }
    const senderName = await this.userDisplayName(user);
    const message = await this.rooms.sendClassSessionPostClassBroadcastMessage({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      channelId: persisted.chatChannelId,
      senderId: user.sub,
      senderName,
      senderRole: this.isAdmin(user) ? 'admin' : 'teacher',
      message: request.message,
      maxMessageLength: liveSettings.chat.messageLengthLimit
    });
    await this.activity?.record({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      eventType: 'post_class.announcement.sent',
      category: 'chat',
      summary: 'Teacher sent a post-class announcement',
      actor: { id: user.sub, name: senderName, email: user.email, roles: user.roles },
      source: { collection: 'chat', id: message.id },
      visibility: 'student_safe',
      metadata: { scope: 'broadcast', phase: 'post_class' }
    });
    return message;
  }

  async publishPostClassMaterial(
    sessionId: string,
    materialId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ClassSessionMaterial> {
    return this.updatePostClassMaterialPublication(sessionId, materialId, batchId, user, true);
  }

  async unpublishPostClassMaterial(
    sessionId: string,
    materialId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ClassSessionMaterial> {
    return this.updatePostClassMaterialPublication(sessionId, materialId, batchId, user, false);
  }

  async publishPostClassRecording(
    sessionId: string,
    recordingId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<Recording> {
    return this.updatePostClassRecordingPublication(sessionId, recordingId, batchId, user, true);
  }

  async unpublishPostClassRecording(
    sessionId: string,
    recordingId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<Recording> {
    return this.updatePostClassRecordingPublication(sessionId, recordingId, batchId, user, false);
  }

  async publishPostClassWhiteboard(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<StudentCompletedClassWhiteboardSummary> {
    return this.updatePostClassWhiteboardPublication(sessionId, batchId, user, true);
  }

  async unpublishPostClassWhiteboard(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<StudentCompletedClassWhiteboardSummary> {
    return this.updatePostClassWhiteboardPublication(sessionId, batchId, user, false);
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
    const rows = await this.adminAttendanceExportRows(query);
    const csvRows = [
      [
        'Session ID',
        'Session Title',
        'Session Status',
        'Course',
        'Course ID',
        'Batch',
        'Batch ID',
        'Teacher',
        'Teacher ID',
        'Student',
        'Student Email',
        'Student ID',
        'Attendance Status',
        'Roster Source',
        'First Join',
        'Last Leave',
        'Duration Seconds',
        'Reconnect Count',
        'Attendance Source',
        'Scheduled At',
        'Started At',
        'Completed At'
      ],
      ...rows.map((row) => [
        row.sessionId,
        row.title,
        row.sessionStatus,
        row.courseName ?? '',
        row.courseId ?? '',
        row.batchName,
        row.batchId,
        row.teacherName ?? '',
        row.teacherId,
        row.studentName,
        row.studentEmail ?? '',
        row.studentId,
        row.attendanceStatus,
        row.rosterSource,
        row.firstJoinAt ?? '',
        row.lastLeaveAt ?? '',
        String(row.totalDurationSeconds),
        String(row.reconnectCount),
        row.attendanceSource,
        row.scheduledAt,
        row.startedAt ?? '',
        row.completedAt ?? ''
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
    await this.activity?.record({
      sessionId: payload.sessionId,
      batchId: payload.batchId,
      roomId: payload.roomId,
      eventType: 'session.started',
      category: 'lifecycle',
      summary: `Started class session ${payload.title}`,
      actor: { id: user.sub, email: user.email, roles: user.roles },
      visibility: 'student_safe',
      metadata: { status: payload.status, startedAt: payload.startedAt }
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
    await this.activity?.record({
      sessionId: payload.sessionId,
      batchId: payload.batchId,
      roomId: payload.roomId,
      eventType: 'session.ended',
      category: 'lifecycle',
      summary: `Ended class session ${payload.title}`,
      actor: { id: user.sub, email: user.email, roles: user.roles },
      visibility: 'student_safe',
      metadata: { status: payload.status, completedAt: payload.completedAt }
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
    await this.assertCanReadClassSessionForResolution(resolution, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!this.canViewRecordingContent(liveSettings, resolution.batch, user)) {
      return [];
    }
    const recordings = await this.recordings.listAuthorizedClassSessionRecordings(resolution.planned.id);
    return this.payloadRole(user, resolution.batch) === 'student' && (resolution.persisted?.status === 'completed' || resolution.persisted?.status === 'cancelled')
      ? recordings.filter((recording) => this.isPostClassRecordingPublished(recording))
      : recordings;
  }

  async downloadRecording(
    sessionId: string,
    recordingId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<RecordingDownload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSessionForResolution(resolution, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!this.canViewRecordingContent(liveSettings, resolution.batch, user)) {
      throw new ForbiddenException('Recording playback is not available for this class.');
    }
    this.assertExportWithinRetention(liveSettings, resolution.persisted?.completedAt);
    if (this.payloadRole(user, resolution.batch) === 'student' && (resolution.persisted?.status === 'completed' || resolution.persisted?.status === 'cancelled')) {
      const recordings = await this.recordings.listAuthorizedClassSessionRecordings(resolution.planned.id);
      const recording = recordings.find((item) => item.recordingId === recordingId || item.id === recordingId);
      if (!recording || !this.isPostClassRecordingPublished(recording)) {
        throw new ForbiddenException('Recording playback is not available for this class.');
      }
    }
    return this.recordings.readAuthorizedClassSessionRecordingDownload(resolution.planned.id, recordingId);
  }

  async listStudentCompletedSessions(
    user: AuthenticatedUser,
    query: StudentCompletedClassQuery = {}
  ): Promise<StudentCompletedClassSessionListResponse> {
    this.assertStudentUser(user);
    const page = this.clampPositiveInteger(query.page, 1, 10_000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const eligibleBatchIds = await this.studentEnrollments.listStudentClassHistoryBatchIds(user.sub);
    if (query.batchId && !eligibleBatchIds.includes(query.batchId)) {
      throw new ForbiddenException('You are not allowed to view this class history.');
    }
    const batchMap = await this.adminBatchMap(query.batchId ? [query.batchId] : eligibleBatchIds);
    const visibleBatchIds = (query.batchId ? [query.batchId] : eligibleBatchIds).filter((batchId) => {
      const batch = batchMap.get(batchId);
      if (!batch) {
        return false;
      }
      return query.courseId ? batch.courseId === query.courseId : true;
    });
    if (!visibleBatchIds.length) {
      return { items: [], page, limit, total: 0 };
    }
    const filter = {
      batchId: { $in: visibleBatchIds },
      status: 'completed'
    };
    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      this.classSessions.find(filter).sort({ completedAt: -1, scheduledAt: -1 }).skip(skip).limit(limit).exec(),
      this.classSessions.countDocuments(filter).exec()
    ]);
    const teacherMap = await this.adminTeacherMap(sessions.map((session) => session.teacherId));
    const items = await Promise.all(
      sessions.map((session) => this.toStudentCompletedClassRow(session, batchMap.get(session.batchId), teacherMap.get(session.teacherId), user))
    );
    return {
      items: items.filter((item): item is StudentCompletedClassSessionListItem => Boolean(item)),
      page,
      limit,
      total
    };
  }

  async getStudentProgress(user: AuthenticatedUser): Promise<StudentProgressResponse> {
    this.assertStudentUser(user);
    const generatedAt = new Date();
    const now = generatedAt.getTime();
    const batchIds = await this.studentEnrollments.listStudentClassHistoryBatchIds(user.sub);
    if (!batchIds.length) {
      return this.emptyStudentProgressResponse(user.sub, generatedAt, 'No enrolled or historical batches are available.');
    }

    const batchMap = await this.adminBatchMap(batchIds);
    const visibleBatchIds = batchIds.filter((batchId) => batchMap.has(batchId));
    if (!visibleBatchIds.length) {
      return this.emptyStudentProgressResponse(user.sub, generatedAt, 'No accessible enrolled batches are available.');
    }

    const [sessions, assignments] = await Promise.all([
      this.classSessions
        .find({ batchId: { $in: visibleBatchIds }, status: { $in: ['scheduled', 'live', 'completed'] } })
        .sort({ scheduledAt: -1 })
        .exec(),
      this.assignments
        .find({
          batchId: { $in: visibleBatchIds },
          status: 'published',
          deletedAt: { $exists: false }
        })
        .exec()
    ]);
    const teacherMap = await this.adminTeacherMap([...new Set([...sessions.map((session) => session.teacherId), ...visibleBatchIds.map((id) => batchMap.get(id)?.teacherId ?? '')])]);
    const sessionIds = sessions.map((session) => session.id);
    const completedSessions = sessions.filter((session) => session.status === 'completed');
    const completedSessionIds = completedSessions.map((session) => session.id);
    const assignmentIds = assignments.map((assignment) => assignment.assignmentId);
    const submissionsPromise: Promise<AssignmentSubmissionMongoDocument[]> = assignmentIds.length
      ? this.assignmentSubmissions
          .find({
            assignmentId: { $in: assignmentIds },
            studentId: user.sub,
            deletedAt: { $exists: false }
          })
          .exec()
      : Promise.resolve([]);
    const activityEventsPromise: Promise<ClassSessionTimelineEvent[]> = sessionIds.length
      ? this.activity?.listEventsForAnalytics({
          sessionIds,
          batchIds: visibleBatchIds,
          limit: 10000
        }) ?? Promise.resolve([])
      : Promise.resolve([]);
    const recordingsPromise: Promise<Recording[]> = completedSessionIds.length
      ? this.recordings.listClassSessionRecordingsForAnalytics(completedSessionIds, visibleBatchIds)
      : Promise.resolve([]);
    const qnaStatesPromise: Promise<ClassSessionPostClassThreadStateMongoDocument[]> = completedSessionIds.length
      ? this.postClassThreadStates
          .find({
            sessionId: { $in: completedSessionIds },
            batchId: { $in: visibleBatchIds },
            studentId: user.sub
          })
          .exec()
      : Promise.resolve([]);
    const whiteboardStatesPromise: Promise<ClassSessionWhiteboardStateMongoDocument[]> = completedSessionIds.length
      ? this.whiteboardStates
          .find({
            sessionId: { $in: completedSessionIds },
            batchId: { $in: visibleBatchIds },
            publishedAt: { $exists: true },
            unpublishedAt: { $exists: false }
          })
          .exec()
      : Promise.resolve([]);
    const attendancePointsPromise: Promise<StudentProgressAttendancePoint[]> = Promise.all(
      completedSessions.map((session) => this.studentProgressAttendancePoint(session, user.sub))
    );
    const [submissions, activityEvents, recordings, qnaStates, whiteboardStates, attendancePoints] = await Promise.all([
      submissionsPromise,
      activityEventsPromise,
      recordingsPromise,
      qnaStatesPromise,
      whiteboardStatesPromise,
      attendancePointsPromise
    ]);
    const publishedRecordings = recordings.filter((recording) => this.isPostClassRecordingPublished(recording));
    const recordingProgress = await this.recordings.listPlaybackProgressForStudent(
      publishedRecordings.map((recording) => recording.recordingId ?? recording.id).filter(Boolean),
      user.sub
    );
    const recordingProgressById = new Map(recordingProgress.map((progress) => [progress.recordingId, progress]));

    const sessionsByBatch = this.groupBy(sessions, (session) => session.batchId);
    const assignmentsByBatch = this.groupBy(assignments, (assignment) => assignment.batchId);
    const submissionsByAssignment = new Map(submissions.map((submission) => [submission.assignmentId, submission]));
    const studentEvents = activityEvents.filter((event) => this.isStudentProgressEventForUser(event, user.sub));
    const eventsByBatch = this.groupBy(studentEvents, (event) => event.batchId ?? '');
    const recordingsByBatch = this.groupBy(publishedRecordings, (recording) => recording.batchId ?? '');
    const qnaByBatch = this.groupBy(qnaStates, (state) => state.batchId);
    const whiteboardTopicsByBatch = this.groupBy(this.whiteboardTopicSources(whiteboardStates), (source) => source.batchId);
    const attendanceBySession = new Map(attendancePoints.map((point) => [point.sessionId, point]));

    const batches: StudentProgressBatchSummary[] = visibleBatchIds
      .map((batchId): StudentProgressBatchSummary | null => {
        const batch = batchMap.get(batchId);
        if (!batch) return null;
        const batchSessions = sessionsByBatch.get(batchId) ?? [];
        const batchCompletedSessions = batchSessions.filter((session) => session.status === 'completed');
        const batchAttendance = batchCompletedSessions
          .map((session) => attendanceBySession.get(session.id))
          .filter((point): point is StudentProgressAttendancePoint => Boolean(point));
        const recentAttendance = batchAttendance.slice(0, 8);
        const attendedClasses = batchAttendance.filter((point) => point.status === 'present').length;
        const missedClasses = batchAttendance.filter((point) => point.status === 'absent').length;
        const unknownAttendanceClasses = batchAttendance.filter((point) => point.status === 'unknown').length;
        const attendanceDenominator = attendedClasses + missedClasses;
        const batchAssignments = assignmentsByBatch.get(batchId) ?? [];
        const batchAssignmentSummary = this.studentProgressAssignmentSummary(batchAssignments, submissionsByAssignment, now);
        const batchEvents = eventsByBatch.get(batchId) ?? [];
        const batchQnaStates = qnaByBatch.get(batchId) ?? [];
        const batchWhiteboardTopics = whiteboardTopicsByBatch.get(batchId) ?? [];
        const sourceSessionIds = batchCompletedSessions.map((session) => session.id);
        const sourceRecordingIds = (recordingsByBatch.get(batchId) ?? []).map((recording) => recording.recordingId ?? recording.id);
        return {
          batchId: batch.id,
          batchName: batch.name,
          ...(batch.courseId ? { courseId: batch.courseId } : {}),
          ...(batch.courseName ? { courseName: batch.courseName } : {}),
          teacherId: batch.teacherId,
          ...(teacherMap.get(batch.teacherId)?.displayName || teacherMap.get(batch.teacherId)?.name
            ? { teacherName: teacherMap.get(batch.teacherId)?.displayName ?? teacherMap.get(batch.teacherId)?.name }
            : {}),
          ...(batch.status ? { enrollmentStatus: String(batch.status).toLowerCase() } : {}),
          completedClasses: batchCompletedSessions.length,
          attendedClasses,
          missedClasses,
          unknownAttendanceClasses,
          liveClasses: batchSessions.filter((session) => session.status === 'live').length,
          upcomingClasses: batchSessions.filter((session) => session.status === 'scheduled' && session.scheduledAt.getTime() >= now).length,
          attendanceRate: attendanceDenominator ? Math.round((attendedClasses / attendanceDenominator) * 100) : 0,
          attendanceSource: this.studentProgressAttendanceSource(batchAttendance),
          assignments: batchAssignmentSummary,
          recordings: this.studentProgressRecordingSummary(recordingsByBatch.get(batchId) ?? [], recordingProgressById),
          participation: this.studentProgressParticipation(batchEvents, batchQnaStates),
          topicTags: [...new Set(batchWhiteboardTopics.map((topic) => topic.tag))].slice(0, 8),
          recentAttendance,
          sourceSessionIds,
          sourceAssignmentIds: batchAssignments.map((assignment) => assignment.assignmentId),
          sourceRecordingIds,
          sourceWhiteboardPageIds: batchWhiteboardTopics.map((topic) => topic.pageId)
        } satisfies StudentProgressBatchSummary;
      })
      .filter((item): item is StudentProgressBatchSummary => Boolean(item));

    return {
      generatedAt: generatedAt.toISOString(),
      studentId: user.sub,
      summary: this.studentProgressSummary(batches),
      batches,
      reviewSignals: this.studentProgressReviewSignals(batches, generatedAt),
      availability: {
        attendance: {
          available: completedSessions.length > 0,
          source: this.studentProgressAttendanceSource(attendancePoints),
          reason: completedSessions.length
            ? 'Attendance uses persisted snapshots when present, with existing room attendance inference for legacy sessions.'
            : 'No completed sessions are available yet.'
        },
        assignments: {
          available: assignments.length > 0,
          source: assignments.length ? 'metadata' : 'none',
          reason: assignments.length ? 'Assignment progress uses published assignments and your submission status.' : 'No published assignments are available yet.'
        },
        recordings: {
          available: publishedRecordings.length > 0,
          source: publishedRecordings.length ? 'progress' : 'none',
          reason: publishedRecordings.length
            ? 'Recording progress uses your persisted playback activity for published class recordings.'
            : 'No published recordings are available yet.'
        },
        participation: {
          available: studentEvents.length > 0,
          source: studentEvents.length ? 'activity' : 'none',
          reason: studentEvents.length ? 'Participation uses your class-session activity events.' : 'No participation events are recorded yet.'
        },
        qna: {
          available: qnaStates.length > 0,
          source: qnaStates.length ? 'metadata' : 'none',
          reason: qnaStates.length ? 'Q&A progress uses private thread workflow state only; message bodies are excluded.' : 'No post-class Q&A threads are available yet.'
        }
      }
    };

  }

  async getStudentCompletedSessionDetail(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<StudentCompletedClassDetailResponse> {
    this.assertStudentUser(user);
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    await this.assertCanReadClassSessionHistory(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    const teacherMap = await this.adminTeacherMap([persisted.teacherId]);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    const [row, recordings, materials, whiteboard, announcements, privateThread, chatSummary, attendance] = await Promise.all([
      this.toStudentCompletedClassRow(persisted, resolution.batch, teacherMap.get(persisted.teacherId), user),
      this.canViewRecordingContent(liveSettings, resolution.batch, user)
        ? this.recordings
            .listAuthorizedClassSessionRecordings(resolution.planned.id)
            .then((items) => items.filter((recording) => this.isPostClassRecordingPublished(recording)))
        : Promise.resolve([]),
      this.studentCompletedMaterials(resolution, liveSettings),
      this.studentCompletedWhiteboardSummary(resolution),
      this.rooms.getClassSessionPostClassStudentChatHistory({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: persisted.roomId,
        channelId: persisted.chatChannelId,
        teacherId: resolution.batch.teacherId,
        studentId: user.sub,
        scope: 'broadcast',
        limit: 100
      }),
      this.rooms.getClassSessionPostClassStudentChatHistory({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: persisted.roomId,
        channelId: persisted.chatChannelId,
        teacherId: resolution.batch.teacherId,
        studentId: user.sub,
        scope: 'private',
        limit: 100
      }),
      this.rooms.getClassSessionPostClassStudentChatSummary({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: persisted.roomId,
        teacherId: resolution.batch.teacherId,
        studentId: user.sub
      }),
      this.studentAttendanceForSession(persisted, user.sub)
    ]);
    if (!row) {
      throw new NotFoundException('Completed class session not found.');
    }
    const playbackProgress = await this.recordings.listPlaybackProgressForStudent(
      recordings.map((recording) => recording.recordingId ?? recording.id).filter(Boolean),
      user.sub
    );
    const playbackProgressById = new Map(playbackProgress.map((progress) => [progress.recordingId, progress]));
    const recordingsWithProgress = recordings.map((recording) => ({
      ...recording,
      ...(playbackProgressById.get(recording.recordingId ?? recording.id)
        ? { playbackProgress: playbackProgressById.get(recording.recordingId ?? recording.id) }
        : {})
    }));
    return {
      session: row,
      recordings: recordingsWithProgress,
      materials,
      whiteboard,
      announcements: announcements.messages,
      privateThread,
      chatSummary,
      attendance
    };
  }

  async sendPostClassQuestion(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    request: SendPostClassQuestionRequest
  ): Promise<ChatMessage> {
    const resolution = await this.resolveSession(sessionId, batchId ?? request.batchId);
    this.assertCompletedClassSession(resolution);
    await this.assertCanReadClassSessionHistory(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!liveSettings.chat.privateTeacherStudentChatEnabled) {
      throw new ForbiddenException('Private class chat is disabled for this class.');
    }
    const role = this.payloadRole(user, resolution.batch);
    let studentId = user.sub;
    if (role === 'student') {
      if (request.recipientId && request.recipientId !== resolution.batch.teacherId) {
        throw new ForbiddenException('Students can only message the teacher.');
      }
    } else {
      this.assertCanManageBatch(resolution.batch, user);
      if (!request.recipientId) {
        throw new BadRequestException('A student recipient is required.');
      }
      if (!(await this.studentEnrollments.isStudentHistoricallyEnrolledInBatch(request.recipientId, resolution.batch.id))) {
        throw new BadRequestException('Target student is not enrolled in this class history.');
      }
      studentId = request.recipientId;
    }
    const senderName = await this.userDisplayName(user);
    const message = await this.rooms.sendClassSessionPostClassPrivateMessage({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      channelId: persisted.chatChannelId,
      teacherId: resolution.batch.teacherId,
      senderId: user.sub,
      senderName,
      senderRole: role,
      studentId,
      message: request.message,
      maxMessageLength: liveSettings.chat.messageLengthLimit
    });
    await this.activity?.record({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      eventType: role === 'student' ? 'post_class.question.asked' : 'post_class.question.replied',
      category: 'chat',
      summary: role === 'student' ? 'Student asked a private post-class question' : 'Teacher replied to a private post-class question',
      actor: { id: user.sub, name: senderName, email: user.email, roles: user.roles },
      target: {
        userId: role === 'student' ? resolution.batch.teacherId : studentId,
        type: role === 'student' ? 'teacher' : 'student'
      },
      source: { collection: 'chat', id: message.id },
      visibility: 'actor_only',
      metadata: { scope: 'private', phase: 'post_class' }
    });
    return message;
  }

  async getPostClassChatSummary(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser
  ): Promise<ChatThreadSummaryResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    return this.rooms.getClassSessionPostClassTeacherChatSummary({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub
    });
  }

  async getPostClassChatHistory(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    options: { participantId?: string; before?: string; limit?: number } = {}
  ): Promise<ChatHistoryResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const persisted = resolution.persisted;
    if (!persisted) {
      throw new NotFoundException('Completed class session not found.');
    }
    if (!options.participantId) {
      throw new BadRequestException('Student participant id is required for post-class Q&A.');
    }
    return this.rooms.getClassSessionPostClassTeacherChatHistory({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted.roomId,
      teacherId: resolution.batch.teacherId,
      participantId: options.participantId,
      before: options.before,
      limit: options.limit
    });
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
    await this.assertCanReadClassSessionForResolution(resolution, user);
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
    await this.assertCanReadClassSessionForResolution(resolution, user);
    const state = await this.whiteboardStates.findOne({ sessionId: resolution.planned.id, batchId: resolution.batch.id });
    if (
      state &&
      this.payloadRole(user, resolution.batch) === 'student' &&
      (resolution.persisted?.status === 'completed' || resolution.persisted?.status === 'cancelled') &&
      !this.isPostClassWhiteboardPublished(state)
    ) {
      return null;
    }
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
        compactedThroughSeq: previous?.lastOperationSeq ?? previous?.compactedThroughSeq ?? 0,
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
    await this.assertCanReadClassSessionForResolution(resolution, user);
    const search = this.cleanWhiteboardText(query ?? '', 80).toLowerCase();
    const role = this.payloadRole(user, resolution.batch);
    const allStates = await this.whiteboardStates.find({ batchId: resolution.batch.id }).sort({ updatedAt: -1 }).limit(50).exec();
    const states =
      role === 'student'
        ? allStates.filter((state) => {
            if (state.sessionId !== resolution.planned.id) {
              return this.isPostClassWhiteboardPublished(state);
            }
            return resolution.persisted?.status === 'live' || this.isPostClassWhiteboardPublished(state);
          })
        : allStates;
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

  private async updatePostClassMaterialPublication(
    sessionId: string,
    materialId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    published: boolean
  ): Promise<ClassSessionMaterial> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    this.assertMaterialsEnabled(liveSettings);
    if (!liveSettings.materials.publishMaterialsAfterClass) {
      throw new ForbiddenException('Post-class material publishing is disabled for this class.');
    }
    const now = new Date();
    const update = published
      ? {
          $set: {
            publishedAt: now,
            publishedByUserId: user.sub,
            shared: true
          },
          $unset: {
            unpublishedAt: ''
          }
        }
      : {
          $set: {
            unpublishedAt: now,
            shared: false
          },
          $unset: {
            publishedAt: '',
            publishedByUserId: ''
          }
        };
    const material = await this.materials.findOneAndUpdate(
      {
        materialId,
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      },
      update,
      { new: true }
    );
    if (!material) {
      throw new NotFoundException('Class material not found.');
    }
    await this.recordClassSessionMaterialAudit(published ? 'publish' : 'unpublish', resolution, material, user);
    return this.toMaterialPayload(material);
  }

  private async updatePostClassRecordingPublication(
    sessionId: string,
    recordingId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    published: boolean
  ): Promise<Recording> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    if (!liveSettings.recording.recordingEnabled) {
      throw new ForbiddenException('Recordings are disabled for this class.');
    }
    return this.recordings.updateClassSessionRecordingPublication(resolution.planned.id, recordingId, user.sub, published);
  }

  private async updatePostClassWhiteboardPublication(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    published: boolean
  ): Promise<StudentCompletedClassWhiteboardSummary> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCompletedClassSession(resolution);
    this.assertCanManageBatch(resolution.batch, user);
    const now = new Date();
    const state = await this.whiteboardStates.findOneAndUpdate(
      {
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id
      },
      published
        ? {
            $set: {
              publishedAt: now,
              publishedByUserId: user.sub
            },
            $unset: {
              unpublishedAt: ''
            }
          }
        : {
            $set: {
              unpublishedAt: now
            },
            $unset: {
              publishedAt: '',
              publishedByUserId: ''
            }
          },
      { new: true }
    );
    if (!state) {
      throw new NotFoundException('Whiteboard snapshot not found.');
    }
    await this.activity?.record({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: resolution.persisted?.roomId,
      eventType: published ? 'whiteboard.post_class_published' : 'whiteboard.post_class_unpublished',
      category: 'whiteboard',
      summary: published ? 'Published post-class whiteboard notes' : 'Unpublished post-class whiteboard notes',
      actor: { id: user.sub, email: user.email, roles: user.roles },
      visibility: 'student_safe',
      metadata: {
        snapshotVersion: state.snapshotVersion,
        pageCount: state.pageCount,
        elementCount: state.elementCount
      }
    });
    return this.studentCompletedWhiteboardSummary(resolution, { includeUnpublished: true });
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

  async getTimeline(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    options: { before?: string; limit?: number; category?: ClassSessionTimelineCategory | 'all' } = {}
  ): Promise<ClassSessionTimelineResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSessionForResolution(resolution, user);
    const fullAccess = this.isAdmin(user) || (user.roles.includes('TEACHER') && resolution.batch.teacherId === user.sub);
    return this.activity?.listTimeline({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      before: options.before,
      limit: options.limit,
      category: options.category,
      visibility: fullAccess ? 'full' : 'student_safe',
      audienceIds: [user.sub]
    }) ?? {
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      visibility: fullAccess ? 'full' : 'student_safe',
      items: [],
      limit: Number.isFinite(options.limit) ? Math.min(100, Math.max(1, Math.trunc(options.limit as number))) : 50,
      hasMore: false
    };
  }

  async getCurrentForBatch(batchId: string, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const batch = await this.findBatch(batchId);
    await this.assertCanReadClassSession(batch, user);
    const schedules = await this.findSchedules(batch.id);
    const persistedSessions = await this.classSessions.find({ batchId: batch.id }).sort({ scheduledAt: 1 }).exec();
    const sessions = this.mergeSessions(batch, schedules, persistedSessions);
    const live = sessions.find((session) => session.status === 'live');
    const now = Date.now();
    const nextScheduled = sessions.find((session) => session.status === 'scheduled' && session.planned.scheduledAt.getTime() >= now);
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
    await this.activity?.record({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: resolution.persisted?.roomId ?? classSessionChannelIds(resolution.planned.id).roomId,
      eventType: `session.join_${result}`,
      category: 'attendance',
      summary:
        result === 'admitted'
          ? `${role} was admitted to the class session`
          : `${role} class-session join was denied`,
      actor: { id: user.sub, email: user.email, roles: user.roles },
      visibility: result === 'admitted' ? 'actor_only' : 'full',
      metadata: { actorRole: role, result, reason: safeReason }
    });
  }

  private async recordClassSessionMaterialAudit(
    action: 'upload' | 'link' | 'share' | 'unshare' | 'publish' | 'unpublish' | 'download' | 'delete',
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
    const materialEventTypeByAction = {
      upload: 'material.uploaded',
      link: 'material.linked',
      share: 'material.shared',
      unshare: 'material.unshared',
      publish: 'material.published',
      unpublish: 'material.unpublished',
      download: 'material.downloaded',
      delete: 'material.deleted'
    } as const;
    await this.activity?.record({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: material.roomId ?? resolution.persisted?.roomId,
      eventType: materialEventTypeByAction[action],
      category: 'materials',
      summary:
        action === 'share'
          ? `Shared material ${material.title}`
          : action === 'unshare'
            ? `Stopped sharing material ${material.title}`
            : action === 'download'
              ? `Downloaded material ${material.title}`
              : action === 'delete'
                ? `Archived material ${material.title}`
                : `Added material ${material.title}`,
      actor: { id: user.sub, email: user.email, roles: user.roles },
      target: { id: material.materialId, name: material.title, type: 'material' },
      source: { collection: 'class_session_materials', id: material.materialId },
      visibility: action === 'share' || action === 'unshare' ? 'student_safe' : 'full',
      metadata: {
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

  private boundedTeacherAnalyticsQuery(query: TeacherAnalyticsQuery): BoundedTeacherAnalyticsQuery {
    const now = new Date();
    const dateTo = query.dateTo?.trim() ? this.parseAdminDate(query.dateTo, 'dateTo') : now;
    const dateFrom = query.dateFrom?.trim()
      ? this.parseAdminDate(query.dateFrom, 'dateFrom')
      : new Date(dateTo.getTime() - ADMIN_ATTENDANCE_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    if (dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException('dateFrom must be before dateTo.');
    }
    if (dateTo.getTime() - dateFrom.getTime() > ADMIN_ATTENDANCE_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      throw new BadRequestException(`Teacher analytics date range cannot exceed ${ADMIN_ATTENDANCE_MAX_RANGE_DAYS} days.`);
    }
    return {
      ...(query.batchId?.trim() ? { batchId: query.batchId.trim() } : {}),
      ...(query.courseId?.trim() ? { courseId: query.courseId.trim() } : {}),
      ...(query.studentId?.trim() ? { studentId: query.studentId.trim() } : {}),
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString()
    };
  }

  private teacherAnalyticsBatchFilter(query: BoundedTeacherAnalyticsQuery, user: AuthenticatedUser): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      deletedAt: { $exists: false }
    };
    if (!this.isAdmin(user)) {
      filter.teacherId = user.sub;
    }
    if (query.batchId) {
      filter._id = query.batchId;
    }
    if (query.courseId) {
      filter.courseId = query.courseId;
    }
    return filter;
  }

  private teacherAnalyticsAssignmentFilter(
    batchIds: string[],
    query: BoundedTeacherAnalyticsQuery,
    dateFrom: Date,
    dateTo: Date
  ): Record<string, unknown> {
    const range = { $gte: dateFrom, $lte: dateTo };
    return {
      batchId: { $in: batchIds },
      deletedAt: { $exists: false },
      ...(query.courseId ? {} : {}),
      $or: [{ dueAt: range }, { dueAt: { $exists: false }, createdAt: range }]
    };
  }

  private emptyTeacherAnalyticsResponse(
    query: BoundedTeacherAnalyticsQuery,
    audience: TeacherAnalyticsResponse['audience']
  ): TeacherAnalyticsResponse {
    return {
      generatedAt: new Date().toISOString(),
      query,
      audience,
      summary: this.emptyTeacherAnalyticsSummary(),
      batches: [],
      risks: [],
      weakTopicSignals: [],
      availability: {
        attendance: { available: false, source: 'not_tracked', reason: 'No matching batches are available.' },
        participation: { available: false, source: 'not_tracked', reason: 'No matching batches are available.' },
        qna: { available: false, source: 'not_tracked', reason: 'No matching batches are available.' },
        assignments: { available: false, source: 'not_tracked', reason: 'No matching batches are available.' },
        recordings: { available: false, source: 'not_tracked', reason: 'No matching batches are available.' },
        materials: { available: false, source: 'not_tracked', reason: 'No matching batches are available.' }
      }
    };
  }

  private emptyStudentProgressResponse(studentId: string, generatedAt: Date, reason: string): StudentProgressResponse {
    return {
      generatedAt: generatedAt.toISOString(),
      studentId,
      summary: this.emptyStudentProgressSummary(),
      batches: [],
      reviewSignals: [],
      availability: {
        attendance: { available: false, source: 'none', reason },
        assignments: { available: false, source: 'none', reason },
        recordings: { available: false, source: 'none', reason: 'No published recordings are available yet.' },
        participation: { available: false, source: 'none', reason },
        qna: { available: false, source: 'none', reason }
      }
    };
  }

  private emptyStudentProgressSummary(): StudentProgressSummary {
    return {
      enrolledBatches: 0,
      activeBatches: 0,
      completedClasses: 0,
      attendedClasses: 0,
      missedClasses: 0,
      unknownAttendanceClasses: 0,
      liveClasses: 0,
      upcomingClasses: 0,
      attendanceRate: 0,
      assignmentsDue: 0,
      assignmentsSubmitted: 0,
      assignmentsReviewed: 0,
      assignmentsOverdue: 0,
      assignmentsMissing: 0,
      recordingsReady: 0,
      recordingsWatched: 0,
      recordingsUnwatched: 0,
      recordingWatchSeconds: 0,
      recordingCompletionRate: 0,
      handRaises: 0,
      allowedSpeakingTurns: 0,
      questionsAsked: 0,
      unansweredQuestions: 0
    };
  }

  private async studentProgressAttendancePoint(session: ClassSessionMongoDocument, studentId: string): Promise<StudentProgressAttendancePoint> {
    const attendance = await this.studentAttendanceForSession(session, studentId);
    return {
      sessionId: session.id,
      title: session.title,
      scheduledAt: session.scheduledAt.toISOString(),
      ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {}),
      status: attendance.status,
      totalDurationSeconds: attendance.totalDurationSeconds,
      reconnectCount: attendance.reconnectCount,
      source: attendance.source
    };
  }

  private studentProgressAssignmentSummary(
    assignments: AssignmentMongoDocument[],
    submissionsByAssignment: Map<string, AssignmentSubmissionMongoDocument>,
    now: number
  ): StudentProgressAssignmentSummary {
    const summary: StudentProgressAssignmentSummary = {
      total: assignments.length,
      due: 0,
      submitted: 0,
      reviewed: 0,
      overdue: 0,
      missing: 0
    };
    for (const assignment of assignments) {
      const submission = submissionsByAssignment.get(assignment.assignmentId);
      const submitted = submission ? this.isSubmittedAssignmentStatus(submission.status) : false;
      const reviewed = submission ? this.isReviewedAssignmentStatus(submission.status) : false;
      if (submitted) {
        summary.submitted += 1;
      }
      if (reviewed) {
        summary.reviewed += 1;
      }
      if (!reviewed) {
        summary.due += 1;
      }
      if (!submitted) {
        summary.missing += 1;
      }
      if (!submitted && assignment.dueAt && assignment.dueAt.getTime() < now) {
        summary.overdue += 1;
      }
    }
    return summary;
  }

  private studentProgressRecordingSummary(
    recordings: Recording[],
    progressByRecordingId: Map<string, RecordingPlaybackProgress> = new Map()
  ): StudentProgressRecordingSummary {
    const ready = recordings.filter((recording) => recording.status === 'stopped');
    const progressRows = ready
      .map((recording) => progressByRecordingId.get(recording.recordingId ?? recording.id))
      .filter((progress): progress is RecordingPlaybackProgress => Boolean(progress));
    const watched = progressRows.filter((progress) => progress.playCount > 0 || progress.completionPercent > 0).length;
    const completionRate = progressRows.length
      ? Math.round(progressRows.reduce((total, progress) => total + progress.completionPercent, 0) / progressRows.length)
      : 0;
    return {
      ready: ready.length,
      processing: recordings.filter((recording) => recording.status === 'starting' || recording.status === 'recording' || recording.status === 'stopping').length,
      failed: recordings.filter((recording) => recording.status === 'failed').length,
      watched,
      unwatched: Math.max(ready.length - watched, 0),
      totalWatchedSeconds: progressRows.reduce((total, progress) => total + progress.watchedSeconds, 0),
      completionRate,
      watchTrackingAvailable: true,
      usage: {
        available: ready.length > 0,
        source: ready.length > 0 ? 'progress' : 'none',
        reason: ready.length > 0
          ? 'Recording usage uses your persisted playback progress for published recordings.'
          : 'No ready published recordings are available for this batch yet.'
      }
    };
  }

  private studentProgressParticipation(
    events: ClassSessionTimelineEvent[],
    qnaStates: ClassSessionPostClassThreadStateMongoDocument[]
  ): StudentProgressParticipationSummary {
    const questionEvents = events.filter((event) => event.eventType === 'post_class.question.asked').length;
    return {
      handRaises: events.filter((event) => event.eventType === 'hand.raised').length,
      allowedSpeakingTurns: events.filter((event) => event.eventType === 'speak.allowed').length,
      questionsAsked: Math.max(questionEvents, qnaStates.length),
      answeredQuestions: qnaStates.filter((state) => state.answered).length,
      unansweredQuestions: qnaStates.filter((state) => !state.answered).length,
      qnaThreads: qnaStates.length
    };
  }

  private isStudentProgressEventForUser(event: ClassSessionTimelineEvent, studentId: string): boolean {
    return event.actor?.id === studentId || event.target?.userId === studentId || event.target?.id === studentId;
  }

  private studentProgressSummary(batches: StudentProgressBatchSummary[]): StudentProgressSummary {
    const summary = this.emptyStudentProgressSummary();
    summary.enrolledBatches = batches.length;
    summary.activeBatches = batches.filter((batch) => !batch.enrollmentStatus || batch.enrollmentStatus === 'active').length;
    summary.completedClasses = batches.reduce((total, batch) => total + batch.completedClasses, 0);
    summary.attendedClasses = batches.reduce((total, batch) => total + batch.attendedClasses, 0);
    summary.missedClasses = batches.reduce((total, batch) => total + batch.missedClasses, 0);
    summary.unknownAttendanceClasses = batches.reduce((total, batch) => total + batch.unknownAttendanceClasses, 0);
    summary.liveClasses = batches.reduce((total, batch) => total + batch.liveClasses, 0);
    summary.upcomingClasses = batches.reduce((total, batch) => total + batch.upcomingClasses, 0);
    const attendanceDenominator = summary.attendedClasses + summary.missedClasses;
    summary.attendanceRate = attendanceDenominator ? Math.round((summary.attendedClasses / attendanceDenominator) * 100) : 0;
    summary.assignmentsDue = batches.reduce((total, batch) => total + batch.assignments.due, 0);
    summary.assignmentsSubmitted = batches.reduce((total, batch) => total + batch.assignments.submitted, 0);
    summary.assignmentsReviewed = batches.reduce((total, batch) => total + batch.assignments.reviewed, 0);
    summary.assignmentsOverdue = batches.reduce((total, batch) => total + batch.assignments.overdue, 0);
    summary.assignmentsMissing = batches.reduce((total, batch) => total + batch.assignments.missing, 0);
    summary.recordingsReady = batches.reduce((total, batch) => total + batch.recordings.ready, 0);
    summary.recordingsWatched = batches.reduce((total, batch) => total + (batch.recordings.watched ?? 0), 0);
    summary.recordingsUnwatched = batches.reduce((total, batch) => total + (batch.recordings.unwatched ?? 0), 0);
    summary.recordingWatchSeconds = batches.reduce((total, batch) => total + (batch.recordings.totalWatchedSeconds ?? 0), 0);
    summary.recordingCompletionRate = summary.recordingsReady
      ? Math.round(batches.reduce((total, batch) => total + (batch.recordings.completionRate ?? 0) * batch.recordings.ready, 0) / summary.recordingsReady)
      : 0;
    summary.handRaises = batches.reduce((total, batch) => total + batch.participation.handRaises, 0);
    summary.allowedSpeakingTurns = batches.reduce((total, batch) => total + batch.participation.allowedSpeakingTurns, 0);
    summary.questionsAsked = batches.reduce((total, batch) => total + batch.participation.questionsAsked, 0);
    summary.unansweredQuestions = batches.reduce((total, batch) => total + batch.participation.unansweredQuestions, 0);
    return summary;
  }

  private studentProgressReviewSignals(batches: StudentProgressBatchSummary[], generatedAt: Date): StudentProgressReviewSignal[] {
    const signals: StudentProgressReviewSignal[] = [];
    const generated = generatedAt.toISOString();
    for (const batch of batches) {
      if (batch.completedClasses >= 3 && batch.attendanceRate < 75) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'missed_class', batch.sourceSessionIds),
          type: 'missed_class',
          category: 'attendance',
          severity: 'needs_attention',
          confidence: 'high',
          batchId: batch.batchId,
          batchName: batch.batchName,
          label: 'Attendance needs attention',
          explanation: `${batch.missedClasses} missed completed classes and ${batch.attendanceRate}% attendance in ${batch.batchName}.`,
          detail: `${batch.missedClasses} missed completed classes in ${batch.batchName}.`,
          sourceRecords: this.recommendationSources('session', batch.sourceSessionIds, batch.batchId),
          generatedAt: generated,
          sourceSessionIds: batch.sourceSessionIds
        });
      } else if (batch.missedClasses > 0) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'missed_class', batch.sourceSessionIds),
          type: 'missed_class',
          category: 'attendance',
          severity: 'watch',
          confidence: 'high',
          batchId: batch.batchId,
          batchName: batch.batchName,
          label: 'Review missed class',
          explanation: `${batch.missedClasses} completed class${batch.missedClasses === 1 ? ' was' : 'es were'} marked absent from attendance records.`,
          detail: `${batch.missedClasses} completed class${batch.missedClasses === 1 ? ' was' : 'es were'} marked absent.`,
          sourceRecords: this.recommendationSources('session', batch.sourceSessionIds, batch.batchId),
          generatedAt: generated,
          sourceSessionIds: batch.sourceSessionIds
        });
      }
      if (batch.assignments.overdue > 0 || batch.assignments.missing >= 2) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'overdue_assignment', batch.sourceAssignmentIds),
          type: batch.assignments.overdue > 0 ? 'overdue_assignment' : 'weak_assignment_area',
          category: 'assignment',
          severity: batch.assignments.overdue > 0 ? 'needs_attention' : 'watch',
          confidence: 'high',
          batchId: batch.batchId,
          batchName: batch.batchName,
          label: 'Assignment follow-up',
          explanation: `${batch.assignments.overdue} overdue and ${batch.assignments.missing} missing assignment${batch.assignments.missing === 1 ? '' : 's'} are recorded for this batch.`,
          detail: `${batch.assignments.overdue} overdue and ${batch.assignments.missing} not submitted assignment${batch.assignments.missing === 1 ? '' : 's'}.`,
          sourceRecords: this.recommendationSources('assignment', batch.sourceAssignmentIds, batch.batchId),
          generatedAt: generated,
          sourceAssignmentIds: batch.sourceAssignmentIds
        });
      }
      if ((batch.recordings.unwatched ?? 0) > 0 || (batch.recordings.ready > 0 && (batch.recordings.completionRate ?? 0) < 60)) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'low_recording_completion', batch.sourceRecordingIds ?? []),
          type: 'low_recording_completion',
          category: 'recording',
          severity: (batch.recordings.unwatched ?? 0) >= 2 || (batch.recordings.completionRate ?? 0) < 40 ? 'watch' : 'info',
          confidence: 'medium',
          batchId: batch.batchId,
          batchName: batch.batchName,
          recordingId: batch.sourceRecordingIds?.[0],
          label: 'Review class recordings',
          explanation: `${batch.recordings.watched ?? 0} of ${batch.recordings.ready} published recordings have recorded playback progress, with ${batch.recordings.completionRate ?? 0}% average completion.`,
          detail: `${batch.recordings.unwatched ?? 0} recording${(batch.recordings.unwatched ?? 0) === 1 ? '' : 's'} still need review.`,
          sourceRecords: this.recommendationSources('recording', batch.sourceRecordingIds ?? [], batch.batchId),
          generatedAt: generated,
          sourceRecordingIds: batch.sourceRecordingIds
        });
      }
      if (batch.completedClasses >= 3 && batch.participation.handRaises + batch.participation.allowedSpeakingTurns + batch.participation.questionsAsked === 0) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'low_participation', batch.sourceSessionIds),
          type: 'low_participation',
          category: 'participation',
          severity: 'info',
          confidence: 'medium',
          batchId: batch.batchId,
          batchName: batch.batchName,
          label: 'Low recorded participation',
          explanation: `${batch.completedClasses} completed classes have no hand raises, speaking turns, or post-class questions recorded for you.`,
          detail: 'No hand raises, speaking turns, or post-class questions have been recorded for this batch.',
          sourceRecords: this.recommendationSources('participation', batch.sourceSessionIds, batch.batchId),
          generatedAt: generated,
          sourceSessionIds: batch.sourceSessionIds
        });
      }
      if (batch.participation.unansweredQuestions > 0) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'unanswered_question', batch.sourceSessionIds),
          type: 'unanswered_question',
          category: 'qna',
          severity: 'watch',
          confidence: 'high',
          batchId: batch.batchId,
          batchName: batch.batchName,
          label: 'Open Q&A',
          explanation: `${batch.participation.unansweredQuestions} private post-class question${batch.participation.unansweredQuestions === 1 ? ' is' : 's are'} still marked unanswered.`,
          detail: `${batch.participation.unansweredQuestions} private post-class question${batch.participation.unansweredQuestions === 1 ? ' is' : 's are'} still unanswered.`,
          sourceRecords: this.recommendationSources('qna', batch.sourceSessionIds, batch.batchId),
          generatedAt: generated,
          sourceSessionIds: batch.sourceSessionIds
        });
      }
      if (batch.recordings.ready === 0 && batch.completedClasses > 0) {
        signals.push({
          id: this.signalId('student', batch.batchId, 'recording', batch.sourceSessionIds),
          type: 'recording',
          category: 'recording',
          severity: 'info',
          confidence: 'medium',
          batchId: batch.batchId,
          batchName: batch.batchName,
          label: 'No published recordings yet',
          explanation: 'Completed sessions exist, but there is no teacher-published recording source for this batch yet.',
          detail: 'Completed sessions exist, but no teacher-published recording is available for review.',
          sourceRecords: this.recommendationSources('session', batch.sourceSessionIds, batch.batchId),
          generatedAt: generated,
          sourceSessionIds: batch.sourceSessionIds
        });
      }
      if (batch.topicTags?.length && (batch.missedClasses > 0 || (batch.recordings.unwatched ?? 0) > 0 || batch.assignments.missing > 0)) {
        const topic = batch.topicTags[0]!;
        signals.push({
          id: this.signalId('student', batch.batchId, 'tagged_topic_review', [topic, ...(batch.sourceWhiteboardPageIds ?? [])]),
          type: 'tagged_topic_review',
          category: 'topic',
          severity: batch.assignments.overdue > 0 || batch.missedClasses >= 2 ? 'watch' : 'info',
          confidence: 'medium',
          batchId: batch.batchId,
          batchName: batch.batchName,
          topic,
          tag: topic,
          label: `Review ${topic}`,
          explanation: `Whiteboard notes include the "${topic}" tag, and this batch has missed, unwatched, or incomplete learning records.`,
          detail: `Review ${topic} from the linked class notes and related class materials.`,
          sourceRecords: [
            ...this.recommendationSources('whiteboard', batch.sourceWhiteboardPageIds ?? [], batch.batchId),
            ...this.recommendationSources('session', batch.sourceSessionIds, batch.batchId)
          ],
          generatedAt: generated,
          sourceSessionIds: batch.sourceSessionIds,
          sourceWhiteboardPageIds: batch.sourceWhiteboardPageIds
        });
      }
    }
    return signals.sort((left, right) => this.signalRank(right.severity) - this.signalRank(left.severity)).slice(0, 8);
  }

  private recommendationSources(kind: RecommendationSource['kind'], ids: string[], batchId?: string): RecommendationSource[] {
    return [...new Set(ids.filter(Boolean))].slice(0, 8).map((id) => ({
      kind,
      id,
      ...(batchId ? { batchId } : {}),
      ...(kind === 'session' || kind === 'qna' ? { sessionId: id } : {})
    }));
  }

  private signalId(scope: string, batchId: string, type: string, parts: string[] = []): string {
    const seed = [scope, batchId, type, ...parts.filter(Boolean).slice(0, 4)].join(':');
    return seed.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 180);
  }

  private signalRank(severity: 'info' | 'watch' | 'needs_attention'): number {
    if (severity === 'needs_attention') return 3;
    if (severity === 'watch') return 2;
    return 1;
  }

  private whiteboardTopicSources(states: ClassSessionWhiteboardStateMongoDocument[]): WhiteboardTopicSignalSource[] {
    const sources: WhiteboardTopicSignalSource[] = [];
    for (const state of states) {
      for (const page of state.pages ?? []) {
        for (const tag of page.tags ?? []) {
          const normalized = this.normalizeTopicTag(tag);
          if (!normalized) continue;
          sources.push({
            tag: normalized,
            sessionId: state.sessionId,
            batchId: state.batchId,
            pageId: page.pageId,
            pageTitle: page.title
          });
        }
      }
    }
    return sources;
  }

  private normalizeTopicTag(value: unknown): string {
    return String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
  }

  private studentProgressAttendanceSource(points: Array<StudentProgressAttendancePoint | undefined>): StudentProgressBatchSummary['attendanceSource'] {
    const sources = new Set(points.map((point) => point?.source).filter((source): source is StudentProgressAttendancePoint['source'] => Boolean(source)));
    sources.delete('none');
    if (!sources.size) {
      return 'none';
    }
    return sources.size > 1 ? 'mixed' : [...sources][0]!;
  }

  private emptyTeacherAnalyticsSummary(): TeacherAnalyticsSummary {
    return {
      batchCount: 0,
      enrolledStudents: 0,
      totalSessions: 0,
      completedSessions: 0,
      liveSessions: 0,
      upcomingSessions: 0,
      attendanceRate: 0,
      missedClasses: 0,
      lateJoins: 0,
      reconnects: 0,
      handRaises: 0,
      allowedSpeakingTurns: 0,
      questionsAsked: 0,
      unansweredQuestions: 0,
      assignmentsDue: 0,
      assignmentsSubmitted: 0,
      assignmentsReviewed: 0,
      assignmentsOverdue: 0,
      assignmentsMissing: 0,
      recordingsReady: 0,
      materialDownloads: 0,
      riskStudents: 0,
      weakTopicSignals: 0
    };
  }

  private async teacherAnalyticsAttendance(
    sessions: ClassSessionMongoDocument[],
    studentId: string | undefined,
    students: Map<string, TeacherAnalyticsStudentAccumulator>
  ): Promise<TeacherAnalyticsAttendanceSummary> {
    const summary: TeacherAnalyticsAttendanceSummary = {
      enrolledSlots: 0,
      present: 0,
      absent: 0,
      attendanceRate: 0,
      missedClasses: 0,
      lateJoins: 0,
      reconnects: 0,
      averageDurationSeconds: 0,
      source: 'none'
    };
    if (!sessions.length) {
      return summary;
    }
    let snapshotSessions = 0;
    let inferredSessions = 0;
    let totalDuration = 0;
    let presentDurationRows = 0;
    for (const session of sessions) {
      const attendance = await this.adminAttendanceRowsForSession(session);
      if (attendance.source === 'snapshot') {
        snapshotSessions += 1;
      } else {
        inferredSessions += 1;
      }
      const rows = studentId ? attendance.rows.filter((row) => row.studentId === studentId) : attendance.rows;
      for (const row of rows) {
        summary.enrolledSlots += 1;
        const student = students.get(row.studentId);
        if (student) {
          student.sessionsEnrolled += 1;
          student.sourceSessionIds.add(session.id);
        }
        if (row.status === 'present') {
          summary.present += 1;
          summary.reconnects += row.reconnectCount;
          totalDuration += row.totalDurationSeconds;
          presentDurationRows += 1;
          if (student) {
            student.sessionsAttended += 1;
            student.reconnects += row.reconnectCount;
          }
          if (row.firstJoinAt && row.firstJoinAt.getTime() - session.scheduledAt.getTime() > this.lateJoinThresholdMs(session)) {
            summary.lateJoins += 1;
          }
        } else {
          summary.absent += 1;
          summary.missedClasses += 1;
          if (student) {
            student.missedClasses += 1;
          }
        }
      }
    }
    summary.attendanceRate = summary.enrolledSlots ? Math.round((summary.present / summary.enrolledSlots) * 100) : 0;
    summary.averageDurationSeconds = presentDurationRows ? Math.round(totalDuration / presentDurationRows) : 0;
    summary.source = snapshotSessions && inferredSessions ? 'mixed' : snapshotSessions ? 'snapshot' : inferredSessions ? 'inferred' : 'none';
    return summary;
  }

  private teacherAnalyticsParticipation(
    events: ClassSessionTimelineEvent[],
    studentId: string | undefined,
    students: Map<string, TeacherAnalyticsStudentAccumulator>,
    qnaStates: ClassSessionPostClassThreadStateMongoDocument[]
  ): TeacherAnalyticsParticipationSummary {
    const filtered = studentId
      ? events.filter((event) => event.actor?.id === studentId || event.target?.userId === studentId || event.target?.id === studentId)
      : events;
    const summary: TeacherAnalyticsParticipationSummary = {
      handRaises: filtered.filter((event) => event.eventType === 'hand.raised').length,
      allowedSpeakingTurns: filtered.filter((event) => event.eventType === 'speak.allowed').length,
      revokedSpeakingTurns: filtered.filter((event) => event.eventType === 'speak.revoked').length,
      questionsAsked: filtered.filter((event) => event.eventType === 'post_class.question.asked').length,
      qnaThreads: qnaStates.length,
      unansweredQuestions: qnaStates.filter((state) => !state.answered).length
    };
    for (const event of filtered) {
      const actorId = event.actor?.id;
      const targetId = event.target?.userId ?? event.target?.id;
      if (event.eventType === 'hand.raised' && actorId && students.has(actorId)) {
        students.get(actorId)!.handRaises += 1;
      }
      if (event.eventType === 'post_class.question.asked' && actorId && students.has(actorId)) {
        students.get(actorId)!.questionsAsked += 1;
      }
      if (event.eventType === 'speak.allowed' && targetId && students.has(targetId)) {
        students.get(targetId)!.allowedSpeakingTurns += 1;
      }
    }
    for (const state of qnaStates) {
      const student = students.get(state.studentId);
      if (student && !state.answered) {
        student.unansweredQuestions += 1;
      }
    }
    return summary;
  }

  private teacherAnalyticsAssignments(
    assignments: AssignmentMongoDocument[],
    submissions: AssignmentSubmissionMongoDocument[],
    rosterSize: number,
    studentId: string | undefined,
    students: Map<string, TeacherAnalyticsStudentAccumulator>
  ): TeacherAnalyticsAssignmentSummary {
    const now = Date.now();
    const summary: TeacherAnalyticsAssignmentSummary = {
      total: assignments.length,
      published: assignments.filter((assignment) => assignment.status === 'published').length,
      archived: assignments.filter((assignment) => assignment.status === 'archived').length,
      due: assignments.filter((assignment) => Boolean(assignment.dueAt)).length,
      overdue: assignments.filter((assignment) => assignment.status === 'published' && assignment.dueAt && assignment.dueAt.getTime() < now).length,
      missing: 0,
      submissions: this.emptyAssignmentSubmissionSummary()
    };
    for (const submission of submissions) {
      if (ASSIGNMENT_SUBMISSION_STATUS_KEYS.includes(submission.status as keyof AssignmentSubmissionSummary)) {
        summary.submissions[submission.status as keyof AssignmentSubmissionSummary] += 1;
      }
    }
    const submissionsByAssignment = this.groupBy(submissions, (submission) => submission.assignmentId);
    const scopedRosterSize = studentId ? students.size : rosterSize;
    for (const assignment of assignments) {
      const assignmentSubmissions = submissionsByAssignment.get(assignment.assignmentId) ?? [];
      const submittedCount = assignmentSubmissions.filter((submission) => this.isSubmittedAssignmentStatus(submission.status)).length;
      const missing = Math.max(scopedRosterSize - submittedCount, 0);
      summary.missing += missing;
      for (const student of students.values()) {
        student.assignmentsAssigned += 1;
        student.sourceAssignmentIds.add(assignment.assignmentId);
      }
      for (const submission of assignmentSubmissions) {
        const student = students.get(submission.studentId);
        if (!student) continue;
        if (this.isSubmittedAssignmentStatus(submission.status)) {
          student.assignmentsSubmitted += 1;
        }
        if (this.isReviewedAssignmentStatus(submission.status)) {
          student.assignmentsReviewed += 1;
        }
      }
      for (const student of students.values()) {
        if (!assignmentSubmissions.some((submission) => submission.studentId === student.studentId && this.isSubmittedAssignmentStatus(submission.status))) {
          student.assignmentsMissing += 1;
        }
      }
    }
    return summary;
  }

  private teacherAnalyticsRecordings(
    recordings: Recording[],
    progress: RecordingPlaybackProgressRecord[] = [],
    rosterSize = 0
  ): TeacherAnalyticsRecordingSummary {
    const ready = recordings.filter((recording) => recording.status === 'stopped');
    const readyIds = new Set(ready.map((recording) => recording.recordingId ?? recording.id));
    const progressRows = progress.filter((row) => readyIds.has(row.recordingId));
    const watchedStudents = new Set(progressRows.filter((row) => row.playCount > 0 || row.completionPercent > 0).map((row) => row.studentId));
    const averageCompletionPercent = progressRows.length
      ? Math.round(progressRows.reduce((total, row) => total + row.completionPercent, 0) / progressRows.length)
      : 0;
    return {
      total: recordings.length,
      ready: ready.length,
      failed: recordings.filter((recording) => recording.status === 'failed').length,
      active: recordings.filter((recording) => recording.status === 'starting' || recording.status === 'recording' || recording.status === 'stopping').length,
      watched: watchedStudents.size,
      unwatched: Math.max(rosterSize - watchedStudents.size, 0),
      averageCompletionPercent,
      totalWatchedSeconds: progressRows.reduce((total, row) => total + row.watchedSeconds, 0),
      usage: {
        available: ready.length > 0,
        source: ready.length > 0 ? 'progress' : 'metadata',
        reason: ready.length > 0
          ? 'Recording engagement uses persisted student playback progress for ready recordings.'
          : 'Only recording readiness metadata is available for this range.'
      }
    };
  }

  private teacherAnalyticsMaterials(
    materials: ClassSessionMaterialMongoDocument[],
    events: ClassSessionTimelineEvent[]
  ): TeacherAnalyticsMaterialSummary {
    const downloads = events.filter((event) => event.eventType === 'material.downloaded').length;
    return {
      total: materials.length,
      shared: materials.filter((material) => material.shared).length,
      published: materials.filter((material) => material.publishedAt && !material.unpublishedAt).length,
      downloads,
      usage: {
        available: downloads > 0,
        source: downloads > 0 ? 'activity' : 'metadata',
        reason: downloads > 0 ? 'Downloads are counted from material.downloaded activity events.' : 'Material metadata is available; no download events were recorded in this range.'
      }
    };
  }

  private teacherAnalyticsRisk(student: TeacherAnalyticsStudentAccumulator): TeacherAnalyticsRiskIndicator | null {
    const reasons: string[] = [];
    const attendanceRate = student.sessionsEnrolled ? Math.round((student.sessionsAttended / student.sessionsEnrolled) * 100) : 100;
    if (student.missedClasses >= 2 && attendanceRate < 75) {
      reasons.push(`${student.missedClasses} missed completed classes`);
    }
    if (student.assignmentsAssigned >= 2 && student.assignmentsSubmitted === 0) {
      reasons.push('No submitted assignments');
    } else if (student.assignmentsMissing >= 2) {
      reasons.push(`${student.assignmentsMissing} missing assignments`);
    }
    if (student.sessionsEnrolled >= 3 && student.handRaises + student.allowedSpeakingTurns + student.questionsAsked === 0) {
      reasons.push('Low recorded participation');
    }
    if (student.unansweredQuestions >= 2) {
      reasons.push(`${student.unansweredQuestions} unanswered private Q&A threads`);
    }
    if (!reasons.length) {
      return null;
    }
    const riskLevel: TeacherAnalyticsRiskLevel =
      reasons.length >= 2 || student.missedClasses >= 3 || student.assignmentsMissing >= 3 ? 'high' : 'medium';
    return {
      studentId: student.studentId,
      ...(student.studentName ? { studentName: student.studentName } : {}),
      ...(student.studentEmail ? { studentEmail: student.studentEmail } : {}),
      batchId: student.batchId,
      batchName: student.batchName,
      riskLevel,
      reasons,
      sourceSessionIds: [...student.sourceSessionIds],
      sourceAssignmentIds: [...student.sourceAssignmentIds]
    };
  }

  private teacherWeakTopicSignals(options: {
    batch: BatchMongoDocument;
    attendance: TeacherAnalyticsAttendanceSummary;
    participation: TeacherAnalyticsParticipationSummary;
    assignments: TeacherAnalyticsAssignmentSummary;
    recordings: TeacherAnalyticsRecordingSummary;
    materials: TeacherAnalyticsMaterialSummary;
    risks: TeacherAnalyticsRiskIndicator[];
    whiteboardTopics: WhiteboardTopicSignalSource[];
    sourceSessionIds: string[];
    sourceAssignmentIds: string[];
    generatedAt: Date;
  }): TeacherWeakTopicSignal[] {
    const generatedAt = options.generatedAt.toISOString();
    const signals: TeacherWeakTopicSignal[] = [];
    const batchName = options.batch.name;
    const base = {
      batchId: options.batch.id,
      batchName,
      ...(options.batch.courseId ? { courseId: options.batch.courseId } : {}),
      ...(options.batch.courseName ? { courseName: options.batch.courseName } : {}),
      generatedAt
    };
    if (options.attendance.missedClasses >= 2) {
      signals.push({
        ...base,
        id: this.signalId('teacher', options.batch.id, 'missed_class', options.sourceSessionIds),
        type: 'missed_class',
        severity: options.attendance.attendanceRate < 70 ? 'needs_attention' : 'watch',
        confidence: 'high',
        label: 'Attendance review',
        explanation: `${options.attendance.missedClasses} missed class records and ${options.attendance.attendanceRate}% attendance are recorded for ${batchName}.`,
        affectedStudentCount: Math.max(options.attendance.absent, 0),
        sourceRecords: this.recommendationSources('attendance', options.sourceSessionIds, options.batch.id),
        sourceSessionIds: options.sourceSessionIds,
        sourceAssignmentIds: []
      });
    }
    if (options.assignments.overdue > 0 || options.assignments.missing >= 2) {
      signals.push({
        ...base,
        id: this.signalId('teacher', options.batch.id, 'weak_assignment_area', options.sourceAssignmentIds),
        type: options.assignments.overdue > 0 ? 'overdue_assignment' : 'weak_assignment_area',
        severity: options.assignments.missing >= 3 || options.assignments.overdue > 0 ? 'needs_attention' : 'watch',
        confidence: 'high',
        label: 'Assignment gap',
        explanation: `${options.assignments.missing} missing and ${options.assignments.overdue} overdue assignment slots are recorded for ${batchName}.`,
        affectedStudentCount: options.assignments.missing,
        sourceRecords: this.recommendationSources('assignment', options.sourceAssignmentIds, options.batch.id),
        sourceSessionIds: options.sourceSessionIds,
        sourceAssignmentIds: options.sourceAssignmentIds
      });
    }
    if (options.recordings.ready > 0 && ((options.recordings.unwatched ?? 0) > 0 || (options.recordings.averageCompletionPercent ?? 0) < 60)) {
      signals.push({
        ...base,
        id: this.signalId('teacher', options.batch.id, 'low_recording_completion', options.sourceSessionIds),
        type: 'low_recording_completion',
        severity: (options.recordings.averageCompletionPercent ?? 0) < 40 ? 'watch' : 'info',
        confidence: 'medium',
        label: 'Recording review gap',
        explanation: `${options.recordings.watched ?? 0} students have watched recordings, ${options.recordings.unwatched ?? 0} have no recorded playback, and average completion is ${options.recordings.averageCompletionPercent ?? 0}%.`,
        affectedStudentCount: options.recordings.unwatched ?? 0,
        sourceRecords: this.recommendationSources('session', options.sourceSessionIds, options.batch.id),
        sourceSessionIds: options.sourceSessionIds,
        sourceAssignmentIds: []
      });
    }
    if (options.participation.unansweredQuestions >= 2) {
      signals.push({
        ...base,
        id: this.signalId('teacher', options.batch.id, 'unanswered_question', options.sourceSessionIds),
        type: 'unanswered_question',
        severity: 'watch',
        confidence: 'high',
        label: 'Open post-class Q&A',
        explanation: `${options.participation.unansweredQuestions} private post-class Q&A threads are still unanswered. Message bodies are excluded from analytics.`,
        affectedStudentCount: options.participation.unansweredQuestions,
        sourceRecords: this.recommendationSources('qna', options.sourceSessionIds, options.batch.id),
        sourceSessionIds: options.sourceSessionIds,
        sourceAssignmentIds: []
      });
    }
    if (options.sourceSessionIds.length >= 3 && options.participation.handRaises + options.participation.allowedSpeakingTurns + options.participation.questionsAsked === 0) {
      signals.push({
        ...base,
        id: this.signalId('teacher', options.batch.id, 'low_participation', options.sourceSessionIds),
        type: 'low_participation',
        severity: 'info',
        confidence: 'medium',
        label: 'Low participation pattern',
        explanation: `${batchName} has no recorded hand raises, speaking turns, or questions in the selected range.`,
        affectedStudentCount: options.risks.filter((risk) => risk.reasons.some((reason) => reason.includes('Low recorded participation'))).length,
        sourceRecords: this.recommendationSources('participation', options.sourceSessionIds, options.batch.id),
        sourceSessionIds: options.sourceSessionIds,
        sourceAssignmentIds: []
      });
    }
    const topicCounts = new Map<string, WhiteboardTopicSignalSource[]>();
    for (const topic of options.whiteboardTopics) {
      topicCounts.set(topic.tag, [...(topicCounts.get(topic.tag) ?? []), topic]);
    }
    const topic = [...topicCounts.entries()].sort((left, right) => right[1].length - left[1].length)[0];
    if (topic && (options.assignments.missing > 0 || options.attendance.missedClasses > 0 || (options.recordings.unwatched ?? 0) > 0)) {
      const [tag, sources] = topic;
      signals.push({
        ...base,
        id: this.signalId('teacher', options.batch.id, 'tagged_topic_review', [tag, ...sources.map((source) => source.pageId)]),
        type: 'tagged_topic_review',
        severity: options.assignments.missing >= 2 || options.attendance.missedClasses >= 2 ? 'watch' : 'info',
        confidence: 'medium',
        tag,
        topic: tag,
        label: `Topic review: ${tag}`,
        explanation: `Whiteboard pages are tagged "${tag}", and this batch also has missed, incomplete, or unwatched review signals.`,
        affectedStudentCount: Math.max(options.risks.length, options.assignments.missing, options.attendance.absent, options.recordings.unwatched ?? 0),
        sourceRecords: [
          ...this.recommendationSources('whiteboard', sources.map((source) => source.pageId), options.batch.id),
          ...this.recommendationSources('session', [...new Set(sources.map((source) => source.sessionId))], options.batch.id)
        ],
        sourceSessionIds: [...new Set(sources.map((source) => source.sessionId))],
        sourceAssignmentIds: options.sourceAssignmentIds,
        sourceWhiteboardPageIds: sources.map((source) => source.pageId)
      });
    }
    return signals.sort((left, right) => this.signalRank(right.severity) - this.signalRank(left.severity)).slice(0, 8);
  }

  private teacherAnalyticsSummary(batches: TeacherAnalyticsBatchSummary[]): TeacherAnalyticsSummary {
    const summary = this.emptyTeacherAnalyticsSummary();
    summary.batchCount = batches.length;
    summary.enrolledStudents = batches.reduce((total, batch) => total + batch.enrolledStudents, 0);
    summary.totalSessions = batches.reduce((total, batch) => total + batch.totalSessions, 0);
    summary.completedSessions = batches.reduce((total, batch) => total + batch.completedSessions, 0);
    summary.liveSessions = batches.reduce((total, batch) => total + batch.liveSessions, 0);
    summary.upcomingSessions = batches.reduce((total, batch) => total + batch.upcomingSessions, 0);
    const enrolledSlots = batches.reduce((total, batch) => total + batch.attendance.enrolledSlots, 0);
    const present = batches.reduce((total, batch) => total + batch.attendance.present, 0);
    summary.attendanceRate = enrolledSlots ? Math.round((present / enrolledSlots) * 100) : 0;
    summary.missedClasses = batches.reduce((total, batch) => total + batch.attendance.missedClasses, 0);
    summary.lateJoins = batches.reduce((total, batch) => total + batch.attendance.lateJoins, 0);
    summary.reconnects = batches.reduce((total, batch) => total + batch.attendance.reconnects, 0);
    summary.handRaises = batches.reduce((total, batch) => total + batch.participation.handRaises, 0);
    summary.allowedSpeakingTurns = batches.reduce((total, batch) => total + batch.participation.allowedSpeakingTurns, 0);
    summary.questionsAsked = batches.reduce((total, batch) => total + batch.participation.questionsAsked, 0);
    summary.unansweredQuestions = batches.reduce((total, batch) => total + batch.participation.unansweredQuestions, 0);
    summary.assignmentsDue = batches.reduce((total, batch) => total + batch.assignments.due, 0);
    summary.assignmentsSubmitted = batches.reduce((total, batch) => total + batch.assignments.submissions.submitted + batch.assignments.submissions.late, 0);
    summary.assignmentsReviewed = batches.reduce((total, batch) => total + batch.assignments.submissions.reviewed + batch.assignments.submissions.completed, 0);
    summary.assignmentsOverdue = batches.reduce((total, batch) => total + batch.assignments.overdue, 0);
    summary.assignmentsMissing = batches.reduce((total, batch) => total + batch.assignments.missing, 0);
    summary.recordingsReady = batches.reduce((total, batch) => total + batch.recordings.ready, 0);
    summary.materialDownloads = batches.reduce((total, batch) => total + batch.materials.downloads, 0);
    summary.riskStudents = batches.reduce((total, batch) => total + batch.riskIndicators.length, 0);
    summary.weakTopicSignals = batches.reduce((total, batch) => total + batch.weakTopicSignals.length, 0);
    return summary;
  }

  private isSubmittedAssignmentStatus(status: string): boolean {
    return status === 'submitted' || status === 'late' || status === 'reviewed' || status === 'returned' || status === 'completed';
  }

  private isReviewedAssignmentStatus(status: string): boolean {
    return status === 'reviewed' || status === 'returned' || status === 'completed';
  }

  private riskRank(level: TeacherAnalyticsRiskLevel): number {
    if (level === 'high') return 3;
    if (level === 'medium') return 2;
    return 1;
  }

  private groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const itemKey = key(item);
      if (!itemKey) continue;
      groups.set(itemKey, [...(groups.get(itemKey) ?? []), item]);
    }
    return groups;
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
    const {
      studentId: rawStudentId,
      attendanceStatus: rawAttendanceStatus,
      source: rawSource,
      ...rest
    } = query;
    const now = new Date();
    const dateTo = rest.dateTo?.trim() ? this.parseAdminDate(rest.dateTo, 'dateTo') : now;
    const dateFrom = rest.dateFrom?.trim()
      ? this.parseAdminDate(rest.dateFrom, 'dateFrom')
      : new Date(dateTo.getTime() - ADMIN_ATTENDANCE_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const attendanceStatus = rawAttendanceStatus?.trim() as AdminAttendanceQuery['attendanceStatus'];
    if (attendanceStatus && attendanceStatus !== 'all' && attendanceStatus !== 'present' && attendanceStatus !== 'absent') {
      throw new BadRequestException('Invalid attendance status filter.');
    }
    const source = rawSource?.trim() as AdminAttendanceQuery['source'];
    if (source && source !== 'all' && source !== 'snapshot' && source !== 'inferred') {
      throw new BadRequestException('Invalid attendance source filter.');
    }
    const studentId = rawStudentId?.trim();
    if (dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException('dateFrom must be before dateTo.');
    }
    if (dateTo.getTime() - dateFrom.getTime() > ADMIN_ATTENDANCE_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      throw new BadRequestException(`Attendance analytics date range cannot exceed ${ADMIN_ATTENDANCE_MAX_RANGE_DAYS} days.`);
    }
    return {
      ...rest,
      ...(studentId ? { studentId } : {}),
      ...(attendanceStatus && attendanceStatus !== 'all' ? { attendanceStatus } : {}),
      ...(source && source !== 'all' ? { source } : {}),
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString()
    };
  }

  private async adminAttendanceSessionRows(query: AdminAttendanceQuery): Promise<AdminAttendanceSessionRow[]> {
    const bounded = this.boundedAdminAttendanceQuery(query);
    const filters = await this.adminClassSessionFilters(bounded);
    const sessions = await this.classSessions.find(filters).sort({ scheduledAt: -1 }).exec();
    return this.toAdminAttendanceSessionRows(sessions, bounded);
  }

  private async toAdminAttendanceSessionRows(
    sessions: ClassSessionMongoDocument[],
    query: AdminAttendanceQuery = {}
  ): Promise<AdminAttendanceSessionRow[]> {
    if (!sessions.length) {
      return [];
    }
    const batchMap = await this.adminBatchMap(sessions.map((session) => session.batchId));
    const teacherMap = await this.adminTeacherMap(sessions.map((session) => session.teacherId));
    const rows = await Promise.all(
      sessions.map(async (session) => {
        const batch = batchMap.get(session.batchId);
        const teacher = teacherMap.get(session.teacherId);
        const attendance = await this.adminAttendanceRowsForSession(session);
        if (!this.adminAttendanceSourceMatches(attendance.source, query.source)) {
          return null;
        }
        const attendanceRows = this.filterAdminAttendanceRows(attendance.rows, query);
        if (this.hasAdminAttendanceRowFilter(query) && !attendanceRows.length) {
          return null;
        }
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
    return rows.filter((row): row is AdminAttendanceSessionRow => Boolean(row));
  }

  private classSessionReportAttendance(
    session: ClassSessionMongoDocument,
    attendance: AttendanceRowsWithSource
  ): ClassSessionReport['attendance'] {
    const rows = attendance.rows;
    const presentRows = rows.filter((row) => row.status === 'present');
    const enrolled = rows.length;
    const present = presentRows.length;
    const totalDurationSeconds = presentRows.reduce((total, row) => total + row.totalDurationSeconds, 0);
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
    return {
      enrolled,
      present,
      absent: Math.max(0, enrolled - present),
      attendanceRate: enrolled ? Math.round((present / enrolled) * 100) : 0,
      averageDurationSeconds: present ? Math.round(totalDurationSeconds / present) : 0,
      reconnects: presentRows.reduce((total, row) => total + row.reconnectCount, 0),
      lateJoins,
      earlyLeaves,
      source: attendance.source
    };
  }

  private classSessionReportParticipation(events: ClassSessionTimelineEvent[]): ClassSessionReport['participation'] {
    const matches = (...needles: string[]) =>
      events.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return needles.every((needle) => text.includes(needle));
      }).length;
    const attendanceEvents = events.filter((event) => event.category === 'attendance');
    return {
      joins: attendanceEvents.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return text.includes('join') && !text.includes('denied');
      }).length,
      leaves: attendanceEvents.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return text.includes('leave') || text.includes('left');
      }).length,
      reconnects: matches('reconnect'),
      handRaises: events.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return text.includes('hand') && (text.includes('raise') || text.includes('raised'));
      }).length,
      allowedSpeaks: events.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return text.includes('speak') && (text.includes('allow') || text.includes('allowed'));
      }).length,
      revokedSpeaks: events.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return text.includes('speak') && (text.includes('revoke') || text.includes('revoked'));
      }).length,
      mutedMics: events.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return (text.includes('mute') || text.includes('muted')) && (text.includes('mic') || text.includes('microphone'));
      }).length,
      stoppedCameras: events.filter((event) => {
        const text = `${event.eventType} ${event.summary}`.toLowerCase();
        return (text.includes('camera') || text.includes('video')) && (text.includes('stop') || text.includes('stopped'));
      }).length
    };
  }

  private classSessionReportBroadcasts(messages: ChatMessage[]): ClassSessionReport['broadcasts'] {
    const broadcasts = messages.filter((message) => message.scope === 'broadcast');
    const latest = [...broadcasts].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    return {
      count: broadcasts.length,
      ...(latest?.createdAt ? { latestAt: latest.createdAt } : {}),
      ...(latest?.message ? { latestPreview: this.reportPreview(latest.message) } : {})
    };
  }

  private async classSessionReportMaterials(resolution: SessionResolution): Promise<ClassSessionMaterial[]> {
    const materials = await this.materials
      .find({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      })
      .sort({ shared: -1, createdAt: -1 })
      .exec();
    return materials.map((material) => this.toMaterialPayload(material));
  }

  private async classSessionReportAssignments(sessionId: string, batchId: string): Promise<ClassSessionReport['assignments']> {
    const assignments = await this.assignments
      .find({
        sessionId,
        batchId,
        deletedAt: { $exists: false }
      })
      .exec();
    const assignmentIds = assignments.map((assignment) => assignment.assignmentId).filter(Boolean);
    const submissions = this.emptyAssignmentSubmissionSummary();
    if (assignmentIds.length) {
      const submissionRows = await this.assignmentSubmissions
        .find({
          assignmentId: { $in: assignmentIds },
          batchId,
          deletedAt: { $exists: false }
        })
        .exec();
      for (const submission of submissionRows) {
        if (ASSIGNMENT_SUBMISSION_STATUS_KEYS.includes(submission.status)) {
          submissions[submission.status] += 1;
        }
      }
    }
    return {
      total: assignments.length,
      published: assignments.filter((assignment) => assignment.status === 'published').length,
      archived: assignments.filter((assignment) => assignment.status === 'archived').length,
      submissions
    };
  }

  private emptyAssignmentSubmissionSummary(): AssignmentSubmissionSummary {
    return {
      assigned: 0,
      viewed: 0,
      submitted: 0,
      late: 0,
      reviewed: 0,
      returned: 0,
      completed: 0
    };
  }

  private async classSessionWorkspaceAssignments(sessionId: string, batchId: string): Promise<Assignment[]> {
    const assignments = await this.assignments
      .find({
        sessionId,
        batchId,
        deletedAt: { $exists: false }
      })
      .sort({ createdAt: -1 })
      .exec();
    const assignmentIds = assignments.map((assignment) => assignment.assignmentId).filter(Boolean);
    const submissions = assignmentIds.length
      ? await this.assignmentSubmissions
          .find({
            assignmentId: { $in: assignmentIds },
            batchId,
            deletedAt: { $exists: false }
          })
          .exec()
      : [];
    const submissionsByAssignment = new Map<string, AssignmentSubmissionMongoDocument[]>();
    for (const submission of submissions) {
      submissionsByAssignment.set(submission.assignmentId, [...(submissionsByAssignment.get(submission.assignmentId) ?? []), submission]);
    }
    return assignments.map((assignment) => this.toWorkspaceAssignmentPayload(assignment, submissionsByAssignment.get(assignment.assignmentId) ?? []));
  }

  private toWorkspaceAssignmentPayload(assignment: AssignmentMongoDocument, submissions: AssignmentSubmissionMongoDocument[]): Assignment {
    return {
      id: assignment.id,
      assignmentId: assignment.assignmentId,
      batchId: assignment.batchId,
      ...(assignment.batchName ? { batchName: assignment.batchName } : {}),
      ...(assignment.sessionId ? { sessionId: assignment.sessionId } : {}),
      ...(assignment.sessionTitle ? { sessionTitle: assignment.sessionTitle } : {}),
      teacherId: assignment.teacherId,
      title: assignment.title,
      instructions: assignment.instructions,
      ...(assignment.dueAt ? { dueAt: assignment.dueAt.toISOString() } : {}),
      attachments: (assignment.attachments ?? []).map((attachment) => this.toWorkspaceAssignmentAttachment(attachment, assignment.assignmentId)),
      allowedSubmissionTypes: assignment.allowedSubmissionTypes ?? ['text'],
      status: assignment.status,
      submissionSummary: this.assignmentSubmissionSummary(submissions),
      createdAt: assignment.createdAt.toISOString(),
      updatedAt: assignment.updatedAt.toISOString(),
      ...(assignment.deletedAt ? { deletedAt: assignment.deletedAt.toISOString() } : {})
    };
  }

  private toWorkspaceAssignmentAttachment(
    attachment: AssignmentMongoDocument['attachments'][number],
    assignmentId: string,
    submissionId?: string
  ): AssignmentAttachment {
    return {
      id: attachment.id,
      type: attachment.type,
      title: attachment.title,
      ...(attachment.url ? { url: attachment.url } : {}),
      ...(attachment.materialId ? { materialId: attachment.materialId } : {}),
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      ...(attachment.storageProvider ? { storageProvider: attachment.storageProvider } : {}),
      ...(attachment.type === 'file'
        ? {
            downloadUrl: submissionId
              ? `/api/v1/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(submissionId)}/attachments/${encodeURIComponent(attachment.id)}/download`
              : `/api/v1/assignments/${encodeURIComponent(assignmentId)}/attachments/${encodeURIComponent(attachment.id)}/download`
          }
        : {}),
      ...(attachment.createdAt ? { createdAt: this.dateToIso(attachment.createdAt) } : {})
    };
  }

  private assignmentSubmissionSummary(submissions: AssignmentSubmissionMongoDocument[]): AssignmentSubmissionSummary {
    const summary = this.emptyAssignmentSubmissionSummary();
    for (const submission of submissions) {
      if (ASSIGNMENT_SUBMISSION_STATUS_KEYS.includes(submission.status)) {
        summary[submission.status] += 1;
      }
    }
    return summary;
  }

  private postClassQuestionThreads(
    summary: ChatThreadSummaryResponse,
    states: ClassSessionPostClassThreadStateMongoDocument[],
    resolution: SessionResolution
  ): ClassSessionPostClassQuestionThread[] {
    const stateByStudent = new Map(states.map((state) => [state.studentId, state]));
    return summary.threads
      .filter((thread) => thread.scope === 'private')
      .map((thread) => {
        const studentId = this.cleanParticipantId(thread.participantId ?? thread.id.replace(/^private:/, ''));
        return {
          summary: thread,
          workflow: this.postClassWorkflowFromState(stateByStudent.get(studentId), resolution, studentId)
        };
      });
  }

  private postClassWorkflowFromState(
    state: ClassSessionPostClassThreadStateMongoDocument | undefined | null,
    resolution: SessionResolution,
    studentId: string
  ): ClassSessionPostClassThreadWorkflow {
    return {
      studentId,
      threadKey: state?.threadKey ?? this.postClassThreadKey(resolution.planned.id, resolution.batch.teacherId, studentId),
      important: Boolean(state?.important),
      answered: Boolean(state?.answered),
      followUp: Boolean(state?.followUp),
      ...(state?.updatedAt ? { updatedAt: state.updatedAt.toISOString() } : {}),
      ...(state?.updatedByUserId ? { updatedByUserId: state.updatedByUserId } : {})
    };
  }

  private postClassThreadKey(sessionId: string, teacherId: string, studentId: string): string {
    return `${sessionId}:teacher:${teacherId || 'teacher'}:student:${studentId}`;
  }

  private cleanParticipantId(value: string | undefined): string {
    return (value ?? '').trim();
  }

  private classSessionReportQna(summary: ChatThreadSummaryResponse): ClassSessionReport['qna'] {
    const privateThreads = summary.threads.filter((thread) => thread.scope === 'private');
    const latestAt = this.latestIso(privateThreads.map((thread) => thread.lastMessageAt).filter((value): value is string => Boolean(value)));
    return {
      threads: privateThreads.length,
      withQuestions: privateThreads.filter((thread) => Boolean(thread.lastMessageAt)).length,
      unanswered: privateThreads.filter((thread) => thread.lastMessage?.senderRole === 'student').length,
      unreadForTeacher: privateThreads.reduce((total, thread) => total + thread.unreadCount, 0),
      ...(latestAt ? { latestAt } : {})
    };
  }

  private classSessionReportIncidents(events: ClassSessionTimelineEvent[]): ClassSessionReport['incidents'] {
    const incidents = events
      .filter((event) => {
        const text = `${event.category} ${event.eventType} ${event.summary}`.toLowerCase();
        return (
          event.category === 'support' ||
          text.includes('failed') ||
          text.includes('failure') ||
          text.includes('denied') ||
          text.includes('error') ||
          text.includes('disconnect') ||
          text.includes('reconnect grace')
        );
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return {
      total: incidents.length,
      support: incidents.filter((event) => event.category === 'support').length,
      media: incidents.filter((event) => event.category === 'media').length,
      moderation: incidents.filter((event) => event.category === 'moderation').length,
      latest: incidents.slice(0, 5)
    };
  }

  private classSessionReportCsv(report: ClassSessionReport): string {
    const rows: string[][] = [['Section', 'Field', 'Value', 'Notes']];
    const add = (section: string, field: string, value: unknown = '', notes: unknown = '') => {
      rows.push([section, field, this.csvValue(value), this.csvValue(notes)]);
    };
    const session = report.session;
    add('Session', 'Session ID', session.sessionId);
    add('Session', 'Title', session.title);
    add('Session', 'Batch', session.batchName, session.batchId);
    add('Session', 'Course', session.courseName ?? '', session.courseId ?? '');
    add('Session', 'Teacher', session.teacherName ?? session.teacherEmail ?? session.teacherId, session.teacherId);
    add('Session', 'Session number', session.sessionNumber);
    add('Session', 'Status', session.status);
    add('Session', 'Scheduled at', session.scheduledAt);
    add('Session', 'Started at', session.startedAt ?? '');
    add('Session', 'Completed at', session.completedAt ?? '');
    add('Session', 'Duration minutes', session.durationMinutes);
    add('Session', 'Room ID', session.roomId ?? '');
    add('Report', 'Audience', report.audience);
    add('Report', 'Generated at', report.generatedAt);

    add('Attendance', 'Enrolled students', report.attendance.enrolled);
    add('Attendance', 'Present students', report.attendance.present);
    add('Attendance', 'Absent students', report.attendance.absent);
    add('Attendance', 'Attendance rate', `${report.attendance.attendanceRate}%`);
    add('Attendance', 'Average duration seconds', report.attendance.averageDurationSeconds);
    add('Attendance', 'Reconnects', report.attendance.reconnects);
    add('Attendance', 'Late joins', report.attendance.lateJoins);
    add('Attendance', 'Early leaves', report.attendance.earlyLeaves);
    add('Attendance', 'Source', report.attendance.source);

    add('Participation', 'Joins', report.participation.joins);
    add('Participation', 'Leaves', report.participation.leaves);
    add('Participation', 'Reconnects', report.participation.reconnects);
    add('Participation', 'Hand raises', report.participation.handRaises);
    add('Participation', 'Allowed speak', report.participation.allowedSpeaks);
    add('Participation', 'Revoked speak', report.participation.revokedSpeaks);
    add('Participation', 'Mic moderations', report.participation.mutedMics);
    add('Participation', 'Camera stops', report.participation.stoppedCameras);

    add('Broadcasts', 'Count', report.broadcasts.count);
    add('Broadcasts', 'Latest at', report.broadcasts.latestAt ?? '');
    add('Broadcasts', 'Latest preview', report.broadcasts.latestPreview ?? '');

    add('Recordings', 'Count', report.artifacts.recordings.length);
    report.artifacts.recordings.forEach((recording, index) => {
      add(
        'Recording',
        recording.recordingId ?? recording.id ?? `Recording ${index + 1}`,
        recording.status,
        [
          `scope=${recording.scope}`,
          `durationSeconds=${recording.durationSeconds ?? ''}`,
          `publishedAt=${recording.publishedAt ?? ''}`,
          `startedAt=${recording.startedAt ?? ''}`,
          `stoppedAt=${recording.stoppedAt ?? ''}`
        ].join('; ')
      );
    });

    add('Materials', 'Count', report.artifacts.materials.length);
    report.artifacts.materials.forEach((material, index) => {
      add(
        'Material',
        material.title || material.materialId || `Material ${index + 1}`,
        material.kind,
        [
          `source=${material.source}`,
          `shared=${material.shared}`,
          `publishedAt=${material.publishedAt ?? ''}`,
          `fileName=${material.fileName ?? ''}`
        ].join('; ')
      );
    });

    add('Whiteboard', 'Available', report.artifacts.whiteboard.available ? 'Yes' : 'No');
    add('Whiteboard', 'Snapshot version', report.artifacts.whiteboard.snapshotVersion ?? '');
    add('Whiteboard', 'Updated at', report.artifacts.whiteboard.updatedAt ?? '');
    add('Whiteboard', 'Pages', report.artifacts.whiteboard.summary?.pageCount ?? '');
    add('Whiteboard', 'Elements', report.artifacts.whiteboard.summary?.elementCount ?? '');

    add('Assignments', 'Total', report.assignments.total);
    add('Assignments', 'Published', report.assignments.published);
    add('Assignments', 'Archived', report.assignments.archived);
    Object.entries(report.assignments.submissions).forEach(([status, count]) => add('Assignment submissions', status, count));

    add('Post-class Q&A', 'Threads', report.qna.threads);
    add('Post-class Q&A', 'Threads with questions', report.qna.withQuestions);
    add('Post-class Q&A', 'Unanswered', report.qna.unanswered);
    add('Post-class Q&A', 'Unread for teacher', report.qna.unreadForTeacher);
    add('Post-class Q&A', 'Latest activity at', report.qna.latestAt ?? '');

    add('Incidents', 'Total', report.incidents.total);
    add('Incidents', 'Support', report.incidents.support);
    add('Incidents', 'Media', report.incidents.media);
    add('Incidents', 'Moderation', report.incidents.moderation);
    report.incidents.latest.forEach((incident) => {
      add('Incident', incident.eventType, incident.summary, `${incident.category}; ${incident.createdAt}`);
    });

    return `${rows.map((row) => row.map((cell) => this.csvEscape(cell)).join(',')).join('\n')}\n`;
  }

  private csvValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.csvValue(item)).join('; ');
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }

  private async classSessionReportTimelineEvents(resolution: SessionResolution, user: AuthenticatedUser): Promise<ClassSessionTimelineEvent[]> {
    if (!this.activity) {
      return [];
    }
    const response = await this.activity.listTimeline({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      limit: 200,
      visibility: 'full',
      audienceIds: [user.sub]
    });
    return response.items;
  }

  private latestIso(values: string[]): string | undefined {
    return values
      .map((value) => new Date(value))
      .filter((value) => !Number.isNaN(value.getTime()))
      .sort((left, right) => right.getTime() - left.getTime())[0]
      ?.toISOString();
  }

  private reportPreview(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
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
      if (!this.adminAttendanceSourceMatches(attendance.source, bounded.source)) {
        continue;
      }
      const attendanceRows = this.filterAdminAttendanceRows(attendance.rows, bounded);
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

  private async adminAttendanceExportRows(query: AdminAttendanceQuery): Promise<AdminAttendanceExportRow[]> {
    const bounded = this.boundedAdminAttendanceQuery(query);
    const filters = await this.adminClassSessionFilters(bounded);
    const sessions = await this.classSessions.find(filters).sort({ scheduledAt: -1 }).exec();
    if (!sessions.length) {
      return [];
    }
    const batchMap = await this.adminBatchMap(sessions.map((session) => session.batchId));
    const teacherMap = await this.adminTeacherMap(sessions.map((session) => session.teacherId));
    const rows: AdminAttendanceExportRow[] = [];
    for (const session of sessions) {
      const attendance = await this.adminAttendanceRowsForSession(session);
      if (!this.adminAttendanceSourceMatches(attendance.source, bounded.source)) {
        continue;
      }
      const batch = batchMap.get(session.batchId);
      const teacher = teacherMap.get(session.teacherId);
      const attendanceRows = this.filterAdminAttendanceRows(attendance.rows, bounded).sort((left, right) =>
        left.displayName.localeCompare(right.displayName)
      );
      for (const row of attendanceRows) {
        rows.push({
          sessionId: session.id,
          title: session.title,
          sessionStatus: session.status,
          batchId: session.batchId,
          batchName: batch?.name ?? 'Unknown batch',
          ...(batch?.courseId ? { courseId: batch.courseId } : {}),
          ...(batch?.courseName ? { courseName: batch.courseName } : {}),
          teacherId: session.teacherId,
          ...(teacher?.displayName || teacher?.name ? { teacherName: teacher.displayName ?? teacher.name } : {}),
          studentId: row.studentId,
          studentName: row.displayName,
          ...(row.email ? { studentEmail: row.email } : {}),
          attendanceStatus: row.status,
          rosterSource: row.rosterSource ?? 'roster',
          ...(row.firstJoinAt ? { firstJoinAt: row.firstJoinAt.toISOString() } : {}),
          ...(row.lastLeaveAt ? { lastLeaveAt: row.lastLeaveAt.toISOString() } : {}),
          totalDurationSeconds: row.totalDurationSeconds,
          reconnectCount: row.reconnectCount,
          attendanceSource: attendance.source,
          scheduledAt: session.scheduledAt.toISOString(),
          ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
          ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {})
        });
      }
    }
    return rows;
  }

  private adminAttendanceSourceMatches(source: AdminAttendanceSource, filter: AdminAttendanceQuery['source']): boolean {
    return !filter || filter === 'all' || source === filter;
  }

  private filterAdminAttendanceRows(rows: ClassSessionAttendanceRow[], query: AdminAttendanceQuery): ClassSessionAttendanceRow[] {
    return rows.filter((row) => {
      if (query.studentId && row.studentId !== query.studentId) {
        return false;
      }
      if (query.attendanceStatus && query.attendanceStatus !== 'all' && row.status !== query.attendanceStatus) {
        return false;
      }
      return true;
    });
  }

  private hasAdminAttendanceRowFilter(query: AdminAttendanceQuery): boolean {
    return Boolean(query.studentId || (query.attendanceStatus && query.attendanceStatus !== 'all'));
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
    await this.activity?.record({
      sessionId: session.id,
      batchId: session.batchId,
      roomId: session.roomId,
      eventType: 'attendance.snapshot_created',
      category: 'attendance',
      summary: 'Final attendance snapshot created',
      actor: { id: session.teacherId, roles: ['system'] },
      visibility: 'full',
      metadata: {
        snapshotSource,
        enrolled: rows.length,
        present: rows.filter((row) => row.status === 'present').length,
        absent: rows.filter((row) => row.status === 'absent').length,
        reconnects: rows.reduce((total, row) => total + row.reconnectCount, 0)
      }
    });
  }

  private adminAttendanceSummary(rows: AdminAttendanceSessionRow[]): AdminAttendanceSummary {
    const totalEnrolledStudents = rows.reduce((total, row) => total + row.enrolled, 0);
    const totalPresent = rows.reduce((total, row) => total + row.present, 0);
    const attendedRows = rows.filter((row) => row.present > 0);
    return {
      totalSessions: rows.length,
      completedSessions: rows.filter((row) => row.status === 'completed').length,
      snapshottedSessions: rows.filter((row) => row.attendanceSource === 'snapshot').length,
      inferredSessions: rows.filter((row) => row.attendanceSource === 'inferred').length,
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

  private csvEscape(value: unknown): string {
    const text = this.csvValue(value);
    if (!/[",\n\r]/.test(text)) {
      return text;
    }
    return `"${text.replace(/"/g, '""')}"`;
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

  private persistedSessionResolution(session: ClassSessionMongoDocument, batch: BatchMongoDocument): SessionResolution {
    return {
      batch,
      schedules: [],
      planned: {
        id: session.id,
        batchId: session.batchId,
        title: session.title,
        sessionNumber: session.sessionNumber,
        scheduledAt: session.scheduledAt,
        durationMinutes: session.durationMinutes
      },
      persisted: session
    };
  }

  private async toStudentCompletedClassRow(
    session: ClassSessionMongoDocument,
    batch: BatchMongoDocument | undefined,
    teacher: UserMongoDocument | undefined,
    user: AuthenticatedUser
  ): Promise<StudentCompletedClassSessionListItem | null> {
    if (!batch) {
      return null;
    }
    const resolution = this.persistedSessionResolution(session, batch);
    const liveSettings = await this.resolvedLiveSettingsForResolution(resolution);
    const emptyRecordingSummary: { active?: Recording; latest?: Recording } = {};
    const [recordingSummary, materials, whiteboard, chatSummary, attendance] = await Promise.all([
      this.canViewRecordingContent(liveSettings, batch, user) ? this.recordings.getClassSessionRecordingSummary(session.id) : Promise.resolve(emptyRecordingSummary),
      this.studentCompletedMaterials(resolution, liveSettings),
      this.studentCompletedWhiteboardSummary(resolution),
      this.rooms.getClassSessionPostClassStudentChatSummary({
        sessionId: session.id,
        batchId: batch.id,
        roomId: session.roomId,
        teacherId: batch.teacherId,
        studentId: user.sub
      }),
      this.studentAttendanceForSession(session, user.sub)
    ]);
    const latestRecording = recordingSummary.latest && this.isPostClassRecordingPublished(recordingSummary.latest) ? recordingSummary.latest : undefined;
    return {
      sessionId: session.id,
      batchId: batch.id,
      batchName: batch.name,
      ...(batch.courseId ? { courseId: batch.courseId } : {}),
      ...(batch.courseName ? { courseName: batch.courseName } : {}),
      teacherId: session.teacherId,
      ...(teacher?.displayName || teacher?.name ? { teacherName: teacher.displayName ?? teacher.name } : {}),
      title: session.title,
      sessionNumber: session.sessionNumber,
      scheduledAt: session.scheduledAt.toISOString(),
      ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
      ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {}),
      durationMinutes: session.durationMinutes,
      status: 'completed',
      recordingAvailable: Boolean(latestRecording && latestRecording.status !== 'failed'),
      ...(latestRecording?.status ? { recordingStatus: latestRecording.status } : {}),
      materialCount: materials.length,
      notesAvailable: whiteboard.available,
      notesPageCount: whiteboard.summary?.pageCount ?? 0,
      qnaUnreadCount: chatSummary.studentThread?.unreadCount ?? 0,
      ...(chatSummary.studentThread?.lastMessageAt ? { qnaLastMessageAt: chatSummary.studentThread.lastMessageAt } : {}),
      attendance
    };
  }

  private async studentCompletedMaterials(resolution: SessionResolution, liveSettings: LiveClassSettings): Promise<ClassSessionMaterial[]> {
    if (!liveSettings.materials.materialsEnabled) {
      return [];
    }
    const materials = await this.materials
      .find({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        deletedAt: { $exists: false }
      })
      .sort({ shared: -1, createdAt: -1 })
      .exec();
    return materials
      .filter((material) => this.canAccessMaterial(material, resolution, 'student', liveSettings))
      .map((material) => this.toMaterialPayload(material));
  }

  private async studentCompletedWhiteboardSummary(
    resolution: SessionResolution,
    options: { includeUnpublished?: boolean } = {}
  ): Promise<StudentCompletedClassWhiteboardSummary> {
    const state = await this.whiteboardStates.findOne({ sessionId: resolution.planned.id, batchId: resolution.batch.id });
    if (!state) {
      return { available: false };
    }
    if (!options.includeUnpublished && !this.isPostClassWhiteboardPublished(state)) {
      return { available: false };
    }
    return {
      available: true,
      snapshotVersion: state.snapshotVersion,
      updatedAt: state.updatedAt.toISOString(),
      ...(state.publishedAt ? { publishedAt: state.publishedAt.toISOString() } : {}),
      ...(state.publishedByUserId ? { publishedByUserId: state.publishedByUserId } : {}),
      ...(state.unpublishedAt ? { unpublishedAt: state.unpublishedAt.toISOString() } : {}),
      summary: this.whiteboardDocumentSummary(state)
    };
  }

  private async studentAttendanceForSession(session: ClassSessionMongoDocument, studentId: string): Promise<StudentClassAttendanceSummary> {
    const attendance = await this.adminAttendanceRowsForSession(session);
    const row = attendance.rows.find((item) => item.studentId === studentId);
    if (!row) {
      return {
        status: 'unknown',
        totalDurationSeconds: 0,
        reconnectCount: 0,
        source: 'none'
      };
    }
    return {
      status: row.status,
      ...(row.firstJoinAt ? { firstJoinAt: row.firstJoinAt.toISOString() } : {}),
      ...(row.lastLeaveAt ? { lastLeaveAt: row.lastLeaveAt.toISOString() } : {}),
      totalDurationSeconds: row.totalDurationSeconds,
      reconnectCount: row.reconnectCount,
      source: attendance.source === 'snapshot' ? 'snapshot' : 'inferred'
    };
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

  private async assertCanReadClassSessionForResolution(resolution: SessionResolution, user: AuthenticatedUser): Promise<void> {
    if (resolution.persisted?.status === 'completed') {
      await this.assertCanReadClassSessionHistory(resolution.batch, user);
      return;
    }
    await this.assertCanReadClassSession(resolution.batch, user);
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

  private async assertCanReadClassSessionHistory(batch: BatchMongoDocument, user: AuthenticatedUser): Promise<void> {
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) {
      return;
    }
    if (user.roles.includes('STUDENT') && (await this.studentEnrollments.isStudentHistoricallyEnrolledInBatch(user.sub, batch.id))) {
      return;
    }
    throw new ForbiddenException('You are not allowed to open this completed class session.');
  }

  private assertCompletedClassSession(resolution: SessionResolution): void {
    if (!resolution.persisted || resolution.persisted.status !== 'completed') {
      throw new ConflictException('This class session is not completed yet.');
    }
  }

  private assertStudentUser(user: AuthenticatedUser): void {
    if (!user.roles.includes('STUDENT')) {
      throw new ForbiddenException('Student access required.');
    }
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
      return settings.materials.publishMaterialsAfterClass && this.isPostClassMaterialPublished(material);
    }
    return settings.materials.publishMaterialsBeforeClass;
  }

  private isPostClassMaterialPublished(material: ClassSessionMaterialMongoDocument | ClassSessionMaterial): boolean {
    return Boolean(material.shared || (material.publishedAt && !material.unpublishedAt));
  }

  private isPostClassRecordingPublished(recording: Recording): boolean {
    return Boolean(recording.publishedAt && !recording.unpublishedAt);
  }

  private isPostClassWhiteboardPublished(state: ClassSessionWhiteboardStateMongoDocument): boolean {
    return Boolean(state.publishedAt && !state.unpublishedAt);
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
      lastOperationSeq: state.lastOperationSeq ?? 0,
      ...(state.lastOperationId ? { lastOperationId: state.lastOperationId } : {}),
      operationCount: state.operationCount ?? 0,
      compactedThroughSeq: state.compactedThroughSeq ?? 0,
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
    if (metadata.reason !== 'autosave') {
      await this.activity?.record({
        sessionId: resolution.planned.id,
        batchId: resolution.batch.id,
        roomId: resolution.persisted?.roomId,
        eventType: `whiteboard.memory_${action === 'save' ? 'saved' : 'restored'}`,
        category: 'whiteboard',
        summary: action === 'save' ? 'Saved class whiteboard memory' : 'Restored class whiteboard memory',
        actor: { id: user.sub, email: user.email, roles: user.roles },
        visibility: 'full',
        metadata: {
          reason: metadata.reason,
          snapshotVersion: metadata.snapshotVersion,
          pageCount: metadata.pageCount,
          elementCount: metadata.elementCount
        }
      });
    }
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
      ...(material.publishedAt ? { publishedAt: this.dateToIso(material.publishedAt) } : {}),
      ...(material.publishedByUserId ? { publishedByUserId: material.publishedByUserId } : {}),
      ...(material.unpublishedAt ? { unpublishedAt: this.dateToIso(material.unpublishedAt) } : {}),
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

  private async userDisplayName(user: AuthenticatedUser): Promise<string> {
    const profile = this.users ? await this.users.findById(user.sub).exec() : null;
    return profile?.displayName ?? profile?.name ?? user.email ?? user.sub;
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
