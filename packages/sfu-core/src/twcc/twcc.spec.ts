import { parseRtcpCompound } from '../rtcp/rtcp-packet';
import { createTransportWideCcFeedback, parseTransportWideCcFeedback, TwccArrivalTracker, twccMetricsFromFeedback } from './twcc';

describe('TWCC', () => {
  it('creates and parses transport-wide congestion-control feedback with loss', () => {
    const packet = createTransportWideCcFeedback({
      senderSsrc: 111,
      mediaSsrc: 222,
      feedbackPacketCount: 7,
      arrivals: [
        { sequenceNumber: 1000, arrivalTimeMs: 64000, size: 1200 },
        { sequenceNumber: 1001, arrivalTimeMs: 64005, size: 1200 },
        { sequenceNumber: 1003, arrivalTimeMs: 64020, size: 1200 }
      ]
    });

    const parsed = parseTransportWideCcFeedback(parseRtcpCompound(packet)[0]!);

    expect(parsed?.senderSsrc).toBe(111);
    expect(parsed?.mediaSsrc).toBe(222);
    expect(parsed?.feedbackPacketCount).toBe(7);
    expect(parsed?.statuses.map((status) => [status.sequenceNumber, status.received])).toEqual([
      [1000, true],
      [1001, true],
      [1002, false],
      [1003, true]
    ]);
    expect(twccMetricsFromFeedback(parsed!).packetLoss).toBe(0.25);
  });

  it('tracks arrival timeline and delay variation', () => {
    const tracker = new TwccArrivalTracker();
    tracker.recordArrival({ sequenceNumber: 10, arrivalTimeMs: 1000, size: 100 });
    tracker.recordArrival({ sequenceNumber: 11, arrivalTimeMs: 1010, size: 100 });
    tracker.recordArrival({ sequenceNumber: 13, arrivalTimeMs: 1040, size: 100 });

    const snapshot = tracker.snapshot();

    expect(snapshot.receivedPackets).toBe(3);
    expect(snapshot.expectedPackets).toBe(4);
    expect(snapshot.packetLoss).toBe(0.25);
    expect(snapshot.delayVariationMs).toBeGreaterThan(0);
    expect(tracker.createFeedback(1, 2)).toBeInstanceOf(Buffer);
  });
});
