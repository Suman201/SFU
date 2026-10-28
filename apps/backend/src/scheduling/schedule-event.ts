import { randomUUID } from 'node:crypto';
export interface ScheduleEvent {
  id: string;
  kind: 'enrollment' | 'rescheduled' | 'cancelled';
  occurredAt: Date;
  oldScheduledAt?: Date;
  scheduledAt?: Date;
  reason?: string;
  dispatchedAt?: Date;
}
export function scheduleEvent(
  kind: ScheduleEvent['kind'],
  fields: Partial<ScheduleEvent> = {},
): ScheduleEvent {
  return { id: randomUUID(), kind, occurredAt: new Date(), ...fields };
}
