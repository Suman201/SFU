import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { API_BASE_URL } from './app-environment';
import { ClassroomRecoveryStore } from './classroom-recovery-store';

interface PendingCapture {
  recordingId: string; sessionId: string; ownerId: string; captureId: string;
  chunkCount: number; uploadedCount: number; durationSeconds: number; complete: boolean; setupFailed?: boolean;
}
export interface LessonCaptureSources {
  board: () => HTMLCanvasElement | null;
  screen: () => MediaStream | null;
  camera: () => MediaStream | null;
  audio: () => MediaStream[];
}

/** Shared by the web and desktop classroom. Uploads real lesson media in durable, retryable chunks. */
@Injectable({ providedIn: 'root' })
export class LessonRecordingService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly storage = new ClassroomRecoveryStore();
  readonly activeId = signal('');
  readonly notice = signal('');
  readonly pending = signal(false);
  private recorder?: MediaRecorder;
  private capture?: PendingCapture;
  private persistTail: Promise<void> = Promise.resolve();
  private flushing?: Promise<void>;
  private cleanup?: () => void;
  private startedAt = 0;
  private recorderStopped?: Promise<void>;
  private stopping?: Promise<void>;
  private stoppingRecorder?: MediaRecorder;
  private startingCaptureId = '';

  constructor() {
    effect(() => { if (this.auth.user()?.id) void this.recover(); });
    window.addEventListener('online', () => { void this.recover(); });
    window.setInterval(() => { if (this.auth.authenticated()) void this.recover(); }, 15_000);
  }

  async start(recordingId: string, sessionId: string, sources: LessonCaptureSources): Promise<void> {
    if (this.activeId() === recordingId) return;
    if (this.recorder || this.startingCaptureId) throw new Error('Another lesson recording is already running.');
    const ownerId = this.auth.user()?.id;
    if (!ownerId) throw new Error('Sign in before recording a lesson.');
    const key = this.metaKey(ownerId, recordingId);
    // Before a capture starts, this durable marker lets a later launch abort only its own empty claim.
    const capture: PendingCapture = { recordingId, sessionId, ownerId, captureId: crypto.randomUUID(), chunkCount: 0, uploadedCount: 0, durationSeconds: 0, complete: false, setupFailed: true };
    let existing: PendingCapture | undefined;
    try { existing = await this.storage.get<PendingCapture>(key); }
    catch {
      await this.failEmptyCapture(capture).catch(() => undefined);
      throw new Error('Recording needs local storage. Free space or allow storage access, then try again.');
    }
    if (existing) {
      await this.recover();
      throw new Error('The earlier recording is being recovered. Start a new recording after it finishes.');
    }
    if (this.recorder || this.startingCaptureId) throw new Error('Another lesson recording is already running.');
    this.startingCaptureId = capture.captureId;
    let claimAccepted = false;
    let cleanup: (() => void) | undefined;
    let recorder: MediaRecorder | undefined;
    try {
      await this.storage.put(key, capture);
      if (!globalThis.MediaRecorder?.isTypeSupported('video/webm;codecs=vp8,opus')) throw new Error('Lesson recording needs a browser with WebM recording support.');
      await firstValueFrom(this.http.post(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(recordingId)}/capture`, { captureId: capture.captureId }).pipe(timeout(30_000)));
      claimAccepted = true;
      const composed = this.compose(sources);
      cleanup = composed.cleanup;
      recorder = new MediaRecorder(composed.stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_800_000, audioBitsPerSecond: 96_000 });
      this.recorderStopped = new Promise<void>((resolve) => recorder!.addEventListener('stop', () => resolve(), { once: true }));
      this.capture = capture; this.recorder = recorder; this.cleanup = cleanup;
      this.startedAt = performance.now();
      let nextIndex = 0;
      let storageFailed = false;
      const failStorage = () => {
        storageFailed = true;
        this.notice.set('Recording stopped because this device could not save more media. Free space and retry the upload.');
        if (recorder!.state !== 'inactive') recorder!.stop();
        setTimeout(() => { void this.stop().catch(() => undefined); });
      };
      recorder.ondataavailable = (event) => {
        if (!event.data.size || storageFailed) return;
        const index = nextIndex++;
        capture.durationSeconds = Math.max(0.1, (performance.now() - this.startedAt) / 1000);
        this.persistTail = this.persistTail.then(async () => {
          if (storageFailed) return;
          await this.storage.put(this.chunkKey(capture, index), event.data);
          capture.chunkCount = index + 1;
          await this.storage.put(key, { ...capture });
          this.pending.set(true);
        }).catch(failStorage);
        void this.persistTail.then(() => this.flush()).catch(() => undefined);
      };
      recorder.onerror = () => { this.notice.set('Recording was interrupted. Saved media will upload when the connection returns.'); void this.stop().catch(() => undefined); };
      recorder.start(5000);
      capture.setupFailed = false;
      this.persistTail = this.persistTail.then(() => this.storage.put(key, { ...capture })).catch(failStorage);
      this.activeId.set(recordingId);
      this.notice.set('Recording lesson video and audio.');
    } catch (error) {
      if (!claimAccepted && (error as { status?: number })?.status === 409) {
        await this.storage.remove(key).catch(() => undefined);
        throw new Error('This recording is already being captured on another device.');
      }
      cleanup?.();
      if (this.recorder === recorder) { this.recorder = undefined; this.capture = undefined; this.cleanup = undefined; this.recorderStopped = undefined; }
      capture.complete = true; capture.setupFailed = true;
      await this.storage.put(key, capture).catch(() => undefined);
      try { await this.failEmptyCapture(capture); await this.storage.remove(key); }
      catch { this.pending.set(true); this.notice.set('Recording could not start. Its saved setup will be cleared when the connection returns.'); }
      throw error;
    } finally { if (this.startingCaptureId === capture.captureId) this.startingCaptureId = ''; }
  }

  stop(): Promise<void> {
    const recorder = this.recorder;
    const capture = this.capture;
    if (!recorder || !capture) return Promise.resolve();
    if (this.stopping && this.stoppingRecorder === recorder) return this.stopping;
    const work = this.finishStop(recorder, capture);
    this.stoppingRecorder = recorder;
    this.stopping = work;
    void work.finally(() => { if (this.stopping === work) { this.stopping = undefined; this.stoppingRecorder = undefined; } }).catch(() => undefined);
    return work;
  }

  private async finishStop(recorder: MediaRecorder, capture: PendingCapture): Promise<void> {
    // MediaRecorder becomes inactive before its final dataavailable event. Always await its stop event.
    const stopped = this.recorderStopped ?? new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
    const cleanup = this.cleanup;
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    cleanup?.();
    await this.persistTail;
    capture.complete = true;
    await this.storage.put(this.metaKey(capture.ownerId, capture.recordingId), capture);
    if (this.recorder === recorder) { this.cleanup = undefined; this.recorder = undefined; this.capture = undefined; this.recorderStopped = undefined; this.activeId.set(''); }
    await this.flush();
    if (await this.storage.get(this.metaKey(capture.ownerId, capture.recordingId))) await this.flush();
  }

  private async failEmptyCapture(capture: PendingCapture): Promise<void> {
    const result = await firstValueFrom(this.http.post<{ preserved?: boolean; data?: { preserved?: boolean } }>(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(capture.recordingId)}/capture-failed`, { captureId: capture.captureId, reason: 'The recording could not start on the teaching device.' }, { headers: { 'X-Recording-Capture-Id': capture.captureId } }).pipe(timeout(30_000)));
    if ((result.data ?? result).preserved) throw new Error('Existing recording media was preserved.');
  }

  async recover(): Promise<void> {
    try { await this.flush(); } catch { /* Kept locally for the next online retry. */ }
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.uploadPending().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async uploadPending(): Promise<void> {
    const ownerId = this.auth.user()?.id;
    if (!ownerId || !navigator.onLine) return;
    try {
      await this.persistTail;
      let uploadError: unknown;
      for (const item of await this.storage.list<PendingCapture>(`recording:${ownerId}:`)) {
        try {
        const meta = item.value;
        if (meta.captureId === this.startingCaptureId) continue;
        if (meta.setupFailed && this.capture?.recordingId !== meta.recordingId) {
          await this.failEmptyCapture(meta); await this.storage.remove(item.key); continue;
        }
        const current = this.capture?.recordingId === meta.recordingId;
        if (!current) meta.complete = true; // A terminated app cannot append to the previous MediaRecorder stream.
        const headers = { 'X-Recording-Capture-Id': meta.captureId };
        for (let index = meta.uploadedCount; index < meta.chunkCount; index++) {
          const blob = await this.storage.get<Blob>(this.chunkKey(meta, index));
          if (!blob) throw new Error('A saved recording segment is missing.');
          const form = new FormData();
          form.append('file', blob, `${index}.webm`);
          form.append('captureId', meta.captureId);
          await firstValueFrom(this.http.post(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(meta.recordingId)}/chunks/${index}`, form, { headers }).pipe(timeout(60_000)));
          meta.uploadedCount = index + 1;
          if (current && this.capture) this.capture.uploadedCount = meta.uploadedCount;
          // Persist acknowledgement before deleting payload; retries remain idempotent after a crash.
          await this.storage.put(item.key, current && this.capture ? { ...this.capture } : meta);
          await this.storage.remove(this.chunkKey(meta, index));
        }
        if (meta.complete && !meta.chunkCount) { await this.failEmptyCapture(meta); await this.storage.remove(item.key); continue; }
        if (meta.complete && meta.chunkCount) {
          await firstValueFrom(this.http.post(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(meta.recordingId)}/finalize`, { captureId: meta.captureId, chunkCount: meta.chunkCount, durationSeconds: meta.durationSeconds, mimeType: 'video/webm' }, { headers }).pipe(timeout(120_000)));
          // Finalize completes this recording ID idempotently; never stop a different live capture.
          await this.storage.remove(item.key);
          this.notice.set('Recording uploaded and ready.');
        }
        } catch (error) { uploadError = error; }
      }
      if (uploadError) throw uploadError;
      this.pending.set((await this.storage.list(`recording:${ownerId}:`)).some((entry) => (entry.value as PendingCapture).complete || (entry.value as PendingCapture).chunkCount > (entry.value as PendingCapture).uploadedCount));
    } catch (error) {
      this.pending.set(true);
      const status = (error as { status?: number })?.status;
      this.notice.set(status === 401 || status === 403 ? 'Recording is saved on this device. Sign in with the recording teacher account to finish uploading.' : 'Recording is saved on this device. Upload will retry when the connection is available.');
      throw error;
    }
  }

  private metaKey(ownerId: string, id: string): string { return `recording:${ownerId}:${id}`; }
  private chunkKey(meta: PendingCapture, index: number): string { return `media:${meta.ownerId}:${meta.recordingId}:${index}`; }

  private compose(sources: LessonCaptureSources): { stream: MediaStream; cleanup: () => void } {
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
    const context = canvas.getContext('2d')!;
    const screen = document.createElement('video'); const camera = document.createElement('video');
    for (const video of [screen, camera]) { video.muted = true; video.playsInline = true; }
    const audio = new AudioContext(); const destination = audio.createMediaStreamDestination();
    const audioNodes = new Map<string, MediaStreamAudioSourceNode>();
    const oscillator = audio.createOscillator(); const silence = audio.createGain(); silence.gain.value = 0;
    oscillator.connect(silence).connect(destination); oscillator.start();
    void audio.resume().catch(() => {
      // A quick stop may close the context before the browser finishes resuming it.
      if (audio.state !== 'closed') this.notice.set('Recording audio could not start. Check your audio permissions.');
    });
    const fit = (source: CanvasImageSource, width: number, height: number, x = 0, y = 0, boxWidth = 1600, boxHeight = 900) => {
      if (!width || !height) return;
      const scale = Math.min(boxWidth / width, boxHeight / height);
      context.drawImage(source, x + (boxWidth - width * scale) / 2, y + (boxHeight - height * scale) / 2, width * scale, height * scale);
    };
    const tick = () => {
      context.fillStyle = '#14231e'; context.fillRect(0, 0, 1600, 900);
      const sharedScreen = sources.screen();
      for (const [video, stream] of [[screen, sharedScreen], [camera, sources.camera()]] as const) {
        if (video.srcObject !== stream) { video.srcObject = stream; if (stream) void video.play().catch(() => undefined); }
      }
      const board = sources.board();
      if (sharedScreen?.getVideoTracks().some((track) => track.readyState === 'live')) {
        if (screen.readyState >= 2) fit(screen, screen.videoWidth, screen.videoHeight);
      } else if (board?.width && board.height) fit(board, board.width, board.height);
      else if (camera.readyState >= 2) fit(camera, camera.videoWidth, camera.videoHeight);
      if ((board || sharedScreen) && camera.readyState >= 2) fit(camera, camera.videoWidth, camera.videoHeight, 1328, 732, 256, 144);
      const tracks = sources.audio().flatMap((stream) => stream.getAudioTracks()).filter((track) => track.readyState === 'live');
      const ids = new Set(tracks.map((track) => track.id));
      for (const [id, node] of audioNodes) if (!ids.has(id)) { node.disconnect(); audioNodes.delete(id); }
      for (const track of tracks) if (!audioNodes.has(track.id)) {
        const node = audio.createMediaStreamSource(new MediaStream([track])); node.connect(destination); audioNodes.set(track.id, node);
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let stream: MediaStream | undefined;
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; clearInterval(timer); stream?.getTracks().forEach((track) => track.stop()); destination.stream.getTracks().forEach((track) => track.stop()); audioNodes.forEach((node) => node.disconnect()); try { oscillator.stop(); } catch { /* It may not have started. */ } void audio.close().catch(() => undefined); screen.srcObject = camera.srcObject = null; };
    try {
      tick(); timer = window.setInterval(tick, 1000 / 15);
      stream = canvas.captureStream(15); destination.stream.getAudioTracks().forEach((track) => stream!.addTrack(track));
      return { stream, cleanup };
    } catch (error) { cleanup(); throw error; }
  }
}
