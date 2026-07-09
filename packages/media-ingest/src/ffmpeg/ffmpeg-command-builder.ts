import { Buffer } from 'node:buffer';
import type { MediaIngestOutputTarget, MediaIngestRuntimeConfig, MediaIngestSource, MediaIngestSpawnCommand } from '../types';

const DEFAULT_FFMPEG_PATH = 'ffmpeg';
const DEFAULT_USER_AGENT = 'NativeSFU-Ingest/0.1';

export function buildFfmpegCommand(config: MediaIngestRuntimeConfig): MediaIngestSpawnCommand {
  validateOutputs(config.outputs);

  const executable = config.ffmpegPath?.trim() || DEFAULT_FFMPEG_PATH;
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-nostats',
    '-progress',
    'pipe:2',
    '-fflags',
    '+genpts+discardcorrupt',
    ...(config.extraGlobalArgs ?? []),
    ...buildInputArgs(config.source, config.userAgent ?? DEFAULT_USER_AGENT, config.extraInputArgs ?? [], { includeRealtimeFlags: true })
  ];

  for (const output of sortOutputs(config.outputs)) {
    args.push(...buildOutputArgs(output, config.extraOutputArgs ?? []));
  }

  return {
    executable,
    args
  };
}

export function buildInputArgs(
  source: MediaIngestSource,
  userAgent = DEFAULT_USER_AGENT,
  extraInputArgs: string[] = [],
  options: {
    includeRealtimeFlags?: boolean;
  } = {}
): string[] {
  const args: string[] = [];
  const trimmedUrl = source.url.trim();
  if (!trimmedUrl) {
    throw new Error('Media ingest source URL is required');
  }

  if (options.includeRealtimeFlags && source.type === 'mp4' && isLikelyLocalPath(trimmedUrl)) {
    args.push('-re');
  }

  if (source.type === 'hls' || (source.type === 'mp4' && isHttpUrl(trimmedUrl))) {
    args.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_delay_max',
      '2',
      '-rw_timeout',
      '15000000'
    );
  } else if (source.type === 'rtsp') {
    args.push('-rtsp_transport', 'tcp', '-rw_timeout', '15000000');
  } else if (source.type === 'rtmp') {
    args.push('-rw_timeout', '15000000');
  }

  const headers = buildHeaders(source);
  if (headers) {
    args.push('-headers', headers);
  }
  if (isNetworkUrl(trimmedUrl)) {
    args.push('-user_agent', userAgent);
  }

  args.push(...extraInputArgs, '-i', trimmedUrl);
  return args;
}

function buildOutputArgs(output: MediaIngestOutputTarget, extraOutputArgs: string[]): string[] {
  const args: string[] = ['-map_metadata', '-1', '-dn', '-sn'];

  if (output.kind === 'video') {
    args.push(
      '-map',
      '0:v:0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-profile:v',
      'baseline',
      '-level:v',
      '3.1',
      '-g',
      '48',
      '-keyint_min',
      '48',
      '-sc_threshold',
      '0',
      '-bf',
      '0'
    );
    if (output.bitrateKbps) {
      args.push('-b:v', `${output.bitrateKbps}k`, '-maxrate:v', `${output.bitrateKbps}k`, '-bufsize:v', `${output.bitrateKbps * 2}k`);
    }
  } else {
    args.push(
      '-map',
      '0:a:0',
      '-c:a',
      'libopus',
      '-application',
      'lowdelay',
      '-frame_duration',
      '20',
      '-ar',
      String(output.clockRate ?? 48000),
      '-ac',
      '2'
    );
    if (output.bitrateKbps) {
      args.push('-b:a', `${output.bitrateKbps}k`);
    }
  }

  args.push(
    '-flush_packets',
    '1',
    '-payload_type',
    String(output.payloadType),
    '-ssrc',
    String(output.ssrc),
    '-f',
    'rtp',
    ...extraOutputArgs,
    buildRtpUrl(output)
  );

  return args;
}

function buildRtpUrl(output: MediaIngestOutputTarget): string {
  const host = output.host.includes(':') && !output.host.startsWith('[') ? `[${output.host}]` : output.host;
  const mtu = output.mtu ?? 1200;
  return `rtp://${host}:${output.rtpPort}?rtcpport=${output.rtcpPort}&localrtcpport=0&pkt_size=${mtu}`;
}

function sortOutputs(outputs: MediaIngestOutputTarget[]): MediaIngestOutputTarget[] {
  return [...outputs].sort((left, right) => {
    if (left.kind === right.kind) {
      return left.id.localeCompare(right.id);
    }
    return left.kind === 'video' ? -1 : 1;
  });
}

function validateOutputs(outputs: MediaIngestOutputTarget[]): void {
  if (!outputs.length) {
    throw new Error('At least one ingest output target is required');
  }

  const byKind = new Map<string, number>();
  for (const output of outputs) {
    if (!output.id.trim()) {
      throw new Error('Ingest output target id is required');
    }
    if (!output.host.trim()) {
      throw new Error(`Ingest output target ${output.id} host is required`);
    }
    if (!Number.isInteger(output.rtpPort) || output.rtpPort <= 0) {
      throw new Error(`Ingest output target ${output.id} RTP port must be a positive integer`);
    }
    if (!Number.isInteger(output.rtcpPort) || output.rtcpPort <= 0) {
      throw new Error(`Ingest output target ${output.id} RTCP port must be a positive integer`);
    }
    if (!Number.isInteger(output.payloadType) || output.payloadType < 0 || output.payloadType > 127) {
      throw new Error(`Ingest output target ${output.id} payload type must be between 0 and 127`);
    }
    if (!Number.isInteger(output.ssrc) || output.ssrc < 0 || output.ssrc > 0xffffffff) {
      throw new Error(`Ingest output target ${output.id} SSRC must be a 32-bit unsigned integer`);
    }
    byKind.set(output.kind, (byKind.get(output.kind) ?? 0) + 1);
  }

  for (const [kind, count] of byKind.entries()) {
    if (count > 1) {
      throw new Error(`Phase 3 ingest runtime currently supports at most one ${kind} output target`);
    }
  }
}

function buildHeaders(source: MediaIngestSource): string | undefined {
  const auth = source.auth;
  if (!auth) {
    return undefined;
  }

  const headers = new Map<string, string>();
  if (auth.basicUsername !== undefined || auth.basicPassword !== undefined) {
    if (!auth.basicUsername || !auth.basicPassword) {
      throw new Error('Basic auth requires both username and password');
    }
    headers.set('authorization', `Basic ${Buffer.from(`${auth.basicUsername}:${auth.basicPassword}`).toString('base64')}`);
  }
  if (auth.bearerToken) {
    if (headers.has('authorization')) {
      throw new Error('Bearer auth cannot be combined with basic auth');
    }
    headers.set('authorization', `Bearer ${auth.bearerToken}`);
  }
  for (const header of auth.headers ?? []) {
    const normalizedName = header.name.trim().toLowerCase();
    if (headers.has(normalizedName)) {
      throw new Error(`Duplicate ingest auth header ${header.name}`);
    }
    headers.set(normalizedName, header.value);
  }

  if (!headers.size) {
    return undefined;
  }

  return `${Array.from(headers.entries())
    .map(([name, value]) => `${canonicalHeaderName(name)}: ${value}`)
    .join('\r\n')}\r\n`;
}

function canonicalHeaderName(value: string): string {
  return value
    .split('-')
    .map((part) => (part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
    .join('-');
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function isNetworkUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);
}

function isLikelyLocalPath(value: string): boolean {
  return !isNetworkUrl(value) || value.startsWith('file://');
}
