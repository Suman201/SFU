export interface BandwidthSample {
  timestamp: number;
  bytes: number;
  rtt: number;
  packetLoss: number;
  direction?: 'incoming' | 'outgoing';
  delayVariationMs?: number;
}

export interface BandwidthEstimate {
  id: string;
  estimatedIncomingBitrate: number;
  estimatedOutgoingBitrate: number;
  availableBitrate: number;
  recommendedBitrate: number;
  packetLoss: number;
  rtt: number;
  jitter: number;
  delayVariationMs: number;
  updatedAt: number;
}

export interface TwccBandwidthObservation {
  packetLoss: number;
  delayVariationMs: number;
  rtt?: number;
  jitter?: number;
  timestamp?: number;
}

type BandwidthDirection = 'incoming' | 'outgoing';

interface DirectionSample {
  timestamp: number;
  bytes: number;
}

interface EstimatorState {
  incoming: DirectionSample[];
  outgoing: DirectionSample[];
  packetLoss: number;
  rtt: number;
  jitter: number;
  delayVariationMs: number;
  availableBitrate: number;
  updatedAt: number;
}

export class BandwidthEstimator {
  private readonly states = new Map<string, EstimatorState>();

  addSample(participantId: string, sample: BandwidthSample): number {
    this.observePacket(participantId, sample.direction ?? 'incoming', sample.bytes, sample.timestamp);
    this.updateNetworkObservation(participantId, {
      packetLoss: sample.packetLoss,
      delayVariationMs: sample.delayVariationMs ?? 0,
      rtt: sample.rtt,
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
      jitter: state.jitter,
      delayVariationMs: state.delayVariationMs,
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
    state.rtt = smooth(state.rtt, Math.max(0, observation.rtt ?? state.rtt), observation.rtt === undefined ? 0 : 0.25);
    state.jitter = smooth(state.jitter, Math.max(0, observation.jitter ?? observation.delayVariationMs), 0.25);
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
    const target = Math.max(80_000, Math.floor(observedBitrate * lossPenalty * delayPenalty * rttPenalty));
    state.availableBitrate = state.availableBitrate === 0 ? target : Math.floor(smooth(state.availableBitrate, target, 0.25));
    return this.estimate(id);
  }

  private state(id: string): EstimatorState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        incoming: [],
        outgoing: [],
        packetLoss: 0,
        rtt: 0,
        jitter: 0,
        delayVariationMs: 0,
        availableBitrate: 0,
        updatedAt: Date.now()
      };
      this.states.set(id, state);
    }
    return state;
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

function smooth(current: number, next: number, weight: number): number {
  if (current === 0) {
    return next;
  }
  return current * (1 - weight) + next * weight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
