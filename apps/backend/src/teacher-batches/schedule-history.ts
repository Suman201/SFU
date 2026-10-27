import type { BatchWeekday } from '../database/schemas';

interface ScheduleTime { dayOfWeek: BatchWeekday; startTime: string; rescheduledAt?: Date; originalStartTime?: string; }

/** Preserve when a recurring lesson moved, without marking unchanged days as rescheduled. */
export function withScheduleHistory(next: ScheduleTime[], previous: ScheduleTime[], changedAt = new Date()): ScheduleTime[] {
  return next.map((item) => {
    const old = previous.find((candidate) => candidate.dayOfWeek === item.dayOfWeek);
    if (old?.startTime === item.startTime) return { ...item, ...(old.rescheduledAt ? { rescheduledAt: old.rescheduledAt } : {}), ...(old.originalStartTime ? { originalStartTime: old.originalStartTime } : {}) };
    return { ...item, ...(previous.length ? { rescheduledAt: changedAt } : {}), ...(old ? { originalStartTime: old.originalStartTime ?? old.startTime } : {}) };
  });
}
