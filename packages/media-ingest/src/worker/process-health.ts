import type { FfmpegProgressSnapshot, IngestProcessHealthSnapshot, MediaIngestSupervisorState } from '../types';

interface IngestProcessHealthTrackerOptions {
  staleAfterMs?: number;
  startupGraceMs?: number;
  now?: () => number;
}

export class IngestProcessHealthTracker {
  private readonly staleAfterMs: number;
  private readonly startupGraceMs: number;
  private readonly now: () => number;
  private state: MediaIngestSupervisorState = 'idle';
  private pid?: number;
  private startedAt?: number;
  private lastProgressAt?: number;
  private lastLogAt?: number;
  private lastExitAt?: number;
  private exitCode?: number | null;
  private exitSignal?: NodeJS.Signals | null;
  private lastError?: string;
  private progressCount = 0;
  private lastProgress?: FfmpegProgressSnapshot;

  constructor(options: IngestProcessHealthTrackerOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
    this.startupGraceMs = options.startupGraceMs ?? Math.max(this.staleAfterMs, 15_000);
    this.now = options.now ?? Date.now;
  }

  setState(state: MediaIngestSupervisorState): void {
    this.state = state;
  }

  recordStart(pid?: number): void {
    const now = this.now();
    this.pid = pid;
    this.startedAt = now;
    this.lastExitAt = undefined;
    this.exitCode = undefined;
    this.exitSignal = undefined;
    this.lastError = undefined;
    this.progressCount = 0;
    this.lastProgress = undefined;
    this.lastProgressAt = undefined;
    this.state = 'starting';
  }

  recordProgress(snapshot: FfmpegProgressSnapshot): void {
    this.lastProgress = snapshot;
    this.lastProgressAt = this.now();
    this.progressCount += 1;
    if (this.state === 'starting' || this.state === 'restarting') {
      this.state = 'live';
    }
  }

  recordLog(): void {
    this.lastLogAt = this.now();
  }

  recordError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  recordExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.lastExitAt = this.now();
    this.exitCode = code;
    this.exitSignal = signal;
    this.state = code === 0 ? 'stopped' : 'failed';
  }

  snapshot(): IngestProcessHealthSnapshot {
    const now = this.now();
    const stale = this.state === 'live' && this.lastProgressAt !== undefined ? now - this.lastProgressAt > this.staleAfterMs : false;
    const healthy =
      this.state === 'live'
        ? !stale
        : (this.state === 'starting' || this.state === 'restarting') && this.startedAt !== undefined
          ? now - this.startedAt <= this.startupGraceMs
          : false;
    return {
      state: this.state,
      pid: this.pid,
      startedAt: toIso(this.startedAt),
      lastProgressAt: toIso(this.lastProgressAt),
      lastLogAt: toIso(this.lastLogAt),
      lastExitAt: toIso(this.lastExitAt),
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      lastError: this.lastError,
      healthy,
      stale,
      progressCount: this.progressCount,
      lastProgress: this.lastProgress ? { ...this.lastProgress, rawFields: { ...this.lastProgress.rawFields } } : undefined
    };
  }
}

function toIso(value?: number): string | undefined {
  return value !== undefined ? new Date(value).toISOString() : undefined;
}
