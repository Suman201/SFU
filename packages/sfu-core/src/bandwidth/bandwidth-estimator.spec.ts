import { BandwidthEstimator } from './bandwidth-estimator';

describe('BandwidthEstimator', () => {
  it('combines packet samples with TWCC loss and delay observations', () => {
    const estimator = new BandwidthEstimator();

    estimator.observePacket('consumer-1', 'outgoing', 1200, 1000);
    estimator.observePacket('consumer-1', 'outgoing', 1200, 1100);
    const healthy = estimator.updateTwcc('consumer-1', { packetLoss: 0.01, delayVariationMs: 5, timestamp: 1100 });
    const congested = estimator.updateTwcc('consumer-1', { packetLoss: 0.12, delayVariationMs: 150, timestamp: 1200 });

    expect(healthy.estimatedOutgoingBitrate).toBeGreaterThan(0);
    expect(congested.recommendedBitrate).toBeLessThanOrEqual(healthy.recommendedBitrate);
    expect(estimator.snapshot().length).toBe(1);
  });
});
