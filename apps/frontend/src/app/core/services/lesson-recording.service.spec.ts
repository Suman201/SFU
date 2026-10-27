import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { LessonRecordingService } from './lesson-recording.service';

interface Capture { recordingId: string; sessionId: string; ownerId: string; captureId: string; chunkCount: number; uploadedCount: number; durationSeconds: number; complete: boolean; setupFailed?: boolean; }
class MemoryStore {
  values = new Map<string, unknown>();
  writes: Array<{ operation: string; key: string; value?: unknown }> = [];
  async get<T>(key: string): Promise<T | undefined> { const value = this.values.get(key); return value === undefined ? undefined : structuredClone(value) as T; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); this.writes.push({ operation: 'put', key, value: structuredClone(value) }); }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> { return [...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); }
  async remove(key: string): Promise<void> { this.values.delete(key); this.writes.push({ operation: 'remove', key }); }
}

describe('Durable lesson recording upload', () => {
  let service: LessonRecordingService;
  let store: MemoryStore;
  let post: jasmine.Spy;
  let currentUser: { id: string } | null;
  const metaKey = (id: string, owner = 'teacher-1') => `recording:${owner}:${id}`;
  const chunkKey = (id: string, index = 0, owner = 'teacher-1') => `media:${owner}:${id}:${index}`;
  const capture = (id: string, overrides: Partial<Capture> = {}): Capture => ({ recordingId: id, sessionId: 'class-1', ownerId: 'teacher-1', captureId: `capture-${id}`, chunkCount: 1, uploadedCount: 0, durationSeconds: 12, complete: true, ...overrides });
  const internal = () => service as unknown as { storage: MemoryStore; capture?: Capture; recorder?: MediaRecorder; recorderStopped?: Promise<void>; persistTail: Promise<void>; cleanup?: () => void };

  beforeEach(() => {
    currentUser = null;
    post = jasmine.createSpy('post').and.returnValue(of({ success: true }));
    spyOn(window, 'setInterval').and.returnValue(0);
    TestBed.configureTestingModule({ providers: [
      { provide: HttpClient, useValue: { post } },
      { provide: AuthService, useValue: { user: () => currentUser, authenticated: () => Boolean(currentUser) } }
    ] });
    service = TestBed.inject(LessonRecordingService);
    store = new MemoryStore(); internal().storage = store;
    TestBed.tick();
    currentUser = { id: 'teacher-1' };
  });

  it('finishes an old crashed recording without stopping a newer active recording', async () => {
    const old = capture('old', { complete: false, uploadedCount: 1 });
    const active = capture('new', { complete: false, uploadedCount: 1 });
    await store.put(metaKey('old'), old); await store.put(metaKey('new'), active);
    internal().capture = active;
    await service.recover();
    const urls = post.calls.allArgs().map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/old/finalize'))).toBeTrue();
    expect(urls.some((url) => url.endsWith('/new/finalize') || url.endsWith('/recording/stop'))).toBeFalse();
    expect(await store.get(metaKey('old'))).toBeUndefined();
    expect(await store.get(metaKey('new'))).toEqual(active);
  });

  it('continues recovering other lessons when one saved recording has a missing chunk', async () => {
    await store.put(metaKey('a-broken'), capture('a-broken'));
    await store.put(metaKey('z-good'), capture('z-good'));
    await store.put(chunkKey('z-good'), new Blob(['saved lesson'], { type: 'video/webm' }));
    await service.recover();
    expect(post.calls.allArgs().map(([url]) => String(url)).some((url) => url.endsWith('/z-good/finalize'))).toBeTrue();
    expect(await store.get(metaKey('a-broken'))).toBeDefined();
    expect(await store.get(metaKey('z-good'))).toBeUndefined();
    expect(service.pending()).toBeTrue();
  });

  it('persists server acknowledgement before deleting the only local chunk', async () => {
    await store.put(metaKey('lesson'), capture('lesson'));
    await store.put(chunkKey('lesson'), new Blob(['saved lesson']));
    store.writes.length = 0;
    await service.recover();
    const acknowledged = store.writes.findIndex((entry) => entry.operation === 'put' && entry.key === metaKey('lesson') && (entry.value as Capture).uploadedCount === 1);
    const deleted = store.writes.findIndex((entry) => entry.operation === 'remove' && entry.key === chunkKey('lesson'));
    expect(acknowledged).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(acknowledged);
  });

  it('drains the final durable chunk before finalizing after a local stop', async () => {
    const active = capture('lesson', { complete: false, chunkCount: 0 });
    await store.put(metaKey('lesson'), active);
    internal().capture = active;
    const recorder = new EventTarget() as EventTarget & { state: string; stop: () => void };
    recorder.state = 'recording';
    recorder.stop = () => { recorder.state = 'inactive'; recorder.dispatchEvent(new Event('stop')); };
    internal().recorder = recorder as unknown as MediaRecorder;
    internal().cleanup = jasmine.createSpy('cleanup');
    let release!: () => void;
    internal().persistTail = new Promise<void>((resolve) => release = resolve);
    const stopped = service.stop();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    active.chunkCount = 1;
    await store.put(chunkKey('lesson'), new Blob(['final segment']));
    await store.put(metaKey('lesson'), active);
    release();
    await stopped;
    const finalization = post.calls.allArgs().find(([url]) => String(url).endsWith('/lesson/finalize'));
    expect(finalization?.[1]).toEqual(jasmine.objectContaining({ chunkCount: 1, captureId: 'capture-lesson' }));
    expect(await store.get(metaKey('lesson'))).toBeUndefined();
    expect(service.activeId()).toBe('');
  });

  it('coalesces concurrent stop requests until the final recorder event arrives', async () => {
    const active = capture('lesson', { complete: false, chunkCount: 0 });
    await store.put(metaKey('lesson'), active); internal().capture = active;
    const recorder = new EventTarget() as EventTarget & { state: string; stop: jasmine.Spy };
    recorder.state = 'recording'; recorder.stop = jasmine.createSpy().and.callFake(() => recorder.state = 'inactive');
    internal().recorder = recorder as unknown as MediaRecorder;
    internal().recorderStopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
    const first = service.stop(); const second = service.stop();
    expect(second).toBe(first);
    await Promise.resolve(); expect(post).not.toHaveBeenCalled();
    active.chunkCount = 1; await store.put(chunkKey('lesson'), new Blob(['final data'])); await store.put(metaKey('lesson'), active);
    recorder.dispatchEvent(new Event('stop'));
    await Promise.all([first, second]);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(post.calls.allArgs().filter(([url]) => String(url).endsWith('/lesson/finalize')).length).toBe(1);
  });

  it('releases composed media and fails only the claimed recording when recorder construction fails', async () => {
    const cleanup = jasmine.createSpy('cleanup');
    spyOn(service as any, 'compose').and.returnValue({ stream: new MediaStream(), cleanup });
    const constructor = spyOn(window, 'MediaRecorder').and.throwError('Recorder unavailable');
    Object.assign(constructor, { isTypeSupported: () => true });
    await expectAsync(service.start('broken-start', 'class-1', { board: () => null, screen: () => null, camera: () => null, audio: () => [] })).toBeRejectedWithError('Recorder unavailable');
    expect(cleanup).toHaveBeenCalledOnceWith();
    expect(post.calls.allArgs().some(([url]) => String(url).endsWith('/broken-start/capture-failed'))).toBeTrue();
    expect(await store.get(metaKey('broken-start'))).toBeUndefined();
    expect(service.activeId()).toBe('');
  });

  it('keeps failed setup identity until the server acknowledges cleanup after reconnect', async () => {
    spyOn(service as any, 'compose').and.throwError('No capture surface');
    post.and.callFake((url: string) => url.endsWith('/capture-failed') ? throwError(() => ({ status: 0 })) : of({}));
    await expectAsync(service.start('offline-start', 'class-1', { board: () => null, screen: () => null, camera: () => null, audio: () => [] })).toBeRejected();
    const saved = await store.get<Capture>(metaKey('offline-start'));
    expect(saved?.setupFailed).toBeTrue(); expect(saved?.captureId).toBeTruthy();
    post.and.returnValue(of({}));
    await service.recover();
    expect(await store.get(metaKey('offline-start'))).toBeUndefined();
  });

  it('records the currently selected shared source and returns to the preserved classroom board', async () => {
    const makeCanvas = (color: string) => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64); return canvas; };
    const board = makeCanvas('#0000ff'); const teacherCanvas = makeCanvas('#ff0000'); const studentCanvas = makeCanvas('#00ff00');
    const teacher = teacherCanvas.captureStream(10); const student = studentCanvas.captureStream(10);
    let selected: MediaStream | null = teacher;
    const create = document.createElement.bind(document);
    const createdCanvases: HTMLCanvasElement[] = []; const createdVideos: HTMLVideoElement[] = [];
    spyOn(document, 'createElement').and.callFake(((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (tag === 'canvas') createdCanvases.push(element as HTMLCanvasElement);
      if (tag === 'video') createdVideos.push(element as HTMLVideoElement);
      return element;
    }) as typeof document.createElement);
    const composition = (service as any).compose({ board: () => board, screen: () => selected, camera: () => null, audio: () => [] });
    const tick = (window.setInterval as jasmine.Spy).calls.mostRecent().args[0] as () => void;
    const awaitFrame = async (source: MediaStream) => {
      tick();
      const video = createdVideos[0]!;
      const deadline = performance.now() + 2000;
      while ((video.srcObject !== source || video.readyState < 2) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(video.readyState).toBeGreaterThanOrEqual(2); tick();
      return [...createdCanvases[0]!.getContext('2d')!.getImageData(800, 450, 1, 1).data];
    };
    try {
      const teacherPixel = await awaitFrame(teacher); expect(teacherPixel[0]).toBeGreaterThan(200); expect(teacherPixel[1]).toBeLessThan(30);
      selected = student;
      const studentPixel = await awaitFrame(student); expect(studentPixel[1]).toBeGreaterThan(200); expect(studentPixel[0]).toBeLessThan(30);
      selected = null; tick();
      const boardPixel = createdCanvases[0]!.getContext('2d')!.getImageData(800, 450, 1, 1).data;
      expect(boardPixel[2]).toBeGreaterThan(200); expect(boardPixel[0]).toBeLessThan(30);
      composition.cleanup();
      expect(teacher.getVideoTracks()[0]!.readyState).toBe('live'); expect(student.getVideoTracks()[0]!.readyState).toBe('live');
    } finally { composition.cleanup(); teacher.getTracks().forEach(track => track.stop()); student.getTracks().forEach(track => track.stop()); }
  });

  it('never uploads another account’s stored lesson work', async () => {
    await store.put(metaKey('private', 'teacher-2'), capture('private', { ownerId: 'teacher-2', uploadedCount: 1 }));
    await service.recover();
    expect(post).not.toHaveBeenCalled();
    expect(await store.get(metaKey('private', 'teacher-2'))).toBeDefined();
  });
});
