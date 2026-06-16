import { RtpPacket } from './rtp-packet';
import { ConsumerRtpRewriter } from './rtp-rewriter';

describe('ConsumerRtpRewriter', () => {
  it('rewrites SSRC, payload type, sequence number, and timestamp while preserving deltas', () => {
    const rewriter = new ConsumerRtpRewriter({
      sequenceNumberGenerator: () => 40000,
      timestampGenerator: () => 900000
    });

    const first = rewriter.rewrite(packet(1111, 96, 10, 1000), {
      sourceSsrc: 1111,
      targetSsrc: 2222,
      sourcePayloadType: 96,
      targetPayloadType: 120
    });
    const second = rewriter.rewrite(packet(1111, 96, 11, 4000), {
      sourceSsrc: 1111,
      targetSsrc: 2222,
      sourcePayloadType: 96,
      targetPayloadType: 120
    });

    expect(first.ssrc).toBe(2222);
    expect(first.payloadType).toBe(120);
    expect(first.sequenceNumber).toBe(40000);
    expect(first.timestamp).toBe(900000);
    expect(second.sequenceNumber).toBe(40001);
    expect(second.timestamp).toBe(903000);
    expect(rewriter.sourceSequenceForTarget(2222, 40001)).toEqual({ sourceSsrc: 1111, sequenceNumber: 11 });
  });

  it('assigns contiguous target sequence numbers across filtered source gaps', () => {
    const rewriter = new ConsumerRtpRewriter({
      sequenceNumberGenerator: () => 50000,
      timestampGenerator: () => 900000
    });
    const mapping = {
      sourceSsrc: 1111,
      targetSsrc: 2222,
      sourcePayloadType: 96,
      targetPayloadType: 120
    };

    const first = rewriter.rewrite(packet(1111, 96, 10, 1000), mapping);
    const second = rewriter.rewrite(packet(1111, 96, 12, 7000), mapping);
    const repairPreview = rewriter.preview(packet(1111, 96, 10, 1000), mapping);

    expect(first.sequenceNumber).toBe(50000);
    expect(second.sequenceNumber).toBe(50001);
    expect(second.timestamp).toBe(906000);
    expect(rewriter.sourceSequenceForTarget(2222, 50001)).toEqual({ sourceSsrc: 1111, sequenceNumber: 12 });
    expect(repairPreview.sequenceNumber).toBe(50000);
  });
});

function packet(ssrc: number, payloadType: number, sequenceNumber: number, timestamp: number): RtpPacket {
  const payload = Buffer.from('rewrite');
  return new RtpPacket(2, false, false, false, payloadType, sequenceNumber, timestamp, ssrc, [], null, payload);
}
