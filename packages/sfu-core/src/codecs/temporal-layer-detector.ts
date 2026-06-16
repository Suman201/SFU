import type { RtpCodecParameters } from '@native-sfu/contracts';
import { RtpPacket } from '../rtp/rtp-packet';

export type TemporalLayerCodecName = 'VP8' | 'VP9';

export interface TemporalLayerDetectionResult {
  codec: TemporalLayerCodecName;
  temporalLayer?: number;
}

export function detectTemporalLayer(packet: RtpPacket, codec: Pick<RtpCodecParameters, 'mimeType'> | string): TemporalLayerDetectionResult | null {
  const codecName = temporalCodecNameFromMime(typeof codec === 'string' ? codec : codec.mimeType);
  if (!codecName) {
    return null;
  }
  switch (codecName) {
    case 'VP8':
      return { codec: codecName, temporalLayer: parseVp8TemporalLayer(packet.payload) };
    case 'VP9':
      return { codec: codecName, temporalLayer: parseVp9TemporalLayer(packet.payload) };
  }
}

export function parseVp8TemporalLayer(payload: Buffer): number | undefined {
  if (payload.length < 2) {
    return undefined;
  }
  const first = payload[0]!;
  if ((first & 0x80) === 0) {
    return undefined;
  }
  let offset = 1;
  const extension = payload[offset++]!;
  const hasPictureId = Boolean(extension & 0x80);
  const hasTl0PicIdx = Boolean(extension & 0x40);
  const hasTidKeyIdx = Boolean(extension & 0x20);
  if (hasPictureId) {
    if (offset >= payload.length) {
      return undefined;
    }
    const pictureId = payload[offset++]!;
    if (pictureId & 0x80) {
      offset += 1;
    }
  }
  if (hasTl0PicIdx) {
    offset += 1;
  }
  if (!hasTidKeyIdx || offset >= payload.length) {
    return undefined;
  }
  return (payload[offset]! >> 6) & 0x03;
}

export function parseVp9TemporalLayer(payload: Buffer): number | undefined {
  if (payload.length < 2) {
    return undefined;
  }
  const first = payload[0]!;
  let offset = 1;
  const hasPictureId = Boolean(first & 0x80);
  const interPicturePredicted = Boolean(first & 0x40);
  const hasLayerIndices = Boolean(first & 0x20);
  const flexibleMode = Boolean(first & 0x10);
  let temporalLayer: number | undefined;
  if (hasPictureId) {
    if (offset >= payload.length) {
      return undefined;
    }
    const pictureId = payload[offset++]!;
    if (pictureId & 0x80) {
      offset += 1;
    }
  }
  if (hasLayerIndices) {
    if (offset >= payload.length) {
      return undefined;
    }
    temporalLayer = (payload[offset++]! >> 5) & 0x07;
    if (!flexibleMode) {
      offset += 1;
    }
  }
  if (interPicturePredicted && flexibleMode) {
    while (offset < payload.length) {
      const pDiff = payload[offset++]!;
      if ((pDiff & 0x80) === 0) {
        break;
      }
    }
  }
  return temporalLayer;
}

function temporalCodecNameFromMime(mimeType: string): TemporalLayerCodecName | undefined {
  const normalized = mimeType.toLowerCase();
  if (normalized.endsWith('/vp8')) {
    return 'VP8';
  }
  if (normalized.endsWith('/vp9')) {
    return 'VP9';
  }
  return undefined;
}
