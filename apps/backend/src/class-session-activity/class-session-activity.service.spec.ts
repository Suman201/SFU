import { BadRequestException } from '@nestjs/common';
import { ClassSessionActivityService } from './class-session-activity.service';

describe('ClassSessionActivityService', () => {
  it('records immutable activity events with sensitive metadata redacted', async () => {
    const { service, activityEvents } = createHarness();

    await service.record({
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      eventType: 'chat.broadcast_sent',
      category: 'chat',
      summary: 'Teacher sent a class broadcast',
      actor: { id: 'teacher-1', email: 'teacher@example.test', roles: ['TEACHER'] },
      metadata: {
        message: 'secret body',
        storageKey: 'private/file.pdf',
        safe: 'kept'
      },
      visibility: 'student_safe'
    });

    const payload = activityEvents.create.mock.calls[0]?.[0];
    expect(payload.sessionId).toBe('session-1');
    expect(payload.batchId).toBe('batch-1');
    expect(payload.roomId).toBe('room-1');
    expect(payload.eventType).toBe('chat.broadcast_sent');
    expect(payload.category).toBe('chat');
    expect(payload.actorId).toBe('teacher-1');
    expect(payload.actorEmail).toBe('teacher@example.test');
    expect(payload.actorRoles).toEqual(['TEACHER']);
    expect(payload.visibility).toBe('student_safe');
    expect(payload.metadata).toEqual({
      message: '[redacted]',
      storageKey: '[redacted]',
      safe: 'kept'
    });
  });

  it('lists student-safe timeline events without leaking full events', async () => {
    const { service, activityEvents } = createHarness();

    const response = await service.listTimeline({
      sessionId: 'session-1',
      batchId: 'batch-1',
      visibility: 'student_safe',
      audienceIds: ['student-1'],
      limit: 1
    });

    expect(response.items.length).toBe(1);
    expect(response.items[0]?.id).toBe('event-new');
    expect(response.hasMore).toBe(true);
    expect(response.nextBefore).toBe('2026-06-22T10:05:00.000Z');
    expect(activityEvents.find).toHaveBeenCalledWith({
      sessionId: 'session-1',
      batchId: 'batch-1',
      $or: [
        { visibility: 'student_safe' },
        { visibility: 'actor_only', actorId: { $in: ['student-1'] } },
        { visibility: 'actor_only', targetUserId: { $in: ['student-1'] } },
        { visibility: 'actor_only', targetId: { $in: ['student-1'] } }
      ]
    });
  });

  it('rejects invalid pagination dates', async () => {
    const { service } = createHarness();

    let thrown: unknown;
    try {
      await service.listTimeline({
        sessionId: 'session-1',
        visibility: 'full',
        before: 'not-a-date'
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  function createHarness(): {
    service: ClassSessionActivityService;
    activityEvents: {
      create: jest.Mock;
      find: jest.Mock;
    };
  } {
    const docs = [
      doc({
        id: 'event-new',
        eventType: 'session.ended',
        category: 'lifecycle',
        summary: 'Ended',
        visibility: 'student_safe',
        createdAt: new Date('2026-06-22T10:05:00.000Z')
      }),
      doc({
        id: 'event-old',
        eventType: 'session.started',
        category: 'lifecycle',
        summary: 'Started',
        visibility: 'student_safe',
        createdAt: new Date('2026-06-22T10:00:00.000Z')
      })
    ];
    const activityEvents = {
      create: jest.fn(async () => undefined),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          limit: jest.fn(() => ({
            exec: jest.fn(async () => docs)
          }))
        }))
      }))
    };
    return {
      service: new ClassSessionActivityService(activityEvents as never),
      activityEvents
    };
  }

  function doc(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: overrides.id,
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      eventType: overrides.eventType,
      category: overrides.category,
      summary: overrides.summary,
      actorRoles: [],
      visibility: overrides.visibility,
      createdAt: overrides.createdAt
    };
  }
});
