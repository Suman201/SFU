import type { DtlsParameters, IceCandidate, IceParameters, ProducerKind, RtpHeaderExtensionDirection, RtpParameters, TransportOptions } from '@native-sfu/contracts';

export type SdpDirection = 'sendonly' | 'recvonly' | 'sendrecv' | 'inactive';

export interface UnifiedPlanAnswerOptions {
  transport: TransportOptions;
  offer: string;
  direction: SdpDirection;
  mediaKind?: 'audio' | 'video' | 'application';
  rtpParameters?: RtpParameters;
}

interface RidInfo {
  rid: string;
  paused: boolean;
  maxBitrate?: number;
  scaleResolutionDownBy?: number;
}

export function parseSdpIceParameters(sdp: string, mediaKind?: 'audio' | 'video' | 'application'): IceParameters {
  const lines = scopedLines(sdp, mediaKind);
  const usernameFragment = findLineValue(lines, 'a=ice-ufrag:');
  const password = findLineValue(lines, 'a=ice-pwd:');
  if (!usernameFragment || !password) {
    throw new Error('SDP does not include ICE credentials');
  }
  return { usernameFragment, password, iceLite: false };
}

export function parseSdpDtlsParameters(sdp: string, mediaKind?: 'audio' | 'video' | 'application'): DtlsParameters {
  const lines = scopedLines(sdp, mediaKind);
  const fingerprints = lines
    .filter((line) => line.startsWith('a=fingerprint:'))
    .map((line) => line.slice('a=fingerprint:'.length).trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      algorithm: parts[0] as 'sha-256' | 'sha-384' | 'sha-512',
      value: parts.slice(1).join(' ')
    }));
  if (!fingerprints.length) {
    throw new Error('SDP does not include DTLS fingerprints');
  }
  return { role: 'client', fingerprints };
}

export function parseSdpCandidates(sdp: string, mediaKind?: 'audio' | 'video' | 'application'): IceCandidate[] {
  return scopedLines(sdp, mediaKind)
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.slice('a=candidate:'.length).trim().split(/\s+/))
    .filter((parts) => parts.length >= 8 && parts.some((part) => part.toLowerCase() === 'typ'))
    .map((parts) => ({
      foundation: parts[0] ?? '0',
      component: Number(parts[1] ?? 1) as 1 | 2,
      protocol: (parts[2]?.toLowerCase() ?? 'udp') as 'udp' | 'tcp',
      priority: Number(parts[3] ?? 0),
      ip: parts[4] ?? '0.0.0.0',
      port: Number(parts[5] ?? 0),
      type: (relatedValue(parts, 'typ') ?? 'host') as 'host' | 'srflx' | 'prflx' | 'relay',
      relatedAddress: relatedValue(parts, 'raddr'),
      relatedPort: numberValue(relatedValue(parts, 'rport')),
      tcpType: relatedValue(parts, 'tcptype') as IceCandidate['tcpType']
    }));
}

export function parseSdpRtpParameters(kind: ProducerKind, sdp: string): RtpParameters {
  const mediaKind = kind === 'audio' ? 'audio' : 'video';
  const section = mediaSection(sdp, mediaKind);
  const mLine = section.find((line) => line.startsWith('m=')) ?? '';
  const payloadTypes = mLine.split(/\s+/).slice(3).map(Number).filter(Number.isFinite);
  const codecPayloadType = selectPrimaryPayloadType(section, payloadTypes, mediaKind);
  const rtpmap = section.find((line) => line.startsWith(`a=rtpmap:${codecPayloadType} `));
  if (!rtpmap) {
    throw new Error('SDP media section does not include an RTP codec mapping');
  }
  const codecParts = rtpmap.split(/\s+/)[1]?.split('/') ?? [];
  const codecs = [
    {
      mimeType: `${mediaKind}/${codecParts[0] ?? (mediaKind === 'audio' ? 'opus' : 'VP8')}`,
      payloadType: codecPayloadType,
      clockRate: Number(codecParts[1] ?? (mediaKind === 'audio' ? 48000 : 90000)),
      channels: codecParts[2] ? Number(codecParts[2]) : undefined,
      parameters: fmtpParameters(section, codecPayloadType),
      rtcpFeedback: section
        .filter((line) => line.startsWith(`a=rtcp-fb:${codecPayloadType}`))
        .map((line) => line.split(/\s+/).slice(1).join(' '))
    },
    ...rtxPayloadTypesForApt(section, codecPayloadType).map((payloadType) => ({
      mimeType: `${mediaKind}/rtx`,
      payloadType,
      clockRate: Number(section.find((line) => line.startsWith(`a=rtpmap:${payloadType} `))?.split(/\s+/)[1]?.split('/')[1] ?? 90000),
      parameters: fmtpParameters(section, payloadType),
      rtcpFeedback: []
    }))
  ];
  const fidGroups = fidGroupsFromSection(section);
  const primarySsrcs = primarySsrcsFromSection(section);
  const ridInfos = mediaKind === 'audio' ? [] : ridInfosFromSection(section);
  if (primarySsrcs.length === 0 && ridInfos.length === 0) {
    throw new Error('SDP media section does not include a primary SSRC');
  }
  const cnameSsrc = primarySsrcs[0];
  const cname = cnameSsrc ? section.find((line) => line.startsWith(`a=ssrc:${cnameSsrc} cname:`))?.split('cname:')[1] ?? randomId() : randomId();
  const encodingCount = Math.max(primarySsrcs.length, ridInfos.length);
  return {
    codecs,
    headerExtensions: headerExtensionsFromSection(section),
    encodings: Array.from({ length: encodingCount }).map((_, index) => {
      const ssrc = primarySsrcs[index];
      const ridInfo = ridInfos[index];
      const rtxSsrc = ssrc === undefined ? undefined : fidGroups.get(ssrc);
      const rtxPayloadType = rtxPayloadTypesForApt(section, codecPayloadType)[0];
      return {
        ssrc,
        rid: mediaKind === 'audio' ? undefined : ridInfo?.rid ?? ridAt(section, index),
        spatialLayer: mediaKind === 'audio' ? undefined : spatialLayerFromRid(ridInfo?.rid, index),
        maxBitrate: ridInfo?.maxBitrate,
        scaleResolutionDownBy: ridInfo?.scaleResolutionDownBy,
        rtx: rtxSsrc !== undefined ? { ssrc: rtxSsrc, payloadType: rtxPayloadType } : undefined
      };
    }),
    simulcast:
      mediaKind === 'video' && ridInfos.length > 1
        ? {
            direction: 'send',
            rids: ridInfos.map((rid) => rid.rid),
            pausedRids: ridInfos.filter((rid) => rid.paused).map((rid) => rid.rid)
          }
        : undefined,
    rtcp: { cname, reducedSize: section.includes('a=rtcp-rsize') || section.includes('a=rtcp-mux') }
  };
}

export function buildUnifiedPlanAnswer(options: UnifiedPlanAnswerOptions): string {
  const sections = mediaSections(options.offer);
  const targetKind = options.mediaKind ?? mediaKindFromRtpParameters(options.rtpParameters);
  const targetIndex = sections.findIndex((section) => !targetKind || mediaTypeFromSection(section) === targetKind);
  if (targetIndex < 0) {
    throw new Error('SDP offer does not include a compatible media section');
  }
  const candidate = options.transport.iceCandidates.find((item) => item.ip === '127.0.0.1') ?? options.transport.iceCandidates[0];
  if (!candidate) {
    throw new Error('Transport does not include ICE candidates');
  }
  const mediaAnswers: string[][] = [];
  const activeMids: string[] = [];
  sections.forEach((section, index) => {
    const mid = findLineValue(section, 'a=mid:') ?? String(index);
    const mLine = section.find((line) => line.startsWith('m=')) ?? '';
    const mParts = mLine.split(/\s+/);
    const mediaType = mParts[0]?.slice(2) ?? 'video';
    const protocol = mParts[2] ?? 'UDP/TLS/RTP/SAVPF';
    const payloadTypes = mParts.slice(3).join(' ');
    if (index !== targetIndex) {
      mediaAnswers.push([
        `m=${mediaType} 0 ${protocol} ${payloadTypes}`.trimEnd(),
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=inactive',
        ...(section.includes('a=rtcp-mux') ? ['a=rtcp-mux'] : [])
      ]);
      return;
    }
    activeMids.push(mid);
    const codecLines = section.filter((line) => /^(a=rtpmap:|a=rtcp-fb:|a=fmtp:|a=extmap:|a=extmap-allow-mixed)/.test(line));
    const activeLines = [
      `m=${mediaType} 9 UDP/TLS/RTP/SAVPF ${payloadTypes}`.trimEnd(),
      'c=IN IP4 0.0.0.0',
      `a=mid:${mid}`,
      `a=ice-ufrag:${options.transport.iceParameters.usernameFragment}`,
      `a=ice-pwd:${options.transport.iceParameters.password}`,
      'a=ice-options:trickle',
      ...options.transport.dtlsParameters.fingerprints.map((fingerprint) => `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`),
      'a=setup:passive',
      `a=${options.direction}`,
      'a=rtcp-mux',
      'a=rtcp-rsize',
      ...codecLines,
      ...simulcastAnswerLines(section, options.direction, options.rtpParameters),
      candidateLine(candidate),
      'a=end-of-candidates'
    ];
    if (options.direction === 'sendonly' && options.rtpParameters) {
      for (const encoding of options.rtpParameters.encodings) {
        if (encoding.ssrc === undefined) {
          continue;
        }
        if (encoding.rtx?.ssrc !== undefined) {
          activeLines.push(`a=ssrc-group:FID ${encoding.ssrc} ${encoding.rtx.ssrc}`);
        }
        activeLines.push(`a=ssrc:${encoding.ssrc} cname:${options.rtpParameters.rtcp.cname}`);
        activeLines.push(`a=ssrc:${encoding.ssrc} msid:sfu-stream sfu-track`);
        if (encoding.rtx?.ssrc !== undefined) {
          activeLines.push(`a=ssrc:${encoding.rtx.ssrc} cname:${options.rtpParameters.rtcp.cname}`);
          activeLines.push(`a=ssrc:${encoding.rtx.ssrc} msid:sfu-stream sfu-track`);
        }
      }
    }
    mediaAnswers.push(activeLines);
  });
  const lines = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${activeMids.join(' ')}`,
    'a=msid-semantic: WMS *',
    ...mediaAnswers.flat()
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function scopedLines(sdp: string, mediaKind?: 'audio' | 'video' | 'application'): string[] {
  const session = sessionLines(sdp);
  return mediaKind ? [...session, ...mediaSection(sdp, mediaKind)] : [...session, ...mediaSection(sdp)];
}

function sessionLines(sdp: string): string[] {
  return sdp.split(/\r?\n(?=m=)/)[0]?.split(/\r?\n/).filter(Boolean) ?? [];
}

function mediaSection(sdp: string, mediaKind?: 'audio' | 'video' | 'application'): string[] {
  const sections = mediaSections(sdp);
  const section = mediaKind ? sections.find((item) => item[0]?.startsWith(`m=${mediaKind} `)) : sections.find((item) => /^m=(audio|video|application)\s/.test(item[0] ?? ''));
  if (!section) {
    throw new Error('SDP does not include a compatible media section');
  }
  return section;
}

function mediaSections(sdp: string): string[][] {
  return sdp
    .split(/\r?\n(?=m=)/)
    .slice(1)
    .map((section) => section.split(/\r?\n/).filter(Boolean))
    .filter((section) => /^m=(audio|video|application)\s/.test(section[0] ?? ''));
}

function findLineValue(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

function selectPrimaryPayloadType(section: string[], payloadTypes: number[], mediaKind: 'audio' | 'video'): number {
  const rtxPayloads = new Set(
    section
      .filter((line) => /a=rtpmap:\d+\s+rtx\//i.test(line))
      .map((line) => Number(line.match(/^a=rtpmap:(\d+)/)?.[1]))
      .filter(Number.isFinite)
  );
  const preferred = mediaKind === 'audio' ? /opus/i : /^(VP8|VP9|H264|AV1)\//i;
  return (
    payloadTypes.find((payloadType) => !rtxPayloads.has(payloadType) && preferred.test(section.find((line) => line.startsWith(`a=rtpmap:${payloadType} `))?.split(/\s+/)[1] ?? '')) ??
    payloadTypes.find((payloadType) => !rtxPayloads.has(payloadType)) ??
    payloadTypes[0] ??
    (mediaKind === 'audio' ? 111 : 96)
  );
}

function primarySsrcsFromSection(section: string[]): number[] {
  const fidGroups = [...fidGroupsFromSection(section).keys()];
  if (fidGroups.length > 0) {
    return [...new Set(fidGroups)];
  }
  return [
    ...new Set(
      section
        .filter((line) => line.startsWith('a=ssrc:'))
        .map((line) => Number(line.match(/^a=ssrc:(\d+)/)?.[1]))
        .filter(Number.isFinite)
    )
  ];
}

function fidGroupsFromSection(section: string[]): Map<number, number> {
  const groups = new Map<number, number>();
  for (const line of section.filter((item) => item.startsWith('a=ssrc-group:FID '))) {
    const [, primary, rtx] = line.split(/\s+/).map((part, index) => (index === 0 ? part : Number(part)));
    if (typeof primary === 'number' && Number.isFinite(primary) && typeof rtx === 'number' && Number.isFinite(rtx)) {
      groups.set(primary, rtx);
    }
  }
  return groups;
}

function rtxPayloadTypesForApt(section: string[], apt: number): number[] {
  return section
    .filter((line) => /a=rtpmap:\d+\s+rtx\//i.test(line))
    .map((line) => Number(line.match(/^a=rtpmap:(\d+)/)?.[1]))
    .filter(Number.isFinite)
    .filter((payloadType) => Number(fmtpParameters(section, payloadType).apt) === apt);
}

function fmtpParameters(section: string[], payloadType: number): Record<string, string | number | boolean> {
  const fmtp = section.find((line) => line.startsWith(`a=fmtp:${payloadType} `));
  if (!fmtp) {
    return {};
  }
  const parameters: Record<string, string | number | boolean> = {};
  for (const part of fmtp.slice(`a=fmtp:${payloadType} `.length).split(';')) {
    const [rawKey, rawValue] = part.trim().split('=');
    if (!rawKey) {
      continue;
    }
    if (rawValue === undefined) {
      parameters[rawKey] = true;
      continue;
    }
    const numeric = Number(rawValue);
    parameters[rawKey] = Number.isFinite(numeric) && rawValue.trim() !== '' ? numeric : rawValue;
  }
  return parameters;
}

function headerExtensionsFromSection(section: string[]): RtpParameters['headerExtensions'] {
  const extensions: NonNullable<RtpParameters['headerExtensions']> = [];
  for (const line of section.filter((item) => item.startsWith('a=extmap:'))) {
    const match = line.match(/^a=extmap:(\d+)(?:\/(sendrecv|sendonly|recvonly|inactive))?\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }
    const [, rawId, direction, uri, rawParameters] = match;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1 || id > 255 || !uri) {
      continue;
    }
    extensions.push({
      id,
      uri,
      direction: direction as RtpHeaderExtensionDirection | undefined,
      parameters: rawParameters ? { value: rawParameters } : undefined
    });
  }
  return extensions;
}

function ridAt(section: string[], index: number): 'low' | 'medium' | 'high' | undefined {
  const rid = section
    .filter((line) => line.startsWith('a=rid:'))
    .map((line) => line.match(/^a=rid:([^\s]+)/)?.[1])
    .filter(Boolean)[index];
  return rid === 'low' || rid === 'medium' || rid === 'high' ? rid : undefined;
}

function ridInfosFromSection(section: string[]): RidInfo[] {
  const ridLines = new Map<string, RidInfo>();
  for (const line of section.filter((item) => item.startsWith('a=rid:'))) {
    const match = line.match(/^a=rid:([^\s]+)\s+(send|recv|sendrecv)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }
    const [, rid, direction, rawParameters] = match;
    if (!rid || direction === 'recv') {
      continue;
    }
    ridLines.set(rid, {
      rid,
      paused: false,
      ...ridParameters(rawParameters)
    });
  }
  const simulcast = section.find((line) => line.startsWith('a=simulcast:'));
  const orderedRids = simulcast ? ridsFromSimulcastLine(simulcast, 'send') : [];
  if (orderedRids.length === 0) {
    return [...ridLines.values()];
  }
  return orderedRids.map(({ rid, paused }) => ({ ...(ridLines.get(rid) ?? { rid }), paused })).filter((item) => Boolean(item.rid));
}

function ridsFromSimulcastLine(line: string, direction: 'send' | 'recv'): Array<{ rid: string; paused: boolean }> {
  const parts = line.slice('a=simulcast:'.length).trim().split(/\s+/);
  const directionIndex = parts.findIndex((part) => part === direction);
  if (directionIndex < 0 || !parts[directionIndex + 1]) {
    return [];
  }
  return parts[directionIndex + 1]!
    .split(';')
    .map((layer) => layer.split(',')[0]?.trim())
    .filter((rid): rid is string => Boolean(rid))
    .map((rawRid) => ({ rid: rawRid.replace(/^~/, ''), paused: rawRid.startsWith('~') }));
}

function ridParameters(rawParameters: string | undefined): Partial<RidInfo> {
  if (!rawParameters) {
    return {};
  }
  const parameters = rawParameters.split(/[;\s]+/).filter(Boolean);
  const maxBitrate = numberParameter(parameters, 'max-br');
  const maxWidth = numberParameter(parameters, 'max-width');
  const scaleResolutionDownBy = maxWidth && maxWidth > 0 ? Math.max(1, Math.round(1920 / maxWidth)) : undefined;
  return { maxBitrate, scaleResolutionDownBy };
}

function numberParameter(parameters: string[], key: string): number | undefined {
  const value = parameters.find((parameter) => parameter.startsWith(`${key}=`))?.split('=')[1];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function spatialLayerFromRid(rid: string | undefined, fallbackIndex: number): number {
  switch (rid) {
    case 'low':
    case 'q':
      return 0;
    case 'medium':
    case 'mid':
    case 'm':
      return 1;
    case 'high':
    case 'h':
    case 'f':
      return 2;
    default:
      return fallbackIndex;
  }
}

function simulcastAnswerLines(section: string[], direction: SdpDirection, rtpParameters: RtpParameters | undefined): string[] {
  const mediaType = mediaTypeFromSection(section);
  if (mediaType !== 'video') {
    return [];
  }
  const offeredRids = ridInfosFromSection(section).map((rid) => rid.rid);
  const rids = rtpParameters?.simulcast?.rids.length ? rtpParameters.simulcast.rids : offeredRids;
  if (rids.length <= 1) {
    return [];
  }
  const ridDirection = direction === 'sendonly' ? 'send' : direction === 'recvonly' ? 'recv' : direction === 'sendrecv' ? 'sendrecv' : undefined;
  if (!ridDirection) {
    return [];
  }
  const simulcastDirection = direction === 'sendonly' ? 'send' : direction === 'recvonly' ? 'recv' : 'send';
  return [...rids.map((rid) => `a=rid:${rid} ${ridDirection}`), `a=simulcast:${simulcastDirection} ${rids.join(';')}`];
}

function relatedValue(parts: string[], key: string): string | undefined {
  const index = parts.findIndex((part) => part.toLowerCase() === key);
  return index >= 0 ? parts[index + 1] : undefined;
}

function numberValue(value: string | undefined): number | undefined {
  return value ? Number(value) : undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2);
}

function mediaKindFromRtpParameters(rtpParameters: RtpParameters | undefined): 'audio' | 'video' | undefined {
  const mimeType = rtpParameters?.codecs[0]?.mimeType.toLowerCase();
  if (mimeType?.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType?.startsWith('video/')) {
    return 'video';
  }
  return undefined;
}

function mediaTypeFromSection(section: string[]): 'audio' | 'video' | 'application' | undefined {
  const type = section.find((line) => line.startsWith('m='))?.split(/\s+/)[0]?.slice(2);
  return type === 'audio' || type === 'video' || type === 'application' ? type : undefined;
}

function candidateLine(candidate: IceCandidate): string {
  const parts = [
    `a=candidate:${candidate.foundation}`,
    String(candidate.component),
    candidate.protocol.toUpperCase(),
    String(candidate.priority),
    candidate.ip,
    String(candidate.port),
    'typ',
    candidate.type
  ];
  if (candidate.relatedAddress && candidate.relatedPort) {
    parts.push('raddr', candidate.relatedAddress, 'rport', String(candidate.relatedPort));
  }
  if (candidate.tcpType) {
    parts.push('tcptype', candidate.tcpType);
  }
  return parts.join(' ');
}
