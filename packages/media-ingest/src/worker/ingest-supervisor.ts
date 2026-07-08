import { EventEmitter } from 'node:events';
import type { FfmpegProgressSnapshot, MediaIngestRuntimeConfig, MediaIngestSupervisorSnapshot, MediaIngestSupervisorState, MediaProbeResult } from '../types';
import { IngestRuntimeMetrics } from '../metrics/ingest-runtime-metrics';
import { MediaIngestRunner } from './ingest-runner';

type MediaIngestSupervisorEvents = {
  state: [MediaIngestSupervisorState, MediaIngestSupervisorSnapshot];
  probe: [MediaProbeResult];
  progress: [FfmpegProgressSnapshot];
  log: [string];
  restart: [number];
  error: [Error];
};

export class MediaIngestSupervisor extends EventEmitter<MediaIngestSupervisorEvents> {
  private readonly metrics = new IngestRuntimeMetrics();
  private state: MediaIngestSupervisorState = 'idle';
  private restartCount = 0;
  private lastError?: string;
  private runner?: MediaIngestRunner;
  private loop?: Promise<void>;
  private stopRequested = false;
  private liveRecorded = false;
  private readonly now: () => number;
  private currentProbe?: MediaProbeResult;

  constructor(
    private readonly config: MediaIngestRuntimeConfig,
    private readonly options: {
      runnerFactory?: (config: MediaIngestRuntimeConfig) => MediaIngestRunner;
      now?: () => number;
    } = {}
  ) {
    super();
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.loop) {
      return;
    }
    this.stopRequested = false;
    this.loop = this.runLoop();
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.runner) {
      this.transition('stopping');
      await this.runner.stop();
    }
    if (this.loop) {
      await this.loop;
      this.loop = undefined;
    }
  }

  async waitForState(state: MediaIngestSupervisorState, timeoutMs = this.config.startupTimeoutMs ?? 10_000): Promise<MediaIngestSupervisorSnapshot> {
    if (this.state === state) {
      return this.snapshot();
    }
    return await new Promise<MediaIngestSupervisorSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ingest supervisor ${this.config.ingestId} state ${state}`));
      }, timeoutMs);
      timer.unref?.();
      const onState = (nextState: MediaIngestSupervisorState) => {
        if (nextState !== state) {
          return;
        }
        cleanup();
        resolve(this.snapshot());
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('state', onState);
      };
      this.on('state', onState);
    });
  }

  snapshot(): MediaIngestSupervisorSnapshot {
    return {
      ingestId: this.config.ingestId,
      state: this.state,
      restartCount: this.restartCount,
      lastError: this.lastError,
      probe: this.currentProbe ? { ...this.currentProbe, streams: this.currentProbe.streams.map((stream) => ({ ...stream })) } : undefined,
      runner: this.runner?.snapshot(),
      metrics: this.metrics.snapshot()
    };
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      this.liveRecorded = false;
      this.transition(this.restartCount > 0 ? 'restarting' : 'starting');
      this.metrics.recordStart(new Date(this.now()));
      const runner = this.options.runnerFactory?.(this.config) ?? new MediaIngestRunner(this.config);
      this.runner = runner;
      this.bindRunner(runner);
      try {
        await runner.start();
        const exit = await runner.waitForExit();
        this.metrics.recordExit(exit);
        this.runner = undefined;
        if (this.stopRequested) {
          this.metrics.recordStop(new Date(this.now()));
          this.transition('stopped');
          return;
        }
        const restart = shouldRestart(this.config.restartPolicy, exit.code, this.restartCount);
        if (!restart) {
          this.lastError = exit.code === 0 ? undefined : `ingest process exited with code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`;
          if (exit.code !== 0) {
            this.metrics.recordFailure(this.lastError);
          }
          this.transition(exit.code === 0 ? 'stopped' : 'failed');
          return;
        }
        await this.scheduleRestart();
      } catch (error) {
        this.runner = undefined;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.metrics.recordFailure(this.lastError);
        this.emit('error', error instanceof Error ? error : new Error(this.lastError));
        if (!shouldRestart(this.config.restartPolicy, 1, this.restartCount)) {
          this.transition('failed');
          return;
        }
        await this.scheduleRestart();
      }
    }

    this.metrics.recordStop(new Date(this.now()));
    this.transition('stopped');
  }

  private bindRunner(runner: MediaIngestRunner): void {
    runner.on('probe', (probe) => {
      this.currentProbe = probe;
      this.emit('probe', probe);
    });
    runner.on('progress', (progress) => {
      this.metrics.recordProgress(progress, new Date(this.now()));
      if (!this.liveRecorded) {
        this.liveRecorded = true;
        this.metrics.recordLive(new Date(this.now()));
        this.transition('live');
      }
      this.emit('progress', progress);
    });
    runner.on('log', (line) => this.emit('log', line));
    runner.on('error', (error) => {
      this.lastError = error.message;
      this.emit('error', error);
    });
  }

  private async scheduleRestart(): Promise<void> {
    this.restartCount += 1;
    this.metrics.recordRestart();
    this.emit('restart', this.restartCount);
    const backoffMs = computeBackoffMs(this.config.restartPolicy, this.restartCount);
    await delay(backoffMs);
  }

  private transition(state: MediaIngestSupervisorState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.emit('state', state, this.snapshot());
  }
}

function shouldRestart(
  restartPolicy: MediaIngestRuntimeConfig['restartPolicy'],
  exitCode: number | null,
  restartCount: number
): boolean {
  const mode = restartPolicy?.mode ?? 'never';
  if (restartPolicy?.maxAttempts !== undefined && restartCount >= restartPolicy.maxAttempts) {
    return false;
  }
  if (mode === 'never') {
    return false;
  }
  if (mode === 'always') {
    return true;
  }
  return exitCode !== 0;
}

function computeBackoffMs(restartPolicy: MediaIngestRuntimeConfig['restartPolicy'], restartCount: number): number {
  const initial = restartPolicy?.initialBackoffMs ?? 500;
  const max = restartPolicy?.maxBackoffMs ?? 10_000;
  return Math.min(max, initial * Math.max(1, 2 ** Math.max(0, restartCount - 1)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
