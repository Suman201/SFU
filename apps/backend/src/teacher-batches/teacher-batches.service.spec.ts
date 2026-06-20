import { BadRequestException, ConflictException } from '@nestjs/common';
import { TeacherBatchesService } from './teacher-batches.service';

describe('TeacherBatchesService', () => {
  it('rejects duplicate weekdays in a batch schedule', async () => {
    const service = serviceWith({ batchExists: false });

    let thrown: unknown;
    try {
      await service.create('teacher-1', {
        name: 'Laravel Morning Batch 2026',
        year: 2026,
        maxCapacity: 30,
        schedule: [
          { dayOfWeek: 'MONDAY', startTime: '10:00' },
          { dayOfWeek: 'MONDAY', startTime: '14:00' }
        ]
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate batch name and year for the same teacher', async () => {
    const service = serviceWith({ batchExists: true });

    let thrown: unknown;
    try {
      await service.create('teacher-1', {
        name: 'Laravel Morning Batch 2026',
        year: 2026,
        maxCapacity: 30,
        schedule: [{ dayOfWeek: 'MONDAY', startTime: '10:00' }]
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
  });

  it('lists teacher batches with schedules and zero enrolled count', async () => {
    const service = serviceWith({
      batches: [
        {
          id: 'batch-1',
          name: 'Laravel Morning Batch 2026',
          courseName: 'Laravel',
          teacherId: 'teacher-1',
          year: 2026,
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: new Date(Date.UTC(2026, 11, 31)),
          maxCapacity: 30,
          status: 'ACTIVE',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z')
        }
      ],
      schedules: [
        { id: 'schedule-1', batchId: 'batch-1', dayOfWeek: 'MONDAY', startTime: '10:00' },
        { id: 'schedule-2', batchId: 'batch-1', dayOfWeek: 'WEDNESDAY', startTime: '14:00' }
      ]
    });

    const results = await service.findAll('teacher-1');
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe('batch-1');
    expect(results[0]?.name).toBe('Laravel Morning Batch 2026');
    expect(results[0]?.enrolledCount).toBe(0);
    expect(results[0]?.maxCapacity).toBe(30);
    expect(results[0]?.schedule).toEqual([
      { id: 'schedule-1', dayOfWeek: 'MONDAY', startTime: '10:00' },
      { id: 'schedule-2', dayOfWeek: 'WEDNESDAY', startTime: '14:00' }
    ]);
  });
});

function serviceWith(options: { batchExists?: boolean; batches?: unknown[]; schedules?: unknown[] }): TeacherBatchesService {
  const batches = {
    exists: jest.fn().mockResolvedValue(options.batchExists ? { _id: 'existing' } : null),
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(options.batches ?? []) })
  };
  const schedules = {
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(options.schedules ?? []) })
  };
  const connection = {
    startSession: jest.fn()
  };
  return new TeacherBatchesService(batches as never, schedules as never, connection as never);
}
