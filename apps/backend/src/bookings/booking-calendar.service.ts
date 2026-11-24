import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  StudentEnrollmentDocument,
} from '../database/schemas';
import {
  classSessionChannelIds,
  planClassSessions,
} from '../class-sessions/class-session-planner';
import {
  BookingCalendarLockDocument,
  LessonSlotDocument,
} from './booking.schema';

@Injectable()
export class BookingCalendarService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    @InjectModel(BookingCalendarLockDocument.name)
    private readonly locks: Model<BookingCalendarLockDocument>,
    @InjectModel(LessonSlotDocument.name)
    private readonly slots: Model<LessonSlotDocument>,
    @InjectModel(BatchDocument.name)
    private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name)
    private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name)
    private readonly classes: Model<ClassSessionMongoDocument>,
    @InjectModel(StudentEnrollmentDocument.name)
    private readonly enrollments: Model<StudentEnrollmentDocument>,
  ) {}
  get enabled(): boolean {
    return (
      this.config.get<boolean>('BOOKINGS_ENABLED', false) ||
      Boolean(this.config.get<string>('STRIPE_SECRET_KEY'))
    );
  }
  async lockTeacher(teacherId: string, session?: ClientSession): Promise<void> {
    if (!this.enabled) return;
    await this.locks
      .findOneAndUpdate(
        { _id: 'teacher:' + teacherId },
        { $inc: { revision: 1 } },
        { upsert: true, session },
      )
      .exec();
  }
  async lockStudent(studentId: string, session: ClientSession): Promise<void> {
    await this.locks
      .findOneAndUpdate(
        { _id: 'student:' + studentId },
        { $inc: { revision: 1 } },
        { upsert: true, session },
      )
      .exec();
  }
  async transaction<T>(
    handler: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(
        async () => {
          result = await handler(session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return result as T;
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new ConflictException(
          'Availability changed while the reservation was being updated. Try again.',
        );
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async withTeacherLock<T>(
    teacherId: string,
    handler: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (session) => {
      await this.lockTeacher(teacherId, session);
      return handler(session);
    });
  }
  async assertFree(
    teacherId: string,
    start: Date,
    end: Date,
    session?: ClientSession,
    ignoreSlotId?: string,
    ignoreSessionId?: string,
  ): Promise<void> {
    const clash = await this.slots
      .exists({
        teacherId,
        status: { $in: ['open', 'held', 'booked'] },
        startsAt: { $lt: end },
        endsAt: { $gt: start },
        ...(ignoreSlotId ? { _id: { $ne: ignoreSlotId } } : {}),
      })
      .session(session ?? null);
    if (clash)
      throw new ConflictException(
        'This time is already published or reserved.',
      );
    const batches = await this.batches
      .find({
        teacherId,
        status: 'ACTIVE',
        deletedAt: { $exists: false },
        startDate: { $lt: end },
        endDate: { $gte: start },
      })
      .session(session ?? null);
    await this.assertBatchesFree(batches, start, end, session, ignoreSessionId);
  }
  async assertStudentFree(
    studentId: string,
    start: Date,
    end: Date,
    session: ClientSession,
  ): Promise<void> {
    const enrollments = await this.enrollments
      .find({ studentId, status: 'active', deletedAt: { $exists: false } })
      .session(session);
    const batches = await this.batches
      .find({
        _id: { $in: enrollments.map((e) => e.batchId) },
        status: 'ACTIVE',
        deletedAt: { $exists: false },
      })
      .session(session);
    await this.assertBatchesFree(batches, start, end, session);
  }
  private async assertBatchesFree(
    batches: BatchMongoDocument[],
    start: Date,
    end: Date,
    session?: ClientSession,
    ignoreSessionId?: string,
  ): Promise<void> {
    if (!batches.length) return;
    const ids = batches.map((b) => b.id);
    const schedules = await this.schedules
      .find({ batchId: { $in: ids } })
      .session(session ?? null);
    const persisted = await this.classes
      .find({ batchId: { $in: ids } })
      .session(session ?? null);
    for (const batch of batches) {
      const lessons = new Map(
        planClassSessions(
          batch,
          schedules.filter((s) => s.batchId === batch.id),
        ).map((item) => [item.id, { ...item, status: 'scheduled' }]),
      );
      for (const item of persisted.filter((item) => item.batchId === batch.id))
        lessons.set(item.id, { ...item.toObject(), id: item.id });
      if (
        [...lessons.values()].some(
          (item) =>
            item.id !== ignoreSessionId &&
            ['scheduled', 'live'].includes(item.status) &&
            item.scheduledAt < end &&
            item.scheduledAt.getTime() + item.durationMinutes * 60000 >
              start.getTime(),
        )
      )
        throw new ConflictException('This time overlaps an existing class.');
    }
  }
  async assertBatchCompatible(
    teacherId: string,
    batch: {
      id?: string;
      name: string;
      startDate: Date;
      endDate: Date;
      scheduleTimezone?: string;
    },
    schedules: BatchScheduleMongoDocument[],
    session?: ClientSession,
  ): Promise<void> {
    await this.lockTeacher(teacherId, session);
    const upcoming = planClassSessions(
      { ...batch, id: batch.id ?? 'new-batch' },
      schedules,
    ).filter((item) => item.scheduledAt > new Date());
    for (const item of upcoming) {
      const overlap = await this.slots
        .exists({
          teacherId,
          status: { $in: ['open', 'held', 'booked'] },
          startsAt: {
            $lt: new Date(
              item.scheduledAt.getTime() + item.durationMinutes * 60000,
            ),
          },
          endsAt: { $gt: item.scheduledAt },
        })
        .session(session ?? null);
      if (overlap)
        throw new ConflictException(
          'This schedule overlaps published lesson availability. Manage those bookings first.',
        );
    }
  }
  channelIds(sessionId: string) {
    return classSessionChannelIds(sessionId);
  }
}
