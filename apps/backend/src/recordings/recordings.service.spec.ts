import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Role } from '@native-sfu/contracts';
import { RecordingsService } from './recordings.service';

const now = new Date('2026-06-22T10:00:00.000Z');
const tempDirs: string[] = [];

describe('RecordingsService', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('emits a recording.started platform event when a generic room host starts recording', async () => {
    const harness = createHarness();
    harness.rooms.findById.mockResolvedValue({ id: 'room-1', name: 'Ops Review', hostId: 'host-1' });
    harness.participants.findOne.mockResolvedValue({ id: 'host-1', userId: 'user-1', displayName: 'Host One', nodeId: 'node-a' });
    harness.recordings.create.mockResolvedValue(recordingDoc({ id: 'recording-1', roomId: 'room-1', participantId: 'host-1' }));

    const recording = await harness.service.start('user-1', 'room-1', 'room', 'host-1');

    expect(recording.id).toBe('recording-1');
    const eventInput = (harness.platformEvents.appendEvent.mock.calls as any)[0][0];
    expect(eventInput.type).toBe('recording.started');
    expect(eventInput.roomId).toBe('room-1');
  });

  it('requires the room host to control generic room recordings', async () => {
    const harness = createHarness();
    harness.rooms.findById.mockResolvedValue({ id: 'room-1', hostId: 'host-1' });
    harness.participants.findOne.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await harness.service.start('user-2', 'room-1', 'room');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('starts a server-owned class-session recording manifest for a live session', async () => {
    const harness = createHarness();
    const session = classSessionDoc();
    const batch = batchDoc();
    const participant = participantDoc({ id: 'teacher-participant', userId: 'teacher-1', role: Role.HOST });
    const producer = producerDoc({ id: 'producer-screen', participantId: 'teacher-participant', kind: 'screen' });
    harness.recordings.create.mockImplementation(async (payload: Record<string, unknown>) =>
      recordingDoc({
        id: 'recording-db-1',
        recordingId: 'recording-1',
        ...payload
      })
    );
    harness.participants.find.mockResolvedValue([participant]);
    harness.producers.find.mockResolvedValue([producer]);

    const recording = await harness.service.startClassSessionRecording({
      session,
      batch,
      actor: teacher()
    });

    expect(recording.status).toBe('recording');
    expect(recording.sessionId).toBe('session-1');
    expect(recording.batchId).toBe('batch-1');
    expect(recording.roomId).toBe('room-1');
    expect(recording.mimeType).toBe('application/vnd.native-sfu.recording-manifest+json');
    expect(recording.container).toBe('manifest-json');
    expect(recording.retentionExpiresAt).toBeDefined();
    expect(recording.consentRequired).toBe(true);
    expect(recording.downloadUrl).toBe('/api/v1/class-sessions/session-1/recordings/recording-1/download');
    expect('path' in recording).toBe(false);
    expect(recording.tracks?.[0]?.producerId).toBe('producer-screen');
    expect((harness.platformEvents.appendEvent.mock.calls as any)[0][0].type).toBe('recording.started');
    expect(harness.events[0]?.event).toBe('recording:started');
  });

  it('rejects class-session recording start for scheduled sessions and non-teachers', async () => {
    const harness = createHarness();

    let scheduledThrown: unknown;
    try {
      await harness.service.startClassSessionRecording({
        session: classSessionDoc({ status: 'scheduled' }),
        batch: batchDoc(),
        actor: teacher()
      });
    } catch (error) {
      scheduledThrown = error;
    }
    expect(scheduledThrown).toBeInstanceOf(BadRequestException);

    let studentThrown: unknown;
    try {
      await harness.service.startClassSessionRecording({
        session: classSessionDoc(),
        batch: batchDoc(),
        actor: student()
      });
    } catch (error) {
      studentThrown = error;
    }
    expect(studentThrown).toBeInstanceOf(ForbiddenException);
  });

  it('rejects duplicate active class-session recordings', async () => {
    const harness = createHarness();
    harness.recordings.findOne.mockResolvedValue(recordingDoc({ status: 'recording' }));

    let thrown: unknown;
    try {
      await harness.service.startClassSessionRecording({
        session: classSessionDoc(),
        batch: batchDoc(),
        actor: teacher()
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(harness.recordings.create).not.toHaveBeenCalled();
  });

  it('stops an active class-session recording and finalizes the manifest', async () => {
    const harness = createHarness();
    const session = classSessionDoc();
    const batch = batchDoc();
    const recording = recordingDoc({
      id: 'recording-db-1',
      recordingId: 'recording-1',
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      status: 'recording',
      startedAt: new Date('2026-06-22T09:59:00.000Z')
    });
    harness.classSessions.findById.mockResolvedValue(session);
    harness.batches.findOne.mockResolvedValue(batch);
    harness.recordings.findOne.mockReturnValue(sortable(recording));
    harness.participants.find.mockResolvedValue([participantDoc({ id: 'teacher-participant', userId: 'teacher-1', role: Role.HOST })]);
    harness.producers.find.mockResolvedValue([producerDoc({ id: 'producer-camera', participantId: 'teacher-participant', kind: 'video' })]);

    const stopped = await harness.service.stopClassSessionRecording('session-1', undefined, teacher());

    expect(stopped.status).toBe('stopped');
    expect(stopped.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(stopped.downloadUrl).toBe('/api/v1/class-sessions/session-1/recordings/recording-1/download');
    expect(recording.save).toHaveBeenCalled();
    const calls = harness.platformEvents.appendEvent.mock.calls as any;
    const lastEvent = calls[calls.length - 1][0];
    expect(lastEvent.type).toBe('recording.stopped');
    expect(harness.events.map((event) => event.event)).toContain('recording:updated');
    expect(harness.events.map((event) => event.event)).toContain('recording:stopped');
  });

  it('lists and downloads finalized recordings only for authorized class-session users', async () => {
    const harness = createHarness();
    const recording = recordingDoc({
      id: 'recording-db-1',
      recordingId: 'recording-1',
      sessionId: 'session-1',
      batchId: 'batch-1',
      roomId: 'room-1',
      status: 'stopped',
      path: join(harness.tempDir, 'class-sessions', 'session-1', 'recording-1.json'),
      storageKey: 'class-sessions/session-1/recording-1.json'
    });
    harness.classSessions.findById.mockResolvedValue(classSessionDoc());
    harness.batches.findOne.mockResolvedValue(batchDoc());
    harness.studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);
    harness.recordings.find.mockReturnValue(sortable([recording]));
    harness.recordings.findOne.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.status) return sortable(null);
      return recording;
    });
    await recording.saveManifestFile();

    const list = await harness.service.listClassSessionRecordings('session-1', student());
    const download = await harness.service.readClassSessionRecordingDownload('session-1', 'recording-1', student());

    expect(list.length).toBe(1);
    expect(download.fileName).toBe('class-session-session-1-recording-recording-1.json');
    expect(download.content).toContain('recording-1');
    expect('path' in download.recording).toBe(false);
  });

  it('blocks non-enrolled students and not-ready recordings from playback', async () => {
    const harness = createHarness();
    harness.classSessions.findById.mockResolvedValue(classSessionDoc());
    harness.batches.findOne.mockResolvedValue(batchDoc());
    harness.studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(false);

    let forbidden: unknown;
    try {
      await harness.service.listClassSessionRecordings('session-1', student());
    } catch (error) {
      forbidden = error;
    }
    expect(forbidden).toBeInstanceOf(ForbiddenException);

    harness.studentEnrollments.isStudentEnrolledInBatch.mockResolvedValue(true);
    harness.recordings.findOne.mockReturnValue(recordingDoc({ status: 'recording', sessionId: 'session-1' }));
    let conflict: unknown;
    try {
      await harness.service.readClassSessionRecordingDownload('session-1', 'recording-1', student());
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(ConflictException);
  });

  it('lists admin recordings with safe metadata and no storage internals', async () => {
    const harness = createHarness();
    const recording = recordingDoc({
      id: 'recording-db-1',
      recordingId: 'recording-1',
      sessionId: 'session-1',
      batchId: 'batch-1',
      status: 'stopped',
      path: '/private/recordings/session-1/recording-1.json',
      storageKey: 'class-sessions/session-1/recording-1.json',
      retentionExpiresAt: new Date('2026-07-01T00:00:00.000Z'),
      stoppedAt: new Date('2026-06-22T10:30:00.000Z'),
      durationSeconds: 1800,
      size: 512
    });
    harness.recordings.find.mockReturnValue(queryChain([recording]));
    harness.recordings.countDocuments.mockReturnValue(queryResult(1));
    harness.classSessions.find.mockReturnValue(queryResult([classSessionDoc()]));
    harness.batches.find.mockReturnValue(queryResult([batchDoc({ courseId: 'course-1', courseName: 'Native SFU', teacherId: 'teacher-1' })]));

    const response = await harness.service.listAdminRecordings({ page: 1, limit: 10 }, admin());

    expect(response.items[0]?.recordingId).toBe('recording-1');
    expect(response.items[0]?.sessionTitle).toBe('Native SFU - Session 1');
    expect(response.items[0]?.storageProvider).toBe('Server storage');
    expect(response.items[0]?.canDownload).toBe(true);
    expect('path' in (response.items[0] as unknown as Record<string, unknown>)).toBe(false);
    expect('storageKey' in (response.items[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('rejects non-admin users from admin recording management', async () => {
    const harness = createHarness();

    let thrown: unknown;
    try {
      await harness.service.listAdminRecordings({}, teacher());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(harness.recordings.find).not.toHaveBeenCalled();
  });

  it('updates and expires admin recording retention as metadata only', async () => {
    const harness = createHarness();
    const recording = recordingDoc({ status: 'stopped', sessionId: 'session-1', batchId: 'batch-1' });
    harness.recordings.findOne.mockReturnValue(queryResult(recording));
    harness.classSessions.find.mockReturnValue(queryResult([classSessionDoc()]));
    harness.batches.find.mockReturnValue(queryResult([batchDoc()]));

    const updated = await harness.service.updateAdminRecordingRetention('recording-1', '2026-08-01T00:00:00.000Z', admin());
    const expired = await harness.service.expireAdminRecording('recording-1', admin());

    expect(updated.retentionExpiresAt).toBe('2026-08-01T00:00:00.000Z');
    expect(expired.status).toBe('expired');
    expect(recording.save).toHaveBeenCalledTimes(2);
  });

  it('guards admin recording download and reuses ready manifest checks', async () => {
    const harness = createHarness();
    const recording = recordingDoc({
      recordingId: 'recording-1',
      sessionId: 'session-1',
      batchId: 'batch-1',
      status: 'stopped',
      path: join(harness.tempDir, 'class-sessions', 'session-1', 'recording-1.json')
    });
    harness.recordings.findOne.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.$or && !filter.sessionId) return queryResult(recording);
      return recording;
    });
    harness.classSessions.findById.mockResolvedValue(classSessionDoc());
    harness.batches.findOne.mockResolvedValue(batchDoc());
    await recording.saveManifestFile();

    let forbidden: unknown;
    try {
      await harness.service.readAdminRecordingDownload('recording-1', student());
    } catch (error) {
      forbidden = error;
    }
    const download = await harness.service.readAdminRecordingDownload('recording-1', admin());

    expect(forbidden).toBeInstanceOf(ForbiddenException);
    expect(download.content).toContain('recording-1');
    expect('path' in download.recording).toBe(false);
  });

  it('fails when stopping an unknown generic recording', async () => {
    const harness = createHarness();
    harness.recordings.findById.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await harness.service.stop('user-1', 'missing-recording');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });
});

function createHarness() {
  const tempDir = join(tmpdir(), `native-sfu-recordings-${randomUUID()}`);
  tempDirs.push(tempDir);
  const rooms: any = { findById: jest.fn() };
  const batches: any = { findOne: jest.fn(), find: jest.fn(() => queryResult([])) };
  const classSessions: any = { findById: jest.fn(), find: jest.fn(() => queryResult([])) };
  const participants: any = {
    findOne: jest.fn(),
    find: jest.fn(async () => [])
  };
  const producers: any = { find: jest.fn(async () => []) };
  const recordings: any = {
    create: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(async () => null),
    find: jest.fn(() => sortable([])),
    countDocuments: jest.fn(() => queryResult(0))
  };
  const platformEvents: any = { appendEvent: jest.fn(async () => ({ id: 'event-1' })) };
  const studentEnrollments: any = { isStudentEnrolledInBatch: jest.fn(async () => true) };
  const events: Array<{ event: string; status?: string; reason?: string }> = [];
  const service = new RecordingsService(
    rooms as never,
    batches as never,
    classSessions as never,
    participants as never,
    producers as never,
    recordings as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'recording.driver') return 'local';
        if (key === 'recording.localPath') return tempDir;
        if (key === 'recording.retentionDays') return 30;
        return fallback;
      })
    } as never,
    platformEvents as never,
    studentEnrollments as never
  );
  service.onClassSessionRecordingEvent((event, payload) => events.push({ event, status: payload.status, reason: payload.reason }));
  return { service, rooms, batches, classSessions, participants, producers, recordings, platformEvents, studentEnrollments, events, tempDir };
}

function sortable(value: any): any {
  return {
    sort: jest.fn(async () => value)
  };
}

function queryChain(value: any): any {
  const chain = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    exec: jest.fn(async () => value)
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function queryResult(value: any): any {
  return {
    sort: jest.fn(() => queryResult(value)),
    exec: jest.fn(async () => value)
  };
}

function teacher(): any {
  return { sub: 'teacher-1', email: 'teacher@example.test', roles: ['TEACHER'], permissions: [], tokenId: 'token-1' };
}

function student(): any {
  return { sub: 'student-1', email: 'student@example.test', roles: ['STUDENT'], permissions: [], tokenId: 'token-2' };
}

function admin(): any {
  return { sub: 'admin-1', email: 'admin@example.test', roles: ['ADMIN'], permissions: [], tokenId: 'token-3' };
}

function batchDoc(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'batch-1',
    _id: 'batch-1',
    teacherId: 'teacher-1',
    name: 'Native SFU Batch',
    ...overrides
  };
}

function classSessionDoc(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'session-1',
    _id: 'session-1',
    batchId: 'batch-1',
    roomId: 'room-1',
    teacherId: 'teacher-1',
    title: 'Native SFU - Session 1',
    sessionNumber: 1,
    scheduledAt: now,
    status: 'live',
    startedAt: now,
    ...overrides
  };
}

function participantDoc(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'participant-1',
    _id: 'participant-1',
    userId: 'user-1',
    roomId: 'room-1',
    displayName: 'Participant One',
    role: Role.PARTICIPANT,
    admitted: true,
    joinedAt: now,
    ...overrides
  };
}

function producerDoc(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'producer-1',
    _id: 'producer-1',
    roomId: 'room-1',
    participantId: 'participant-1',
    kind: 'video',
    status: 'live',
    createdAt: now,
    ...overrides
  };
}

function recordingDoc(overrides: Record<string, unknown> = {}): any {
  const doc: Record<string, unknown> & {
    save: jest.Mock<Promise<void>, []>;
    saveManifestFile: () => Promise<void>;
  } = {
    id: 'recording-db-1',
    _id: 'recording-db-1',
    recordingId: 'recording-1',
    sessionId: undefined,
    batchId: undefined,
    roomId: 'room-1',
    participantId: undefined,
    scope: 'room',
    status: 'recording',
    storageDriver: 'local',
    storageKey: undefined,
    path: undefined,
    url: undefined,
    downloadUrl: undefined,
    playbackUrl: undefined,
    mimeType: undefined,
    container: undefined,
    size: undefined,
    durationSeconds: undefined,
    startedBy: 'teacher-1',
    stoppedBy: undefined,
    failureReason: undefined,
    retentionExpiresAt: undefined,
    consentVersion: undefined,
    consentRequired: true,
    tracks: [],
    startedAt: now,
    stoppedAt: undefined,
    save: jest.fn(async () => undefined),
    saveManifestFile: async () => {
      // Placeholder; overwritten below after path merge.
    },
    ...overrides
  };
  doc.saveManifestFile = async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = String(doc.path);
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, JSON.stringify({ recordingId: doc.recordingId }), 'utf8');
  };
  return doc;
}
