import type {
  Consumer,
  Producer,
  ProducerDynacastEvent,
  ProducerDynacastEventType,
  ProducerDynacastReason,
  ProducerDynacastState,
  RtpLayerInfo,
  RtpLayerSelection
} from '@native-sfu/contracts';
import { normalizeLayerSelection, sameLayer } from '../simulcast/simulcast-state';

export interface DynacastStateOptions {
  enabled?: boolean;
  now?: () => number;
}

export interface DynacastDemandChange {
  state: ProducerDynacastState;
  neededLayers: RtpLayerSelection[];
  unneededLayers: RtpLayerSelection[];
  reason: ProducerDynacastReason;
}

interface ConsumerDemand {
  consumerId: string;
  preferredLayers?: RtpLayerSelection;
  currentLayers?: RtpLayerSelection;
  targetLayers?: RtpLayerSelection;
  paused: boolean;
}

interface LayerDurationState {
  desired: boolean;
  changedAt: number;
  lastUpdatedAt: number;
  activeDurationMs: number;
  suspendedDurationMs: number;
}

export class ProducerDynacastDemandState {
  private readonly demands = new Map<string, ConsumerDemand>();
  private readonly layerDurations = new Map<string, LayerDurationState>();
  private desiredKeys = new Set<string>();
  private availableLayers: RtpLayerInfo[] = [];
  private layerDemandChanges = 0;
  private layerResumeCount = 0;
  private layerSuspendCount = 0;
  private lastReason: ProducerDynacastReason = 'initial';

  constructor(
    private readonly producer: Producer,
    private readonly options: DynacastStateOptions = {}
  ) {}

  get enabled(): boolean {
    return this.options.enabled !== false && this.producer.kind !== 'audio' && this.producer.rtpParameters.encodings.length > 1;
  }

  setAvailableLayers(layers: RtpLayerInfo[], reason: ProducerDynacastReason): DynacastDemandChange | undefined {
    this.availableLayers = layers.map((layer) => ({ ...layer }));
    return this.recompute(reason);
  }

  updateConsumer(consumer: Consumer, reason: ProducerDynacastReason): DynacastDemandChange | undefined {
    this.demands.set(consumer.id, {
      consumerId: consumer.id,
      preferredLayers: normalizeLayerSelection(consumer.preferredLayers),
      currentLayers: normalizeLayerSelection(consumer.currentLayers),
      targetLayers: normalizeLayerSelection(consumer.targetLayers ?? consumer.currentLayers ?? consumer.preferredLayers),
      paused: consumer.status === 'paused'
    });
    return this.recompute(reason);
  }

  updateConsumerLayers(
    consumerId: string,
    preferredLayers: RtpLayerSelection | undefined,
    targetLayers: RtpLayerSelection | undefined,
    currentLayers: RtpLayerSelection | undefined,
    paused: boolean,
    reason: ProducerDynacastReason
  ): DynacastDemandChange | undefined {
    this.demands.set(consumerId, {
      consumerId,
      preferredLayers: normalizeLayerSelection(preferredLayers),
      currentLayers: normalizeLayerSelection(currentLayers),
      targetLayers: normalizeLayerSelection(targetLayers ?? preferredLayers),
      paused
    });
    return this.recompute(reason);
  }

  removeConsumer(consumerId: string, reason: ProducerDynacastReason): DynacastDemandChange | undefined {
    this.demands.delete(consumerId);
    return this.recompute(reason);
  }

  layerDesired(layer: RtpLayerSelection): boolean {
    if (!this.enabled) {
      return true;
    }
    const demands = [...this.activeDemandSelections()];
    if (demands.length === 0) {
      return false;
    }
    return demands.some((demand) => layerSatisfiesDemand(layer, demand));
  }

  snapshot(reason: ProducerDynacastReason = this.lastReason): ProducerDynacastState {
    const now = this.now();
    const desiredLayers = this.desiredLayers();
    const activeLayers = this.availableLayers.filter((layer) => layer.active).map(selectionFromLayer);
    const layerStates = this.availableLayers.map((layer) => {
      const selection = selectionFromLayer(layer);
      const consumers = this.consumersDemandingLayer(selection);
      const desired = !this.enabled || consumers.length > 0;
      const duration = this.updateLayerDuration(layerKey(selection), desired, now);
      return {
        layer: selection,
        active: layer.active,
        desired,
        suspended: this.enabled && !desired,
        demandCount: consumers.length,
        consumerIds: consumers,
        maxBitrate: layer.maxBitrate,
        rid: layer.rid,
        ssrc: layer.ssrc,
        stateChangedAt: new Date(duration.changedAt).toISOString(),
        activeDurationMs: Math.round(duration.activeDurationMs),
        suspendedDurationMs: Math.round(duration.suspendedDurationMs)
      };
    });
    const suspendedLayers = layerStates.filter((layer) => layer.suspended).map((layer) => layer.layer);
    const estimatedBandwidthSavedBps = this.estimatedBandwidthSavedBps(layerStates);
    return {
      producerId: this.producer.id,
      roomId: this.producer.roomId,
      participantId: this.producer.participantId,
      enabled: this.enabled,
      activeLayers: uniqueSelections(activeLayers),
      desiredLayers,
      suspendedLayers: uniqueSelections(suspendedLayers),
      highestRequiredSpatialLayer: highestLayerValue(desiredLayers, 'spatialLayer'),
      highestRequiredTemporalLayer: highestLayerValue(desiredLayers, 'temporalLayer'),
      layers: layerStates,
      layerDemandChanges: this.layerDemandChanges,
      layerResumeCount: this.layerResumeCount,
      layerSuspendCount: this.layerSuspendCount,
      estimatedBandwidthSavedBps,
      estimatedIngressBandwidthSavedBps: estimatedBandwidthSavedBps,
      activeLayerDurationMs: Math.round(layerStates.reduce((total, layer) => total + (layer.activeDurationMs ?? 0), 0)),
      suspendedLayerDurationMs: Math.round(layerStates.reduce((total, layer) => total + (layer.suspendedDurationMs ?? 0), 0)),
      reason,
      updatedAt: new Date(now).toISOString()
    };
  }

  event(type: ProducerDynacastEventType, change: DynacastDemandChange): ProducerDynacastEvent {
    return {
      type,
      producerId: this.producer.id,
      roomId: this.producer.roomId,
      participantId: this.producer.participantId,
      enabled: change.state.enabled,
      activeLayers: change.state.activeLayers,
      desiredLayers: change.state.desiredLayers,
      suspendedLayers: change.state.suspendedLayers,
      neededLayers: change.neededLayers,
      unneededLayers: change.unneededLayers,
      reason: change.reason,
      estimatedBandwidthSavedBps: change.state.estimatedBandwidthSavedBps,
      state: change.state,
      timestamp: change.state.updatedAt
    };
  }

  private recompute(reason: ProducerDynacastReason): DynacastDemandChange | undefined {
    this.lastReason = reason;
    const nextDesired = new Set(this.desiredLayers().map(layerKey));
    const neededLayers = [...nextDesired].filter((key) => !this.desiredKeys.has(key)).map(parseLayerKey);
    const unneededLayers = [...this.desiredKeys].filter((key) => !nextDesired.has(key)).map(parseLayerKey);
    const changed = neededLayers.length > 0 || unneededLayers.length > 0;
    if (changed) {
      this.layerDemandChanges += 1;
      this.layerResumeCount += neededLayers.length;
      this.layerSuspendCount += unneededLayers.length;
      this.desiredKeys = nextDesired;
    }
    const state = this.snapshot(reason);
    this.producer.dynacast = state;
    return changed || reason === 'layer_active' ? { state, neededLayers, unneededLayers, reason } : undefined;
  }

  private desiredLayers(): RtpLayerSelection[] {
    if (!this.enabled) {
      return uniqueSelections(this.availableLayers.map(selectionFromLayer));
    }
    return uniqueSelections([...this.activeDemandSelections()].flatMap(expandTemporalDemand)).sort(compareSelections);
  }

  private *activeDemandSelections(): Iterable<RtpLayerSelection> {
    for (const demand of this.demands.values()) {
      if (demand.paused) {
        continue;
      }
      for (const layer of demandLayers(demand)) {
        yield layer;
      }
    }
  }

  private consumersDemandingLayer(layer: RtpLayerSelection): string[] {
    if (!this.enabled) {
      return [...this.demands.keys()].sort();
    }
    const consumers: string[] = [];
    for (const demand of this.demands.values()) {
      if (demand.paused) {
        continue;
      }
      if (demandLayers(demand).some((target) => layerSatisfiesDemand(layer, target))) {
        consumers.push(demand.consumerId);
      }
    }
    return consumers.sort();
  }

  private estimatedBandwidthSavedBps(layers: ProducerDynacastState['layers']): number {
    const seen = new Set<string>();
    let saved = 0;
    for (const layer of layers) {
      if (!layer.suspended || !layer.maxBitrate) {
        continue;
      }
      const key = `${layer.rid ?? layer.layer.spatialLayer ?? 'x'}:${layer.ssrc ?? 'x'}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      saved += layer.maxBitrate;
    }
    return saved;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private updateLayerDuration(key: string, desired: boolean, now: number): LayerDurationState {
    const existing =
      this.layerDurations.get(key) ??
      ({
        desired,
        changedAt: now,
        lastUpdatedAt: now,
        activeDurationMs: 0,
        suspendedDurationMs: 0
      } satisfies LayerDurationState);
    const elapsed = Math.max(0, now - existing.lastUpdatedAt);
    if (existing.desired) {
      existing.activeDurationMs += elapsed;
    } else {
      existing.suspendedDurationMs += elapsed;
    }
    if (existing.desired !== desired) {
      existing.desired = desired;
      existing.changedAt = now;
    }
    existing.lastUpdatedAt = now;
    this.layerDurations.set(key, existing);
    return existing;
  }
}

export function createProducerDynacastEventName(type: ProducerDynacastEventType): 'producer:layers-needed' | 'producer:layers-unneeded' | 'producer:dynacast-updated' {
  switch (type) {
    case 'layers-needed':
      return 'producer:layers-needed';
    case 'layers-unneeded':
      return 'producer:layers-unneeded';
    case 'updated':
      return 'producer:dynacast-updated';
    default:
      return 'producer:dynacast-updated';
  }
}

function layerSatisfiesDemand(layer: RtpLayerSelection, demand: RtpLayerSelection): boolean {
  if (demand.spatialLayer !== undefined && layer.spatialLayer !== demand.spatialLayer) {
    return false;
  }
  if (demand.temporalLayer === undefined || layer.temporalLayer === undefined) {
    return true;
  }
  return layer.temporalLayer <= demand.temporalLayer;
}

function demandLayers(demand: ConsumerDemand): RtpLayerSelection[] {
  const layers = [demand.currentLayers, demand.targetLayers ?? demand.preferredLayers].map((layer) => normalizeLayerSelection(layer)).filter((layer): layer is RtpLayerSelection => Boolean(layer));
  return uniqueSelections(layers);
}

function expandTemporalDemand(layer: RtpLayerSelection): RtpLayerSelection[] {
  const normalized = normalizeLayerSelection(layer);
  if (!normalized) {
    return [];
  }
  if (normalized.temporalLayer === undefined) {
    return [normalized];
  }
  const layers: RtpLayerSelection[] = [];
  for (let temporalLayer = 0; temporalLayer <= normalized.temporalLayer; temporalLayer += 1) {
    layers.push({ spatialLayer: normalized.spatialLayer, temporalLayer });
  }
  return layers;
}

function selectionFromLayer(layer: RtpLayerInfo): RtpLayerSelection {
  return normalizeLayerSelection({ spatialLayer: layer.spatialLayer, temporalLayer: layer.temporalLayer }) ?? {};
}

function uniqueSelections(layers: RtpLayerSelection[]): RtpLayerSelection[] {
  const unique = new Map<string, RtpLayerSelection>();
  for (const layer of layers) {
    const normalized = normalizeLayerSelection(layer) ?? {};
    unique.set(layerKey(normalized), normalized);
  }
  return [...unique.values()].sort(compareSelections);
}

function layerKey(layer: RtpLayerSelection): string {
  return `${layer.spatialLayer ?? 'x'}:${layer.temporalLayer ?? 'x'}`;
}

function parseLayerKey(key: string): RtpLayerSelection {
  const [spatial, temporal] = key.split(':');
  return {
    spatialLayer: spatial === 'x' ? undefined : Number(spatial),
    temporalLayer: temporal === 'x' ? undefined : Number(temporal)
  };
}

function highestLayerValue(layers: RtpLayerSelection[], key: 'spatialLayer' | 'temporalLayer'): number | undefined {
  const values = layers.map((layer) => layer[key]).filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function compareSelections(left: RtpLayerSelection, right: RtpLayerSelection): number {
  return (left.spatialLayer ?? -1) - (right.spatialLayer ?? -1) || (left.temporalLayer ?? -1) - (right.temporalLayer ?? -1);
}

export function sameSelectionSet(left: RtpLayerSelection[], right: RtpLayerSelection[]): boolean {
  const normalizedLeft = uniqueSelections(left);
  const normalizedRight = uniqueSelections(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((layer, index) => sameLayer(layer, normalizedRight[index]));
}
