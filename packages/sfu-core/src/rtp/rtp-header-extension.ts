import type { RtpHeaderExtensionParameters } from '@native-sfu/contracts';
import { RtpPacket, type RtpHeaderExtension } from './rtp-packet';

export const RTP_ONE_BYTE_EXTENSION_PROFILE = 0xbede;
export const RTP_TWO_BYTE_EXTENSION_PROFILE = 0x1000;

export const RTP_HEADER_EXTENSION_URIS = {
  mid: 'urn:ietf:params:rtp-hdrext:sdes:mid',
  rid: 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
  rrid: 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id',
  audioLevel: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  absoluteSendTime: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  twcc: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
} as const;

export type RtpHeaderExtensionKind = keyof typeof RTP_HEADER_EXTENSION_URIS;

export interface RtpAudioLevelExtension {
  voiceActivity: boolean;
  level: number;
}

export type RtpHeaderExtensionValue = string | number | RtpAudioLevelExtension;

export interface RtpHeaderExtensionElement {
  id: number;
  data: Buffer;
}

export interface ParsedRtpHeaderExtension {
  id: number;
  uri: string;
  kind: RtpHeaderExtensionKind;
  value: RtpHeaderExtensionValue;
  rawValue: Buffer;
}

export interface HeaderExtensionRewritePlanEntry {
  kind: RtpHeaderExtensionKind;
  uri: string;
  targetId: number;
  sourceId?: number;
}

export interface HeaderExtensionRewriteValues {
  mid?: string;
  rid?: string;
  rrid?: string;
  audioLevel?: RtpAudioLevelExtension;
  absoluteSendTime?: number;
  twccSequenceNumber?: number;
}

export interface RtpHeaderExtensionSet {
  headerExtensions?: RtpHeaderExtensionParameters[];
}

export class RtpHeaderExtensionRegistry {
  private readonly uriToKind = new Map<string, RtpHeaderExtensionKind>();
  private readonly kindToUri = new Map<RtpHeaderExtensionKind, string>();

  constructor(entries: Record<RtpHeaderExtensionKind, string> = RTP_HEADER_EXTENSION_URIS) {
    for (const [kind, uri] of Object.entries(entries) as Array<[RtpHeaderExtensionKind, string]>) {
      this.register(kind, uri);
    }
  }

  register(kind: RtpHeaderExtensionKind, uri: string): void {
    this.uriToKind.set(normalizeHeaderExtensionUri(uri), kind);
    this.kindToUri.set(kind, uri);
  }

  kindForUri(uri: string): RtpHeaderExtensionKind | undefined {
    return this.uriToKind.get(normalizeHeaderExtensionUri(uri));
  }

  uriForKind(kind: RtpHeaderExtensionKind): string | undefined {
    return this.kindToUri.get(kind);
  }
}

export const DEFAULT_RTP_HEADER_EXTENSION_REGISTRY = new RtpHeaderExtensionRegistry();

export function parseRtpHeaderExtensionElements(headerExtension: RtpHeaderExtension | null): RtpHeaderExtensionElement[] {
  if (!headerExtension) {
    return [];
  }
  if (headerExtension.profile === RTP_ONE_BYTE_EXTENSION_PROFILE) {
    return parseOneByteHeaderExtensionElements(headerExtension.value);
  }
  if ((headerExtension.profile & 0xfff0) === RTP_TWO_BYTE_EXTENSION_PROFILE) {
    return parseTwoByteHeaderExtensionElements(headerExtension.value);
  }
  return [];
}

export function serializeRtpHeaderExtensionElements(elements: RtpHeaderExtensionElement[]): RtpHeaderExtension | null {
  const filtered = elements.filter((element) => element.id > 0 && element.data.length > 0);
  if (filtered.length === 0) {
    return null;
  }
  const canUseOneByte = filtered.every((element) => element.id <= 14 && element.data.length <= 16);
  return canUseOneByte ? serializeOneByteHeaderExtensionElements(filtered) : serializeTwoByteHeaderExtensionElements(filtered);
}

export function parseRtpHeaderExtensions(
  packet: RtpPacket,
  parameters: RtpHeaderExtensionSet,
  registry = DEFAULT_RTP_HEADER_EXTENSION_REGISTRY
): ParsedRtpHeaderExtension[] {
  const knownById = new Map<number, { uri: string; kind: RtpHeaderExtensionKind }>();
  for (const extension of parameters.headerExtensions ?? []) {
    const kind = registry.kindForUri(extension.uri);
    if (kind) {
      knownById.set(extension.id, { uri: extension.uri, kind });
    }
  }
  const parsed: ParsedRtpHeaderExtension[] = [];
  for (const element of parseRtpHeaderExtensionElements(packet.headerExtension)) {
    const known = knownById.get(element.id);
    if (!known) {
      continue;
    }
    parsed.push({
      id: element.id,
      uri: known.uri,
      kind: known.kind,
      value: decodeHeaderExtensionValue(known.kind, element.data),
      rawValue: Buffer.from(element.data)
    });
  }
  return parsed;
}

export function parsedHeaderExtensionsToObject(extensions: ParsedRtpHeaderExtension[]): Partial<Record<RtpHeaderExtensionKind, RtpHeaderExtensionValue>> {
  const values: Partial<Record<RtpHeaderExtensionKind, RtpHeaderExtensionValue>> = {};
  for (const extension of extensions) {
    values[extension.kind] = extension.value;
  }
  return values;
}

export function negotiateRtpHeaderExtensions(
  source: RtpHeaderExtensionSet,
  target: RtpHeaderExtensionSet,
  registry = DEFAULT_RTP_HEADER_EXTENSION_REGISTRY
): HeaderExtensionRewritePlanEntry[] {
  const sourceByKind = headerExtensionsByKind(source.headerExtensions ?? [], registry);
  const targetByKind = headerExtensionsByKind(target.headerExtensions ?? [], registry);
  const plan: HeaderExtensionRewritePlanEntry[] = [];
  for (const [kind, targetExtension] of targetByKind) {
    const sourceExtension = sourceByKind.get(kind);
    if (!sourceExtension && kind !== 'twcc' && kind !== 'absoluteSendTime') {
      continue;
    }
    plan.push({
      kind,
      uri: targetExtension.uri,
      targetId: targetExtension.id,
      sourceId: sourceExtension?.id
    });
  }
  return plan;
}

export function rewriteRtpHeaderExtensions(
  packet: RtpPacket,
  plan: HeaderExtensionRewritePlanEntry[],
  values: HeaderExtensionRewriteValues = {}
): RtpHeaderExtension | null {
  const sourceElements = new Map<number, Buffer>();
  for (const element of parseRtpHeaderExtensionElements(packet.headerExtension)) {
    sourceElements.set(element.id, element.data);
  }
  const targetElements = new Map<number, RtpHeaderExtensionElement>();
  for (const entry of plan) {
    const override = valueForKind(entry.kind, values);
    const sourceValue = entry.sourceId === undefined ? undefined : sourceElements.get(entry.sourceId);
    const data = override === undefined ? sourceValue : encodeHeaderExtensionValue(entry.kind, override);
    if (!data || data.length === 0) {
      continue;
    }
    targetElements.set(entry.targetId, { id: entry.targetId, data });
  }
  return serializeRtpHeaderExtensionElements([...targetElements.values()].sort((left, right) => left.id - right.id));
}

export function cloneRtpPacketWithHeaderExtension(packet: RtpPacket, headerExtension: RtpHeaderExtension | null): RtpPacket {
  return new RtpPacket(
    packet.version,
    packet.padding,
    Boolean(headerExtension),
    packet.marker,
    packet.payloadType,
    packet.sequenceNumber,
    packet.timestamp,
    packet.ssrc,
    [...packet.csrc],
    headerExtension,
    Buffer.from(packet.payload)
  );
}

export function getRtpHeaderExtensionId(
  parameters: RtpHeaderExtensionSet,
  kind: RtpHeaderExtensionKind,
  registry = DEFAULT_RTP_HEADER_EXTENSION_REGISTRY
): number | undefined {
  return headerExtensionsByKind(parameters.headerExtensions ?? [], registry).get(kind)?.id;
}

export function absoluteSendTime24(nowMs = Date.now()): number {
  return Math.floor(((nowMs % 64_000) / 1000) * 0x40000) & 0xffffff;
}

export function encodeHeaderExtensionValue(kind: RtpHeaderExtensionKind, value: RtpHeaderExtensionValue): Buffer {
  switch (kind) {
    case 'mid':
    case 'rid':
    case 'rrid':
      return Buffer.from(String(value), 'utf8');
    case 'audioLevel': {
      if (typeof value !== 'object') {
        throw new Error('Audio level extension value must be an object');
      }
      const level = Math.max(0, Math.min(127, Math.round(value.level)));
      return Buffer.from([(value.voiceActivity ? 0x80 : 0) | level]);
    }
    case 'absoluteSendTime': {
      const buffer = Buffer.alloc(3);
      buffer.writeUIntBE(Number(value) & 0xffffff, 0, 3);
      return buffer;
    }
    case 'twcc': {
      const buffer = Buffer.alloc(2);
      buffer.writeUInt16BE(Number(value) & 0xffff, 0);
      return buffer;
    }
  }
}

export function decodeHeaderExtensionValue(kind: RtpHeaderExtensionKind, data: Buffer): RtpHeaderExtensionValue {
  switch (kind) {
    case 'mid':
    case 'rid':
    case 'rrid':
      return data.toString('utf8');
    case 'audioLevel':
      return {
        voiceActivity: Boolean((data[0] ?? 0) & 0x80),
        level: (data[0] ?? 0) & 0x7f
      };
    case 'absoluteSendTime':
      if (data.length < 3) {
        throw new Error('Absolute Send Time RTP extension must be 3 bytes');
      }
      return data.readUIntBE(0, 3);
    case 'twcc':
      if (data.length < 2) {
        throw new Error('TWCC RTP extension must be 2 bytes');
      }
      return data.readUInt16BE(0);
  }
}

function parseOneByteHeaderExtensionElements(value: Buffer): RtpHeaderExtensionElement[] {
  const elements: RtpHeaderExtensionElement[] = [];
  let offset = 0;
  while (offset < value.length) {
    const header = value[offset++]!;
    if (header === 0) {
      continue;
    }
    const id = header >> 4;
    if (id === 15) {
      break;
    }
    const length = (header & 0x0f) + 1;
    if (offset + length > value.length) {
      throw new Error('Truncated RTP one-byte header extension element');
    }
    elements.push({ id, data: value.subarray(offset, offset + length) });
    offset += length;
  }
  return elements;
}

function parseTwoByteHeaderExtensionElements(value: Buffer): RtpHeaderExtensionElement[] {
  const elements: RtpHeaderExtensionElement[] = [];
  let offset = 0;
  while (offset + 1 < value.length) {
    const id = value[offset++]!;
    if (id === 0) {
      continue;
    }
    const length = value[offset++]!;
    if (offset + length > value.length) {
      throw new Error('Truncated RTP two-byte header extension element');
    }
    if (length > 0) {
      elements.push({ id, data: value.subarray(offset, offset + length) });
    }
    offset += length;
  }
  return elements;
}

function serializeOneByteHeaderExtensionElements(elements: RtpHeaderExtensionElement[]): RtpHeaderExtension {
  const parts: Buffer[] = [];
  for (const element of elements) {
    parts.push(Buffer.from([(element.id << 4) | ((element.data.length - 1) & 0x0f)]), Buffer.from(element.data));
  }
  return { profile: RTP_ONE_BYTE_EXTENSION_PROFILE, value: padToWordBoundary(Buffer.concat(parts)) };
}

function serializeTwoByteHeaderExtensionElements(elements: RtpHeaderExtensionElement[]): RtpHeaderExtension {
  const parts: Buffer[] = [];
  for (const element of elements) {
    if (element.data.length > 255) {
      throw new Error('RTP two-byte header extension element exceeds 255 bytes');
    }
    parts.push(Buffer.from([element.id, element.data.length]), Buffer.from(element.data));
  }
  return { profile: RTP_TWO_BYTE_EXTENSION_PROFILE, value: padToWordBoundary(Buffer.concat(parts)) };
}

function headerExtensionsByKind(
  extensions: RtpHeaderExtensionParameters[],
  registry: RtpHeaderExtensionRegistry
): Map<RtpHeaderExtensionKind, RtpHeaderExtensionParameters> {
  const result = new Map<RtpHeaderExtensionKind, RtpHeaderExtensionParameters>();
  for (const extension of extensions) {
    const kind = registry.kindForUri(extension.uri);
    if (!kind || extension.direction === 'inactive') {
      continue;
    }
    if (extension.id < 1 || extension.id > 255) {
      continue;
    }
    result.set(kind, extension);
  }
  return result;
}

function valueForKind(kind: RtpHeaderExtensionKind, values: HeaderExtensionRewriteValues): RtpHeaderExtensionValue | undefined {
  switch (kind) {
    case 'mid':
      return values.mid;
    case 'rid':
      return values.rid;
    case 'rrid':
      return values.rrid;
    case 'audioLevel':
      return values.audioLevel;
    case 'absoluteSendTime':
      return values.absoluteSendTime;
    case 'twcc':
      return values.twccSequenceNumber;
  }
}

function normalizeHeaderExtensionUri(uri: string): string {
  return uri.trim().toLowerCase();
}

function padToWordBoundary(value: Buffer): Buffer {
  const padding = (4 - (value.length % 4)) % 4;
  if (padding === 0) {
    return value;
  }
  return Buffer.concat([value, Buffer.alloc(padding)]);
}
