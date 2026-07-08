import { spawn } from 'node:child_process';
import type { MediaIngestSource, MediaProbeResult, MediaProbeStream, SpawnProcess } from '../types';
import { buildInputArgs } from './ffmpeg-command-builder';

const DEFAULT_FFPROBE_PATH = 'ffprobe';
const DEFAULT_TIMEOUT_MS = 8_000;

interface FfprobeJsonStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  bit_rate?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeJsonResult {
  streams?: FfprobeJsonStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

export class FfprobeClient {
  constructor(
    private readonly options: {
      ffprobePath?: string;
      userAgent?: string;
      spawnProcess?: SpawnProcess;
    } = {}
  ) {}

  async probeSource(source: MediaIngestSource, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MediaProbeResult> {
    const executable = this.options.ffprobePath?.trim() || DEFAULT_FFPROBE_PATH;
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,bit_rate,width,height,sample_rate,channels',
      '-of',
      'json',
      ...buildInputArgs(source, this.options.userAgent, [], { includeRealtimeFlags: false })
    ];
    const child = (this.options.spawnProcess ?? spawn)(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    return await new Promise<MediaProbeResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`ffprobe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const message = Buffer.concat(stderr).toString('utf8').trim() || `ffprobe exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`;
          reject(new Error(message));
          return;
        }
        try {
          resolve(parseFfprobeJson(Buffer.concat(stdout).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export function parseFfprobeJson(payload: string): MediaProbeResult {
  const parsed = JSON.parse(payload) as FfprobeJsonResult;
  const streams = (parsed.streams ?? []).map(toProbeStream);
  return {
    formatName: parsed.format?.format_name,
    durationSeconds: toNumber(parsed.format?.duration),
    bitrateBps: toInteger(parsed.format?.bit_rate),
    hasAudio: streams.some((stream) => stream.kind === 'audio'),
    hasVideo: streams.some((stream) => stream.kind === 'video'),
    streams,
    raw: parsed
  };
}

function toProbeStream(stream: FfprobeJsonStream): MediaProbeStream {
  return {
    index: stream.index ?? 0,
    kind: normalizeCodecType(stream.codec_type),
    codec: stream.codec_name,
    bitrateBps: toInteger(stream.bit_rate),
    width: stream.width,
    height: stream.height,
    sampleRate: toInteger(stream.sample_rate),
    channels: stream.channels
  };
}

function normalizeCodecType(value?: string): MediaProbeStream['kind'] {
  if (value === 'audio' || value === 'video' || value === 'data' || value === 'subtitle') {
    return value;
  }
  return 'unknown';
}

function toInteger(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
