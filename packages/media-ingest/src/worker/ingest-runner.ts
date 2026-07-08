import { EventEmitter } from 'node:events';
import type { FfmpegProgressSnapshot, MediaIngestExitInfo, MediaIngestRunnerSnapshot, MediaIngestRuntimeConfig, MediaProbeResult } from '../types';
import { buildFfmpegCommand } from '../ffmpeg/ffmpeg-command-builder';
import { FfmpegSession } from '../ffmpeg/ffmpeg-session';
import { FfprobeClient } from '../ffmpeg/ffprobe';
import { IngestProcessHealthTracker } from './process-health';

type MediaIngestRunnerEvents = {
  started: [{ pid?: number }];
  log: [string];
  progress: [FfmpegProgressSnapshot];
  error: [Error];
  exit: [MediaIngestExitInfo];
  probe: [MediaProbeResult];
};

export class MediaIngestRunner extends EventEmitter<MediaIngestRunnerEvents> {
  private session?: FfmpegSession;
  private probeResult?: MediaProbeResult;
  private command?: ReturnType<typeof buildFfmpegCommand>;
  private readonly health: IngestProcessHealthTracker;

  constructor(
    private readonly config: MediaIngestRuntimeConfig,
    private readonly options: {
      probeClient?: FfprobeClient;
      sessionFactory?: (command: ReturnType<typeof buildFfmpegCommand>, config: MediaIngestRuntimeConfig) => FfmpegSession;
      now?: () => number;
    } = {}
  ) {
    super();
    this.health = new IngestProcessHealthTracker({
      staleAfterMs: config.healthTimeoutMs,
      now: options.now
    });
  }

  async start(): Promise<void> {
    const probeClient =
      this.options.probeClient ??
      new FfprobeClient({
        ffprobePath: this.config.ffprobePath,
        userAgent: this.config.userAgent
      });
    this.probeResult = await probeClient.probeSource(this.config.source, this.config.probeTimeoutMs);
    this.emit('probe', this.probeResult);
    validateProbeMatchesOutputs(this.probeResult, this.config);

    this.command = buildFfmpegCommand(this.config);
    this.session =
      this.options.sessionFactory?.(this.command, this.config) ??
      new FfmpegSession({
        command: this.command,
        stopTimeoutMs: this.config.stopTimeoutMs
      });

    this.wireSession(this.session);
    await this.session.start();
  }

  async waitForExit(): Promise<MediaIngestExitInfo> {
    if (!this.session) {
      throw new Error('Media ingest runner has not been started');
    }
    return this.session.waitForExit();
  }

  async stop(): Promise<MediaIngestExitInfo> {
    if (!this.session) {
      throw new Error('Media ingest runner has not been started');
    }
    this.health.setState('stopping');
    return this.session.stop();
  }

  snapshot(): MediaIngestRunnerSnapshot {
    return {
      ingestId: this.config.ingestId,
      command: this.command ? { executable: this.command.executable, args: [...this.command.args] } : undefined,
      probe: this.probeResult ? cloneProbe(this.probeResult) : undefined,
      health: this.health.snapshot()
    };
  }

  private wireSession(session: FfmpegSession): void {
    session.on('started', (started) => {
      this.health.recordStart(started.pid);
      this.emit('started', started);
    });
    session.on('log', (line) => {
      this.health.recordLog();
      this.emit('log', line);
    });
    session.on('progress', (progress) => {
      this.health.recordProgress(progress);
      this.emit('progress', progress);
    });
    session.on('error', (error) => {
      this.health.recordError(error);
      this.emit('error', error);
    });
    session.on('exit', (exit) => {
      this.health.recordExit(exit.code, exit.signal);
      this.emit('exit', exit);
    });
  }
}

function validateProbeMatchesOutputs(probe: MediaProbeResult, config: MediaIngestRuntimeConfig): void {
  for (const output of config.outputs) {
    if (output.kind === 'video' && !probe.hasVideo) {
      throw new Error(`Ingest source ${config.source.url} does not contain a video stream for output ${output.id}`);
    }
    if (output.kind === 'audio' && !probe.hasAudio) {
      throw new Error(`Ingest source ${config.source.url} does not contain an audio stream for output ${output.id}`);
    }
  }
}

function cloneProbe(probe: MediaProbeResult): MediaProbeResult {
  return {
    ...probe,
    streams: probe.streams.map((stream) => ({ ...stream }))
  };
}
