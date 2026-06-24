import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type {
  AdminBatchCreateRequest,
  AdminBatchDetail,
  AdminBatchListItem,
  AdminBatchListQuery,
  AdminBatchListResponse,
  AdminBatchRosterItem,
  AdminBatchRosterResponse,
  AdminBatchSessionItem,
  AdminBatchSessionListResponse,
  AdminBatchSort,
  AdminBatchSummary,
  AdminBatchUpdateRequest,
  AdminCourseDetail,
  AdminCourseListItem,
  AdminCourseListQuery,
  AdminCourseListResponse,
  AdminCourseSort,
  AdminCourseStatus,
  AdminCourseSummary,
  AdminCourseUpdateRequest,
  BatchLiveClassSettingsResponse,
  LiveClassSettingsPatch
} from '@native-sfu/contracts';
import { Connection, ClientSession, FilterQuery, Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  BatchStatus,
  BatchWeekday,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ClassSessionStatus,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { classSessionChannelIds, PlannedClassSession, planClassSessions } from '../class-sessions/class-session-planner';
import { StudentEnrollmentRosterItem, StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';
import { ProfilesService } from '../profiles/profiles.service';
import { BatchScheduleDto, CreateTeacherBatchDto, UpdateTeacherBatchDto } from './dto/teacher-batch.dto';

interface BatchWithSchedules {
  batch: BatchMongoDocument;
  schedules: BatchScheduleMongoDocument[];
}

@Injectable()
export class TeacherBatchesService {
  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly studentEnrollments: StudentEnrollmentsService,
    private readonly profiles: ProfilesService,
    @Optional() private readonly auditLogs?: AuditLogsService
  ) {}

  async create(teacherId: string, dto: CreateTeacherBatchDto): Promise<Record<string, unknown>> {
    const schedule = this.normalizeSchedule(dto.schedule);
    await this.assertUniqueBatch(teacherId, dto.name, dto.year);
    const dates = this.yearDates(dto.year);

    return this.withTransaction(async (session) => {
      const [batch] = await this.batches.create(
        [
          {
            name: dto.name.trim(),
            courseId: this.optionalTrim(dto.courseId),
            courseName: this.optionalTrim(dto.courseName),
            teacherId,
            year: dto.year,
            startDate: dates.startDate,
            endDate: dates.endDate,
            maxCapacity: dto.maxCapacity,
            status: 'ACTIVE'
          }
        ],
        { session }
      );
      if (!batch) {
        throw new BadRequestException('Batch could not be created.');
      }
      await this.schedules.insertMany(
        schedule.map((item) => ({ batchId: batch.id, dayOfWeek: item.dayOfWeek, startTime: item.startTime })),
        { session }
      );
      return this.findOne(teacherId, batch.id, session);
    });
  }

  async findAll(teacherId: string): Promise<Record<string, unknown>[]> {
    const batches = await this.batches.find({ teacherId, deletedAt: { $exists: false } }).sort({ createdAt: -1 });
    const scheduleMap = await this.scheduleMap(batches.map((batch) => batch.id));
    const sessionMap = await this.classSessionMap(batches.map((batch) => batch.id));
    return Promise.all(batches.map((batch) => this.serialize(batch, scheduleMap.get(batch.id) ?? [], sessionMap.get(batch.id) ?? [])));
  }

  async findOne(teacherId: string, id: string, session?: ClientSession): Promise<Record<string, unknown>> {
    const data = await this.findOwnedWithSchedules(teacherId, id, session);
    const classSessions = await this.classSessions.find({ batchId: id }).sort({ scheduledAt: 1 }).session(session ?? null);
    return this.serialize(data.batch, data.schedules, classSessions);
  }

  async update(teacherId: string, id: string, dto: UpdateTeacherBatchDto): Promise<Record<string, unknown>> {
    const existing = await this.findOwnedBatch(teacherId, id);
    const nextName = dto.name?.trim() ?? existing.name;
    const nextYear = dto.year ?? existing.year;
    const schedule = dto.schedule ? this.normalizeSchedule(dto.schedule) : undefined;

    if (nextName !== existing.name || nextYear !== existing.year) {
      await this.assertUniqueBatch(teacherId, nextName, nextYear, id);
    }

    const update: Partial<BatchDocument> = {};
    if (dto.name !== undefined) update.name = nextName;
    if (dto.courseId !== undefined) update.courseId = this.optionalTrim(dto.courseId);
    if (dto.courseName !== undefined) update.courseName = this.optionalTrim(dto.courseName);
    if (dto.year !== undefined) {
      const dates = this.yearDates(dto.year);
      update.year = dto.year;
      update.startDate = dates.startDate;
      update.endDate = dates.endDate;
    }
    if (dto.maxCapacity !== undefined) {
      const enrolledCount = await this.currentEnrolledCount(id);
      if (dto.maxCapacity < enrolledCount) {
        throw new BadRequestException('Max capacity cannot be less than enrolled student count.');
      }
      update.maxCapacity = dto.maxCapacity;
    }

    return this.withTransaction(async (session) => {
      if (Object.keys(update).length) {
        await this.batches.updateOne({ _id: id, teacherId, deletedAt: { $exists: false } }, { $set: update }, { session });
      }
      if (schedule) {
        await this.schedules.deleteMany({ batchId: id }, { session });
        await this.schedules.insertMany(
          schedule.map((item) => ({ batchId: id, dayOfWeek: item.dayOfWeek, startTime: item.startTime })),
          { session }
        );
      }
      return this.findOne(teacherId, id, session);
    });
  }

  async updateStatus(teacherId: string, id: string, status: BatchStatus): Promise<Record<string, unknown>> {
    const batch = await this.batches.findOneAndUpdate(
      { _id: id, teacherId, deletedAt: { $exists: false } },
      { $set: { status } },
      { new: true }
    );
    if (!batch) throw new NotFoundException('Batch not found');
    const schedules = await this.schedules.find({ batchId: id }).sort({ dayOfWeek: 1 });
    const classSessions = await this.classSessions.find({ batchId: id }).sort({ scheduledAt: 1 });
    return this.serialize(batch, schedules, classSessions);
  }

  async remove(teacherId: string, id: string): Promise<void> {
    const batch = await this.batches.findOneAndUpdate(
      { _id: id, teacherId, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), status: 'CANCELLED' } },
      { new: true }
    );
    if (!batch) throw new NotFoundException('Batch not found');
  }

  async getLiveSettings(teacherId: string, batchId: string): Promise<BatchLiveClassSettingsResponse> {
    const batch = await this.findOwnedBatch(teacherId, batchId);
    return this.profiles.resolveBatchLiveSettings(batch);
  }

  async updateLiveSettings(teacherId: string, batchId: string, patch: LiveClassSettingsPatch): Promise<BatchLiveClassSettingsResponse> {
    const batch = await this.findOwnedBatch(teacherId, batchId);
    const next = this.profiles.normalizeLiveSettingsPatch(patch);
    batch.liveSettingsOverrides = next as BatchMongoDocument['liveSettingsOverrides'];
    await batch.save();
    return this.profiles.resolveBatchLiveSettings(batch);
  }

  async resetLiveSettings(teacherId: string, batchId: string): Promise<BatchLiveClassSettingsResponse> {
    const batch = await this.findOwnedBatch(teacherId, batchId);
    batch.liveSettingsOverrides = undefined;
    await batch.save();
    return this.profiles.resolveBatchLiveSettings(batch);
  }

  async listAdminCourses(query: AdminCourseListQuery, user: AuthenticatedUser): Promise<AdminCourseListResponse> {
    this.assertAdmin(user);
    const page = this.clampPositiveInteger(query.page, 1, 10_000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const batches = await this.batches.find(this.adminCourseBatchFilter(query)).sort({ updatedAt: -1, createdAt: -1 }).exec();
    const countMap = await this.studentEnrollments.activeCountByBatchIds(batches.map((batch) => batch.id));
    const grouped = this.groupCourses(batches, countMap);
    const statusFiltered = query.status && query.status !== 'all' ? grouped.filter((course) => course.status === query.status) : grouped;
    const sorted = this.sortAdminCourses(statusFiltered, query.sort);
    const summary = this.courseSummary(grouped);
    const start = (page - 1) * limit;
    return {
      items: sorted.slice(start, start + limit),
      summary,
      page,
      limit,
      total: statusFiltered.length
    };
  }

  async getAdminCourse(courseId: string, user: AuthenticatedUser): Promise<AdminCourseDetail> {
    this.assertAdmin(user);
    return this.adminCourseDetail(courseId);
  }

  async updateAdminCourse(courseId: string, request: AdminCourseUpdateRequest, user: AuthenticatedUser): Promise<AdminCourseDetail> {
    this.assertAdmin(user);
    const courseName = request.courseName?.trim();
    if (!courseName || courseName.length < 2) {
      throw new BadRequestException('Course name must be at least 2 characters.');
    }
    const result = await this.batches.updateMany(this.courseBatchFilter(courseId), { $set: { courseName } }).exec();
    if (!result.matchedCount) {
      throw new NotFoundException('Course not found.');
    }
    const detail = await this.adminCourseDetail(courseId);
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.courses.update',
      resourceType: 'course',
      resourceId: courseId,
      resourceLabel: detail.courseName,
      metadata: { summary: `Updated course ${detail.courseName}`, matchedBatches: result.matchedCount },
      after: { courseName: detail.courseName }
    });
    return detail;
  }

  async listAdminBatches(query: AdminBatchListQuery, user: AuthenticatedUser): Promise<AdminBatchListResponse> {
    this.assertAdmin(user);
    const page = this.clampPositiveInteger(query.page, 1, 10_000);
    const limit = this.clampPositiveInteger(query.limit, 25, 100);
    const filter = this.adminBatchFilter(query);
    const skip = (page - 1) * limit;
    const [batches, total, summary] = await Promise.all([
      this.batches.find(filter).sort(this.adminBatchSort(query.sort)).skip(skip).limit(limit).exec(),
      this.batches.countDocuments(filter).exec(),
      this.adminBatchSummary()
    ]);
    const items = await this.toAdminBatchListItems(batches);
    return { items, summary, page, limit, total };
  }

  async getAdminBatch(batchId: string, user: AuthenticatedUser): Promise<AdminBatchDetail> {
    this.assertAdmin(user);
    return this.adminBatchDetail(batchId);
  }

  async createAdminBatch(courseId: string, request: AdminBatchCreateRequest, user: AuthenticatedUser): Promise<AdminBatchDetail> {
    this.assertAdmin(user);
    const schedule = this.normalizeSchedule(request.schedule);
    const teacher = await this.findActiveTeacher(request.teacherId);
    await this.assertUniqueBatch(teacher.id, request.name, request.year);
    const dates = this.yearDates(request.year);
    const detail = await this.withTransaction(async (session) => {
      const [batch] = await this.batches.create(
        [
          {
            name: request.name.trim(),
            courseId: this.optionalTrim(courseId),
            courseName: this.optionalTrim(request.courseName),
            teacherId: teacher.id,
            year: request.year,
            startDate: dates.startDate,
            endDate: dates.endDate,
            maxCapacity: request.maxCapacity,
            status: 'ACTIVE'
          }
        ],
        { session }
      );
      if (!batch) {
        throw new BadRequestException('Batch could not be created.');
      }
      await this.schedules.insertMany(
        schedule.map((item) => ({ batchId: batch.id, dayOfWeek: item.dayOfWeek, startTime: item.startTime })),
        { session }
      );
      return this.adminBatchDetail(batch.id, session);
    });
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.batches.create',
      resourceType: 'batch',
      resourceId: detail.id,
      resourceLabel: detail.name,
      metadata: { summary: `Created batch ${detail.name}`, courseId: detail.courseId, teacherId: detail.teacherId },
      after: { name: detail.name, courseId: detail.courseId, teacherId: detail.teacherId, status: detail.status }
    });
    return detail;
  }

  async updateAdminBatch(batchId: string, request: AdminBatchUpdateRequest, user: AuthenticatedUser): Promise<AdminBatchDetail> {
    this.assertAdmin(user);
    const existing = await this.findAdminBatch(batchId);
    const nextTeacherId = request.teacherId?.trim() || existing.teacherId;
    const nextName = request.name?.trim() || existing.name;
    const nextYear = request.year ?? existing.year;
    const schedule = request.schedule ? this.normalizeSchedule(request.schedule) : undefined;
    const structuralChange = Boolean(
      schedule || (request.year !== undefined && nextYear !== existing.year) || (request.teacherId !== undefined && nextTeacherId !== existing.teacherId)
    );
    if (structuralChange) {
      await this.assertNoLiveOrCompletedSessions(batchId);
    }
    if (nextTeacherId !== existing.teacherId) {
      await this.findActiveTeacher(nextTeacherId);
    }
    if (nextTeacherId !== existing.teacherId || nextName !== existing.name || nextYear !== existing.year) {
      await this.assertUniqueBatch(nextTeacherId, nextName, nextYear, batchId);
    }
    if (request.maxCapacity !== undefined) {
      const enrolledCount = await this.currentEnrolledCount(batchId);
      if (request.maxCapacity < enrolledCount) {
        throw new BadRequestException('Max capacity cannot be less than enrolled student count.');
      }
    }
    const update: Partial<BatchDocument> = {};
    if (request.name !== undefined) update.name = nextName;
    if (request.courseId !== undefined) update.courseId = this.optionalTrim(request.courseId);
    if (request.courseName !== undefined) update.courseName = this.optionalTrim(request.courseName);
    if (request.teacherId !== undefined && nextTeacherId !== existing.teacherId) update.teacherId = nextTeacherId;
    if (request.year !== undefined && nextYear !== existing.year) {
      const dates = this.yearDates(nextYear);
      update.year = nextYear;
      update.startDate = dates.startDate;
      update.endDate = dates.endDate;
    }
    if (request.maxCapacity !== undefined) update.maxCapacity = request.maxCapacity;
    if (request.status !== undefined) update.status = request.status;
    const detail = await this.withTransaction(async (session) => {
      if (Object.keys(update).length) {
        await this.batches.updateOne({ _id: batchId, deletedAt: { $exists: false } }, { $set: update }, { session });
        if (update.teacherId !== undefined) {
          await this.classSessions.updateMany({ batchId, status: 'scheduled' }, { $set: { teacherId: nextTeacherId } }, { session });
        }
      }
      if (schedule) {
        await this.schedules.deleteMany({ batchId }, { session });
        await this.schedules.insertMany(
          schedule.map((item) => ({ batchId, dayOfWeek: item.dayOfWeek, startTime: item.startTime })),
          { session }
        );
      }
      return this.adminBatchDetail(batchId, session);
    });
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.batches.update',
      resourceType: 'batch',
      resourceId: detail.id,
      resourceLabel: detail.name,
      metadata: { summary: `Updated batch ${detail.name}`, changedFields: Object.keys(update), scheduleUpdated: Boolean(schedule) },
      before: {
        name: existing.name,
        courseId: existing.courseId,
        courseName: existing.courseName,
        teacherId: existing.teacherId,
        year: existing.year,
        maxCapacity: existing.maxCapacity,
        status: existing.status
      },
      after: {
        name: detail.name,
        courseId: detail.courseId,
        courseName: detail.courseName,
        teacherId: detail.teacherId,
        year: detail.year,
        maxCapacity: detail.maxCapacity,
        status: detail.status
      }
    });
    return detail;
  }

  async updateAdminBatchStatus(batchId: string, status: BatchStatus, user: AuthenticatedUser): Promise<AdminBatchDetail> {
    this.assertAdmin(user);
    const batch = await this.batches.findOneAndUpdate({ _id: batchId, deletedAt: { $exists: false } }, { $set: { status } }, { new: true }).exec();
    if (!batch) {
      throw new NotFoundException('Batch not found.');
    }
    const detail = await this.adminBatchDetail(batch.id);
    await this.auditLogs?.record({
      actor: user,
      action: 'admin.batches.status_update',
      resourceType: 'batch',
      resourceId: detail.id,
      resourceLabel: detail.name,
      metadata: { summary: `Set batch ${detail.name} to ${status}` },
      after: { status: detail.status }
    });
    return detail;
  }

  async getAdminBatchRoster(batchId: string, user: AuthenticatedUser): Promise<AdminBatchRosterResponse> {
    this.assertAdmin(user);
    await this.findAdminBatch(batchId);
    const roster = await this.studentEnrollments.listBatchRoster(batchId);
    const items = roster.map((item) => this.toAdminRosterItem(item));
    return { batchId, items, total: items.length };
  }

  async getAdminBatchSessions(batchId: string, user: AuthenticatedUser): Promise<AdminBatchSessionListResponse> {
    this.assertAdmin(user);
    const detail = await this.adminBatchDetail(batchId);
    return { batchId, items: detail.sessions, total: detail.sessions.length };
  }

  private async findOwnedBatch(teacherId: string, id: string, session?: ClientSession): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: id, teacherId, deletedAt: { $exists: false } }).session(session ?? null);
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  private async findOwnedWithSchedules(teacherId: string, id: string, session?: ClientSession): Promise<BatchWithSchedules> {
    const batch = await this.findOwnedBatch(teacherId, id, session);
    const schedules = await this.schedules.find({ batchId: id }).sort({ dayOfWeek: 1 }).session(session ?? null);
    return { batch, schedules };
  }

  private async findAdminBatch(id: string, session?: ClientSession): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: id, deletedAt: { $exists: false } }).session(session ?? null);
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  private async findActiveTeacher(teacherId: string): Promise<UserMongoDocument> {
    const teacher = await this.users.findOne({
      _id: teacherId,
      roles: 'TEACHER',
      status: 'active',
      disabled: false,
      deletedAt: { $exists: false }
    }).exec();
    if (!teacher) {
      throw new BadRequestException('Assigned teacher must be an active teacher user.');
    }
    return teacher;
  }

  private async adminCourseDetail(courseId: string): Promise<AdminCourseDetail> {
    const batches = await this.batches.find(this.courseBatchFilter(courseId)).sort({ updatedAt: -1, createdAt: -1 }).exec();
    if (!batches.length) {
      throw new NotFoundException('Course not found.');
    }
    const countMap = await this.studentEnrollments.activeCountByBatchIds(batches.map((batch) => batch.id));
    const course = this.groupCourses(batches, countMap)[0];
    if (!course) {
      throw new NotFoundException('Course not found.');
    }
    const batchItems = await this.toAdminBatchListItems(batches);
    return {
      ...course,
      batches: batchItems
    };
  }

  private async adminBatchDetail(batchId: string, session?: ClientSession): Promise<AdminBatchDetail> {
    const batch = await this.findAdminBatch(batchId, session);
    const [schedules, persistedSessions, roster, teachers, countMap] = await Promise.all([
      this.schedules.find({ batchId }).sort({ dayOfWeek: 1 }).session(session ?? null).exec(),
      this.classSessions.find({ batchId }).sort({ scheduledAt: 1 }).session(session ?? null).exec(),
      this.studentEnrollments.listBatchRoster(batchId),
      this.teacherMap([batch.teacherId]),
      this.studentEnrollments.activeCountByBatchIds([batch.id])
    ]);
    return {
      ...this.toAdminBatchListItem(batch, schedules, countMap.get(batch.id) ?? 0, teachers.get(batch.teacherId), persistedSessions),
      roster: roster.map((item) => this.toAdminRosterItem(item)),
      sessions: this.toAdminBatchSessions(batch, schedules, persistedSessions)
    };
  }

  private async toAdminBatchListItems(batches: BatchMongoDocument[]): Promise<AdminBatchListItem[]> {
    if (!batches.length) {
      return [];
    }
    const batchIds = batches.map((batch) => batch.id);
    const [scheduleMap, sessionMap, countMap, teachers] = await Promise.all([
      this.scheduleMap(batchIds),
      this.classSessionMap(batchIds),
      this.studentEnrollments.activeCountByBatchIds(batchIds),
      this.teacherMap(batches.map((batch) => batch.teacherId).filter(Boolean))
    ]);
    return batches.map((batch) =>
      this.toAdminBatchListItem(
        batch,
        scheduleMap.get(batch.id) ?? [],
        countMap.get(batch.id) ?? 0,
        teachers.get(batch.teacherId),
        sessionMap.get(batch.id) ?? []
      )
    );
  }

  private toAdminBatchListItem(
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    enrolledCount: number,
    teacher?: UserMongoDocument,
    persistedSessions: ClassSessionMongoDocument[] = []
  ): AdminBatchListItem {
    const nextSessionAt = this.nextSessionAt(batch, schedules, persistedSessions);
    return {
      id: batch.id,
      name: batch.name,
      ...(batch.courseId ? { courseId: batch.courseId } : {}),
      ...(batch.courseName ? { courseName: batch.courseName } : {}),
      teacherId: batch.teacherId,
      ...(teacher ? { teacherName: teacher.displayName ?? teacher.name, teacherEmail: teacher.email } : {}),
      year: batch.year,
      startDate: this.dateOnly(batch.startDate),
      endDate: this.dateOnly(batch.endDate),
      maxCapacity: batch.maxCapacity,
      enrolledCount,
      status: batch.status,
      schedule: schedules.map((schedule) => ({
        id: schedule.id,
        dayOfWeek: schedule.dayOfWeek,
        startTime: schedule.startTime
      })),
      ...(nextSessionAt ? { nextSessionAt } : {}),
      ...(batch.createdAt ? { createdAt: batch.createdAt.toISOString() } : {}),
      ...(batch.updatedAt ? { updatedAt: batch.updatedAt.toISOString() } : {})
    };
  }

  private toAdminBatchSessions(
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    persistedSessions: ClassSessionMongoDocument[]
  ): AdminBatchSessionItem[] {
    const persistedById = new Map(persistedSessions.map((session) => [session.id, session]));
    const planned = planClassSessions(batch, schedules).map((session) => this.toAdminBatchSession(session, persistedById.get(session.id)));
    const plannedIds = new Set(planned.map((session) => session.id));
    const orphaned = persistedSessions
      .filter((session) => !plannedIds.has(session.id))
      .map((session) =>
        this.toAdminBatchSession(
          {
            id: session.id,
            batchId: session.batchId,
            title: session.title,
            sessionNumber: session.sessionNumber,
            scheduledAt: session.scheduledAt,
            durationMinutes: session.durationMinutes
          },
          session
        )
      );
    return [...planned, ...orphaned].sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime());
  }

  private toAdminBatchSession(planned: PlannedClassSession, persisted?: ClassSessionMongoDocument): AdminBatchSessionItem {
    const channelIds = classSessionChannelIds(planned.id);
    return {
      id: planned.id,
      batchId: planned.batchId,
      title: persisted?.title ?? planned.title,
      sessionNumber: persisted?.sessionNumber ?? planned.sessionNumber,
      scheduledAt: (persisted?.scheduledAt ?? planned.scheduledAt).toISOString(),
      durationMinutes: persisted?.durationMinutes ?? planned.durationMinutes,
      status: persisted?.status ?? 'scheduled',
      roomId: persisted?.roomId ?? channelIds.roomId,
      ...(persisted?.startedAt ? { startedAt: persisted.startedAt.toISOString() } : {}),
      ...(persisted?.completedAt ? { completedAt: persisted.completedAt.toISOString() } : {})
    };
  }

  private toAdminRosterItem(item: StudentEnrollmentRosterItem): AdminBatchRosterItem {
    return {
      id: item.id,
      enrollmentId: item.enrollmentId,
      userId: item.userId,
      displayName: item.displayName,
      email: item.email,
      status: item.status,
      joinedAt: item.joinedAt
    };
  }

  private nextSessionAt(
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    persistedSessions: ClassSessionMongoDocument[]
  ): string | undefined {
    const now = Date.now();
    const sessions = this.toAdminBatchSessions(batch, schedules, persistedSessions);
    return sessions.find((session) => session.status !== 'completed' && session.status !== 'cancelled' && new Date(session.scheduledAt).getTime() >= now)?.scheduledAt;
  }

  private async teacherMap(teacherIds: string[]): Promise<Map<string, UserMongoDocument>> {
    const ids = [...new Set(teacherIds.filter(Boolean))];
    if (!ids.length) {
      return new Map();
    }
    const teachers = await this.users.find({ _id: { $in: ids }, deletedAt: { $exists: false } }).exec();
    return teachers.reduce((map, teacher) => {
      map.set(teacher.id, teacher);
      return map;
    }, new Map<string, UserMongoDocument>());
  }

  private groupCourses(batches: BatchMongoDocument[], countMap: Map<string, number>): AdminCourseListItem[] {
    const groups = new Map<
      string,
      {
        courseId: string;
        courseName: string;
        statuses: BatchStatus[];
        batchCount: number;
        activeStudentCount: number;
        teachers: Set<string>;
        createdAt?: Date;
        updatedAt?: Date;
      }
    >();
    for (const batch of batches) {
      const courseId = this.adminCourseId(batch);
      const existing = groups.get(courseId) ?? {
        courseId,
        courseName: batch.courseName?.trim() || batch.courseId?.trim() || 'Unassigned course',
        statuses: [],
        batchCount: 0,
        activeStudentCount: 0,
        teachers: new Set<string>(),
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt
      };
      if (batch.courseName?.trim()) {
        existing.courseName = batch.courseName.trim();
      }
      existing.statuses.push(batch.status);
      existing.batchCount += 1;
      existing.activeStudentCount += countMap.get(batch.id) ?? 0;
      if (batch.status === 'ACTIVE') {
        existing.teachers.add(batch.teacherId);
      }
      if (batch.createdAt && (!existing.createdAt || batch.createdAt < existing.createdAt)) {
        existing.createdAt = batch.createdAt;
      }
      if (batch.updatedAt && (!existing.updatedAt || batch.updatedAt > existing.updatedAt)) {
        existing.updatedAt = batch.updatedAt;
      }
      groups.set(courseId, existing);
    }
    return [...groups.values()]
      .map((group) => ({
        courseId: group.courseId,
        courseName: group.courseName,
        status: this.courseStatus(group.statuses),
        batchCount: group.batchCount,
        activeBatchCount: group.statuses.filter((status) => status === 'ACTIVE').length,
        activeStudentCount: group.activeStudentCount,
        teacherCount: group.teachers.size,
        ...(group.createdAt ? { createdAt: group.createdAt.toISOString() } : {}),
        ...(group.updatedAt ? { updatedAt: group.updatedAt.toISOString() } : {})
      }))
      .sort((left, right) => new Date(right.updatedAt ?? '').getTime() - new Date(left.updatedAt ?? '').getTime());
  }

  private courseStatus(statuses: BatchStatus[]): AdminCourseStatus {
    if (statuses.includes('ACTIVE')) return 'active';
    if (statuses.includes('INACTIVE')) return 'inactive';
    if (statuses.includes('COMPLETED')) return 'completed';
    return 'cancelled';
  }

  private courseSummary(courses: AdminCourseListItem[]): AdminCourseSummary {
    return {
      totalCourses: courses.length,
      activeCourses: courses.filter((course) => course.status === 'active').length,
      inactiveCourses: courses.filter((course) => course.status === 'inactive').length,
      archivedCourses: courses.filter((course) => course.status === 'completed' || course.status === 'cancelled').length
    };
  }

  private sortAdminCourses(courses: AdminCourseListItem[], sort: AdminCourseSort = 'updated_desc'): AdminCourseListItem[] {
    return [...courses].sort((left, right) => {
      if (sort === 'name_asc' || sort === 'name_desc') {
        return sort === 'name_asc'
          ? left.courseName.localeCompare(right.courseName)
          : right.courseName.localeCompare(left.courseName);
      }
      const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
      const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
      return sort === 'updated_asc' ? leftTime - rightTime : rightTime - leftTime;
    });
  }

  private adminBatchSort(sort: AdminBatchSort = 'updated_desc'): Record<string, 1 | -1> {
    if (sort === 'name_asc') return { name: 1, updatedAt: -1 };
    if (sort === 'name_desc') return { name: -1, updatedAt: -1 };
    if (sort === 'start_asc') return { startDate: 1, updatedAt: -1 };
    if (sort === 'start_desc') return { startDate: -1, updatedAt: -1 };
    if (sort === 'updated_asc') return { updatedAt: 1, createdAt: 1 };
    return { updatedAt: -1, createdAt: -1 };
  }

  private async adminBatchSummary(): Promise<AdminBatchSummary> {
    const base = { deletedAt: { $exists: false } };
    const [allBatches, totalBatches, activeBatches, completedBatches, cancelledBatches] = await Promise.all([
      this.batches.find(base).exec(),
      this.batches.countDocuments(base).exec(),
      this.batches.countDocuments({ ...base, status: 'ACTIVE' }).exec(),
      this.batches.countDocuments({ ...base, status: 'COMPLETED' }).exec(),
      this.batches.countDocuments({ ...base, status: 'CANCELLED' }).exec()
    ]);
    const countMap = await this.studentEnrollments.activeCountByBatchIds(allBatches.map((batch) => batch.id));
    const activeStudents = [...countMap.values()].reduce((total, count) => total + count, 0);
    return { totalBatches, activeBatches, completedBatches, cancelledBatches, activeStudents };
  }

  private adminCourseBatchFilter(query: AdminCourseListQuery): FilterQuery<BatchDocument> {
    const filter: FilterQuery<BatchDocument> = { deletedAt: { $exists: false } };
    const search = query.search?.trim();
    if (search) {
      const regex = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [{ courseId: regex }, { courseName: regex }, { name: regex }];
    }
    return filter;
  }

  private adminBatchFilter(query: AdminBatchListQuery): FilterQuery<BatchDocument> {
    const filter: FilterQuery<BatchDocument> = { deletedAt: { $exists: false } };
    if (query.courseId?.trim()) filter.courseId = query.courseId.trim();
    if (query.teacherId?.trim()) filter.teacherId = query.teacherId.trim();
    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.dateFrom || query.dateTo) {
      filter.startDate = {
        ...(query.dateFrom ? { $gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
        ...(query.dateTo ? { $lte: new Date(`${query.dateTo}T23:59:59.999Z`) } : {})
      };
    }
    const search = query.search?.trim();
    if (search) {
      const regex = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [{ name: regex }, { courseId: regex }, { courseName: regex }, { teacherId: regex }];
    }
    return filter;
  }

  private courseBatchFilter(courseId: string): FilterQuery<BatchDocument> {
    if (courseId === 'unassigned') {
      return { deletedAt: { $exists: false }, $or: [{ courseId: { $exists: false } }, { courseId: '' }] };
    }
    return { courseId, deletedAt: { $exists: false } };
  }

  private adminCourseId(batch: BatchMongoDocument): string {
    return batch.courseId?.trim() || 'unassigned';
  }

  private async assertNoLiveOrCompletedSessions(batchId: string): Promise<void> {
    const locked = await this.classSessions.exists({ batchId, status: { $in: ['live', 'completed'] } }).exec();
    if (locked) {
      throw new BadRequestException('Schedule, year, and teacher changes are blocked after a session is live or completed.');
    }
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!user.roles.includes('ADMIN') && !user.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Only administrators can manage courses and batches.');
    }
  }

  private async assertUniqueBatch(teacherId: string, name: string, year: number, excludeId?: string): Promise<void> {
    const filter: Record<string, unknown> = {
      teacherId,
      name: name.trim(),
      year,
      deletedAt: { $exists: false }
    };
    if (excludeId) filter._id = { $ne: excludeId };
    if (await this.batches.exists(filter)) {
      throw new ConflictException('A batch with this name already exists for the selected year.');
    }
  }

  private normalizeSchedule(schedule: BatchScheduleDto[]): BatchScheduleDto[] {
    if (!schedule.length) {
      throw new BadRequestException('At least one schedule row is required.');
    }
    const seen = new Set<BatchWeekday>();
    return schedule.map((item) => {
      if (!item.startTime) {
        throw new BadRequestException('Every selected weekday must include a start time.');
      }
      if (seen.has(item.dayOfWeek)) {
        throw new BadRequestException('Duplicate weekdays are not allowed in the same batch.');
      }
      seen.add(item.dayOfWeek);
      return { dayOfWeek: item.dayOfWeek, startTime: item.startTime };
    });
  }

  private async scheduleMap(batchIds: string[]): Promise<Map<string, BatchScheduleMongoDocument[]>> {
    if (!batchIds.length) return new Map();
    const schedules = await this.schedules.find({ batchId: { $in: batchIds } }).sort({ dayOfWeek: 1 });
    return schedules.reduce((map, schedule) => {
      const list = map.get(schedule.batchId) ?? [];
      list.push(schedule);
      map.set(schedule.batchId, list);
      return map;
    }, new Map<string, BatchScheduleMongoDocument[]>());
  }

  private async classSessionMap(batchIds: string[]): Promise<Map<string, ClassSessionMongoDocument[]>> {
    if (!batchIds.length) return new Map();
    const classSessions = await this.classSessions.find({ batchId: { $in: batchIds } }).sort({ scheduledAt: 1 });
    return classSessions.reduce((map, session) => {
      const list = map.get(session.batchId) ?? [];
      list.push(session);
      map.set(session.batchId, list);
      return map;
    }, new Map<string, ClassSessionMongoDocument[]>());
  }

  private async serialize(batch: BatchMongoDocument, schedules: BatchScheduleMongoDocument[], classSessions: ClassSessionMongoDocument[] = []): Promise<Record<string, unknown>> {
    const roster = await this.studentEnrollments.listBatchRoster(batch.id);
    return {
      id: batch.id,
      name: batch.name,
      courseId: batch.courseId,
      courseName: batch.courseName,
      teacherId: batch.teacherId,
      year: batch.year,
      startDate: this.dateOnly(batch.startDate),
      endDate: this.dateOnly(batch.endDate),
      maxCapacity: batch.maxCapacity,
      enrolledCount: roster.length,
      status: batch.status,
      schedule: schedules.map((schedule) => ({
        id: schedule.id,
        dayOfWeek: schedule.dayOfWeek,
        startTime: schedule.startTime
      })),
      students: roster.map((student) => ({
        id: student.userId,
        displayName: student.displayName,
        email: student.email,
        attendanceRate: 0,
        joinedAt: student.joinedAt,
        status: student.status === 'active' ? 'active' : student.status === 'pending' ? 'invited' : student.status
      })),
      sessions: this.serializeClassSessions(batch, schedules, classSessions),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt
    };
  }

  private serializeClassSessions(
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    classSessions: ClassSessionMongoDocument[]
  ): Record<string, unknown>[] {
    const persistedById = new Map(classSessions.map((session) => [session.id, session]));
    const planned = planClassSessions(batch, schedules).map((session) => this.serializeClassSession(session, persistedById.get(session.id)));
    const plannedIds = new Set(planned.map((session) => String(session.id)));
    const orphaned = classSessions
      .filter((session) => !plannedIds.has(session.id))
      .map((session) =>
        this.serializeClassSession(
          {
            id: session.id,
            batchId: session.batchId,
            title: session.title,
            sessionNumber: session.sessionNumber,
            scheduledAt: session.scheduledAt,
            durationMinutes: session.durationMinutes
          },
          session
        )
      );
    return [...planned, ...orphaned].sort((left, right) => {
      const leftDate = typeof left.scheduledAt === 'string' ? left.scheduledAt : '';
      const rightDate = typeof right.scheduledAt === 'string' ? right.scheduledAt : '';
      return new Date(leftDate).getTime() - new Date(rightDate).getTime();
    });
  }

  private serializeClassSession(planned: PlannedClassSession, persisted?: ClassSessionMongoDocument): Record<string, unknown> {
    const channelIds = classSessionChannelIds(planned.id);
    const status: ClassSessionStatus = persisted?.status ?? 'scheduled';
    return {
      id: planned.id,
      batchId: planned.batchId,
      title: planned.title,
      sessionNumber: planned.sessionNumber,
      scheduledAt: planned.scheduledAt.toISOString(),
      durationMinutes: planned.durationMinutes,
      status,
      roomId: persisted?.roomId ?? channelIds.roomId,
      chatChannelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
      whiteboardChannelId: persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId,
      startedAt: persisted?.startedAt?.toISOString(),
      completedAt: persisted?.completedAt?.toISOString()
    };
  }

  private async withTransaction<T>(work: (session?: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => work(session));
    } catch (error) {
      if (this.isStandaloneTransactionError(error)) {
        return work();
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private isStandaloneTransactionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return message.includes('Transaction numbers are only allowed') || message.includes('replica set member or mongos');
  }

  private yearDates(year: number): { startDate: Date; endDate: Date } {
    return {
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31))
    };
  }

  private dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private optionalTrim(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private async currentEnrolledCount(batchId: string): Promise<number> {
    return this.studentEnrollments.countActiveByBatch(batchId);
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
}
