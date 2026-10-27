import { describe, it, expect, afterEach } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { DesktopService, parseMediaRange } from './desktop.service';

function query(value: unknown) {
  const result: any = { exec: jest.fn(async () => value) };
  for (const method of ['sort', 'select', 'limit']) result[method] = jest.fn(() => result);
  return result;
}
const teacher = { sub: 'teacher-1', email: 'teacher@example.test', roles: ['TEACHER'], permissions: [], tokenId: 'login-1' };
const student = { ...teacher, sub: 'student-1', roles: ['STUDENT'] };
const batch = { id: 'batch-1', name: 'Algebra', courseId: 'math', courseName: 'Mathematics', teacherId: teacher.sub, startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 86400000) };
const session = { id: 'session-1', title: 'Linear equations', batchId: batch.id, teacherId: teacher.sub, scheduledAt: new Date(), status: 'live', durationMinutes: 60 };
const cleanup: string[] = [];

async function harness(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-recording-'));
  cleanup.push(directory);
  const recording: any = { recordingId: randomUUID(), sessionId: session.id, batchId: batch.id, roomId: 'room-1', storageDriver: 'local', startedBy: teacher.sub, status: 'stopped', startedAt: new Date(), publishedAt: new Date(), durationSeconds: 120, ...overrides };
  const progressRow: any = { lastPositionSeconds: 15 };
  const batches = { find: jest.fn(() => query([batch])), findOne: jest.fn(() => query(batch)) };
  const sessions = { find: jest.fn(() => query([session])), findById: jest.fn(() => query(session)) };
  const schedules = { find: jest.fn(() => query([])) };
  const enrollments = { find: jest.fn(() => query([{ batchId: batch.id }])), exists: jest.fn(async () => true) };
  const users = { find: jest.fn(() => query([{ id: teacher.sub, displayName: 'Teacher One' }])), findOne: jest.fn(() => query({ id: student.sub, email: student.email, roles: student.roles, permissions: [] })) };
  const recordings = {
    find: jest.fn(() => query([recording])), findOne: jest.fn(() => query(recording)),
    findOneAndUpdate: jest.fn((_filter: unknown, update: any) => { Object.assign(recording, update.$set ?? {}); return query(recording); }),
    updateOne: jest.fn((_filter: unknown, update: any) => {
      Object.assign(recording, update.$set ?? {});
      for (const [key, value] of Object.entries(update.$inc ?? {})) recording[key] = (recording[key] ?? 0) + Number(value);
      for (const key of Object.keys(update.$unset ?? {})) delete recording[key];
      return query({ modifiedCount: 1 });
    })
  };
  const progress = { find: jest.fn(() => query([])), findOne: jest.fn(() => query(progressRow)), findOneAndUpdate: jest.fn((_filter: unknown, update: any) => { Object.assign(progressRow, update.$set); return query(progressRow); }) };
  const materials = { find: jest.fn(() => query([])) };
  const boards = { findOne: jest.fn(() => query(null)) };
  const logins = { exists: jest.fn(async () => true) };
  const config = { get: jest.fn((key: string, fallback: unknown) => key === 'recording.localPath' ? directory : fallback), getOrThrow: jest.fn(() => 'desktop-unit-test-secret-32-characters') };
  const recordingLifecycle = { failClassSessionCapture: jest.fn(async () => { recording.status = 'failed'; return recording; }), stopClassSessionRecording: jest.fn(async () => { recording.status = 'stopped'; return recording; }) };
  const service = new DesktopService(batches as any, sessions as any, schedules as any, enrollments as any, users as any, recordings as any, progress as any, materials as any, boards as any, logins as any, config as any, recordingLifecycle as any);
  return { directory, service, recording, batches, sessions, schedules, enrollments, users, recordings, progress, materials, boards, logins, recordingLifecycle };
}

class ResponseSink extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  status(code: number) { this.statusCode = code; return this; }
  set(headers: Record<string, string>) { Object.assign(this.headers, headers); return this; }
  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error) => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
}

afterEach(async () => { await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('desktop class access', () => {
  it('chooses the classroom role per batch for a dual-role user', async () => {
    const h = await harness();
    const learning = { ...batch, id: 'learning', teacherId: 'another-teacher' };
    h.batches.find.mockReturnValue(query([batch, learning]));
    h.sessions.find.mockReturnValue(query([session, { ...session, id: 'lesson-2', batchId: learning.id }]));
    const result = await h.service.classes({ ...teacher, roles: ['TEACHER', 'STUDENT'] });
    expect(result.items.map((item) => item.role)).toEqual(['teacher', 'student']);
    expect(h.enrollments.find).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('includes unpersisted planned classes and resolves their authorized deep links', async () => {
    const h = await harness();
    const day = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][new Date().getDay()];
    h.schedules.find.mockReturnValue(query([{ batchId: batch.id, dayOfWeek: day, startTime: '23:00', originalStartTime: '22:00', rescheduledAt: new Date() }]));
    h.sessions.find.mockReturnValue(query([]));
    h.sessions.findById.mockReturnValue(query(null));
    const response = await h.service.classes(student);
    expect(response.items.length).toBeGreaterThan(0);
    const planned = response.items[0]!;
    expect(planned).toMatchObject({ role: 'student', status: 'scheduled', canJoin: true });
    expect(planned.rescheduledAt).toBeDefined();
    expect(planned.originalScheduledAt).toBeDefined();
    expect(await h.service.classroom(student, planned.sessionId)).toMatchObject({ sessionId: planned.sessionId });
  });

  it('rejects a class deep link when a student is not enrolled', async () => {
    const h = await harness(); h.enrollments.exists.mockResolvedValue(false);
    await expect(h.service.classroom(student, session.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns cancelled class status without allowing entry', async () => {
    const h = await harness(); h.sessions.findById.mockReturnValue(query({ ...session, status: 'cancelled' }));
    expect(await h.service.classroom(teacher, session.id)).toMatchObject({ role: 'teacher', status: 'cancelled', canJoin: false });
  });
});

describe('desktop recording access', () => {
  it('does not advertise a JSON-only legacy manifest as playable video', async () => {
    const h = await harness({ mimeType: 'application/vnd.native-sfu.recording-manifest+json' });
    expect((await h.service.listRecordings(student)).items[0]?.status).toBe('unavailable');
    await expect(h.service.playback(student, h.recording.recordingId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('hides unpublished recordings from students but keeps them visible to their teacher', async () => {
    const h = await harness({ unpublishedAt: new Date() });
    expect((await h.service.listRecordings(student)).items).toHaveLength(0);
    expect((await h.service.listRecordings(teacher)).items).toHaveLength(1);
    await expect(h.service.playback(student, h.recording.recordingId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects expired media even when it was published', async () => {
    const h = await harness({ retentionExpiresAt: new Date(Date.now() - 1000) });
    await expect(h.service.playback(student, h.recording.recordingId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await h.service.listRecordings(student)).items[0]?.status).toBe('expired');
  });

  it('rejects progress from unauthorized viewers and clamps it to server duration', async () => {
    const h = await harness({ mediaReadyAt: new Date(), mediaPath: 'video.webm', mediaDurationSeconds: 120 });
    h.enrollments.exists.mockResolvedValue(false);
    await expect(h.service.saveProgress(student, h.recording.recordingId, { positionSeconds: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    h.enrollments.exists.mockResolvedValue(true);
    await expect(h.service.saveProgress(student, h.recording.recordingId, { positionSeconds: NaN })).rejects.toBeInstanceOf(BadRequestException);
    expect(await h.service.saveProgress(student, h.recording.recordingId, { positionSeconds: 900, durationSeconds: 10000, event: 'seek' })).toMatchObject({ lastPositionSeconds: 120, durationSeconds: 120 });
  });

  it('supports resume position for the owning teacher as well as students', async () => {
    const h = await harness({ mediaReadyAt: new Date(), mediaPath: 'video.webm' });
    expect(await h.service.saveProgress(teacher, h.recording.recordingId, { positionSeconds: 35 })).toMatchObject({ lastPositionSeconds: 35 });
    expect(h.progress.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ studentId: teacher.sub }), expect.anything(), expect.anything());
  });

  it('filters materials and notes by publication for students', async () => {
    const h = await harness();
    await h.service.notes(student, h.recording.recordingId).catch(() => undefined);
    expect(h.boards.findOne).toHaveBeenCalledWith(expect.objectContaining({ publishedAt: { $exists: true }, unpublishedAt: { $exists: false } }));
  });
});

describe('durable composed lesson upload', () => {
  it('requires the recording owner and a capture claim', async () => {
    const h = await harness();
    await expect(h.service.claimCapture(student, h.recording.recordingId, randomUUID())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.uploadChunk(teacher, h.recording.recordingId, '0', undefined as any, Buffer.from('test'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.uploadChunk(teacher, h.recording.recordingId, '0', randomUUID(), Buffer.from('test'))).rejects.toBeInstanceOf(ConflictException);
  });

  it('prevents competing teacher windows from mixing recording chunks', async () => {
    const h = await harness(); const capture = randomUUID();
    await h.service.claimCapture(teacher, h.recording.recordingId, capture);
    await expect(h.service.claimCapture(teacher, h.recording.recordingId, randomUUID())).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.uploadChunk(teacher, h.recording.recordingId, '0', randomUUID(), Buffer.from('test'))).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks an empty failed setup exactly once and preserves received media', async () => {
    const h = await harness(); const capture = randomUUID(); const id = h.recording.recordingId;
    expect(await h.service.captureFailed(teacher, id, capture)).toMatchObject({ status: 'failed', preserved: false });
    expect(await h.service.captureFailed(teacher, id, capture)).toMatchObject({ status: 'failed' });
    await expect(h.service.captureFailed(teacher, id, randomUUID())).rejects.toBeInstanceOf(ConflictException);
    const partial = await harness(); const partialId = partial.recording.recordingId;
    await partial.service.claimCapture(teacher, partialId, capture);
    await partial.service.uploadChunk(teacher, partialId, '0', capture, Buffer.from('preserve'));
    expect(await partial.service.captureFailed(teacher, partialId, capture)).toMatchObject({ preserved: true });
    expect(partial.recordingLifecycle.failClassSessionCapture).not.toHaveBeenCalled();
  });

  it('accepts identical retries and rejects out-of-order or changed chunks', async () => {
    const h = await harness(); const capture = randomUUID(); const id = h.recording.recordingId;
    await h.service.claimCapture(teacher, id, capture);
    await expect(h.service.uploadChunk(teacher, id, '1', capture, Buffer.from('first'))).rejects.toBeInstanceOf(ConflictException);
    await h.service.uploadChunk(teacher, id, '0', capture, Buffer.from('first'));
    await expect(h.service.uploadChunk(teacher, id, '0', capture, Buffer.from('first'))).resolves.toMatchObject({ received: true });
    await expect(h.service.uploadChunk(teacher, id, '0', capture, Buffer.from('other'))).rejects.toBeInstanceOf(ConflictException);
    expect(await h.service.uploadStatus(teacher, id)).toMatchObject({ indices: [0], captureId: capture, finalized: false });
    expect(h.recording.mediaUploadBytes).toBe(5);
  });

  it('refuses missing chunks and invalid containers without creating playable media', async () => {
    const h = await harness(); const capture = randomUUID(); const id = h.recording.recordingId;
    await h.service.claimCapture(teacher, id, capture);
    await h.service.uploadChunk(teacher, id, '0', capture, Buffer.from('not video'));
    await expect(h.service.finalize(teacher, id, capture, { chunkCount: 2, durationSeconds: 1, mimeType: 'video/webm' })).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.finalize(teacher, id, capture, { chunkCount: 1, durationSeconds: 1, mimeType: 'video/webm' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.recording.mediaReadyAt).toBeUndefined();
  });

  it('purges expired desktop video and partial chunks only inside its recording storage', async () => {
    const h = await harness({ retentionExpiresAt: new Date(Date.now() - 1000), mediaCaptureId: randomUUID() });
    const directory = join(h.directory, 'desktop-media');
    const chunks = join(directory, `${h.recording.recordingId}.chunks`);
    const media = join(directory, `${h.recording.recordingId}.webm`);
    const unrelated = join(h.directory, 'unrelated.txt');
    await mkdir(chunks, { recursive: true }); await writeFile(join(chunks, '0.part'), 'chunk'); await writeFile(media, 'video'); await writeFile(unrelated, 'keep');
    h.recording.mediaPath = unrelated; // A database path must not be used as an unlink target.
    expect(await h.service.cleanupExpiredMedia()).toBe(1);
    await expect(stat(media)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(chunks)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
    expect(h.recording.mediaPurgedAt).toBeInstanceOf(Date);
  });

  it('remuxes actual media, serves byte ranges, and rechecks access after publication or login changes', async () => {
    const h = await harness(); const capture = randomUUID(); const id = h.recording.recordingId;
    const source = join(h.directory, 'fixture.webm');
    await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libvpx', '-c:a', 'libopus', '-f', 'webm', source]);
    const bytes = await readFile(source); const midpoint = Math.floor(bytes.length / 2);
    await h.service.claimCapture(teacher, id, capture);
    await h.service.uploadChunk(teacher, id, '0', capture, bytes.subarray(0, midpoint));
    await h.service.uploadChunk(teacher, id, '1', capture, bytes.subarray(midpoint));
    expect(await h.service.finalize(teacher, id, capture, { chunkCount: 2, durationSeconds: 1000, mimeType: 'video/webm' })).toMatchObject({ finalized: true });
    expect(h.recording.mediaDurationSeconds).toBeLessThan(2);
    expect(h.recordingLifecycle.stopClassSessionRecording).toHaveBeenCalledWith(session.id, id, teacher); // trusted media duration, not the client's number
    const file = await stat(h.recording.mediaPath); expect(file.size).toBeGreaterThan(1000);
    const playback = await h.service.playback(student, id);
    const ticket = new URL(playback.playbackUrl, 'http://local.test').searchParams.get('ticket')!;
    const sink = new ResponseSink(); await h.service.stream(id, ticket, 'bytes=0-31', sink);
    expect(sink.statusCode).toBe(206); expect(Buffer.concat(sink.chunks)).toHaveLength(32);
    expect(sink.headers['Content-Range']).toBe(`bytes 0-31/${file.size}`);
    const invalid = new ResponseSink(); await h.service.stream(id, ticket, `bytes=${file.size}-`, invalid); expect(invalid.statusCode).toBe(416);
    await expect(h.service.stream(id, `${ticket}tampered`, undefined, new ResponseSink())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(h.service.stream(randomUUID(), ticket, undefined, new ResponseSink())).rejects.toBeInstanceOf(UnauthorizedException);
    h.logins.exists.mockResolvedValue(false);
    await expect(h.service.stream(id, ticket, undefined, new ResponseSink())).rejects.toBeInstanceOf(UnauthorizedException);
    h.logins.exists.mockResolvedValue(true); h.recording.unpublishedAt = new Date();
    await expect(h.service.stream(id, ticket, undefined, new ResponseSink())).rejects.toBeInstanceOf(NotFoundException);
    delete h.recording.unpublishedAt; h.enrollments.exists.mockResolvedValue(false);
    await expect(h.service.stream(id, ticket, undefined, new ResponseSink())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.finalize(teacher, id, capture, { chunkCount: 2, durationSeconds: 1, mimeType: 'video/webm' })).resolves.toMatchObject({ finalized: true });
  }, 30_000);
});

describe('media range parsing', () => {
  it('supports full, bounded, open-ended and suffix ranges', () => {
    expect(parseMediaRange(undefined, 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(parseMediaRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20, partial: true });
    expect(parseMediaRange('bytes=10-', 100)).toEqual({ start: 10, end: 99, partial: true });
    expect(parseMediaRange('bytes=-10', 100)).toEqual({ start: 90, end: 99, partial: true });
  });
  it.each(['bytes=200-', 'bytes=20-10', 'bytes=0-2,5-9', 'bytes=-0', 'bytes=-', 'bytes=9007199254740992-'])('rejects malformed or unsatisfiable range %s', (range) => {
    expect(() => parseMediaRange(range, 100)).toThrow(BadRequestException);
  });
});
