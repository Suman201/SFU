import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { IngestRestartPolicy, IngestSourceType } from '@native-sfu/contracts';

export type MediaIngestTrackKind = 'audio' | 'video';
export type MediaIngestTrackCodec = 'h264' | 'opus';
export type MediaIngestSupervisorState = 'idle' | 'starting' | 'live' | 'restarting' | 'stopping' | 'stopped' | 'failed';

export interface ResolvedIngestHeaderAuth {
  name: string;
  value: string;
}

export interface ResolvedIngestAuthConfig {
  basicUsername?: string;
  basicPassword?: string;
  bearerToken?: string;
  headers?: ResolvedIngestHeaderAuth[];
}

export interface MediaIngestSource {
  type: IngestSourceType;
  url: string;
  auth?: ResolvedIngestAuthConfig;
}

export interface MediaIngestOutputTarget {
  id: string;
  kind: MediaIngestTrackKind;
  codec: MediaIngestTrackCodec;
  host: string;
  rtpPort: number;
  rtcpPort: number;
  payloadType: number;
  ssrc: number;
  clockRate?: number;
  bitrateKbps?: number;
  mtu?: number;
}

export interface MediaIngestRuntimeConfig {
  ingestId: string;
  source: MediaIngestSource;
  outputs: MediaIngestOutputTarget[];
  restartPolicy?: IngestRestartPolicy;
  ffmpegPath?: string;
  ffprobePath?: string;
  userAgent?: string;
  progressIntervalMs?: number;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  extraGlobalArgs?: string[];
  extraInputArgs?: string[];
  extraOutputArgs?: string[];
}

export interface MediaProbeStream {
  index: number;
  kind: MediaIngestTrackKind | 'data' | 'subtitle' | 'unknown';
  codec?: string;
  bitrateBps?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

export interface MediaProbeResult {
  formatName?: string;
  durationSeconds?: number;
  bitrateBps?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  streams: MediaProbeStream[];
  raw: unknown;
}

export interface FfmpegProgressSnapshot {
  frame?: number;
  fps?: number;
  bitrateKbps?: number;
  totalSizeBytes?: number;
  outputTimeUs?: number;
  dupFrames?: number;
  dropFrames?: number;
  speed?: number;
  progress: 'continue' | 'end';
  rawFields: Record<string, string>;
}

export interface MediaIngestSpawnCommand {
  executable: string;
  args: string[];
}

export interface MediaIngestExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface IngestRuntimeMetricsSnapshot {
  starts: number;
  liveTransitions: number;
  restarts: number;
  cleanStops: number;
  failures: number;
  lastStartAt?: string;
  lastLiveAt?: string;
  lastStopAt?: string;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  lastError?: string;
  lastProgressAt?: string;
}

export interface IngestProcessHealthSnapshot {
  state: MediaIngestSupervisorState;
  pid?: number;
  startedAt?: string;
  lastProgressAt?: string;
  lastLogAt?: string;
  lastExitAt?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  lastError?: string;
  healthy: boolean;
  stale: boolean;
  progressCount: number;
  lastProgress?: FfmpegProgressSnapshot;
}

export interface MediaIngestRunnerSnapshot {
  ingestId: string;
  command?: MediaIngestSpawnCommand;
  probe?: MediaProbeResult;
  health: IngestProcessHealthSnapshot;
}

export interface MediaIngestSupervisorSnapshot {
  ingestId: string;
  state: MediaIngestSupervisorState;
  restartCount: number;
  lastError?: string;
  probe?: MediaProbeResult;
  runner?: MediaIngestRunnerSnapshot;
  metrics: IngestRuntimeMetricsSnapshot;
}

export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
