import type { Producer, RtpEncodingParameters, RtpLayerInfo, RtpLayerSelection } from '@native-sfu/contracts';
import type { BandwidthEstimate } from '../bandwidth/bandwidth-estimator';

export interface LayerSelectionResult {
  selection?: RtpLayerSelection;
  reason: 'audio' | 'preferred' | 'adaptive' | 'fallback' | 'none';
}

export interface LayerActivityResult {
  layer: RtpLayerInfo;
  becameActive: boolean;
}

export class ProducerSimulcastState {
  private readonly activeSsrcs = new Map<number, { lastSeenAt: number; packets: number }>();
  private readonly activeTemporalLayers = new Map<number, Set<number>>();
  private readonly knownSsrcs = new Set<number>();

  constructor(
    private readonly producer: Producer,
    private readonly now: () => number = () => Date.now(),
    private readonly activityTimeoutMs = 4000
  ) {
    for (const encoding of producer.rtpParameters.encodings) {
      if (isKnownSsrc(encoding.ssrc)) {
        this.knownSsrcs.add(encoding.ssrc);
      }
      if (isKnownSsrc(encoding.rtx?.ssrc)) {
        this.knownSsrcs.add(encoding.rtx.ssrc);
      }
    }
    this.publishSnapshots();
  }

  knownMediaSsrcs(): number[] {
    return this.producer.rtpParameters.encodings.map((encoding) => encoding.ssrc).filter(isKnownSsrc);
  }

  knownSsrcList(): number[] {
    return [...this.knownSsrcs];
  }

  encodingForSsrc(ssrc: number): { encoding: RtpEncodingParameters; index: number; isRtx: boolean; mediaSsrc: number } | undefined {
    const index = this.producer.rtpParameters.encodings.findIndex((encoding) => encoding.ssrc === ssrc || encoding.rtx?.ssrc === ssrc);
    if (index < 0) {
      return undefined;
    }
    const encoding = this.producer.rtpParameters.encodings[index]!;
    if (!isKnownSsrc(encoding.ssrc)) {
      return undefined;
    }
    return {
      encoding,
      index,
      isRtx: encoding.rtx?.ssrc === ssrc,
      mediaSsrc: encoding.ssrc
    };
  }

  encodingForRid(rid: string): { encoding: RtpEncodingParameters; index: number } | undefined {
    const index = this.producer.rtpParameters.encodings.findIndex((encoding) => encoding.rid === rid);
    return index < 0 ? undefined : { encoding: this.producer.rtpParameters.encodings[index]!, index };
  }

  bindMediaSsrc(rid: string, ssrc: number): { encoding: RtpEncodingParameters; index: number } | undefined {
    const source = this.encodingForRid(rid);
    if (!source) {
      return undefined;
    }
    if (isKnownSsrc(source.encoding.ssrc) && source.encoding.ssrc !== ssrc) {
      return undefined;
    }
    source.encoding.ssrc = ssrc >>> 0;
    source.encoding.active = source.encoding.active ?? true;
    this.knownSsrcs.add(source.encoding.ssrc);
    if (isKnownSsrc(source.encoding.rtx?.ssrc)) {
      this.knownSsrcs.add(source.encoding.rtx.ssrc);
    }
    this.publishSnapshots();
    return source;
  }

  bindRtxSsrc(rid: string, ssrc: number): { encoding: RtpEncodingParameters; index: number } | undefined {
    const source = this.encodingForRid(rid);
    if (!source) {
      return undefined;
    }
    if (isKnownSsrc(source.encoding.rtx?.ssrc) && source.encoding.rtx.ssrc !== ssrc) {
      return undefined;
    }
    const rtxSsrc = ssrc >>> 0;
    source.encoding.rtx = { ...source.encoding.rtx, ssrc: rtxSsrc };
    this.knownSsrcs.add(rtxSsrc);
    this.publishSnapshots();
    return source;
  }

  markPacket(ssrc: number, temporalLayer?: number): LayerActivityResult | undefined {
    const source = this.encodingForSsrc(ssrc);
    if (!source || source.isRtx) {
      return undefined;
    }
    const existed = this.activeSsrcs.has(source.mediaSsrc);
    const current = this.activeSsrcs.get(source.mediaSsrc) ?? { lastSeenAt: 0, packets: 0 };
    current.lastSeenAt = this.now();
    current.packets += 1;
    this.activeSsrcs.set(source.mediaSsrc, current);
    if (temporalLayer !== undefined) {
      const active = this.activeTemporalLayers.get(source.mediaSsrc) ?? new Set<number>();
      active.add(Math.max(0, Math.trunc(temporalLayer)));
      this.activeTemporalLayers.set(source.mediaSsrc, active);
    }
    source.encoding.active = true;
    const layer = this.layerInfoForEncoding(source.encoding, source.index, temporalLayer);
    this.publishSnapshots();
    return { layer, becameActive: !existed };
  }

  layerInfoForSsrc(ssrc: number): RtpLayerInfo | undefined {
    const source = this.encodingForSsrc(ssrc);
    return source ? this.layerInfoForEncoding(source.encoding, source.index) : undefined;
  }

  layerSelectionForSsrc(ssrc: number, temporalLayer?: number): RtpLayerSelection | undefined {
    const source = this.encodingForSsrc(ssrc);
    return source ? layerSelectionForEncoding(source.encoding, source.index, temporalLayer) : undefined;
  }

  availableLayers(): RtpLayerInfo[] {
    if (this.pruneStaleActivity()) {
      this.publishSnapshots();
    }
    return this.producer.rtpParameters.encodings
      .flatMap((encoding, index) => {
        const temporalLayers = isKnownSsrc(encoding.ssrc) ? this.activeTemporalLayers.get(encoding.ssrc) : undefined;
        if (!temporalLayers || temporalLayers.size === 0) {
          return [this.layerInfoForEncoding(encoding, index)];
        }
        return [...temporalLayers].sort((left, right) => left - right).map((temporalLayer) => this.layerInfoForEncoding(encoding, index, temporalLayer));
      })
      .sort(compareLayers);
  }

  currentLayers(): RtpLayerSelection | undefined {
    if (this.pruneStaleActivity()) {
      this.publishSnapshots();
    }
    const active = this.availableLayers()
      .filter((layer) => layer.active)
      .sort(compareLayers);
    const highest = active.at(-1);
    return highest ? { spatialLayer: highest.spatialLayer, temporalLayer: highest.temporalLayer } : undefined;
  }

  selectLayer(estimate?: BandwidthEstimate, preferred?: RtpLayerSelection, enableAdaptive = true): LayerSelectionResult {
    if (this.pruneStaleActivity()) {
      this.publishSnapshots();
    }
    const knownLayers = this.availableLayers().filter((layer) => layer.active || isKnownSsrc(layer.ssrc));
    const activeLayers = knownLayers.filter((layer) => layer.active);
    const layers = activeLayers.length > 0 ? activeLayers : knownLayers;
    if (layers.length === 0) {
      return { reason: 'none' };
    }
    const allowed = layers.filter((layer) => layerWithinPreference(layer, preferred));
    const candidates = (allowed.length > 0 ? allowed : layers).sort(compareLayers);
    if (!enableAdaptive || !estimate) {
      return { selection: selectionFromLayer(candidates.at(-1)!), reason: preferred ? 'preferred' : 'fallback' };
    }
    const budget = estimate.recommendedBitrate || estimate.availableBitrate || 0;
    if (budget <= 0) {
      return { selection: selectionFromLayer(candidates[0]!), reason: 'adaptive' };
    }
    const affordable = candidates.filter((layer) => !layer.maxBitrate || layer.maxBitrate <= budget);
    return { selection: selectionFromLayer((affordable.length > 0 ? affordable : [candidates[0]!]).at(-1)!), reason: 'adaptive' };
  }

  private layerInfoForEncoding(encoding: RtpEncodingParameters, index: number, temporalLayer = encoding.temporalLayer): RtpLayerInfo {
    const spatialLayer = encoding.spatialLayer ?? spatialLayerFromRid(encoding.rid, index);
    return {
      spatialLayer,
      temporalLayer,
      rid: encoding.rid,
      ssrc: encoding.ssrc,
      rtxSsrc: encoding.rtx?.ssrc,
      maxBitrate: encoding.maxBitrate,
      scaleResolutionDownBy: encoding.scaleResolutionDownBy,
      active: Boolean(isKnownSsrc(encoding.ssrc) && this.activeSsrcs.has(encoding.ssrc))
    };
  }

  private publishSnapshots(): void {
    this.producer.availableLayers = this.availableLayers();
    this.producer.currentLayers = this.currentLayers();
  }

  private pruneStaleActivity(): boolean {
    if (this.activityTimeoutMs <= 0) {
      return false;
    }
    const now = this.now();
    let pruned = false;
    for (const [ssrc, state] of [...this.activeSsrcs.entries()]) {
      if (now - state.lastSeenAt <= this.activityTimeoutMs) {
        continue;
      }
      this.activeSsrcs.delete(ssrc);
      this.activeTemporalLayers.delete(ssrc);
      pruned = true;
    }
    return pruned;
  }
}

export function spatialLayerFromRid(rid: string | undefined, fallbackIndex: number): number {
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

export function layerSelectionForEncoding(encoding: RtpEncodingParameters, index: number, temporalLayer = encoding.temporalLayer): RtpLayerSelection {
  return {
    spatialLayer: encoding.spatialLayer ?? spatialLayerFromRid(encoding.rid, index),
    temporalLayer
  };
}

export function preferredLayerNameToSelection(layer: 'low' | 'medium' | 'high' | undefined): RtpLayerSelection | undefined {
  switch (layer) {
    case 'low':
      return { spatialLayer: 0 };
    case 'medium':
      return { spatialLayer: 1 };
    case 'high':
      return { spatialLayer: 2 };
    default:
      return undefined;
  }
}

export function normalizeLayerSelection(selection: RtpLayerSelection | undefined): RtpLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    spatialLayer: normalizeLayerNumber(selection.spatialLayer),
    temporalLayer: normalizeLayerNumber(selection.temporalLayer)
  };
}

export function sameLayer(left: RtpLayerSelection | undefined, right: RtpLayerSelection | undefined): boolean {
  return left?.spatialLayer === right?.spatialLayer && left?.temporalLayer === right?.temporalLayer;
}

export function isKnownSsrc(ssrc: number | undefined): ssrc is number {
  return typeof ssrc === 'number' && Number.isFinite(ssrc) && ssrc > 0;
}

function normalizeLayerNumber(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function layerWithinPreference(layer: RtpLayerInfo, preferred: RtpLayerSelection | undefined): boolean {
  if (preferred?.spatialLayer !== undefined && layer.spatialLayer > preferred.spatialLayer) {
    return false;
  }
  if (preferred?.temporalLayer !== undefined && layer.temporalLayer !== undefined && layer.temporalLayer > preferred.temporalLayer) {
    return false;
  }
  return true;
}

function selectionFromLayer(layer: RtpLayerInfo): RtpLayerSelection {
  return {
    spatialLayer: layer.spatialLayer,
    temporalLayer: layer.temporalLayer
  };
}

function compareLayers(left: RtpLayerInfo, right: RtpLayerInfo): number {
  return left.spatialLayer - right.spatialLayer || (left.temporalLayer ?? 0) - (right.temporalLayer ?? 0);
}
