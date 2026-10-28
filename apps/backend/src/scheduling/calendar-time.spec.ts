import { describe, it, expect } from '@jest/globals';
import { localDateTime, utcInstantsForLocal } from '@native-sfu/contracts';
import { planClassSessions } from '../class-sessions/class-session-planner';
import { BatchScheduleMongoDocument } from '../database/schemas';
describe('class calendar timezones', () => {
  it('converts European winter and summer independently of the server timezone', () => {
    expect(utcInstantsForLocal('2027-01-12T10:00', 'Europe/Paris')).toEqual([
      '2027-01-12T09:00:00.000Z',
    ]);
    expect(utcInstantsForLocal('2027-07-12T10:00', 'Europe/Paris')).toEqual([
      '2027-07-12T08:00:00.000Z',
    ]);
    expect(localDateTime('2027-07-12T08:00:00Z', 'Asia/Kolkata')).toBe(
      '2027-07-12T13:30',
    );
  });
  it('rejects invalid dates and nonexistent spring times', () => {
    expect(utcInstantsForLocal('2027-03-28T02:30', 'Europe/Berlin')).toEqual(
      [],
    );
    expect(utcInstantsForLocal('2027-02-30T10:00', 'Europe/Paris')).toEqual([]);
    expect(utcInstantsForLocal('2027-01-12T10:00', 'invented/zone')).toEqual(
      [],
    );
  });
  it('requires a choice between the two autumn occurrences, including a half-hour transition', () => {
    expect(utcInstantsForLocal('2027-10-31T02:30', 'Europe/Berlin')).toEqual([
      '2027-10-31T00:30:00.000Z',
      '2027-10-31T01:30:00.000Z',
    ]);
    expect(
      utcInstantsForLocal('2027-04-04T01:45', 'Australia/Lord_Howe'),
    ).toHaveLength(2);
  });
  it('keeps recurring classes at the same local clock time across DST', () => {
    const sessions = planClassSessions(
      {
        id: 'dst',
        name: 'Maths',
        startDate: new Date('2027-03-21Z'),
        endDate: new Date('2027-04-04Z'),
        scheduleTimezone: 'Europe/Paris',
      },
      [
        { dayOfWeek: 'SUNDAY', startTime: '10:00' },
      ] as BatchScheduleMongoDocument[],
    );
    expect(sessions.map((s) => s.scheduledAt.toISOString())).toEqual([
      '2027-03-21T09:00:00.000Z',
      '2027-03-28T08:00:00.000Z',
      '2027-04-04T08:00:00.000Z',
    ]);
    expect(sessions.map((s) => s.id)).toEqual([
      'dst-SUNDAY-2027-03-21',
      'dst-SUNDAY-2027-03-28',
      'dst-SUNDAY-2027-04-04',
    ]);
  });
  it('moves a recurring spring-gap time to the first valid clock minute', () => {
    const sessions = planClassSessions(
      {
        id: 'gap',
        name: 'Maths',
        startDate: new Date('2027-03-28Z'),
        endDate: new Date('2027-03-28Z'),
        scheduleTimezone: 'Europe/Berlin',
      },
      [
        { dayOfWeek: 'SUNDAY', startTime: '02:30' },
      ] as BatchScheduleMongoDocument[],
    );
    expect(sessions[0]!.scheduledAt.toISOString()).toBe(
      '2027-03-28T01:00:00.000Z',
    );
  });
});
