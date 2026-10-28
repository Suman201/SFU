import { utcInstantsForLocal, validTimeZone } from '@native-sfu/contracts';
import { BatchScheduleMongoDocument, BatchWeekday } from '../database/schemas';

export interface ClassSessionBatchLike {
  id?: string;
  _id?: string;
  name: string;
  startDate: Date;
  endDate: Date;
  scheduleTimezone?: string;
}

export interface PlannedClassSession {
  id: string;
  batchId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: Date;
  durationMinutes: number;
}

const DAY_INDEX: Record<BatchWeekday, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6
};

const WEEK_IN_DAYS = 7;
const SESSION_DURATION_MINUTES = 60;

export function planClassSessions(batch: ClassSessionBatchLike, schedules: BatchScheduleMongoDocument[]): PlannedClassSession[] {
  const sessions: PlannedClassSession[] = [];
  const batchId = String(batch.id ?? batch._id ?? '');
  if (!batchId) {
    return sessions;
  }
  const zone = batch.scheduleTimezone ?? process.env.LEGACY_SCHEDULE_TIMEZONE ?? 'UTC';
  if (!validTimeZone(zone)) throw new Error('Invalid batch schedule timezone');
  const start = new Date(`${dateOnly(batch.startDate)}T00:00:00Z`);
  const end = new Date(`${dateOnly(batch.endDate)}T23:59:59Z`);

  for (const schedule of schedules) {
    const current = new Date(start);
    const dayOffset = (DAY_INDEX[schedule.dayOfWeek] - current.getUTCDay() + WEEK_IN_DAYS) % WEEK_IN_DAYS;
    current.setUTCDate(current.getUTCDate() + dayOffset);

    while (current <= end) {
      const sessionDate = current.toISOString().slice(0,10);
      const wallTime = `${sessionDate}T${schedule.startTime}`;
      let choices = utcInstantsForLocal(wallTime, zone);
      // A recurring time in the spring gap moves to the first valid clock minute.
      for (let minutes = 1; !choices.length && minutes <= 180; minutes++) {
        const next = new Date(Date.parse(wallTime + ':00Z') + minutes * 60000).toISOString().slice(0,16);
        choices = utcInstantsForLocal(next, zone);
      }
      if (!choices.length) throw new Error('Cannot resolve recurring class time');
      const scheduledAt = new Date(choices[0]!);
      sessions.push({
        id: classSessionId(batchId, schedule.dayOfWeek, sessionDate),
        batchId,
        title: `${batch.name} - ${weekdayLabel(schedule.dayOfWeek)}`,
        sessionNumber: 0,
        scheduledAt,
        durationMinutes: SESSION_DURATION_MINUTES
      });
      current.setUTCDate(current.getUTCDate() + WEEK_IN_DAYS);
    }
  }

  return sessions
    .sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime())
    .map((session, index) => ({
      ...session,
      title: `${batch.name} - Session ${index + 1}`,
      sessionNumber: index + 1
    }));
}

export function classSessionChannelIds(sessionId: string): { roomId: string; chatChannelId: string; whiteboardChannelId: string } {
  return {
    roomId: `classroom:${sessionId}`,
    chatChannelId: `classroom:${sessionId}:chat`,
    whiteboardChannelId: `classroom:${sessionId}:whiteboard`
  };
}

function classSessionId(batchId: string, dayOfWeek: BatchWeekday, date: string): string {
  return `${batchId}-${dayOfWeek}-${date}`;
}

function weekdayLabel(day: BatchWeekday): string {
  return day[0] + day.slice(1).toLowerCase();
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
