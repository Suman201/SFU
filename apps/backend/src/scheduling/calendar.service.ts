import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CalendarClass, utcInstantsForLocal } from '@native-sfu/contracts';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  StudentEnrollmentDocument,
  StudentEnrollmentMongoDocument,
  UserDocument,
  UserMongoDocument,
} from '../database/schemas';
import {
  classSessionChannelIds,
  planClassSessions,
} from '../class-sessions/class-session-planner';
import { CalendarChangeDto } from './calendar.dto';
import { scheduleEvent } from './schedule-event';
@Injectable()
export class CalendarService {
  constructor(
    @InjectModel(BatchDocument.name)
    readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name)
    readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name)
    readonly sessions: Model<ClassSessionMongoDocument>,
    @InjectModel(StudentEnrollmentDocument.name)
    readonly enrollments: Model<StudentEnrollmentMongoDocument>,
    @InjectModel(UserDocument.name) readonly users: Model<UserMongoDocument>,
  ) {}
  async list(
    user: AuthenticatedUser,
    from: string,
    to: string,
  ): Promise<CalendarClass[]> {
    const start = Date.parse(from),
      end = Date.parse(to);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start > 63 * 86400000
    )
      throw new BadRequestException('Choose a date range of up to 63 days.');
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (user.roles.includes('TEACHER')) filter.teacherId = user.sub;
    else {
      const enrolled = await this.enrollments
        .find({
          studentId: user.sub,
          status: 'active',
          deletedAt: { $exists: false },
        })
        .select('batchId');
      filter._id = { $in: enrolled.map((e) => e.batchId) };
    }
    const batches = await this.batches.find(filter);
    return (await this.classesForBatches(batches))
      .filter(
        (c) =>
          Date.parse(c.scheduledAt) >= start && Date.parse(c.scheduledAt) < end,
      )
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }
  async classesForBatches(
    batches: BatchMongoDocument[],
  ): Promise<CalendarClass[]> {
    if (!batches.length) return [];
    const ids = batches.map((b) => b.id);
    const [schedules, persisted, teachers] = await Promise.all([
      this.schedules.find({ batchId: { $in: ids } }),
      this.sessions.find({ batchId: { $in: ids } }),
      this.users
        .find({ _id: { $in: batches.map((b) => b.teacherId) } })
        .select('displayName name'),
    ]);
    return batches.flatMap((batch) => {
      const plan = new Map(
        planClassSessions(
          batch,
          schedules.filter((s) => s.batchId === batch.id),
        ).map((p) => [
          p.id,
          {
            ...p,
            scheduledAt: p.scheduledAt.toISOString(),
            status: 'scheduled' as CalendarClass['status'],
            scheduleTimezone:
              batch.scheduleTimezone ??
              process.env.LEGACY_SCHEDULE_TIMEZONE ??
              'UTC',
            batchName: batch.name,
            teacherName:
              teachers.find((t) => t.id === batch.teacherId)?.displayName ??
              'Teacher',
          } as CalendarClass,
        ]),
      );
      for (const session of persisted.filter((p) => p.batchId === batch.id))
        plan.set(session.id, {
          id: session.id,
          batchId: batch.id,
          batchName: batch.name,
          teacherName:
            teachers.find((t) => t.id === batch.teacherId)?.displayName ??
            'Teacher',
          title: session.title,
          scheduledAt: session.scheduledAt.toISOString(),
          durationMinutes: session.durationMinutes,
          status: session.status,
          scheduleTimezone:
            batch.scheduleTimezone ??
            process.env.LEGACY_SCHEDULE_TIMEZONE ??
            'UTC',
          originalScheduledAt: session.originalScheduledAt?.toISOString(),
          rescheduledAt: session.rescheduledAt?.toISOString(),
          reason: session.scheduleEvents?.at(-1)?.reason,
        });
      return [...plan.values()].map((item) =>
        batch.status !== 'ACTIVE' && item.status === 'scheduled'
          ? { ...item, status: 'cancelled' as const }
          : item,
      );
    });
  }
  async change(
    user: AuthenticatedUser,
    batchId: string,
    sessionId: string,
    request: CalendarChangeDto,
  ) {
    const batch = await this.batches.findOne({
      _id: batchId,
      teacherId: user.sub,
      deletedAt: { $exists: false },
      status: 'ACTIVE',
    });
    if (!batch || !user.roles.includes('TEACHER'))
      throw new ForbiddenException(
        'Only the batch teacher can change this class.',
      );
    const item = (await this.classesForBatches([batch])).find(
      (c) => c.id === sessionId,
    );
    if (!item) throw new NotFoundException('Class not found.');
    if (
      item.status !== 'scheduled' ||
      Date.parse(item.scheduledAt) <= Date.now()
    )
      throw new ConflictException(
        'Only upcoming scheduled classes can be changed.',
      );
    if (
      item.scheduledAt !== new Date(request.expectedScheduledAt).toISOString()
    )
      throw new ConflictException(
        'This class has changed. Refresh the calendar.',
      );
    let scheduledAt = new Date(item.scheduledAt);
    if (request.action === 'reschedule') {
      const choices = utcInstantsForLocal(
        request.localTime ?? '',
        request.timeZone ?? '',
      );
      if (!choices.length)
        throw new BadRequestException(
          'This local time does not exist. Choose another time.',
        );
      if (choices.length > 1 && !request.chosenInstant)
        throw new BadRequestException(
          'This clock time occurs twice. Choose the intended UTC offset.',
        );
      const selected = request.chosenInstant
        ? new Date(request.chosenInstant).toISOString()
        : choices[0]!;
      if (!choices.includes(selected))
        throw new BadRequestException(
          'The chosen time does not match the timezone.',
        );
      scheduledAt = new Date(selected);
      if (scheduledAt.getTime() < Date.now() + 60000)
        throw new BadRequestException('Choose a future class time.');
      const peers = await this.batches.find({
        teacherId: user.sub,
        status: 'ACTIVE',
        deletedAt: { $exists: false },
      });
      const overlap = (await this.classesForBatches(peers)).find(
        (c) =>
          c.id !== sessionId &&
          ['scheduled', 'live'].includes(c.status) &&
          Date.parse(c.scheduledAt) <
            scheduledAt.getTime() + item.durationMinutes * 60000 &&
          Date.parse(c.scheduledAt) + c.durationMinutes * 60000 >
            scheduledAt.getTime(),
      );
      if (overlap)
        throw new ConflictException(
          `This time overlaps ${overlap.batchName}. Choose another time.`,
        );
      if (scheduledAt.toISOString() === item.scheduledAt) return item;
    }
    const schedules = await this.schedules.find({ batchId });
    const planned = planClassSessions(batch, schedules).find(
      (p) => p.id === sessionId,
    );
    if (planned)
      await this.sessions.updateOne(
        { _id: sessionId },
        {
          $setOnInsert: {
            ...planned,
            _id: sessionId,
            teacherId: user.sub,
            status: 'scheduled',
            ...classSessionChannelIds(sessionId),
          },
        },
        { upsert: true },
      );
    const kind = request.action === 'cancel' ? 'cancelled' : 'rescheduled';
    const changed = await this.sessions.findOneAndUpdate(
      {
        _id: sessionId,
        batchId,
        status: 'scheduled',
        scheduledAt: new Date(item.scheduledAt),
      },
      {
        $set:
          request.action === 'cancel'
            ? {
                individualScheduleOverride: true,
                status: 'cancelled',
                cancelledAt: new Date(),
              }
            : {
                individualScheduleOverride: true,
                scheduledAt,
                originalScheduledAt: item.originalScheduledAt
                  ? new Date(item.originalScheduledAt)
                  : new Date(item.scheduledAt),
                rescheduledAt: new Date(),
              },
        $push: {
          scheduleEvents: scheduleEvent(kind, {
            oldScheduledAt: new Date(item.scheduledAt),
            scheduledAt,
            reason: request.reason?.trim(),
          }),
        },
      },
      { new: true },
    );
    if (!changed)
      throw new ConflictException(
        'This class has changed. Refresh the calendar.',
      );
    return {
      id: changed.id,
      status: changed.status,
      scheduledAt: changed.scheduledAt.toISOString(),
    };
  }
}
