import { describe, it, expect } from '@jest/globals';
import { planClassSessions } from './class-session-planner';
import type { BatchScheduleMongoDocument } from '../database/schemas';

describe('class session calendar dates', () => {
  it('keeps the scheduled weekday and calendar date in session IDs across local UTC offsets', () => {
    const batch = { id: 'calendar', name: 'Calendar class', startDate: new Date('2026-10-26T00:00:00Z'), endDate: new Date('2026-11-01T00:00:00Z') };
    const sessions = planClassSessions(batch, [{ dayOfWeek: 'WEDNESDAY', startTime: '12:30' }] as BatchScheduleMongoDocument[]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('calendar-WEDNESDAY-2026-10-28');
    expect(sessions[0]!.scheduledAt.getDay()).toBe(3);
    expect(sessions[0]!.scheduledAt.getDate()).toBe(28);
    expect(sessions[0]!.scheduledAt.getHours()).toBe(12);
    expect(sessions[0]!.scheduledAt.getMinutes()).toBe(30);
  });
});
