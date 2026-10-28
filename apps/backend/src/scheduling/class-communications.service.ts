import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { validTimeZone } from '@native-sfu/contracts';
import { CalendarService } from './calendar.service';
import {
  CalendarNotice,
  CalendarNoticeDocument,
} from './calendar-notice.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { ScheduleEvent } from './schedule-event';
@Injectable()
export class ClassCommunicationsService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(ClassCommunicationsService.name);
  constructor(
    @InjectModel(CalendarNoticeDocument.name)
    private readonly notices: Model<CalendarNotice>,
    private readonly calendar: CalendarService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () => void this.tick(),
      Math.max(
        500,
        Number(this.config.get('CLASS_NOTIFICATION_POLL_MS')) || 30000,
      ),
    );
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async list(userId: string) {
    const rows = await this.notices
      .find({
        userId,
        availableAt: { $lte: new Date() },
        emailStatus: { $ne: 'void' },
      })
      .sort({ availableAt: -1 })
      .limit(50);
    return rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      batchId: n.batchId,
      sessionId: n.sessionId,
      kind: n.kind,
      createdAt: n.availableAt.toISOString(),
      readAt: n.readAt?.toISOString(),
    }));
  }
  async markRead(userId: string, id: string) {
    const n = await this.notices.findOneAndUpdate(
      { _id: id, userId },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!n) throw new NotFoundException('Notification not found.');
    return { readAt: n.readAt };
  }
  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.dispatchEvents();
      await this.prepareReminders();
      await this.deliver();
    } catch (error) {
      this.logger.error(
        `Class notifications: ${error instanceof Error ? error.message : 'worker failed'}`,
      );
    } finally {
      this.busy = false;
    }
  }
  private async queue(
    eventId: string,
    userId: string,
    payload: Partial<CalendarNoticeDocument>,
  ) {
    const id = createHash('sha256')
      .update(`${eventId}:${userId}`)
      .digest('hex');
    try {
      await this.notices.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            ...payload,
            _id: id,
            userId,
            emailStatus: 'queued',
            attempts: 0,
            nextAttemptAt: payload.availableAt ?? new Date(),
          },
        },
        { upsert: true },
      );
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  private async dispatchEvents() {
    const [enrollments, sessions] = await Promise.all([
      this.calendar.enrollments
        .find({
          scheduleEvents: { $elemMatch: { dispatchedAt: { $exists: false } } },
        })
        .limit(100),
      this.calendar.sessions
        .find({
          scheduleEvents: { $elemMatch: { dispatchedAt: { $exists: false } } },
        })
        .limit(100),
    ]);
    for (const enrollment of enrollments) {
      for (const event of enrollment.scheduleEvents.filter(
        (e) => !e.dispatchedAt,
      )) {
        const batch = await this.calendar.batches.findById(enrollment.batchId);
        if (batch) {
          const labels: Record<string, string> = {
            active: 'Enrollment confirmed',
            pending: 'Enrollment pending',
            cancelled: 'Enrollment cancelled',
            suspended: 'Enrollment paused',
            completed: 'Batch completed',
          };
          await this.queue(event.id, enrollment.studentId, {
            batchId: batch.id,
            kind: 'enrollment',
            title: labels[event.reason ?? 'active'] ?? 'Enrollment updated',
            body: `${batch.name}: ${labels[event.reason ?? 'active'] ?? 'Enrollment updated'}. Open your calendar for the latest timetable.`,
            availableAt: event.occurredAt,
            enrollmentId: enrollment.id,
            enrollmentStatus: event.reason,
          });
        }
        await this.calendar.enrollments.updateOne(
          { _id: enrollment.id, 'scheduleEvents.id': event.id },
          { $set: { 'scheduleEvents.$.dispatchedAt': new Date() } },
          { timestamps: false },
        );
      }
    }
    for (const session of sessions) {
      for (const event of session.scheduleEvents.filter(
        (e) => !e.dispatchedAt,
      )) {
        const batch = await this.calendar.batches.findById(session.batchId);
        if (batch) {
          const students = await this.calendar.enrollments.find({
            batchId: batch.id,
            status: 'active',
            deletedAt: { $exists: false },
          });
          for (const recipient of new Set([
            batch.teacherId,
            ...students.map((e) => e.studentId),
          ])) {
            const person = await this.calendar.users
              .findById(recipient)
              .select('timezone');
            const zone =
              person?.timezone && validTimeZone(person.timezone)
                ? person.timezone
                : (batch.scheduleTimezone ??
                  process.env.LEGACY_SCHEDULE_TIMEZONE ??
                  'UTC');
            const at = (time?: Date) =>
              time
                ? new Intl.DateTimeFormat('en-GB', {
                    timeZone: zone,
                    dateStyle: 'full',
                    timeStyle: 'short',
                  }).format(time)
                : '';
            const title =
              event.kind === 'cancelled'
                ? 'Class cancelled'
                : 'Class rescheduled';
            const body =
              event.kind === 'cancelled'
                ? `${session.title} on ${at(event.scheduledAt)} (${zone}) has been cancelled.`
                : `${session.title} moved from ${at(event.oldScheduledAt)} to ${at(event.scheduledAt)} (${zone}).`;
            await this.queue(event.id, recipient, {
              batchId: batch.id,
              sessionId: session.id,
              kind: event.kind,
              title,
              body: body + (event.reason ? ` ${event.reason}` : ''),
              availableAt: event.occurredAt,
              scheduledAt: event.scheduledAt,
            });
          }
        }
        await this.calendar.sessions.updateOne(
          { _id: session.id, 'scheduleEvents.id': event.id },
          { $set: { 'scheduleEvents.$.dispatchedAt': new Date() } },
          { timestamps: false },
        );
      }
    }
  }
  private async prepareReminders() {
    const now = Date.now();
    const windowEnd = new Date(now + 25 * 3600000);
    const overrides = await this.calendar.sessions
      .find({
        status: 'scheduled',
        scheduledAt: { $gt: new Date(now), $lte: windowEnd },
      })
      .select('batchId');
    const batches = await this.calendar.batches.find({
      status: 'ACTIVE',
      deletedAt: { $exists: false },
      $or: [
        {
          endDate: { $gte: new Date(now - 86400000) },
          startDate: { $lte: windowEnd },
        },
        { _id: { $in: overrides.map((c) => c.batchId) } },
      ],
    });
    for (const batch of batches) {
      const classes = (await this.calendar.classesForBatches([batch])).filter(
        (c) =>
          c.status === 'scheduled' &&
          Date.parse(c.scheduledAt) > now &&
          Date.parse(c.scheduledAt) <= now + 25 * 3600000,
      );
      if (!classes.length) continue;
      const students = await this.calendar.enrollments.find({
        batchId: batch.id,
        status: 'active',
        deletedAt: { $exists: false },
      });
      const recipients = [
        { userId: batch.teacherId, enrolledAt: batch.createdAt },
        ...students.map((s) => ({
          userId: s.studentId,
          enrolledAt: s.enrolledAt ?? s.createdAt,
        })),
      ];
      for (const item of classes)
        for (const hours of [24, 1]) {
          const due = Date.parse(item.scheduledAt) - hours * 3600000;
          if (due < now - 15 * 60000) continue;
          for (const recipient of recipients) {
            if (recipient.enrolledAt && recipient.enrolledAt.getTime() > due)
              continue;
            const person = await this.calendar.users
              .findById(recipient.userId)
              .select('timezone settings');
            if (person?.settings?.notifications?.classReminders === false)
              continue;
            const zone =
              person?.timezone && validTimeZone(person.timezone)
                ? person.timezone
                : item.scheduleTimezone;
            const when = new Intl.DateTimeFormat('en-GB', {
              timeZone: zone,
              dateStyle: 'full',
              timeStyle: 'short',
            }).format(new Date(item.scheduledAt));
            await this.queue(
              `reminder:${item.id}:${item.scheduledAt}:${hours}`,
              recipient.userId,
              {
                batchId: batch.id,
                sessionId: item.id,
                kind: 'reminder',
                title: hours === 24 ? 'Class tomorrow' : 'Class in one hour',
                body: `${item.title} starts ${when} (${zone}). Your teacher opens the classroom when the class begins.`,
                availableAt: new Date(due),
                scheduledAt: new Date(item.scheduledAt),
              },
            );
          }
        }
    }
  }
  private async isCurrent(notice: CalendarNotice): Promise<boolean> {
    const batch = await this.calendar.batches.findById(notice.batchId);
    if (!batch) return false;
    const person = await this.calendar.users.findOne({
      _id: notice.userId,
      disabled: { $ne: true },
      deletedAt: { $exists: false },
    });
    if (!person) return false;
    if (notice.kind === 'enrollment') {
      const enrollment = await this.calendar.enrollments.findById(
        notice.enrollmentId,
      );
      return Boolean(
        enrollment && enrollment.status === notice.enrollmentStatus,
      );
    }
    if (
      notice.userId !== batch.teacherId &&
      !(await this.calendar.enrollments.exists({
        batchId: batch.id,
        studentId: notice.userId,
        status: 'active',
        deletedAt: { $exists: false },
      }))
    )
      return false;
    if (notice.kind !== 'reminder') {
      const session = await this.calendar.sessions.findById(notice.sessionId);
      return Boolean(
        session &&
          (notice.kind === 'cancelled'
            ? session.status === 'cancelled'
            : session.status !== 'cancelled' &&
              session.scheduledAt.toISOString() ===
                notice.scheduledAt?.toISOString()),
      );
    }
    if (
      batch.deletedAt ||
      batch.status !== 'ACTIVE' ||
      person.settings?.notifications?.classReminders === false
    )
      return false;
    if (
      !notice.scheduledAt ||
      notice.scheduledAt.getTime() <= Date.now() ||
      Date.now() - notice.availableAt.getTime() > 15 * 60000
    )
      return false;
    const item = (await this.calendar.classesForBatches([batch])).find(
      (c) => c.id === notice.sessionId,
    );
    return Boolean(
      item &&
        item.status === 'scheduled' &&
        item.scheduledAt === notice.scheduledAt.toISOString(),
    );
  }
  private async deliver() {
    for (let i = 0; i < 100; i++) {
      const token = randomUUID(),
        now = new Date();
      const notice = await this.notices.findOneAndUpdate(
        {
          emailStatus: 'queued',
          availableAt: { $lte: now },
          nextAttemptAt: { $lte: now },
          $or: [
            { leaseUntil: { $exists: false } },
            { leaseUntil: { $lt: now } },
          ],
        },
        {
          $set: {
            leaseToken: token,
            leaseUntil: new Date(Date.now() + 120000),
          },
        },
        { new: true, sort: { nextAttemptAt: 1 } },
      );
      if (!notice) break;
      try {
        if (!(await this.isCurrent(notice))) {
          await this.notices.updateOne(
            { _id: notice.id, leaseToken: token },
            {
              $set: { emailStatus: 'void' },
              $unset: { leaseToken: '', leaseUntil: '' },
            },
          );
          continue;
        }
        const configured =
          this.config.get<string>('FRONTEND_URL') ??
          this.config.get<string>('PUBLIC_FRONTEND_URL');
        let link = '';
        if (configured) {
          try {
            const url = new URL(configured);
            if (['http:', 'https:'].includes(url.protocol)) {
              url.pathname = '/calendar';
              url.search = '';
              url.hash = '';
              if (notice.sessionId && notice.kind !== 'cancelled') {
                const batch = await this.calendar.batches.findById(
                  notice.batchId,
                );
                url.pathname =
                  notice.userId === batch?.teacherId
                    ? '/class-session/teacher'
                    : '/class-session/student';
                url.search = new URLSearchParams({
                  sessionId: notice.sessionId,
                  batchId: notice.batchId,
                }).toString();
              }
              link = `\n${notice.sessionId && notice.kind !== 'cancelled' ? 'Open classroom' : 'View your timetable'}: ${url.toString()}`;
            }
          } catch {
            /* A missing public URL never blocks notices. */
          }
        }
        const result = await this.notifications.sendEmailToUser(
          notice.userId,
          notice.kind === 'reminder' ? 'class_reminder' : 'enrollment_update',
          { subject: `${notice.title} · Sapiovian`, text: notice.body + link },
        );
        const failed = result.results.some((r) => r.failed > 0);
        const attempts = notice.attempts + 1;
        await this.notices.updateOne(
          { _id: notice.id, leaseToken: token },
          {
            $set: {
              attempts,
              emailStatus: failed
                ? attempts >= 6
                  ? 'failed'
                  : 'queued'
                : result.results.some((r) => r.delivered > 0)
                  ? 'sent'
                  : 'skipped',
              nextAttemptAt: new Date(
                Date.now() + Math.min(30 * 60000, 30000 * 2 ** (attempts - 1)),
              ),
              lastError: failed
                ? result.results
                    .flatMap((r) => r.errors)
                    .join('; ')
                    .slice(0, 300)
                : '',
            },
            $unset: { leaseToken: '', leaseUntil: '' },
          },
        );
      } catch (error) {
        const attempts = notice.attempts + 1;
        await this.notices.updateOne(
          { _id: notice.id, leaseToken: token },
          {
            $set: {
              attempts,
              emailStatus: attempts >= 6 ? 'failed' : 'queued',
              nextAttemptAt: new Date(Date.now() + 30000 * 2 ** (attempts - 1)),
              lastError: 'Delivery failed',
            },
            $unset: { leaseToken: '', leaseUntil: '' },
          },
        );
      }
    }
  }
}
