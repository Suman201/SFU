import { BandwidthEstimator } from './bandwidth-estimator';

describe('BandwidthEstimator', () => {
  it('combines packet samples with TWCC loss and delay observations', () => {
    const estimator = new BandwidthEstimator();

    estimator.observePacket('consumer-1', 'outgoing', 1200, 1000);
    estimator.observePacket('consumer-1', 'outgoing', 1200, 1100);
    const healthy = estimator.updateTwcc('consumer-1', { packetLoss: 0.01, delayVariationMs: 5, rtt: 40, timestamp: 1100 });
    const congested = estimator.updateTwcc('consumer-1', { packetLoss: 0.12, delayVariationMs: 150, rtt: 100, timestamp: 1200 });

    expect(healthy.estimatedOutgoingBitrate).toBeGreaterThan(0);
    expect(congested.recommendedBitrate).toBeLessThanOrEqual(healthy.recommendedBitrate);
    expect(congested.rttVariance).toBeGreaterThan(0);
    expect(congested.lossCorrelation).toBeGreaterThan(0);
    expect(estimator.snapshot().length).toBe(1);
  });

  it('detects GCC-style overuse and applies probe ramp-up results', () => {
    const estimator = new BandwidthEstimator();

    estimator.observePacket('consumer-1', 'outgoing', 1200, 1000);
    estimator.observePacket('consumer-1', 'outgoing', 1200, 1100);
    let estimate = estimator.updateTwcc('consumer-1', { packetLoss: 0, delayVariationMs: 2, sendDeltaMs: 20, receiveDeltaMs: 20, timestamp: 1100 });
    for (let index = 0; index < 20; index += 1) {
      estimate = estimator.updateTwcc('consumer-1', {
        packetLoss: 0,
        delayVariationMs: 2 + index,
        sendDeltaMs: 20,
        receiveDeltaMs: 22 + index,
        timestamp: 1120 + index * 20
      });
    }

    expect(estimate.delayTrend).toBeGreaterThan(0);
    expect(estimate.overuseState).toBe('overuse');
    expect(estimator.events('consumer-1').some((event) => event.type === 'overuse')).toBe(true);

    const cluster = estimator.startProbeCluster('consumer-1', 1_500_000, 2000);
    const probed = estimator.recordProbeResult('consumer-1', cluster.id, 250_000, 2000, 3000);

    expect(estimator.probeClusters('consumer-1')[0]?.measuredBitrateBps).toBe(2_000_000);
    expect(estimator.probeClusters('consumer-1')[0]?.status).toBe('succeeded');
    expect(probed.probeBitrate).toBeGreaterThan(0);
    expect(estimator.history('consumer-1').length).toBeGreaterThan(0);
    expect(estimator.stats('consumer-1').events.some((event) => event.type === 'probe-succeeded')).toBe(true);
  });

  it('handles high-volume TWCC load observations without losing estimator state', () => {
    const estimator = new BandwidthEstimator();

    for (let index = 0; index < 2000; index += 1) {
      const timestamp = 1000 + index * 20;
      estimator.observePacket('consumer-load', 'outgoing', 1200, timestamp);
      estimator.updateTwcc('consumer-load', {
        packetLoss: index % 50 === 0 ? 0.02 : 0,
        delayVariationMs: index % 10,
        sendDeltaMs: 20,
        receiveDeltaMs: 20 + (index % 5),
        rtt: 40 + (index % 20),
        timestamp
      });
    }

    const estimate = estimator.estimate('consumer-load');
    expect(estimate.estimatedOutgoingBitrate).toBeGreaterThan(0);
    expect(estimate.recommendedBitrate).toBeGreaterThan(0);
    expect(estimate.rtt).toBeGreaterThan(0);
    expect(estimator.snapshot().length).toBe(1);
  });
});
