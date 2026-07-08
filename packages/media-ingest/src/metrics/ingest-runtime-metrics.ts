import type { FfmpegProgressSnapshot, IngestRuntimeMetricsSnapshot, MediaIngestExitInfo } from '../types';

export class IngestRuntimeMetrics {
  private starts = 0;
  private liveTransitions = 0;
  private restarts = 0;
  private cleanStops = 0;
  private failures = 0;
  private lastStartAt?: string;
  private lastLiveAt?: string;
  private lastStopAt?: string;
  private lastExitCode?: number | null;
  private lastExitSignal?: NodeJS.Signals | null;
  private lastError?: string;
  private lastProgressAt?: string;

  recordStart(at = new Date()): void {
    this.starts += 1;
    this.lastStartAt = at.toISOString();
  }

  recordLive(at = new Date()): void {
    this.liveTransitions += 1;
    this.lastLiveAt = at.toISOString();
  }

  recordRestart(): void {
    this.restarts += 1;
  }

  recordStop(at = new Date()): void {
    this.cleanStops += 1;
    this.lastStopAt = at.toISOString();
  }

  recordFailure(error?: string): void {
    this.failures += 1;
    this.lastError = error;
  }

  recordExit(exit: MediaIngestExitInfo): void {
    this.lastExitCode = exit.code;
    this.lastExitSignal = exit.signal;
  }

  recordProgress(_snapshot: FfmpegProgressSnapshot, at = new Date()): void {
    this.lastProgressAt = at.toISOString();
  }

  snapshot(): IngestRuntimeMetricsSnapshot {
    return {
      starts: this.starts,
      liveTransitions: this.liveTransitions,
      restarts: this.restarts,
      cleanStops: this.cleanStops,
      failures: this.failures,
      lastStartAt: this.lastStartAt,
      lastLiveAt: this.lastLiveAt,
      lastStopAt: this.lastStopAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastError: this.lastError,
      lastProgressAt: this.lastProgressAt
    };
  }
}
