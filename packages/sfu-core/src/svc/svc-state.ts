import type {
  Producer,
  ProducerSvcState,
  RtpLayerSelection,
  SvcCapabilities,
  SvcLayerInfo,
  SvcLayerSelection
} from '@native-sfu/contracts';
import type { BandwidthEstimate } from '../bandwidth/bandwidth-estimator';
import { detectSvcCapabilities, type SvcLayerDetectionResult } from '../codecs/svc-layer-detector';

export interface SvcSelectionResult {
  selection?: SvcLayerSelection;
  reason: 'audio' | 'preferred' | 'adaptive' | 'fallback' | 'none';
}

export interface SvcLayerActivityResult {
  layer: SvcLayerInfo;
  becameActive: boolean;
}

export class ProducerSvcStateTracker {
  private readonly activeLayers = new Map<string, { layer: SvcLayerInfo; lastSeenAt: number; packets: number }>();
  private readonly capabilities: SvcCapabilities;

  constructor(private readonly producer: Producer, private readonly now: () => number = () => Date.now()) {
    this.capabilities = detectSvcCapabilities(producer.rtpParameters);
    this.publishSnapshot();
  }

  enabled(): boolean {
    if (this.producer.kind === 'audio') {
      return false;
    }
    if (this.producer.rtpParameters.encodings.length !== 1) {
      return false;
    }
    return this.capabilities.supported && (this.capabilities.spatialLayerCount > 1 || this.capabilities.temporalLayerCount > 1);
  }

  snapshot(): ProducerSvcState {
    return {
      producerId: this.producer.id,
      roomId: this.producer.roomId,
      participantId: this.producer.participantId,
      capabilities: { ...this.capabilities },
      activeLayers: this.activeLayerSelections(),
      availableLayers: this.availableLayers(),
      currentLayers: this.currentLayers(),
      updatedAt: new Date(this.now()).toISOString()
    };
  }

  markPacket(ssrc: number, detection: SvcLayerDetectionResult | null): SvcLayerActivityResult | undefined {
    if (!this.enabled() || !detection) {
      return undefined;
    }
    const selection = normalizeSvcLayer(detection.layer);
    const key = svcLayerKey(selection);
    const existed = this.activeLayers.has(key);
    const current = this.activeLayers.get(key);
    const layer: SvcLayerInfo = {
      codec: detection.codec,
      spatialLayerId: selection.spatialLayerId,
      temporalLayerId: selection.temporalLayerId,
      qualityLayerId: selection.qualityLayerId,
      ssrc,
      maxBitrate: this.maxBitrateForLayer(selection),
      active: true,
      decodable: detection.decodable,
      requiresKeyframe: detection.requiresKeyframe,
      dependencyLayerIds: dependencyChainForLayer(selection)
    };
    this.activeLayers.set(key, {
      layer,
      lastSeenAt: this.now(),
      packets: (current?.packets ?? 0) + 1
    });
    this.publishSnapshot();
    return { layer, becameActive: !existed };
  }

  layerSelectionForPacket(detection: SvcLayerDetectionResult | null): RtpLayerSelection | undefined {
    if (!this.enabled() || !detection) {
      return undefined;
    }
    return toRtpLayerSelection(detection.layer);
  }

  svcSelectionForPacket(detection: SvcLayerDetectionResult | null): SvcLayerSelection | undefined {
    if (!this.enabled() || !detection) {
      return undefined;
    }
    return normalizeSvcLayer(detection.layer);
  }

  availableLayers(): SvcLayerInfo[] {
    const active = [...this.activeLayers.values()].map((entry) => entry.layer);
    const planned = expectedLayers(this.capabilities, this.producer.rtpParameters.encodings[0]?.maxBitrate).map((layer) => {
      const activeLayer = active.find((candidate) => sameSvcLayer(candidate, layer));
      return activeLayer ?? layer;
    });
    const activeOnly = active.filter((layer) => !planned.some((candidate) => sameSvcLayer(candidate, layer)));
    return [...planned, ...activeOnly].sort(compareSvcLayers);
  }

  currentLayers(): SvcLayerSelection | undefined {
    const highest = [...this.activeLayers.values()]
      .map((entry) => entry.layer)
      .sort(compareSvcLayers)
      .at(-1);
    return highest ? stripSvcInfo(highest) : undefined;
  }

  selectLayer(estimate?: BandwidthEstimate, preferred?: SvcLayerSelection, enableAdaptive = true): SvcSelectionResult {
    if (this.producer.kind === 'audio') {
      return { reason: 'audio' };
    }
    if (!this.enabled()) {
      return { reason: 'none' };
    }
    const candidates = this.availableLayers().filter((layer) => layer.active || layer.decodable);
    if (candidates.length === 0) {
      return { reason: 'none' };
    }
    const allowed = candidates.filter((layer) => svcLayerWithinPreference(layer, preferred));
    const ordered = (allowed.length > 0 ? allowed : candidates).sort(compareSvcLayers);
    if (!enableAdaptive || !estimate) {
      return { selection: stripSvcInfo(ordered.at(-1)!), reason: preferred ? 'preferred' : 'fallback' };
    }
    const budget = estimate.recommendedBitrate || estimate.availableBitrate || 0;
    if (budget <= 0) {
      return { selection: stripSvcInfo(ordered[0]!), reason: 'adaptive' };
    }
    const affordable = ordered.filter((layer) => !layer.maxBitrate || layer.maxBitrate <= budget);
    return { selection: stripSvcInfo((affordable.length > 0 ? affordable : [ordered[0]!]).at(-1)!), reason: 'adaptive' };
  }

  private maxBitrateForLayer(layer: SvcLayerSelection): number | undefined {
    const baseBitrate = this.producer.rtpParameters.encodings[0]?.maxBitrate;
    if (!baseBitrate) {
      return undefined;
    }
    const spatialLayers = Math.max(1, this.capabilities.spatialLayerCount);
    const temporalLayers = Math.max(1, this.capabilities.temporalLayerCount);
    const spatialWeight = ((layer.spatialLayerId ?? 0) + 1) / spatialLayers;
    const temporalWeight = ((layer.temporalLayerId ?? 0) + 1) / temporalLayers;
    return Math.max(1, Math.round(baseBitrate * spatialWeight * temporalWeight));
  }

  private activeLayerSelections(): SvcLayerSelection[] {
    return [...this.activeLayers.values()]
      .map((entry) => stripSvcInfo(entry.layer))
      .sort(compareSvcSelections);
  }

  private publishSnapshot(): void {
    this.producer.svc = this.snapshot();
  }
}

export function normalizeSvcLayer(selection: SvcLayerSelection | undefined): SvcLayerSelection {
  return {
    spatialLayerId: normalizeLayerNumber(selection?.spatialLayerId) ?? 0,
    temporalLayerId: normalizeLayerNumber(selection?.temporalLayerId) ?? 0,
    qualityLayerId: normalizeLayerNumber(selection?.qualityLayerId ?? selection?.spatialLayerId) ?? 0
  };
}

export function toRtpLayerSelection(selection: SvcLayerSelection | undefined): RtpLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  const normalized = normalizeSvcLayer(selection);
  return {
    spatialLayer: normalized.spatialLayerId,
    temporalLayer: normalized.temporalLayerId
  };
}

export function fromRtpLayerSelection(selection: RtpLayerSelection | undefined): SvcLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return normalizeSvcLayer({
    spatialLayerId: selection.spatialLayer,
    temporalLayerId: selection.temporalLayer,
    qualityLayerId: selection.spatialLayer
  });
}

export function sameSvcLayer(left: SvcLayerSelection | undefined, right: SvcLayerSelection | undefined): boolean {
  return (
    left?.spatialLayerId === right?.spatialLayerId &&
    left?.temporalLayerId === right?.temporalLayerId &&
    (left?.qualityLayerId ?? left?.spatialLayerId) === (right?.qualityLayerId ?? right?.spatialLayerId)
  );
}

export function svcLayerKey(layer: SvcLayerSelection | undefined): string {
  return `${layer?.spatialLayerId ?? 'x'}:${layer?.temporalLayerId ?? 'x'}:${layer?.qualityLayerId ?? layer?.spatialLayerId ?? 'x'}`;
}

function expectedLayers(capabilities: SvcCapabilities, baseMaxBitrate?: number): SvcLayerInfo[] {
  const layers: SvcLayerInfo[] = [];
  for (let spatial = 0; spatial < Math.max(1, capabilities.spatialLayerCount); spatial += 1) {
    for (let temporal = 0; temporal < Math.max(1, capabilities.temporalLayerCount); temporal += 1) {
      const selection = normalizeSvcLayer({ spatialLayerId: spatial, temporalLayerId: temporal, qualityLayerId: spatial });
      layers.push({
        ...selection,
        codec: capabilities.codec,
        active: false,
        decodable: true,
        requiresKeyframe: spatial > 0 || capabilities.requiresKeyframeForSpatialSwitch,
        maxBitrate: bitrateForExpectedLayer(selection, capabilities, baseMaxBitrate),
        dependencyLayerIds: dependencyChainForLayer(selection)
      });
    }
  }
  return layers;
}

function dependencyChainForLayer(selection: SvcLayerSelection): SvcLayerSelection[] {
  const normalized = normalizeSvcLayer(selection);
  const dependencies: SvcLayerSelection[] = [];
  for (let spatial = 0; spatial <= (normalized.spatialLayerId ?? 0); spatial += 1) {
    dependencies.push({ spatialLayerId: spatial, temporalLayerId: 0, qualityLayerId: spatial });
  }
  return dependencies.filter((dependency) => !sameSvcLayer(dependency, normalized));
}

function bitrateForExpectedLayer(layer: SvcLayerSelection, capabilities: SvcCapabilities, baseMaxBitrate?: number): number | undefined {
  if (!baseMaxBitrate) {
    return undefined;
  }
  const spatialWeight = ((layer.spatialLayerId ?? 0) + 1) / Math.max(1, capabilities.spatialLayerCount);
  const temporalWeight = ((layer.temporalLayerId ?? 0) + 1) / Math.max(1, capabilities.temporalLayerCount);
  return Math.max(1, Math.round(baseMaxBitrate * spatialWeight * temporalWeight));
}

function svcLayerWithinPreference(layer: SvcLayerSelection, preferred: SvcLayerSelection | undefined): boolean {
  if (preferred?.spatialLayerId !== undefined && (layer.spatialLayerId ?? 0) > preferred.spatialLayerId) {
    return false;
  }
  if (preferred?.temporalLayerId !== undefined && (layer.temporalLayerId ?? 0) > preferred.temporalLayerId) {
    return false;
  }
  if (preferred?.qualityLayerId !== undefined && (layer.qualityLayerId ?? layer.spatialLayerId ?? 0) > preferred.qualityLayerId) {
    return false;
  }
  return true;
}

function stripSvcInfo(layer: SvcLayerSelection): SvcLayerSelection {
  return {
    spatialLayerId: layer.spatialLayerId,
    temporalLayerId: layer.temporalLayerId,
    qualityLayerId: layer.qualityLayerId
  };
}

function compareSvcLayers(left: SvcLayerInfo, right: SvcLayerInfo): number {
  return compareSvcSelections(left, right);
}

function compareSvcSelections(left: SvcLayerSelection, right: SvcLayerSelection): number {
  return (
    (left.spatialLayerId ?? 0) - (right.spatialLayerId ?? 0) ||
    (left.temporalLayerId ?? 0) - (right.temporalLayerId ?? 0) ||
    (left.qualityLayerId ?? left.spatialLayerId ?? 0) - (right.qualityLayerId ?? right.spatialLayerId ?? 0)
  );
}

function normalizeLayerNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}
