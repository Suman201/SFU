import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { FfmpegProgressSnapshot, MediaIngestExitInfo, MediaIngestSpawnCommand, SpawnProcess } from '../types';

interface FfmpegSessionOptions {
  command: MediaIngestSpawnCommand;
  spawnProcess?: SpawnProcess;
  stopTimeoutMs?: number;
}

type FfmpegSessionEvents = {
  started: [{ pid?: number }];
  log: [string];
  progress: [FfmpegProgressSnapshot];
  error: [Error];
  exit: [MediaIngestExitInfo];
};

export class FfmpegSession extends EventEmitter<FfmpegSessionEvents> {
  private readonly stopTimeoutMs: number;
  private readonly spawnProcess: SpawnProcess;
  private child?: ChildProcess;
  private stderrRemainder = '';
  private currentProgressFields: Record<string, string> = {};
  private exitPromise?: Promise<MediaIngestExitInfo>;
  private exiting?: {
    resolve: (value: MediaIngestExitInfo) => void;
    reject: (reason: Error) => void;
  };
  private exitInfo?: MediaIngestExitInfo;

  constructor(private readonly options: FfmpegSessionOptions) {
    super();
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const child = this.spawnProcess(this.options.command.executable, this.options.command.args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    this.child = child;
    this.exitPromise = new Promise<MediaIngestExitInfo>((resolve, reject) => {
      this.exiting = { resolve, reject };
    });

    child.stderr?.on('data', (chunk: Buffer) => this.consumeStderr(chunk.toString('utf8')));
    child.once('spawn', () => this.emit('started', { pid: child.pid }));
    child.once('error', (error) => {
      this.emit('error', error);
      this.exiting?.reject(error);
      this.exiting = undefined;
      this.child = undefined;
    });
    child.once('exit', (code, signal) => {
      this.consumeStderr('\n');
      const exit: MediaIngestExitInfo = { code, signal };
      this.exitInfo = exit;
      this.emit('exit', exit);
      this.exiting?.resolve(exit);
      this.exiting = undefined;
      this.child = undefined;
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(error));
    });
  }

  async waitForExit(): Promise<MediaIngestExitInfo> {
    if (this.exitInfo) {
      return this.exitInfo;
    }
    if (!this.exitPromise) {
      throw new Error('FFmpeg session has not been started');
    }
    return this.exitPromise;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<MediaIngestExitInfo> {
    if (this.exitInfo) {
      return this.exitInfo;
    }
    const child = this.child;
    if (!child) {
      throw new Error('FFmpeg session has not been started');
    }
    child.kill(signal);
    const timer = setTimeout(() => {
      if (!this.exitInfo && child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }, this.stopTimeoutMs);
    timer.unref?.();
    try {
      return await this.waitForExit();
    } finally {
      clearTimeout(timer);
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrRemainder += chunk;
    let newlineIndex = this.stderrRemainder.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stderrRemainder.slice(0, newlineIndex).replace(/\r$/, '');
      this.stderrRemainder = this.stderrRemainder.slice(newlineIndex + 1);
      this.handleStderrLine(line);
      newlineIndex = this.stderrRemainder.indexOf('\n');
    }
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex > 0) {
      const key = trimmed.slice(0, separatorIndex);
      const value = trimmed.slice(separatorIndex + 1);
      this.currentProgressFields[key] = value;
      if (key === 'progress' && (value === 'continue' || value === 'end')) {
        const snapshot = parseProgressFields(this.currentProgressFields);
        this.emit('progress', snapshot);
        this.currentProgressFields = {};
      }
      return;
    }

    this.emit('log', trimmed);
  }
}

function parseProgressFields(fields: Record<string, string>): FfmpegProgressSnapshot {
  return {
    frame: toInteger(fields.frame),
    fps: toNumber(fields.fps),
    bitrateKbps: parseBitrateKbps(fields.bitrate),
    totalSizeBytes: toInteger(fields.total_size),
    outputTimeUs: toInteger(fields.out_time_us),
    dupFrames: toInteger(fields.dup_frames),
    dropFrames: toInteger(fields.drop_frames),
    speed: parseSpeed(fields.speed),
    progress: fields.progress === 'end' ? 'end' : 'continue',
    rawFields: { ...fields }
  };
}

function toInteger(value?: string): number | undefined {
  if (!value || value === 'N/A') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toNumber(value?: string): number | undefined {
  if (!value || value === 'N/A') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBitrateKbps(value?: string): number | undefined {
  if (!value || value === 'N/A') {
    return undefined;
  }
  const normalized = value.trim().replace(/kbits\/s$/i, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSpeed(value?: string): number | undefined {
  if (!value || value === 'N/A') {
    return undefined;
  }
  const normalized = value.trim().replace(/x$/i, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
