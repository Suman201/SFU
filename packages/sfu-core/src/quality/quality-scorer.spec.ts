import { computeQualityScore } from './quality-scorer';

describe('quality scorer', () => {
  it('classifies stable transport as excellent', () => {
    const score = computeQualityScore({
      packetLoss: 0.001,
      rtt: 40,
      jitter: 4,
      delayVariationMs: 4,
      overuseState: 'normal',
      allocationRatio: 1,
      now: 1000
    });

    expect(score.level).toBe('excellent');
    expect(score.score).toBeGreaterThanOrEqual(85);
    expect(score.reasons).toEqual(['stable']);
  });

  it('reports loss, delay, overuse, repair, and allocation pressure', () => {
    const score = computeQualityScore({
      packetLoss: 0.12,
      rtt: 420,
      jitter: 90,
      delayVariationMs: 95,
      overuseState: 'overuse',
      pacingQueueBytes: 512_000,
      retransmissionFailureRate: 0.25,
      allocationRatio: 0.5,
      now: 1000
    });

    expect(['poor', 'critical']).toContain(score.level);
    expect(score.score).toBeLessThan(55);
    for (const reason of ['packet_loss', 'high_rtt', 'high_jitter', 'overuse', 'pacing_queue', 'retransmission_loss', 'bandwidth_limited'] as const) {
      expect(score.reasons.includes(reason)).toBe(true);
    }
  });
});
