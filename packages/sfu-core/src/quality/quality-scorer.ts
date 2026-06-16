import type { QualityIssueReason, QualityScore, QualityNetworkState } from '@native-sfu/contracts';
import type { BandwidthEstimate, OveruseState } from '../bandwidth/bandwidth-estimator';

export interface QualityScoreInput {
  packetLoss?: number;
  rtt?: number;
  jitter?: number;
  delayVariationMs?: number;
  overuseState?: OveruseState;
  pacingQueueBytes?: number;
  retransmissionFailureRate?: number;
  allocationRatio?: number;
  staleMs?: number;
  additionalReasons?: QualityIssueReason[];
  now?: number;
}

export function computeQualityScore(input: QualityScoreInput = {}): QualityScore {
  const packetLoss = clamp01(input.packetLoss ?? 0);
  const rtt = Math.max(0, input.rtt ?? 0);
  const jitter = Math.max(0, input.jitter ?? input.delayVariationMs ?? 0);
  const delayVariationMs = Math.max(0, input.delayVariationMs ?? jitter);
  const queuePenalty = queueScorePenalty(input.pacingQueueBytes ?? 0);
  const allocationRatio = input.allocationRatio === undefined ? 1 : clamp01(input.allocationRatio);
  const retransmissionFailureRate = clamp01(input.retransmissionFailureRate ?? 0);
  const packetLossScore = clampScore(100 - 55 * clamp01((packetLoss - 0.01) / 0.14));
  const rttScore = clampScore(100 - 15 * clamp01((rtt - 150) / 450));
  const jitterScore = clampScore(100 - 20 * clamp01((delayVariationMs - 20) / 100));
  const congestionScore = clampScore(100 - overusePenalty(input.overuseState) - queuePenalty);
  const retransmissionScore = clampScore(100 - 35 * retransmissionFailureRate);
  const allocationScore = clampScore(100 * allocationRatio);
  let score = Math.min(packetLossScore, rttScore, jitterScore, congestionScore, retransmissionScore, allocationScore);
  if ((input.staleMs ?? 0) > 5000) {
    score = Math.min(score, 55);
  }
  const reasons = qualityReasons({
    packetLoss,
    rtt,
    jitter,
    delayVariationMs,
    overuseState: input.overuseState,
    pacingQueueBytes: input.pacingQueueBytes ?? 0,
    retransmissionFailureRate,
    allocationRatio,
    staleMs: input.staleMs ?? 0,
    additionalReasons: input.additionalReasons
  });
  return {
    score,
    level: qualityLevel(score),
    reasons,
    breakdown: {
      packetLossScore,
      rttScore,
      jitterScore,
      congestionScore,
      retransmissionScore,
      allocationScore
    },
    updatedAt: new Date(input.now ?? Date.now()).toISOString()
  };
}

export function combineQualityScores(scores: QualityScore[], now = Date.now()): QualityScore {
  if (scores.length === 0) {
    return computeQualityScore({ now });
  }
  const score = clampScore(scores.reduce((sum, item) => sum + item.score, 0) / scores.length);
  const reasons = [...new Set(scores.flatMap((item) => item.reasons))];
  return {
    score,
    level: qualityLevel(score),
    reasons: reasons.length > 0 ? reasons : ['stable'],
    breakdown: {
      packetLossScore: averageBreakdown(scores, 'packetLossScore'),
      rttScore: averageBreakdown(scores, 'rttScore'),
      jitterScore: averageBreakdown(scores, 'jitterScore'),
      congestionScore: averageBreakdown(scores, 'congestionScore'),
      retransmissionScore: averageBreakdown(scores, 'retransmissionScore'),
      allocationScore: averageBreakdown(scores, 'allocationScore')
    },
    updatedAt: new Date(now).toISOString()
  };
}

export function networkStateFromEstimate(estimate: BandwidthEstimate): QualityNetworkState {
  return {
    packetLoss: clamp01(estimate.packetLoss),
    rtt: Math.max(0, estimate.rtt),
    rttVariance: Math.max(0, estimate.rttVariance),
    jitter: Math.max(0, estimate.jitter || estimate.delayVariationMs),
    delayVariationMs: Math.max(0, estimate.delayVariationMs),
    congestionState: estimate.overuseState
  };
}

export function qualityLevel(score: number): QualityScore['level'] {
  if (score >= 85) {
    return 'excellent';
  }
  if (score >= 70) {
    return 'good';
  }
  if (score >= 55) {
    return 'fair';
  }
  if (score >= 40) {
    return 'poor';
  }
  return 'critical';
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function qualityReasons(input: {
  packetLoss: number;
  rtt: number;
  jitter: number;
  delayVariationMs: number;
  overuseState?: OveruseState;
  pacingQueueBytes: number;
  retransmissionFailureRate: number;
  allocationRatio: number;
  staleMs: number;
  additionalReasons?: QualityIssueReason[];
}): QualityIssueReason[] {
  const reasons: QualityIssueReason[] = [];
  if (input.packetLoss >= 0.03) {
    reasons.push('packet_loss');
  }
  if (input.rtt >= 300) {
    reasons.push('high_rtt');
  }
  if (input.jitter >= 50 || input.delayVariationMs >= 50) {
    reasons.push('high_jitter');
  }
  if (input.overuseState === 'overuse') {
    reasons.push('overuse');
  }
  if (input.overuseState === 'underuse') {
    reasons.push('underuse');
  }
  if (input.pacingQueueBytes > 256_000) {
    reasons.push('pacing_queue');
  }
  if (input.retransmissionFailureRate >= 0.1) {
    reasons.push('retransmission_loss');
  }
  if (input.allocationRatio < 0.85) {
    reasons.push('bandwidth_limited');
  }
  if (input.staleMs > 5000) {
    reasons.push('probe_pending');
  }
  for (const reason of input.additionalReasons ?? []) {
    reasons.push(reason);
  }
  return [...new Set(reasons.length > 0 ? reasons : (['stable'] satisfies QualityIssueReason[]))];
}

function overusePenalty(state: OveruseState | undefined): number {
  if (state === 'overuse') {
    return 25;
  }
  if (state === 'underuse') {
    return 4;
  }
  return 0;
}

function queueScorePenalty(queueBytes: number): number {
  if (queueBytes <= 64_000) {
    return 0;
  }
  return Math.min(30, (queueBytes - 64_000) / 16_000);
}

function averageBreakdown(scores: QualityScore[], key: keyof QualityScore['breakdown']): number {
  return clampScore(scores.reduce((sum, item) => sum + item.breakdown[key], 0) / scores.length);
}
