import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  STUDENT_ENROLLMENT_STATUSES,
  StudentEnrollmentDocument,
  StudentEnrollmentMongoDocument,
  StudentEnrollmentStatus,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';

export interface StudentEnrollmentRosterItem {
  id: string;
  enrollmentId: string;
  userId: string;
  displayName: string;
  email: string;
  status: StudentEnrollmentStatus;
  joinedAt: string;
}

export interface StudentEnrolledBatch {
  id: string;
  title: string;
  subject: string;
  teacherId: string;
  teacherName: string;
  teacherTitle: string;
  schedule: string;
  durationMinutes: number;
  totalWeeks: number;
  enrolledCount: number;
  capacity: number;
  startsAt: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  enrollmentStatus?: StudentEnrollmentStatus;
}

export interface EnrollStudentInput {
  studentId: string;
  batchId: string;
  status?: StudentEnrollmentStatus;
  actorUserId?: string;
}

const ACTIVE_ACCESS_FILTER = {
  status: 'active',
  deletedAt: { $exists: false }
} as const;

@Injectable()
export class StudentEnrollmentsService {
  constructor(
    @InjectModel(StudentEnrollmentDocument.name) private readonly enrollments: Model<StudentEnrollmentMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>
  ) {}

  async enrollStudent(input: EnrollStudentInput): Promise<Record<string, unknown>> {
    const status = input.status ?? 'active';
    this.assertKnownStatus(status);
    const [batch, student] = await Promise.all([this.findBatch(input.batchId), this.findUser(input.studentId)]);
    if (!student.roles.includes('STUDENT')) {
      throw new BadRequestException('Only student users can be enrolled in a batch.');
    }
    if (status === 'active') {
      await this.assertNoActiveEnrollment(input.studentId, input.batchId);
    }
    return this.createEnrollment(input, batch, student, status);
  }

  async selfEnrollStudent(user: AuthenticatedUser, batchId: string): Promise<StudentEnrolledBatch> {
    this.assertStudentSelfService(user);
    const [batch, student] = await Promise.all([this.findBatch(batchId), this.findUser(user.sub)]);
    if (!student.roles.includes('STUDENT')) {
      throw new BadRequestException('Only student users can be enrolled in a batch.');
    }
    this.assertBatchOpenForEnrollment(batch);
    await this.assertNoActiveEnrollment(user.sub, batch.id);
    await this.assertBatchHasCapacity(batch);
    await this.createEnrollment({ studentId: user.sub, batchId: batch.id, status: 'active', actorUserId: user.sub }, batch, student, 'active');
    return this.findStudentBatch(user.sub, batch.id);
  }

  async selfCancelStudentEnrollment(user: AuthenticatedUser, batchId: string): Promise<Record<string, unknown>> {
    this.assertStudentSelfService(user);
    const existing = await this.enrollments.findOne({ studentId: user.sub, batchId, ...ACTIVE_ACCESS_FILTER }).exec();
    if (!existing) {
      throw new NotFoundException('Active student enrollment not found.');
    }
    return this.transitionEnrollment(existing.id, 'cancelled', user.sub);
  }

  private async createEnrollment(
    input: EnrollStudentInput,
    batch: BatchMongoDocument,
    student: UserMongoDocument,
    status: StudentEnrollmentStatus
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    try {
      const enrollment = await this.enrollments.create({
        studentId: student.id,
        studentName: student.displayName ?? student.name,
        studentEmail: student.email,
        courseId: batch.courseId,
        batchId: batch.id,
        batchName: batch.name,
        teacherId: batch.teacherId,
        status,
        enrolledAt: status === 'active' || status === 'pending' ? now : undefined,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
        ...this.statusTimestamp(status, now)
      });
      return this.serialize(enrollment);
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        throw new ConflictException('Student is already actively enrolled in this batch.');
      }
      throw error;
    }
  }

  async bulkEnrollStudents(input: { batchId: string; studentIds: string[]; status?: StudentEnrollmentStatus; actorUserId?: string }): Promise<Record<string, unknown>[]> {
    const uniqueStudentIds = [...new Set(input.studentIds.map((id) => id.trim()).filter(Boolean))];
    if (!uniqueStudentIds.length) {
      throw new BadRequestException('At least one student id is required.');
    }
    const created: Record<string, unknown>[] = [];
    for (const studentId of uniqueStudentIds) {
      created.push(
        await this.enrollStudent({
          batchId: input.batchId,
          studentId,
          status: input.status,
          actorUserId: input.actorUserId
        })
      );
    }
    return created;
  }

  cancelEnrollment(enrollmentId: string, actorUserId?: string): Promise<Record<string, unknown>> {
    return this.transitionEnrollment(enrollmentId, 'cancelled', actorUserId);
  }

  suspendEnrollment(enrollmentId: string, actorUserId?: string): Promise<Record<string, unknown>> {
    return this.transitionEnrollment(enrollmentId, 'suspended', actorUserId);
  }

  reactivateEnrollment(enrollmentId: string, actorUserId?: string): Promise<Record<string, unknown>> {
    return this.transitionEnrollment(enrollmentId, 'active', actorUserId);
  }

  completeEnrollment(enrollmentId: string, actorUserId?: string): Promise<Record<string, unknown>> {
    return this.transitionEnrollment(enrollmentId, 'completed', actorUserId);
  }

  updateEnrollmentStatus(enrollmentId: string, status: StudentEnrollmentStatus, actorUserId?: string): Promise<Record<string, unknown>> {
    return this.transitionEnrollment(enrollmentId, status, actorUserId);
  }

  async listBatchRoster(batchId: string, options: { includeInactive?: boolean } = {}): Promise<StudentEnrollmentRosterItem[]> {
    const filter: Record<string, unknown> = {
      batchId,
      deletedAt: { $exists: false }
    };
    if (!options.includeInactive) {
      filter.status = 'active';
    }
    const docs = await this.enrollments.find(filter).sort({ studentName: 1, studentEmail: 1, enrolledAt: 1 }).exec();
    return docs.map((doc) => this.toRosterItem(doc));
  }

  async listEnrollmentsByBatch(batchId: string, options: { includeInactive?: boolean } = {}): Promise<Record<string, unknown>[]> {
    const filter: Record<string, unknown> = {
      batchId,
      deletedAt: { $exists: false }
    };
    if (!options.includeInactive) {
      filter.status = 'active';
    }
    const docs = await this.enrollments.find(filter).sort({ updatedAt: -1 }).exec();
    return docs.map((doc) => this.serialize(doc));
  }

  async listStudentBatches(studentId: string, options: { status?: StudentEnrollmentStatus } = {}): Promise<StudentEnrolledBatch[]> {
    const filter: Record<string, unknown> = {
      studentId,
      deletedAt: { $exists: false },
      status: options.status ?? 'active'
    };
    const enrollments = await this.enrollments.find(filter).sort({ enrolledAt: -1 }).exec();
    if (!enrollments.length) {
      return [];
    }
    const batchIds = enrollments.map((enrollment) => enrollment.batchId);
    const [batches, scheduleMap, countMap, teachers] = await Promise.all([
      this.batches.find({ _id: { $in: batchIds }, deletedAt: { $exists: false } }).exec(),
      this.scheduleMap(batchIds),
      this.activeCountByBatchIds(batchIds),
      this.teacherMap(enrollments.map((enrollment) => enrollment.teacherId).filter((id): id is string => Boolean(id)))
    ]);
    const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
    return enrollments
      .map((enrollment) => {
        const batch = batchMap.get(enrollment.batchId);
        if (!batch) {
          return null;
        }
        const schedules = scheduleMap.get(batch.id) ?? [];
        const teacher = teachers.get(batch.teacherId);
        return this.toStudentBatch(enrollment, batch, schedules, countMap.get(batch.id) ?? 0, teacher);
      })
      .filter((batch): batch is StudentEnrolledBatch => Boolean(batch));
  }

  async listAvailableBatches(studentId?: string): Promise<StudentEnrolledBatch[]> {
    const batches = await this.batches.find({ status: 'ACTIVE', deletedAt: { $exists: false } }).sort({ startDate: 1, name: 1 }).exec();
    if (!batches.length) {
      return [];
    }
    const batchIds = batches.map((batch) => batch.id);
    const [scheduleMap, countMap, teachers, enrollments] = await Promise.all([
      this.scheduleMap(batchIds),
      this.activeCountByBatchIds(batchIds),
      this.teacherMap(batches.map((batch) => batch.teacherId).filter(Boolean)),
      studentId
        ? this.enrollments.find({ studentId, batchId: { $in: batchIds }, deletedAt: { $exists: false }, status: 'active' }).exec()
        : Promise.resolve([])
    ]);
    const enrollmentMap = new Map(enrollments.map((enrollment) => [enrollment.batchId, enrollment]));
    return batches.map((batch) =>
      this.toStudentBatch(enrollmentMap.get(batch.id) ?? null, batch, scheduleMap.get(batch.id) ?? [], countMap.get(batch.id) ?? 0, teachers.get(batch.teacherId))
    );
  }

  async isStudentEnrolledInBatch(studentId: string, batchId: string): Promise<boolean> {
    return Boolean(await this.enrollments.exists({ studentId, batchId, ...ACTIVE_ACCESS_FILTER }));
  }

  async assertStudentEnrolledInBatch(studentId: string, batchId: string): Promise<void> {
    if (!(await this.isStudentEnrolledInBatch(studentId, batchId))) {
      throw new ForbiddenException('Student is not enrolled in this batch.');
    }
  }

  async countActiveByBatch(batchId: string): Promise<number> {
    return this.enrollments.countDocuments({ batchId, ...ACTIVE_ACCESS_FILTER }).exec();
  }

  async activeCountByBatchIds(batchIds: readonly string[]): Promise<Map<string, number>> {
    if (!batchIds.length) {
      return new Map();
    }
    const docs = await this.enrollments.find({ batchId: { $in: [...new Set(batchIds)] }, ...ACTIVE_ACCESS_FILTER }).select({ batchId: 1 }).exec();
    return docs.reduce((map, doc) => {
      map.set(doc.batchId, (map.get(doc.batchId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
  }

  async assertCanViewRoster(batchId: string, user: AuthenticatedUser): Promise<void> {
    const batch = await this.findBatch(batchId);
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) {
      return;
    }
    throw new ForbiddenException('You are not allowed to view this batch roster.');
  }

  private async transitionEnrollment(enrollmentId: string, status: StudentEnrollmentStatus, actorUserId?: string): Promise<Record<string, unknown>> {
    this.assertKnownStatus(status);
    const existing = await this.enrollments.findOne({ _id: enrollmentId, deletedAt: { $exists: false } }).exec();
    if (!existing) {
      throw new NotFoundException('Student enrollment not found.');
    }
    if (status === 'active') {
      await this.assertNoActiveEnrollment(existing.studentId, existing.batchId, existing.id);
    }
    const now = new Date();
    const updated = await this.enrollments.findOneAndUpdate(
      { _id: enrollmentId, deletedAt: { $exists: false } },
      {
        $set: {
          status,
          updatedBy: actorUserId,
          ...(status === 'active' ? { enrolledAt: existing.enrolledAt ?? now } : {}),
          ...this.statusTimestamp(status, now)
        },
        ...(status === 'active'
          ? {
              $unset: {
                cancelledAt: '',
                suspendedAt: '',
                completedAt: ''
              }
            }
          : {})
      },
      { new: true }
    ).exec();
    if (!updated) {
      throw new NotFoundException('Student enrollment not found.');
    }
    return this.serialize(updated);
  }

  private async assertNoActiveEnrollment(studentId: string, batchId: string, excludeId?: string): Promise<void> {
    const filter: Record<string, unknown> = {
      studentId,
      batchId,
      ...ACTIVE_ACCESS_FILTER
    };
    if (excludeId) {
      filter._id = { $ne: excludeId };
    }
    if (await this.enrollments.exists(filter)) {
      throw new ConflictException('Student is already actively enrolled in this batch.');
    }
  }

  private async assertBatchHasCapacity(batch: BatchMongoDocument): Promise<void> {
    const enrolledCount = await this.countActiveByBatch(batch.id);
    if (enrolledCount >= batch.maxCapacity) {
      throw new ConflictException('This batch is full.');
    }
  }

  private assertBatchOpenForEnrollment(batch: BatchMongoDocument): void {
    if (batch.status !== 'ACTIVE') {
      throw new BadRequestException('This batch is not open for enrollment.');
    }
  }

  private assertStudentSelfService(user: AuthenticatedUser): void {
    if (!user.roles.includes('STUDENT')) {
      throw new ForbiddenException('Only student accounts can manage their own enrollments.');
    }
  }

  private async findStudentBatch(studentId: string, batchId: string): Promise<StudentEnrolledBatch> {
    const batches = await this.listStudentBatches(studentId);
    const batch = batches.find((item) => item.id === batchId);
    if (!batch) {
      throw new NotFoundException('Student batch enrollment not found.');
    }
    return batch;
  }

  private async findBatch(batchId: string): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } }).exec();
    if (!batch) {
      throw new NotFoundException('Batch not found.');
    }
    return batch;
  }

  private async findUser(userId: string): Promise<UserMongoDocument> {
    const user = await this.users.findOne({ _id: userId, deletedAt: { $exists: false } }).exec();
    if (!user) {
      throw new NotFoundException('Student not found.');
    }
    return user;
  }

  private async scheduleMap(batchIds: readonly string[]): Promise<Map<string, BatchScheduleMongoDocument[]>> {
    const schedules = await this.schedules.find({ batchId: { $in: [...new Set(batchIds)] } }).sort({ dayOfWeek: 1 }).exec();
    return schedules.reduce((map, schedule) => {
      const list = map.get(schedule.batchId) ?? [];
      list.push(schedule);
      map.set(schedule.batchId, list);
      return map;
    }, new Map<string, BatchScheduleMongoDocument[]>());
  }

  private async teacherMap(teacherIds: readonly string[]): Promise<Map<string, UserMongoDocument>> {
    if (!teacherIds.length) {
      return new Map();
    }
    const teachers = await this.users.find({ _id: { $in: [...new Set(teacherIds)] }, deletedAt: { $exists: false } }).exec();
    return new Map(teachers.map((teacher) => [teacher.id, teacher]));
  }

  private toRosterItem(doc: StudentEnrollmentMongoDocument): StudentEnrollmentRosterItem {
    return {
      id: doc.studentId,
      enrollmentId: doc.id,
      userId: doc.studentId,
      displayName: doc.studentName?.trim() || doc.studentEmail?.split('@')[0] || 'Student',
      email: doc.studentEmail ?? '',
      status: doc.status,
      joinedAt: (doc.enrolledAt ?? doc.createdAt ?? new Date()).toISOString()
    };
  }

  private toStudentBatch(
    enrollment: Pick<StudentEnrollmentMongoDocument, 'status'> | null,
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    enrolledCount: number,
    teacher?: UserMongoDocument
  ): StudentEnrolledBatch {
    const nextStart = this.nextClassStart(batch, schedules);
    return {
      id: batch.id,
      title: batch.name,
      subject: batch.courseName ?? 'General course',
      teacherId: batch.teacherId,
      teacherName: teacher?.displayName ?? teacher?.name ?? 'Teacher',
      teacherTitle: 'Class instructor',
      schedule: this.scheduleLabel(schedules),
      durationMinutes: 60,
      totalWeeks: Math.max(1, schedules.length * 12),
      enrolledCount,
      capacity: batch.maxCapacity,
      startsAt: nextStart.toISOString(),
      level: 'Intermediate',
      ...(enrollment?.status ? { enrollmentStatus: enrollment.status } : {})
    };
  }

  private serialize(doc: StudentEnrollmentMongoDocument): Record<string, unknown> {
    return {
      id: doc.id,
      studentId: doc.studentId,
      studentName: doc.studentName,
      studentEmail: doc.studentEmail,
      courseId: doc.courseId,
      batchId: doc.batchId,
      batchName: doc.batchName,
      teacherId: doc.teacherId,
      status: doc.status,
      enrolledAt: doc.enrolledAt?.toISOString(),
      completedAt: doc.completedAt?.toISOString(),
      cancelledAt: doc.cancelledAt?.toISOString(),
      suspendedAt: doc.suspendedAt?.toISOString(),
      createdBy: doc.createdBy,
      updatedBy: doc.updatedBy,
      createdAt: doc.createdAt?.toISOString(),
      updatedAt: doc.updatedAt?.toISOString()
    };
  }

  private scheduleLabel(schedules: BatchScheduleMongoDocument[]): string {
    if (!schedules.length) {
      return 'Schedule to be announced';
    }
    return schedules.map((schedule) => `${this.titleCase(schedule.dayOfWeek)} at ${schedule.startTime}`).join(', ');
  }

  private nextClassStart(batch: BatchMongoDocument, schedules: BatchScheduleMongoDocument[]): Date {
    const firstSchedule = schedules[0];
    if (!firstSchedule) {
      return batch.startDate;
    }
    const date = new Date(batch.startDate);
    const [hour = '0', minute = '0'] = firstSchedule.startTime.split(':');
    date.setUTCHours(Number(hour), Number(minute), 0, 0);
    return date;
  }

  private statusTimestamp(status: StudentEnrollmentStatus, date: Date): Partial<StudentEnrollmentDocument> {
    if (status === 'completed') {
      return { completedAt: date };
    }
    if (status === 'cancelled') {
      return { cancelledAt: date };
    }
    if (status === 'suspended') {
      return { suspendedAt: date };
    }
    return {};
  }

  private assertKnownStatus(status: StudentEnrollmentStatus): void {
    if (!STUDENT_ENROLLMENT_STATUSES.includes(status)) {
      throw new BadRequestException('Unsupported enrollment status.');
    }
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN');
  }

  private isDuplicateKey(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000;
  }

  private titleCase(value: string): string {
    return value.toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
  }
}
