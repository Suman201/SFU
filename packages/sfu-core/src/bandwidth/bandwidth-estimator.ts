export interface BandwidthSample {
  timestamp: number;
  bytes: number;
  rtt: number;
  packetLoss: number;
  direction?: 'incoming' | 'outgoing';
  delayVariationMs?: number;
  sendDeltaMs?: number;
  receiveDeltaMs?: number;
}

export type OveruseState = 'normal' | 'underuse' | 'overuse';

export interface BandwidthEstimate {
  id: string;
  estimatedIncomingBitrate: number;
  estimatedOutgoingBitrate: number;
  availableBitrate: number;
  recommendedBitrate: number;
  packetLoss: number;
  rtt: number;
  rttVariance: number;
  jitter: number;
  delayVariationMs: number;
  delayTrend: number;
  overuseState: OveruseState;
  probeBitrate: number;
  lossCorrelation: number;
  updatedAt: number;
}

export interface TwccBandwidthObservation {
  packetLoss: number;
  delayVariationMs: number;
  rtt?: number;
  jitter?: number;
  sendDeltaMs?: number;
  receiveDeltaMs?: number;
  timestamp?: number;
}

export interface ProbeClusterSnapshot {
  id: number;
  targetBitrateBps: number;
  measuredBitrateBps: number;
  startedAt: number;
  completedAt?: number;
  bytes: number;
  packets: number;
  status: 'active' | 'succeeded' | 'failed';
  failureReason?: string;
}

export interface BandwidthEstimateHistoryEntry {
  timestamp: number;
  availableBitrate: number;
  recommendedBitrate: number;
  packetLoss: number;
  rtt: number;
  overuseState: OveruseState;
}

export interface CongestionEvent {
  type: 'overuse' | 'recovery' | 'probe-succeeded' | 'probe-failed';
  timestamp: number;
  packetLoss: number;
  rtt: number;
  availableBitrate: number;
  details?: Record<string, number | string>;
}

export interface BandwidthEstimatorStats {
  estimate: BandwidthEstimate;
  history: BandwidthEstimateHistoryEntry[];
  events: CongestionEvent[];
  probes: ProbeClusterSnapshot[];
}

type BandwidthDirection = 'incoming' | 'outgoing';

interface DirectionSample {
  timestamp: number;
  bytes: number;
}

interface EstimatorState {
  incoming: DirectionSample[];
  outgoing: DirectionSample[];
  trendline: GccTrendlineEstimator;
  overuseDetector: OveruseDetector;
  probeController: ProbeClusterController;
  packetLoss: number;
  rtt: number;
  rttVariance: number;
  jitter: number;
  delayVariationMs: number;
  delayTrend: number;
  overuseState: OveruseState;
  previousOveruseState: OveruseState;
  probeBitrate: number;
  lossCorrelation: number;
  availableBitrate: number;
  updatedAt: number;
  history: BandwidthEstimateHistoryEntry[];
  events: CongestionEvent[];
}

export class BandwidthEstimator {
  private readonly states = new Map<string, EstimatorState>();

  addSample(participantId: string, sample: BandwidthSample): number {
    this.observePacket(participantId, sample.direction ?? 'incoming', sample.bytes, sample.timestamp);
    this.updateNetworkObservation(participantId, {
      packetLoss: sample.packetLoss,
      delayVariationMs: sample.delayVariationMs ?? 0,
      rtt: sample.rtt,
      sendDeltaMs: sample.sendDeltaMs,
      receiveDeltaMs: sample.receiveDeltaMs,
      timestamp: sample.timestamp
    });
    return this.estimate(participantId).availableBitrate;
  }

  observePacket(id: string, direction: BandwidthDirection, bytes: number, timestamp = Date.now()): BandwidthEstimate {
    const state = this.state(id);
    const samples = state[direction];
    samples.push({ timestamp, bytes: Math.max(0, bytes) });
    while (samples.length > 256 || (samples[0] && timestamp - samples[0].timestamp > 5000)) {
      samples.shift();
    }
    state.updatedAt = timestamp;
    return this.recalculate(id);
  }

  updateTwcc(id: string, observation: TwccBandwidthObservation): BandwidthEstimate {
    return this.updateNetworkObservation(id, observation);
  }

  startProbeCluster(id: string, targetBitrateBps: number, timestamp = Date.now()): ProbeClusterSnapshot {
    return this.state(id).probeController.start(targetBitrateBps, timestamp);
  }

  recordProbeResult(id: string, clusterId: number, bytes: number, startedAt: number, completedAt: number): BandwidthEstimate {
    const state = this.state(id);
    const result = state.probeController.recordResult(clusterId, bytes, startedAt, completedAt);
    if (result) {
      state.probeBitrate = smooth(state.probeBitrate, result.measuredBitrateBps, 0.5);
      if (result.status === 'succeeded') {
        state.availableBitrate = Math.max(state.availableBitrate, Math.floor(result.measuredBitrateBps * 0.85));
      }
      state.updatedAt = completedAt;
      this.recordEvent(state, {
        type: result.status === 'succeeded' ? 'probe-succeeded' : 'probe-failed',
        timestamp: completedAt,
        packetLoss: state.packetLoss,
        rtt: state.rtt,
        availableBitrate: state.availableBitrate,
        details: {
          clusterId: result.id,
          targetBitrateBps: result.targetBitrateBps,
          measuredBitrateBps: result.measuredBitrateBps
        }
      });
    }
    return this.recalculate(id);
  }

  failProbeCluster(id: string, clusterId: number, reason: string, timestamp = Date.now()): BandwidthEstimate {
    const state = this.state(id);
    const result = state.probeController.fail(clusterId, reason, timestamp);
    if (result) {
      this.recordEvent(state, {
        type: 'probe-failed',
        timestamp,
        packetLoss: state.packetLoss,
        rtt: state.rtt,
        availableBitrate: state.availableBitrate,
        details: {
          clusterId: result.id,
          targetBitrateBps: result.targetBitrateBps,
          measuredBitrateBps: result.measuredBitrateBps,
          reason
        }
      });
    }
    return this.recalculate(id);
  }

  probeClusters(id: string): ProbeClusterSnapshot[] {
    return this.state(id).probeController.snapshot();
  }

  history(id: string): BandwidthEstimateHistoryEntry[] {
    return [...this.state(id).history];
  }

  events(id: string): CongestionEvent[] {
    return [...this.state(id).events];
  }

  stats(id: string): BandwidthEstimatorStats {
    return {
      estimate: this.estimate(id),
      history: this.history(id),
      events: this.events(id),
      probes: this.probeClusters(id)
    };
  }

  estimate(id: string): BandwidthEstimate {
    const state = this.state(id);
    const incoming = bitrateFromSamples(state.incoming);
    const outgoing = bitrateFromSamples(state.outgoing);
    return {
      id,
      estimatedIncomingBitrate: incoming,
      estimatedOutgoingBitrate: outgoing,
      availableBitrate: state.availableBitrate,
      recommendedBitrate: recommendedBitrate(state.availableBitrate, state.packetLoss, state.delayVariationMs),
      packetLoss: state.packetLoss,
      rtt: state.rtt,
      rttVariance: state.rttVariance,
      jitter: state.jitter,
      delayVariationMs: state.delayVariationMs,
      delayTrend: state.delayTrend,
      overuseState: state.overuseState,
      probeBitrate: state.probeBitrate,
      lossCorrelation: state.lossCorrelation,
      updatedAt: state.updatedAt
    };
  }

  snapshot(): BandwidthEstimate[] {
    return [...this.states.keys()].map((id) => this.estimate(id));
  }

  private updateNetworkObservation(id: string, observation: TwccBandwidthObservation): BandwidthEstimate {
    const state = this.state(id);
    const timestamp = observation.timestamp ?? Date.now();
    state.packetLoss = smooth(state.packetLoss, clamp(observation.packetLoss, 0, 1), 0.35);
    state.delayVariationMs = smooth(state.delayVariationMs, Math.max(0, observation.delayVariationMs), 0.35);
    if (observation.rtt !== undefined) {
      const nextRtt = Math.max(0, observation.rtt);
      const previousRtt = state.rtt;
      state.rtt = smooth(state.rtt, nextRtt, 0.25);
      state.rttVariance = smooth(state.rttVariance, Math.abs(nextRtt - previousRtt), 0.25);
    }
    state.jitter = smooth(state.jitter, Math.max(0, observation.jitter ?? observation.delayVariationMs), 0.25);
    state.lossCorrelation = smooth(state.lossCorrelation, state.packetLoss * (state.rtt || 1), 0.2);
    if (observation.sendDeltaMs !== undefined && observation.receiveDeltaMs !== undefined) {
      state.delayTrend = state.trendline.addSample({
        timestamp,
        sendDeltaMs: Math.max(0, observation.sendDeltaMs),
        receiveDeltaMs: Math.max(0, observation.receiveDeltaMs)
      });
      state.overuseState = state.overuseDetector.detect(state.delayTrend, timestamp);
      this.recordCongestionTransition(state, timestamp);
    }
    state.updatedAt = timestamp;
    return this.recalculate(id);
  }

  private recalculate(id: string): BandwidthEstimate {
    const state = this.state(id);
    const incoming = bitrateFromSamples(state.incoming);
    const outgoing = bitrateFromSamples(state.outgoing);
    const observedBitrate = Math.max(incoming, outgoing, state.availableBitrate || 300_000);
    const lossPenalty = lossBasedPenalty(state.packetLoss);
    const delayPenalty = delayBasedPenalty(state.delayVariationMs);
    const rttPenalty = state.rtt > 450 ? 0.7 : state.rtt > 250 ? 0.85 : 1;
    const overusePenalty = state.overuseState === 'overuse' ? 0.75 : state.overuseState === 'underuse' ? 1.08 : 1;
    const probeCeiling = state.probeBitrate > 0 && state.overuseState !== 'overuse' ? Math.floor(state.probeBitrate * 0.9) : 0;
    const target = Math.max(80_000, probeCeiling, Math.floor(observedBitrate * lossPenalty * delayPenalty * rttPenalty * overusePenalty));
    state.availableBitrate = state.availableBitrate === 0 ? target : Math.floor(smooth(state.availableBitrate, target, 0.25));
    const estimate = this.estimate(id);
    this.recordHistory(state, estimate);
    return estimate;
  }

  private state(id: string): EstimatorState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        incoming: [],
        outgoing: [],
        trendline: new GccTrendlineEstimator(),
        overuseDetector: new OveruseDetector(),
        probeController: new ProbeClusterController(),
        packetLoss: 0,
        rtt: 0,
        rttVariance: 0,
        jitter: 0,
        delayVariationMs: 0,
        delayTrend: 0,
        overuseState: 'normal',
        previousOveruseState: 'normal',
        probeBitrate: 0,
        lossCorrelation: 0,
        availableBitrate: 0,
        updatedAt: Date.now(),
        history: [],
        events: []
      };
      this.states.set(id, state);
    }
    return state;
  }

  private recordHistory(state: EstimatorState, estimate: BandwidthEstimate): void {
    const last = state.history[state.history.length - 1];
    if (last && last.timestamp === estimate.updatedAt) {
      state.history[state.history.length - 1] = toHistoryEntry(estimate);
    } else {
      state.history.push(toHistoryEntry(estimate));
    }
    while (state.history.length > 256) {
      state.history.shift();
    }
  }

  private recordCongestionTransition(state: EstimatorState, timestamp: number): void {
    if (state.previousOveruseState === state.overuseState) {
      return;
    }
    if (state.overuseState === 'overuse') {
      this.recordEvent(state, {
        type: 'overuse',
        timestamp,
        packetLoss: state.packetLoss,
        rtt: state.rtt,
        availableBitrate: state.availableBitrate,
        details: { delayTrend: state.delayTrend }
      });
    }
    if (state.previousOveruseState === 'overuse' && state.overuseState !== 'overuse') {
      this.recordEvent(state, {
        type: 'recovery',
        timestamp,
        packetLoss: state.packetLoss,
        rtt: state.rtt,
        availableBitrate: state.availableBitrate,
        details: { delayTrend: state.delayTrend }
      });
    }
    state.previousOveruseState = state.overuseState;
  }

  private recordEvent(state: EstimatorState, event: CongestionEvent): void {
    state.events.push(event);
    while (state.events.length > 128) {
      state.events.shift();
    }
  }
}

export interface GccTrendlineSample {
  timestamp: number;
  sendDeltaMs: number;
  receiveDeltaMs: number;
}

export class GccTrendlineEstimator {
  private readonly samples: Array<{ timestamp: number; smoothedDelayMs: number }> = [];
  private accumulatedDelayMs = 0;
  private smoothedDelayMs = 0;

  constructor(private readonly windowSize = 20, private readonly smoothing = 0.9) {}

  addSample(sample: GccTrendlineSample): number {
    const delayDelta = sample.receiveDeltaMs - sample.sendDeltaMs;
    this.accumulatedDelayMs += delayDelta;
    this.smoothedDelayMs = this.samples.length === 0 ? this.accumulatedDelayMs : this.smoothing * this.smoothedDelayMs + (1 - this.smoothing) * this.accumulatedDelayMs;
    this.samples.push({ timestamp: sample.timestamp, smoothedDelayMs: this.smoothedDelayMs });
    while (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
    return this.trend();
  }

  trend(): number {
    if (this.samples.length < 2) {
      return 0;
    }
    const firstTimestamp = this.samples[0]!.timestamp;
    const xs = this.samples.map((sample) => sample.timestamp - firstTimestamp);
    const ys = this.samples.map((sample) => sample.smoothedDelayMs);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < xs.length; index += 1) {
      numerator += (xs[index]! - meanX) * (ys[index]! - meanY);
      denominator += (xs[index]! - meanX) ** 2;
    }
    return denominator === 0 ? 0 : numerator / denominator;
  }
}

export class OveruseDetector {
  private threshold = 12.5;
  private lastState: OveruseState = 'normal';
  private overuseStartedAt?: number;

  detect(trendlineSlope: number, timestamp: number): OveruseState {
    const modifiedTrend = trendlineSlope * 1000;
    let state: OveruseState = 'normal';
    if (modifiedTrend > this.threshold) {
      this.overuseStartedAt ??= timestamp;
      state = timestamp - this.overuseStartedAt >= 10 ? 'overuse' : this.lastState;
    } else {
      this.overuseStartedAt = undefined;
      if (modifiedTrend < -this.threshold) {
        state = 'underuse';
      }
    }
    this.threshold = smooth(this.threshold, state === 'normal' ? 12.5 : Math.max(6, Math.min(25, Math.abs(modifiedTrend))), 0.01);
    this.lastState = state;
    return state;
  }
}

class ProbeClusterController {
  private nextId = 1;
  private readonly clusters = new Map<number, ProbeClusterSnapshot>();

  start(targetBitrateBps: number, timestamp: number): ProbeClusterSnapshot {
    const snapshot: ProbeClusterSnapshot = {
      id: this.nextId++,
      targetBitrateBps: Math.max(80_000, Math.floor(targetBitrateBps)),
      measuredBitrateBps: 0,
      startedAt: timestamp,
      bytes: 0,
      packets: 0,
      status: 'active'
    };
    this.clusters.set(snapshot.id, snapshot);
    return { ...snapshot };
  }

  recordResult(clusterId: number, bytes: number, startedAt: number, completedAt: number): ProbeClusterSnapshot | undefined {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      return undefined;
    }
    const elapsedSeconds = Math.max((completedAt - startedAt) / 1000, 0.001);
    cluster.bytes += Math.max(0, bytes);
    cluster.packets += 1;
    cluster.completedAt = completedAt;
    cluster.measuredBitrateBps = Math.floor((cluster.bytes * 8) / elapsedSeconds);
    cluster.status = cluster.measuredBitrateBps >= cluster.targetBitrateBps * 0.8 ? 'succeeded' : 'failed';
    cluster.failureReason = cluster.status === 'failed' ? 'measured_bitrate_below_target' : undefined;
    return { ...cluster };
  }

  fail(clusterId: number, reason: string, timestamp: number): ProbeClusterSnapshot | undefined {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      return undefined;
    }
    cluster.completedAt = timestamp;
    cluster.status = 'failed';
    cluster.failureReason = reason;
    return { ...cluster };
  }

  snapshot(): ProbeClusterSnapshot[] {
    return [...this.clusters.values()].map((cluster) => ({ ...cluster }));
  }
}

function bitrateFromSamples(samples: DirectionSample[]): number {
  if (samples.length < 2) {
    return 0;
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const elapsedSeconds = Math.max((last.timestamp - first.timestamp) / 1000, 0.001);
  const bytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  return Math.floor((bytes * 8) / elapsedSeconds);
}

function lossBasedPenalty(packetLoss: number): number {
  if (packetLoss <= 0.02) {
    return 1.08;
  }
  if (packetLoss <= 0.05) {
    return 0.9;
  }
  if (packetLoss <= 0.1) {
    return 0.7;
  }
  return 0.5;
}

function delayBasedPenalty(delayVariationMs: number): number {
  if (delayVariationMs <= 20) {
    return 1;
  }
  if (delayVariationMs <= 60) {
    return 0.85;
  }
  if (delayVariationMs <= 120) {
    return 0.7;
  }
  return 0.55;
}

function recommendedBitrate(availableBitrate: number, packetLoss: number, delayVariationMs: number): number {
  const guard = packetLoss > 0.08 || delayVariationMs > 80 ? 0.75 : 0.9;
  return Math.max(60_000, Math.floor(availableBitrate * guard));
}

function toHistoryEntry(estimate: BandwidthEstimate): BandwidthEstimateHistoryEntry {
  return {
    timestamp: estimate.updatedAt,
    availableBitrate: estimate.availableBitrate,
    recommendedBitrate: estimate.recommendedBitrate,
    packetLoss: estimate.packetLoss,
    rtt: estimate.rtt,
    overuseState: estimate.overuseState
  };
}

function smooth(current: number, next: number, weight: number): number {
  if (current === 0) {
    return next;
  }
  return current * (1 - weight) + next * weight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
