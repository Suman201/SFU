import { parseRtcpCompound } from '../rtcp/rtcp-packet';
import { createTransportWideCcFeedback, parseTransportWideCcFeedback, TwccArrivalTracker, TwccFeedbackScheduler, TwccSendHistory, twccMetricsFromFeedback } from './twcc';

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

  it('schedules compact feedback containing only new arrivals and newly observed gaps', () => {
    let now = 1000;
    const tracker = new TwccArrivalTracker();
    const scheduler = new TwccFeedbackScheduler(tracker, { intervalMs: 50, compact: true, now: () => now });
    tracker.recordArrival({ sequenceNumber: 10, arrivalTimeMs: 1000, size: 100 });
    tracker.recordArrival({ sequenceNumber: 11, arrivalTimeMs: 1010, size: 100 });

    expect(scheduler.maybeCreateFeedback(1, 2)).toBeInstanceOf(Buffer);
    tracker.recordArrival({ sequenceNumber: 13, arrivalTimeMs: 1040, size: 100 });
    expect(scheduler.maybeCreateFeedback(1, 2)).toBeNull();
    now += 60;
    const compact = scheduler.maybeCreateFeedback(1, 2);
    const parsed = parseTransportWideCcFeedback(parseRtcpCompound(compact!)[0]!);

    expect(parsed?.statuses.map((status) => [status.sequenceNumber, status.received])).toEqual([
      [12, false],
      [13, true]
    ]);
  });

  it('correlates TWCC feedback with send history for accurate send and receive deltas', () => {
    const history = new TwccSendHistory();
    history.recordSend({ sequenceNumber: 10, sentAtMs: 1000, size: 1200, ssrc: 1111 });
    history.recordSend({ sequenceNumber: 11, sentAtMs: 1020, size: 1200, ssrc: 1111 });
    history.recordSend({ sequenceNumber: 12, sentAtMs: 1040, size: 1200, ssrc: 1111 });
    const feedback = parseTransportWideCcFeedback(
      parseRtcpCompound(
        createTransportWideCcFeedback({
          senderSsrc: 1,
          mediaSsrc: 2,
          feedbackPacketCount: 1,
          arrivals: [
            { sequenceNumber: 10, arrivalTimeMs: 64000, size: 1200 },
            { sequenceNumber: 12, arrivalTimeMs: 64060, size: 1200 }
          ]
        })
      )[0]!
    )!;

    const correlation = history.correlate(feedback, 1100);

    expect(correlation.correlatedPackets).toBe(2);
    expect(correlation.missingSequences).toEqual([11]);
    expect(correlation.meanSendDeltaMs).toBe(40);
    expect(correlation.meanReceiveDeltaMs).toBe(60);
    expect(correlation.delayVariationMs).toBe(20);
    expect(correlation.rttMs).toBe(60);
    expect(history.snapshot().sentPackets).toBe(3);
  });
});
