import type { RtpCodecParameters } from '@native-sfu/contracts';
import { RtpPacket } from '../rtp/rtp-packet';

export type RtpCodecName = 'VP8' | 'H264' | 'VP9';

export interface KeyframeDetectionResult {
  codec: RtpCodecName;
  keyframe: boolean;
}

export function detectKeyframe(packet: RtpPacket, codec: Pick<RtpCodecParameters, 'mimeType'> | string): KeyframeDetectionResult | null {
  const codecName = codecNameFromMime(typeof codec === 'string' ? codec : codec.mimeType);
  if (!codecName) {
    return null;
  }
  switch (codecName) {
    case 'VP8':
      return { codec: codecName, keyframe: isVp8Keyframe(packet.payload) };
    case 'H264':
      return { codec: codecName, keyframe: isH264Keyframe(packet.payload) };
    case 'VP9':
      return { codec: codecName, keyframe: isVp9Keyframe(packet.payload) };
  }
}

export function isKeyframe(packet: RtpPacket, codec: Pick<RtpCodecParameters, 'mimeType'> | string): boolean {
  return detectKeyframe(packet, codec)?.keyframe ?? false;
}

function codecNameFromMime(mimeType: string): RtpCodecName | undefined {
  const normalized = mimeType.toLowerCase();
  if (normalized.endsWith('/vp8')) {
    return 'VP8';
  }
  if (normalized.endsWith('/h264')) {
    return 'H264';
  }
  if (normalized.endsWith('/vp9')) {
    return 'VP9';
  }
  return undefined;
}

function isVp8Keyframe(payload: Buffer): boolean {
  const descriptor = parseVp8PayloadDescriptor(payload);
  if (!descriptor || descriptor.payloadOffset >= payload.length) {
    return false;
  }
  const frameTag = payload[descriptor.payloadOffset]!;
  return descriptor.startOfPartition && descriptor.partitionId === 0 && (frameTag & 0x01) === 0;
}

function parseVp8PayloadDescriptor(payload: Buffer): { startOfPartition: boolean; partitionId: number; payloadOffset: number } | null {
  if (payload.length < 2) {
    return null;
  }
  const first = payload[0]!;
  let offset = 1;
  if (first & 0x80) {
    if (offset >= payload.length) {
      return null;
    }
    const extension = payload[offset++]!;
    if (extension & 0x80) {
      if (offset >= payload.length) {
        return null;
      }
      const pictureId = payload[offset++]!;
      if (pictureId & 0x80) {
        offset += 1;
      }
    }
    if (extension & 0x40) {
      offset += 1;
    }
    if (extension & 0x20) {
      offset += 1;
    }
    if (extension & 0x10) {
      offset += 1;
    }
  }
  if (offset >= payload.length) {
    return null;
  }
  return {
    startOfPartition: Boolean(first & 0x10),
    partitionId: first & 0x0f,
    payloadOffset: offset
  };
}

function isH264Keyframe(payload: Buffer): boolean {
  if (payload.length === 0) {
    return false;
  }
  const nalType = payload[0]! & 0x1f;
  if (nalType === 5) {
    return true;
  }
  if (nalType === 24) {
    return stapAContainsIdr(payload);
  }
  if (nalType === 28 && payload.length >= 2) {
    const fuHeader = payload[1]!;
    const start = Boolean(fuHeader & 0x80);
    const originalNalType = fuHeader & 0x1f;
    return start && originalNalType === 5;
  }
  return false;
}

function stapAContainsIdr(payload: Buffer): boolean {
  let offset = 1;
  while (offset + 2 <= payload.length) {
    const nalLength = payload.readUInt16BE(offset);
    offset += 2;
    if (offset + nalLength > payload.length || nalLength === 0) {
      return false;
    }
    if ((payload[offset]! & 0x1f) === 5) {
      return true;
    }
    offset += nalLength;
  }
  return false;
}

function isVp9Keyframe(payload: Buffer): boolean {
  if (payload.length < 2) {
    return false;
  }
  const descriptor = payload[0]!;
  const predictedFrame = Boolean(descriptor & 0x40);
  const beginsFrame = Boolean(descriptor & 0x08);
  return beginsFrame && !predictedFrame;
}
