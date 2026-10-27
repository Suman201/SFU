import { describe, it, expect } from '@jest/globals';
import { withScheduleHistory } from './schedule-history';

describe('recurring lesson schedule history', () => {
  it('does not mark an initial schedule as rescheduled', () => {
    expect(withScheduleHistory([{ dayOfWeek: 'MONDAY', startTime: '09:00' }], [])).toEqual([{ dayOfWeek: 'MONDAY', startTime: '09:00' }]);
  });
  it('records the original time and preserves it across subsequent changes', () => {
    const first = withScheduleHistory([{ dayOfWeek: 'MONDAY', startTime: '10:00' }], [{ dayOfWeek: 'MONDAY', startTime: '09:00' }]);
    const next = withScheduleHistory([{ dayOfWeek: 'MONDAY', startTime: '11:00' }], first);
    expect(next[0]).toMatchObject({ startTime: '11:00', originalStartTime: '09:00' });
    expect(next[0]?.rescheduledAt).toBeInstanceOf(Date);
  });
  it('keeps unchanged days and existing history intact', () => {
    const previous = [{ dayOfWeek: 'MONDAY' as const, startTime: '10:00', originalStartTime: '09:00', rescheduledAt: new Date('2026-01-01') }];
    expect(withScheduleHistory([{ dayOfWeek: 'MONDAY', startTime: '10:00' }], previous)).toEqual(previous);
  });
});
