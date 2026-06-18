import { createFir, createNack, createPli, createReceiverReport, createRemb, createSenderReport } from './rtcp-packet';
import { RtcpProcessor } from './rtcp-processor';

describe('RtcpProcessor', () => {
  it('aggregates reports and feedback from compound RTCP packets', () => {
    const senderReports: number[] = [];
    const receiverReports: number[] = [];
    const nacks: number[][] = [];
    const plis: number[] = [];
    const firs: number[] = [];
    const rembs: number[] = [];
    const processor = new RtcpProcessor({
      onSenderReport: (_roomId, _participantId, report) => senderReports.push(report.senderSsrc),
      onReceiverReport: (_roomId, _participantId, report) => receiverReports.push(report.ssrc),
      onNack: (_roomId, _participantId, feedback) => nacks.push(feedback.lostPacketIds),
      onPli: (_roomId, _participantId, feedback) => plis.push(feedback.mediaSsrc),
      onFir: (_roomId, _participantId, feedback) => firs.push(...feedback.entries.map((entry) => entry.ssrc)),
      onRemb: (_roomId, _participantId, feedback) => rembs.push(feedback.bitrateBps)
    });
    const receiverReportBlock = {
      ssrc: 222,
      fractionLost: 0.25,
      packetsLost: 4,
      highestSequence: 90,
      jitter: 7,
      lastSenderReport: 11,
      delaySinceLastSenderReport: 12
    };
    const compound = Buffer.concat([
      createSenderReport({
        senderSsrc: 111,
        ntpTimestamp: 1n,
        rtpTimestamp: 2,
        packetCount: 3,
        octetCount: 4
      }),
      createReceiverReport({ reporterSsrc: 333, reports: [receiverReportBlock] }),
      createNack({ senderSsrc: 333, mediaSsrc: 222, lostPacketIds: [10, 11] }),
      createPli({ senderSsrc: 333, mediaSsrc: 222 }),
      createFir({ senderSsrc: 333, mediaSsrc: 0, entries: [{ ssrc: 222, sequenceNumber: 5 }] }),
      createRemb({ senderSsrc: 333, mediaSsrc: 0, bitrateBps: 800_000, ssrcs: [222] })
    ]);

    const feedback = processor.process('room-1', 'viewer', compound);

    expect(feedback.senderReports.map((report) => report.senderSsrc)).toEqual([111]);
    expect(feedback.receiverReportPackets.map((report) => report.reporterSsrc)).toEqual([333]);
    expect(feedback.receiverReports).toEqual([receiverReportBlock]);
    expect(feedback.nackPacketIds).toEqual([10, 11]);
    expect(feedback.pliSsrcs).toEqual([222]);
    expect(feedback.firSsrcs).toEqual([222]);
    expect(feedback.rembs.map((remb) => remb.bitrateBps)).toEqual([800_000]);
    expect(senderReports).toEqual([111]);
    expect(receiverReports).toEqual([222]);
    expect(nacks).toEqual([[10, 11]]);
    expect(plis).toEqual([222]);
    expect(firs).toEqual([222]);
    expect(rembs).toEqual([800_000]);
  });

  it('skips unknown padded packets and continues parsing known packets in the same compound frame', () => {
    const processor = new RtcpProcessor();
    const receiverReportBlock = {
      ssrc: 222,
      fractionLost: 0.25,
      packetsLost: 4,
      highestSequence: 90,
      jitter: 7,
      lastSenderReport: 11,
      delaySinceLastSenderReport: 12
    };
    const compound = Buffer.concat([
      createReceiverReport({ reporterSsrc: 333, reports: [receiverReportBlock] }),
      createUnknownRtcpPacketWithPadding(207, 2, Buffer.from([0xfa, 0xce, 0xb0])),
      createNack({ senderSsrc: 333, mediaSsrc: 222, lostPacketIds: [10, 11] })
    ]);

    const feedback = processor.process('room-1', 'viewer', compound);

    expect(feedback.receiverReportPackets.map((report) => report.reporterSsrc)).toEqual([333]);
    expect(feedback.receiverReports).toEqual([receiverReportBlock]);
    expect(feedback.nackPacketIds).toEqual([10, 11]);
  });
});

function createUnknownRtcpPacketWithPadding(type: number, count: number, payload: Buffer): Buffer {
  const paddingLength = (4 - ((payload.length + 1) % 4)) % 4 + 1;
  const buffer = Buffer.alloc(4 + payload.length + paddingLength);
  buffer[0] = 0xa0 | (count & 0x1f);
  buffer[1] = type & 0xff;
  buffer.writeUInt16BE(buffer.length / 4 - 1, 2);
  payload.copy(buffer, 4);
  buffer[buffer.length - 1] = paddingLength;
  return buffer;
}
