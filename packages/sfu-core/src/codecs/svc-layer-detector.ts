import type { RtpCodecParameters, RtpEncodingParameters, RtpParameters, SvcCapabilities, SvcCodecName, SvcFallbackMode, SvcLayerSelection } from '@native-sfu/contracts';
import { RtpPacket } from '../rtp/rtp-packet';
import { parseVp8TemporalLayer } from './temporal-layer-detector';

export interface SvcLayerDetectionResult {
  codec: SvcCodecName;
  layer: Required<Pick<SvcLayerSelection, 'spatialLayerId' | 'temporalLayerId'>> & Pick<SvcLayerSelection, 'qualityLayerId'>;
  frameStart?: boolean;
  frameEnd?: boolean;
  switchUpPoint?: boolean;
  interPicturePredicted?: boolean;
  interLayerDependency?: boolean;
  referenceDiffs?: number[];
  pictureId?: number;
  tl0PicIdx?: number;
  decodable: boolean;
  requiresKeyframe: boolean;
  fallback: SvcFallbackMode;
}

export interface Vp9PayloadDescriptor {
  pictureId?: number;
  temporalLayerId?: number;
  spatialLayerId?: number;
  switchingUpPoint?: boolean;
  interLayerDependency?: boolean;
  tl0PicIdx?: number;
  referenceDiffs: number[];
  interPicturePredicted: boolean;
  flexibleMode: boolean;
  frameStart: boolean;
  frameEnd: boolean;
  scalabilityStructure?: Vp9ScalabilityStructure;
}

export interface Vp9ScalabilityStructure {
  spatialLayerCount: number;
  resolutions?: Array<{ width: number; height: number }>;
  groups?: Array<{ temporalLayerId: number; switchingUpPoint: boolean; referenceIndices: number[] }>;
}

export interface ScalabilityModeInfo {
  scalabilityMode: string;
  spatialLayerCount: number;
  temporalLayerCount: number;
}

export function detectSvcLayer(
  packet: RtpPacket,
  codec: Pick<RtpCodecParameters, 'mimeType'> | string,
  encoding?: Pick<RtpEncodingParameters, 'maxBitrate' | 'scalabilityMode' | 'spatialLayer' | 'temporalLayer'>
): SvcLayerDetectionResult | null {
  const codecName = svcCodecNameFromMime(typeof codec === 'string' ? codec : codec.mimeType);
  switch (codecName) {
    case 'VP9': {
      const descriptor = parseVp9PayloadDescriptor(packet.payload);
      const fallbackSpatialLayerId = normalizeLayerNumber(encoding?.spatialLayer) ?? 0;
      const fallbackTemporalLayerId = normalizeLayerNumber(encoding?.temporalLayer) ?? 0;
      const spatialLayerId = descriptor?.spatialLayerId ?? fallbackSpatialLayerId;
      const temporalLayerId = descriptor?.temporalLayerId ?? fallbackTemporalLayerId;
      return {
        codec: 'VP9',
        layer: { spatialLayerId, temporalLayerId, qualityLayerId: spatialLayerId },
        frameStart: descriptor?.frameStart,
        frameEnd: descriptor?.frameEnd,
        switchUpPoint: descriptor?.switchingUpPoint,
        interPicturePredicted: descriptor?.interPicturePredicted,
        interLayerDependency: descriptor?.interLayerDependency,
        referenceDiffs: descriptor?.referenceDiffs,
        pictureId: descriptor?.pictureId,
        tl0PicIdx: descriptor?.tl0PicIdx,
        decodable: spatialLayerId === 0 || descriptor?.interLayerDependency !== false,
        requiresKeyframe: spatialLayerId > 0,
        fallback: 'native_svc'
      };
    }
    case 'VP8': {
      const temporalLayerId = parseVp8TemporalLayer(packet.payload) ?? normalizeLayerNumber(encoding?.temporalLayer) ?? 0;
      const frameStart = Boolean(packet.payload[0] !== undefined && (packet.payload[0]! & 0x10) !== 0 && (packet.payload[0]! & 0x0f) === 0);
      return {
        codec: 'VP8',
        layer: { spatialLayerId: 0, temporalLayerId, qualityLayerId: 0 },
        frameStart,
        frameEnd: undefined,
        decodable: true,
        requiresKeyframe: false,
        fallback: 'vp8_temporal_only'
      };
    }
    case 'H264':
      return {
        codec: 'H264',
        layer: { spatialLayerId: 0, temporalLayerId: 0, qualityLayerId: 0 },
        decodable: true,
        requiresKeyframe: true,
        fallback: 'h264_single_layer'
      };
    default:
      return null;
  }
}

export function detectSvcCapabilities(parameters: RtpParameters): SvcCapabilities {
  const codec = parameters.codecs.find((candidate) => !/\/rtx$/i.test(candidate.mimeType));
  const codecName = svcCodecNameFromMime(codec?.mimeType ?? '');
  const mode = firstScalabilityMode(parameters, codec);
  const parsedMode = mode ? parseScalabilityMode(mode) : undefined;
  const encodingSpatialLayers = maxEncodingLayer(parameters.encodings, 'spatialLayer') + 1;
  const encodingTemporalLayers = maxEncodingLayer(parameters.encodings, 'temporalLayer') + 1;
  const spatialLayerCount = Math.max(parsedMode?.spatialLayerCount ?? 0, encodingSpatialLayers || 0, codecName === 'VP9' ? 1 : 0);
  const temporalLayerCount = Math.max(parsedMode?.temporalLayerCount ?? 0, encodingTemporalLayers || 0, 1);
  const fallback = fallbackMode(codecName, mode);
  return {
    supported: codecName === 'VP9' || codecName === 'VP8',
    codec: codecName,
    scalabilityMode: mode,
    spatialLayerCount: Math.max(1, spatialLayerCount),
    temporalLayerCount: Math.max(1, temporalLayerCount),
    fallback,
    canPauseIndividualLayers: false,
    requiresKeyframeForSpatialSwitch: codecName !== 'VP8'
  };
}

export function parseScalabilityMode(mode: string): ScalabilityModeInfo | undefined {
  const match = /^L(?<spatial>\d+)T(?<temporal>\d+)(?:_|$)/i.exec(mode.trim());
  if (!match?.groups) {
    return undefined;
  }
  const spatialLayerCount = Number(match.groups['spatial']);
  const temporalLayerCount = Number(match.groups['temporal']);
  if (!Number.isFinite(spatialLayerCount) || !Number.isFinite(temporalLayerCount) || spatialLayerCount <= 0 || temporalLayerCount <= 0) {
    return undefined;
  }
  return {
    scalabilityMode: mode,
    spatialLayerCount: Math.trunc(spatialLayerCount),
    temporalLayerCount: Math.trunc(temporalLayerCount)
  };
}

export function parseVp9PayloadDescriptor(payload: Buffer): Vp9PayloadDescriptor | undefined {
  if (payload.length === 0) {
    return undefined;
  }
  const first = payload[0]!;
  let offset = 1;
  const hasPictureId = Boolean(first & 0x80);
  const interPicturePredicted = Boolean(first & 0x40);
  const hasLayerIndices = Boolean(first & 0x20);
  const flexibleMode = Boolean(first & 0x10);
  const frameStart = Boolean(first & 0x08);
  const frameEnd = Boolean(first & 0x04);
  const hasScalabilityStructure = Boolean(first & 0x02);
  const upperLayerReference = Boolean(first & 0x01);
  let pictureId: number | undefined;
  let temporalLayerId: number | undefined;
  let spatialLayerId: number | undefined;
  let switchingUpPoint: boolean | undefined;
  let interLayerDependency: boolean | undefined;
  let tl0PicIdx: number | undefined;
  const referenceDiffs: number[] = [];

  if (hasPictureId) {
    if (offset >= payload.length) {
      return undefined;
    }
    const firstPictureIdByte = payload[offset++]!;
    if (firstPictureIdByte & 0x80) {
      if (offset >= payload.length) {
        return undefined;
      }
      pictureId = ((firstPictureIdByte & 0x7f) << 8) | payload[offset++]!;
    } else {
      pictureId = firstPictureIdByte & 0x7f;
    }
  }

  if (hasLayerIndices) {
    if (offset >= payload.length) {
      return undefined;
    }
    const layer = payload[offset++]!;
    temporalLayerId = (layer >> 5) & 0x07;
    switchingUpPoint = Boolean(layer & 0x10);
    spatialLayerId = (layer >> 1) & 0x07;
    interLayerDependency = Boolean(layer & 0x01);
    if (!flexibleMode) {
      if (offset >= payload.length) {
        return undefined;
      }
      tl0PicIdx = payload[offset++]!;
    }
  }

  if (interPicturePredicted && flexibleMode) {
    while (offset < payload.length) {
      const pDiff = payload[offset++]!;
      referenceDiffs.push(pDiff & 0x7f);
      if ((pDiff & 0x80) === 0) {
        break;
      }
    }
  }

  const scalabilityStructure = hasScalabilityStructure ? parseVp9ScalabilityStructure(payload, offset) : undefined;
  return {
    pictureId,
    temporalLayerId,
    spatialLayerId,
    switchingUpPoint,
    interLayerDependency: interLayerDependency ?? !upperLayerReference,
    tl0PicIdx,
    referenceDiffs,
    interPicturePredicted,
    flexibleMode,
    frameStart,
    frameEnd,
    scalabilityStructure
  };
}

function parseVp9ScalabilityStructure(payload: Buffer, startOffset: number): Vp9ScalabilityStructure | undefined {
  if (startOffset >= payload.length) {
    return undefined;
  }
  let offset = startOffset;
  const ssHeader = payload[offset++]!;
  const spatialLayerCount = (ssHeader & 0xe0) >> 5;
  const hasResolution = Boolean(ssHeader & 0x10);
  const hasGroups = Boolean(ssHeader & 0x08);
  const layerCount = spatialLayerCount + 1;
  const resolutions: Array<{ width: number; height: number }> = [];
  if (hasResolution) {
    for (let index = 0; index < layerCount; index += 1) {
      if (offset + 4 > payload.length) {
        return undefined;
      }
      resolutions.push({
        width: payload.readUInt16BE(offset),
        height: payload.readUInt16BE(offset + 2)
      });
      offset += 4;
    }
  }
  const groups: Array<{ temporalLayerId: number; switchingUpPoint: boolean; referenceIndices: number[] }> = [];
  if (hasGroups) {
    if (offset >= payload.length) {
      return undefined;
    }
    const groupCount = payload[offset++]!;
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      if (offset >= payload.length) {
        return undefined;
      }
      const group = payload[offset++]!;
      const temporalLayerId = (group >> 5) & 0x07;
      const switchingUpPoint = Boolean(group & 0x10);
      const referenceCount = group & 0x03;
      const referenceIndices: number[] = [];
      if (offset + referenceCount > payload.length) {
        return undefined;
      }
      for (let ref = 0; ref < referenceCount; ref += 1) {
        referenceIndices.push(payload[offset++]!);
      }
      groups.push({ temporalLayerId, switchingUpPoint, referenceIndices });
    }
  }
  return {
    spatialLayerCount: layerCount,
    resolutions: resolutions.length > 0 ? resolutions : undefined,
    groups: groups.length > 0 ? groups : undefined
  };
}

function firstScalabilityMode(parameters: RtpParameters, codec: RtpCodecParameters | undefined): string | undefined {
  const encodingMode = parameters.encodings.map((encoding) => encoding.scalabilityMode).find((mode): mode is string => typeof mode === 'string' && mode.trim() !== '');
  if (encodingMode) {
    return encodingMode;
  }
  const codecMode = codec?.parameters?.['scalability-mode'] ?? codec?.parameters?.['scalabilityMode'];
  return typeof codecMode === 'string' && codecMode.trim() !== '' ? codecMode : undefined;
}

function fallbackMode(codecName: SvcCodecName, scalabilityMode: string | undefined): SvcFallbackMode {
  if (codecName === 'VP9') {
    return scalabilityMode ? 'native_svc' : 'missing_scalability_mode';
  }
  if (codecName === 'VP8') {
    return 'vp8_temporal_only';
  }
  if (codecName === 'H264') {
    return 'h264_single_layer';
  }
  return 'unsupported_codec';
}

function maxEncodingLayer(encodings: RtpEncodingParameters[], key: 'spatialLayer' | 'temporalLayer'): number {
  return encodings.reduce((max, encoding) => Math.max(max, normalizeLayerNumber(encoding[key]) ?? -1), -1);
}

function normalizeLayerNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function svcCodecNameFromMime(mimeType: string): SvcCodecName {
  const normalized = mimeType.toLowerCase();
  if (normalized.endsWith('/vp8')) {
    return 'VP8';
  }
  if (normalized.endsWith('/vp9')) {
    return 'VP9';
  }
  if (normalized.endsWith('/h264')) {
    return 'H264';
  }
  return 'unknown';
}
