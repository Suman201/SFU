const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar dates are wall-clock dates; class instants are always ISO UTC. */
export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}
export function localDateTime(
  instant: Date | string,
  timeZone: string,
): string {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const p = (key: string) => parts.find((item) => item.type === key)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}
/** Zero results means a DST gap; two results means a repeated clock time. */
export function utcInstantsForLocal(local: string, timeZone: string): string[] {
  if (
    !validTimeZone(timeZone) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)
  )
    return [];
  const naive = Date.parse(local + ':00Z');
  if (
    !Number.isFinite(naive) ||
    new Date(naive).toISOString().slice(0, 16) !== local
  )
    return [];
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = new Date(naive + hours * 3600000);
    offsets.add(
      Date.parse(localDateTime(sample, timeZone) + ':00Z') - sample.getTime(),
    );
  }
  return [...offsets]
    .map((offset) => new Date(naive - offset).toISOString())
    .filter((instant) => localDateTime(instant, timeZone) === local)
    .sort();
}
export interface CalendarClass {
  id: string;
  batchId: string;
  batchName: string;
  teacherName: string;
  title: string;
  scheduledAt: string;
  originalScheduledAt?: string;
  durationMinutes: number;
  status: 'scheduled' | 'live' | 'completed' | 'cancelled';
  scheduleTimezone: string;
  rescheduledAt?: string;
  reason?: string;
}
export interface ClassNotice {
  id: string;
  title: string;
  body: string;
  batchId: string;
  sessionId?: string;
  kind: 'enrollment' | 'rescheduled' | 'cancelled' | 'reminder';
  createdAt: string;
  readAt?: string;
}
export interface CalendarChangeRequest {
  action: 'reschedule' | 'cancel';
  expectedScheduledAt: string;
  localTime?: string;
  timeZone?: string;
  chosenInstant?: string;
  reason?: string;
}
