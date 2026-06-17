import { RtpPacket } from './rtp-packet';
import { DeterministicPacketImpairmentHarness } from './packet-impairment-harness';

describe('DeterministicPacketImpairmentHarness', () => {
  it('drops, delays, and releases packets deterministically', () => {
    let now = 1000;
    const left = new DeterministicPacketImpairmentHarness<RtpPacket>({
      lossPercentage: 35,
      baseDelayMs: 20,
      jitterMs: 5,
      seed: 41,
      now: () => now
    });
    const right = new DeterministicPacketImpairmentHarness<RtpPacket>({
      lossPercentage: 35,
      baseDelayMs: 20,
      jitterMs: 5,
      seed: 41,
      now: () => now
    });

    const leftEnqueue = [0, 1, 2, 3, 4].map((index) => left.enqueue(packet(1111, 10 + index, 90_000 + index * 3000), now + index * 10));
    const rightEnqueue = [0, 1, 2, 3, 4].map((index) => right.enqueue(packet(1111, 10 + index, 90_000 + index * 3000), now + index * 10));

    expect(leftEnqueue).toEqual(rightEnqueue);
    now = 2000;
    const leftReleased = left.drain(now);
    const rightReleased = right.drain(now);

    expect(leftReleased.map((entry) => entry.sequence)).toEqual(rightReleased.map((entry) => entry.sequence));
    expect(leftReleased.map((entry) => entry.releaseAt)).toEqual(rightReleased.map((entry) => entry.releaseAt));
    expect(left.snapshot().effectiveLossRate).toBeGreaterThanOrEqual(0);
    expect(left.snapshot().effectiveLossRate).toBeLessThanOrEqual(1);
  });

  it('applies throughput shaping on top of delay and jitter while preserving release order', () => {
    const harness = new DeterministicPacketImpairmentHarness<RtpPacket>({
      baseDelayMs: 10,
      jitterMs: 0,
      maxThroughputBps: 64_000,
      seed: 7
    });

    const first = harness.enqueue(packet(1111, 10, 90_000, 400), 1000);
    const second = harness.enqueue(packet(1111, 11, 93_000, 400), 1000);
    const third = harness.enqueue(packet(1111, 12, 96_000, 400), 1000);

    expect(first.dropped).toBe(false);
    expect(second.dropped).toBe(false);
    expect(third.dropped).toBe(false);
    expect(second.releaseAt!).toBeGreaterThan(first.releaseAt!);
    expect(third.releaseAt!).toBeGreaterThan(second.releaseAt!);

    const beforeReady = harness.drain(first.releaseAt! - 1);
    expect(beforeReady).toEqual([]);

    const flushed = harness.flushAll();
    expect(flushed.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(harness.snapshot().queuedPackets).toBe(0);
    expect(harness.snapshot().releasedPackets).toBe(3);
  });
});

function packet(ssrc: number, sequenceNumber: number, timestamp: number, payloadBytes = 120): RtpPacket {
  return new RtpPacket(2, false, false, false, 96, sequenceNumber, timestamp, ssrc, [], null, Buffer.alloc(payloadBytes, 0x11));
}
