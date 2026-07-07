import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClassLibraryArtifactType, ClassLibrarySearchQuery, ClassLibrarySearchResponse, ClassLibrarySearchResult } from '@native-sfu/contracts';
import { Model } from 'mongoose';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  AssignmentDocument,
  type AssignmentMongoDocument,
  BatchDocument,
  type BatchMongoDocument,
  ChatMessageDocument,
  type ChatMessageMongoDocument,
  ClassSessionDocument,
  type ClassSessionMongoDocument,
  ClassSessionMaterialDocument,
  type ClassSessionMaterialMongoDocument,
  ClassSessionPostClassThreadStateDocument,
  type ClassSessionPostClassThreadStateMongoDocument,
  ClassSessionWhiteboardStateDocument,
  type ClassSessionWhiteboardStateMongoDocument,
  RecordingDocument,
  type RecordingMongoDocument
} from '../database/schemas';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';

type SearchAudience = 'student' | 'teacher' | 'admin';

interface NormalizedSearchQuery extends Required<Pick<ClassLibrarySearchQuery, 'page' | 'limit'>> {
  q: string;
  courseId?: string;
  batchId?: string;
  teacherId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  artifactType?: ClassLibraryArtifactType;
  status?: string;
}

@Injectable()
export class ClassLibraryService {
  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(ClassSessionMaterialDocument.name) private readonly materials: Model<ClassSessionMaterialMongoDocument>,
    @InjectModel(RecordingDocument.name) private readonly recordings: Model<RecordingMongoDocument>,
    @InjectModel(ClassSessionWhiteboardStateDocument.name) private readonly whiteboardStates: Model<ClassSessionWhiteboardStateMongoDocument>,
    @InjectModel(AssignmentDocument.name) private readonly assignments: Model<AssignmentMongoDocument>,
    @InjectModel(ChatMessageDocument.name) private readonly chatMessages: Model<ChatMessageMongoDocument>,
    @InjectModel(ClassSessionPostClassThreadStateDocument.name)
    private readonly postClassThreadStates: Model<ClassSessionPostClassThreadStateMongoDocument>,
    private readonly studentEnrollments: StudentEnrollmentsService
  ) {}

  async search(query: ClassLibrarySearchQuery, user: AuthenticatedUser, options: { adminOnly?: boolean } = {}): Promise<ClassLibrarySearchResponse> {
    if (options.adminOnly && !this.isAdmin(user)) {
      throw new ForbiddenException('Only administrators can search the admin class library.');
    }
    const normalized = this.normalizeQuery(query);
    const audience = this.audienceFor(user);
    const batches = await this.accessibleBatches(user, normalized, audience);
    if (!batches.length) {
      return this.emptyResponse(normalized);
    }

    const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
    const batchIds = batches.map((batch) => batch.id);
    const sessions = await this.classSessions
      .find({ batchId: { $in: batchIds }, status: 'completed' })
      .sort({ completedAt: -1, scheduledAt: -1 })
      .limit(500)
      .exec();
    const filteredSessions = sessions.filter((session) => this.resultDateMatches(session.completedAt ?? session.scheduledAt, normalized));
    const sessionIds = filteredSessions.map((session) => session.id);
    const sessionMap = new Map(filteredSessions.map((session) => [session.id, session]));

    const results: ClassLibrarySearchResult[] = [];
    if (this.includeType(normalized, 'session')) {
      results.push(...filteredSessions.map((session) => this.sessionResult(session, batchMap.get(session.batchId), audience)));
    }
    if (sessionIds.length) {
      const [materialDocs, recordingDocs, whiteboardDocs, assignmentDocs, announcements, qnaStates] = await Promise.all([
        this.includeType(normalized, 'material') ? this.loadMaterials(batchIds, sessionIds, audience) : Promise.resolve([]),
        this.includeType(normalized, 'recording') ? this.loadRecordings(batchIds, sessionIds, audience) : Promise.resolve([]),
        this.includeType(normalized, 'whiteboard') ? this.loadWhiteboards(batchIds, sessionIds, audience) : Promise.resolve([]),
        this.includeType(normalized, 'assignment') ? this.loadAssignments(batchIds, sessionIds, audience) : Promise.resolve([]),
        this.includeType(normalized, 'announcement') ? this.loadAnnouncements(batchIds, sessionIds) : Promise.resolve([]),
        this.includeType(normalized, 'qna') ? this.loadQnaStates(batchIds, sessionIds, user, audience) : Promise.resolve([])
      ]);
      results.push(...materialDocs.map((doc) => this.materialResult(doc, batchMap.get(doc.batchId), sessionMap.get(doc.sessionId), audience)));
      results.push(...recordingDocs.map((doc) => this.recordingResult(doc, batchMap.get(doc.batchId ?? ''), sessionMap.get(doc.sessionId ?? ''), audience)));
      results.push(...whiteboardDocs.map((doc) => this.whiteboardResult(doc, batchMap.get(doc.batchId), sessionMap.get(doc.sessionId), audience)));
      results.push(...assignmentDocs.map((doc) => this.assignmentResult(doc, batchMap.get(doc.batchId), sessionMap.get(doc.sessionId ?? ''), audience)));
      results.push(...announcements.map((doc) => this.announcementResult(doc, batchMap.get(doc.batchId ?? ''), sessionMap.get(doc.sessionId ?? ''), audience)));
      results.push(...qnaStates.map((doc) => this.qnaResult(doc, batchMap.get(doc.batchId), sessionMap.get(doc.sessionId), audience)));
    }

    const filtered = results
      .filter((result) => this.matchesStatus(result, normalized))
      .filter((result) => this.matchesText(result, normalized.q))
      .sort((left, right) => this.compareResults(left, right, normalized.q));
    const start = (normalized.page - 1) * normalized.limit;
    return {
      items: filtered.slice(start, start + normalized.limit),
      page: normalized.page,
      limit: normalized.limit,
      total: filtered.length,
      query: this.responseQuery(normalized)
    };
  }

  private async accessibleBatches(
    user: AuthenticatedUser,
    query: NormalizedSearchQuery,
    audience: SearchAudience
  ): Promise<BatchMongoDocument[]> {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (query.batchId) {
      filter._id = query.batchId;
    }
    if (query.courseId) {
      filter.courseId = query.courseId;
    }
    if (query.teacherId) {
      filter.teacherId = query.teacherId;
    }
    if (audience === 'teacher') {
      filter.teacherId = user.sub;
    }
    if (audience === 'student') {
      const batchIds = await this.studentEnrollments.listStudentClassHistoryBatchIds(user.sub);
      filter._id = query.batchId ? (batchIds.includes(query.batchId) ? query.batchId : '__none__') : { $in: batchIds.length ? batchIds : ['__none__'] };
    }
    return this.batches.find(filter).sort({ updatedAt: -1 }).limit(500).exec();
  }

  private loadMaterials(batchIds: string[], sessionIds: string[], audience: SearchAudience): Promise<ClassSessionMaterialMongoDocument[]> {
    const filter: Record<string, unknown> = {
      batchId: { $in: batchIds },
      sessionId: { $in: sessionIds },
      deletedAt: { $exists: false }
    };
    if (audience === 'student') {
      filter.$or = [
        { shared: true },
        { publishedAt: { $exists: true }, unpublishedAt: { $exists: false } }
      ];
    }
    return this.materials.find(filter).sort({ updatedAt: -1 }).limit(500).exec();
  }

  private loadRecordings(batchIds: string[], sessionIds: string[], audience: SearchAudience): Promise<RecordingMongoDocument[]> {
    const filter: Record<string, unknown> = {
      batchId: { $in: batchIds },
      sessionId: { $in: sessionIds }
    };
    if (audience === 'student') {
      filter.publishedAt = { $exists: true };
      filter.unpublishedAt = { $exists: false };
    }
    return this.recordings.find(filter).sort({ startedAt: -1 }).limit(500).exec();
  }

  private loadWhiteboards(batchIds: string[], sessionIds: string[], audience: SearchAudience): Promise<ClassSessionWhiteboardStateMongoDocument[]> {
    const filter: Record<string, unknown> = {
      batchId: { $in: batchIds },
      sessionId: { $in: sessionIds }
    };
    if (audience === 'student') {
      filter.publishedAt = { $exists: true };
      filter.unpublishedAt = { $exists: false };
    }
    return this.whiteboardStates.find(filter).sort({ updatedAt: -1 }).limit(500).exec();
  }

  private loadAssignments(batchIds: string[], sessionIds: string[], audience: SearchAudience): Promise<AssignmentMongoDocument[]> {
    const filter: Record<string, unknown> = {
      batchId: { $in: batchIds },
      deletedAt: { $exists: false },
      $or: [{ sessionId: { $in: sessionIds } }, { sessionId: { $exists: false } }]
    };
    if (audience === 'student') {
      filter.status = 'published';
    }
    return this.assignments.find(filter).sort({ updatedAt: -1 }).limit(500).exec();
  }

  private loadAnnouncements(batchIds: string[], sessionIds: string[]): Promise<ChatMessageMongoDocument[]> {
    return this.chatMessages
      .find({
        batchId: { $in: batchIds },
        sessionId: { $in: sessionIds },
        scope: 'broadcast',
        deletedAt: { $exists: false }
      })
      .sort({ createdAt: -1 })
      .limit(500)
      .exec();
  }

  private loadQnaStates(
    batchIds: string[],
    sessionIds: string[],
    user: AuthenticatedUser,
    audience: SearchAudience
  ): Promise<ClassSessionPostClassThreadStateMongoDocument[]> {
    const filter: Record<string, unknown> = {
      batchId: { $in: batchIds },
      sessionId: { $in: sessionIds }
    };
    if (audience === 'student') {
      filter.studentId = user.sub;
    }
    return this.postClassThreadStates.find(filter).sort({ updatedAt: -1 }).limit(500).exec();
  }

  private sessionResult(session: ClassSessionMongoDocument, batch: BatchMongoDocument | undefined, audience: SearchAudience): ClassLibrarySearchResult {
    return this.baseResult({
      id: `session:${session.id}`,
      artifactType: 'session',
      title: session.title,
      description: `${batch?.name ?? 'Class'} session ${session.sessionNumber}`,
      session,
      batch,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      scheduledAt: session.scheduledAt,
      completedAt: session.completedAt,
      detailUrl: this.sessionDetailUrl(session.id, session.batchId, audience),
      metadata: { sessionNumber: session.sessionNumber, durationMinutes: session.durationMinutes }
    });
  }

  private materialResult(
    material: ClassSessionMaterialMongoDocument,
    batch: BatchMongoDocument | undefined,
    session: ClassSessionMongoDocument | undefined,
    audience: SearchAudience
  ): ClassLibrarySearchResult {
    return this.baseResult({
      id: `material:${material.materialId}`,
      artifactType: 'material',
      title: material.title,
      description: material.description ?? material.fileName ?? material.kind,
      session,
      batch,
      status: this.publishedStatus(Boolean(material.shared || (material.publishedAt && !material.unpublishedAt))),
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
      targetUrl: material.source === 'upload'
        ? `/api/v1/class-sessions/${encodeURIComponent(material.sessionId)}/materials/${encodeURIComponent(material.materialId)}/download`
        : material.url,
      detailUrl: this.sessionDetailUrl(material.sessionId, material.batchId, audience),
      metadata: { kind: material.kind, source: material.source, fileName: material.fileName ?? null, size: material.size ?? null }
    });
  }

  private recordingResult(
    recording: RecordingMongoDocument,
    batch: BatchMongoDocument | undefined,
    session: ClassSessionMongoDocument | undefined,
    audience: SearchAudience
  ): ClassLibrarySearchResult {
    const recordingId = recording.recordingId ?? recording.id;
    return this.baseResult({
      id: `recording:${recordingId}`,
      artifactType: 'recording',
      title: `${session?.title ?? 'Class recording'} recording`,
      description: `${recording.scope} · ${recording.status}`,
      session,
      batch,
      status: recording.status,
      createdAt: recording.createdAt,
      updatedAt: recording.updatedAt,
      targetUrl: audience === 'admin' && recordingId ? `/recordings/${encodeURIComponent(recordingId)}` : undefined,
      detailUrl: recording.sessionId ? this.sessionDetailUrl(recording.sessionId, recording.batchId ?? session?.batchId, audience) : undefined,
      metadata: {
        scope: recording.scope,
        durationSeconds: recording.durationSeconds ?? null,
        published: Boolean(recording.publishedAt && !recording.unpublishedAt)
      }
    });
  }

  private whiteboardResult(
    state: ClassSessionWhiteboardStateMongoDocument,
    batch: BatchMongoDocument | undefined,
    session: ClassSessionMongoDocument | undefined,
    audience: SearchAudience
  ): ClassLibrarySearchResult {
    const pageTitles = (state.pages ?? []).map((page) => page.title).filter(Boolean).join(', ');
    const tags = (state.pages ?? []).flatMap((page) => page.tags ?? []).filter(Boolean).join(', ');
    return this.baseResult({
      id: `whiteboard:${state.sessionId}`,
      artifactType: 'whiteboard',
      title: `${session?.title ?? 'Class'} whiteboard notes`,
      description: pageTitles || tags || 'Saved whiteboard snapshot',
      session,
      batch,
      status: this.publishedStatus(Boolean(state.publishedAt && !state.unpublishedAt)),
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      detailUrl: this.sessionDetailUrl(state.sessionId, state.batchId, audience),
      metadata: {
        pages: state.pageCount,
        elements: state.elementCount,
        snapshotVersion: state.snapshotVersion,
        tags: tags || null
      }
    });
  }

  private assignmentResult(
    assignment: AssignmentMongoDocument,
    batch: BatchMongoDocument | undefined,
    session: ClassSessionMongoDocument | undefined,
    audience: SearchAudience
  ): ClassLibrarySearchResult {
    return this.baseResult({
      id: `assignment:${assignment.assignmentId}`,
      artifactType: 'assignment',
      title: assignment.title,
      description: this.preview(assignment.instructions, 220),
      session,
      batch,
      status: assignment.status,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
      detailUrl: audience === 'student'
        ? `/student/assignments/${encodeURIComponent(assignment.assignmentId)}`
        : assignment.sessionId
          ? this.sessionDetailUrl(assignment.sessionId, assignment.batchId, audience)
          : `/teacher/dashboard/batches/${encodeURIComponent(assignment.batchId)}`,
      metadata: {
        dueAt: assignment.dueAt?.toISOString() ?? null,
        sessionTitle: assignment.sessionTitle ?? null
      }
    });
  }

  private announcementResult(
    message: ChatMessageMongoDocument,
    batch: BatchMongoDocument | undefined,
    session: ClassSessionMongoDocument | undefined,
    audience: SearchAudience
  ): ClassLibrarySearchResult {
    return this.baseResult({
      id: `announcement:${message.id}`,
      artifactType: 'announcement',
      title: `Announcement: ${session?.title ?? batch?.name ?? 'Class'}`,
      description: this.preview(message.message, 220),
      excerpt: this.preview(message.message, 180),
      session,
      batch,
      status: message.context === 'post_class' ? 'post_class' : 'live',
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      detailUrl: message.sessionId ? this.sessionDetailUrl(message.sessionId, message.batchId, audience) : undefined,
      metadata: { senderName: message.senderName, context: message.context }
    });
  }

  private qnaResult(
    state: ClassSessionPostClassThreadStateMongoDocument,
    batch: BatchMongoDocument | undefined,
    session: ClassSessionMongoDocument | undefined,
    audience: SearchAudience
  ): ClassLibrarySearchResult {
    const status = state.answered ? 'answered' : 'unanswered';
    return this.baseResult({
      id: `qna:${state.sessionId}:${state.studentId}`,
      artifactType: 'qna',
      title: `Post-class Q&A: ${session?.title ?? batch?.name ?? 'Class'}`,
      description: [
        status,
        state.important ? 'important' : '',
        state.followUp ? 'follow-up' : ''
      ].filter(Boolean).join(' · '),
      session,
      batch,
      status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      detailUrl: this.sessionDetailUrl(state.sessionId, state.batchId, audience),
      metadata: {
        answered: state.answered,
        important: state.important,
        followUp: state.followUp,
        studentId: audience === 'student' ? 'self' : state.studentId
      }
    });
  }

  private baseResult(input: {
    id: string;
    artifactType: ClassLibraryArtifactType;
    title: string;
    description?: string;
    excerpt?: string;
    session?: ClassSessionMongoDocument;
    batch?: BatchMongoDocument;
    status?: string;
    detailUrl?: string;
    targetUrl?: string;
    createdAt?: Date;
    updatedAt?: Date;
    scheduledAt?: Date;
    completedAt?: Date;
    metadata?: Record<string, string | number | boolean | null | undefined>;
  }): ClassLibrarySearchResult {
    const metadata: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value !== undefined) {
        metadata[key] = value;
      }
    }
    return {
      id: input.id,
      artifactType: input.artifactType,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.excerpt ? { excerpt: input.excerpt } : {}),
      ...(input.session?.id ? { sessionId: input.session.id } : {}),
      ...(input.batch?.id ? { batchId: input.batch.id } : input.session?.batchId ? { batchId: input.session.batchId } : {}),
      ...(input.batch?.name ? { batchName: input.batch.name } : {}),
      ...(input.batch?.courseId ? { courseId: input.batch.courseId } : {}),
      ...(input.batch?.courseName ? { courseName: input.batch.courseName } : {}),
      ...(input.session?.teacherId ?? input.batch?.teacherId ? { teacherId: input.session?.teacherId ?? input.batch?.teacherId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.detailUrl ? { detailUrl: input.detailUrl } : {}),
      ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
      createdAt: this.dateToIso(input.createdAt ?? input.updatedAt ?? input.session?.scheduledAt ?? new Date(0)),
      ...(input.updatedAt ? { updatedAt: this.dateToIso(input.updatedAt) } : {}),
      ...(input.scheduledAt ?? input.session?.scheduledAt ? { scheduledAt: this.dateToIso(input.scheduledAt ?? input.session?.scheduledAt) } : {}),
      ...(input.completedAt ?? input.session?.completedAt ? { completedAt: this.dateToIso(input.completedAt ?? input.session?.completedAt) } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {})
    };
  }

  private normalizeQuery(query: ClassLibrarySearchQuery): NormalizedSearchQuery {
    const page = this.toBoundedNumber(query.page, 1, 1, 500);
    const limit = this.toBoundedNumber(query.limit, 20, 1, 50);
    const artifactType = query.artifactType && query.artifactType !== 'all' ? query.artifactType : undefined;
    return {
      q: this.cleanString(query.q).slice(0, 120),
      page,
      limit,
      ...(this.cleanString(query.courseId) ? { courseId: this.cleanString(query.courseId) } : {}),
      ...(this.cleanString(query.batchId) ? { batchId: this.cleanString(query.batchId) } : {}),
      ...(this.cleanString(query.teacherId) ? { teacherId: this.cleanString(query.teacherId) } : {}),
      ...(this.parseDate(query.dateFrom) ? { dateFrom: this.parseDate(query.dateFrom) } : {}),
      ...(this.parseDate(query.dateTo, true) ? { dateTo: this.parseDate(query.dateTo, true) } : {}),
      ...(artifactType ? { artifactType } : {}),
      ...(this.cleanString(query.status) ? { status: this.cleanString(query.status).toLowerCase() } : {})
    };
  }

  private responseQuery(query: NormalizedSearchQuery): ClassLibrarySearchQuery {
    return {
      ...(query.q ? { q: query.q } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom.toISOString() } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo.toISOString() } : {}),
      ...(query.artifactType ? { artifactType: query.artifactType } : {}),
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit
    };
  }

  private includeType(query: NormalizedSearchQuery, artifactType: ClassLibraryArtifactType): boolean {
    return !query.artifactType || query.artifactType === artifactType;
  }

  private matchesStatus(result: ClassLibrarySearchResult, query: NormalizedSearchQuery): boolean {
    return !query.status || (result.status ?? '').toLowerCase() === query.status;
  }

  private matchesText(result: ClassLibrarySearchResult, query: string): boolean {
    if (!query) {
      return true;
    }
    const haystack = [
      result.artifactType,
      result.title,
      result.description,
      result.excerpt,
      result.batchName,
      result.courseName,
      result.status,
      ...Object.values(result.metadata ?? {}).map((value) => String(value ?? ''))
    ].join(' ').toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  private compareResults(left: ClassLibrarySearchResult, right: ClassLibrarySearchResult, query: string): number {
    if (query) {
      const scoreDelta = this.score(right, query) - this.score(left, query);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
    }
    return Date.parse(right.updatedAt ?? right.completedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.completedAt ?? left.createdAt);
  }

  private score(result: ClassLibrarySearchResult, query: string): number {
    const needle = query.toLowerCase();
    let score = 0;
    if (result.title.toLowerCase().includes(needle)) score += 40;
    if ((result.description ?? '').toLowerCase().includes(needle)) score += 16;
    if ((result.batchName ?? '').toLowerCase().includes(needle)) score += 10;
    if ((result.courseName ?? '').toLowerCase().includes(needle)) score += 10;
    if ((result.status ?? '').toLowerCase().includes(needle)) score += 6;
    return score;
  }

  private resultDateMatches(value: Date | undefined, query: NormalizedSearchQuery): boolean {
    if (!value) {
      return true;
    }
    const time = value.getTime();
    return (!query.dateFrom || time >= query.dateFrom.getTime()) && (!query.dateTo || time <= query.dateTo.getTime());
  }

  private sessionDetailUrl(sessionId: string, batchId: string | undefined, audience: SearchAudience): string {
    if (audience === 'admin') {
      return `/class-sessions/${encodeURIComponent(sessionId)}`;
    }
    if (audience === 'student') {
      return `/student/classes/completed/${encodeURIComponent(sessionId)}`;
    }
    return `/teacher/dashboard/batches/${encodeURIComponent(batchId ?? '')}`;
  }

  private publishedStatus(published: boolean): string {
    return published ? 'published' : 'draft';
  }

  private preview(value: string | undefined, maxLength: number): string {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  }

  private cleanString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private parseDate(value: unknown, endOfDay = false): Date | undefined {
    const text = this.cleanString(value);
    if (!text) {
      return undefined;
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      return undefined;
    }
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }

  private toBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(numeric)));
  }

  private audienceFor(user: AuthenticatedUser): SearchAudience {
    if (this.isAdmin(user)) {
      return 'admin';
    }
    if (this.hasRole(user, 'TEACHER')) {
      return 'teacher';
    }
    return 'student';
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return this.hasRole(user, 'ADMIN') || this.hasRole(user, 'SUPER_ADMIN');
  }

  private hasRole(user: AuthenticatedUser, role: string): boolean {
    return user.roles.map((item) => item.toUpperCase()).includes(role);
  }

  private dateToIso(value: Date | undefined): string {
    return value ? value.toISOString() : new Date(0).toISOString();
  }

  private emptyResponse(query: NormalizedSearchQuery): ClassLibrarySearchResponse {
    return {
      items: [],
      page: query.page,
      limit: query.limit,
      total: 0,
      query: this.responseQuery(query)
    };
  }
}
