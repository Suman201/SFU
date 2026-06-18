import {
  createFir,
  createNack,
  createPli,
  createReceiverReport,
  createRemb,
  createSenderReport,
  parseFir,
  parseNack,
  parsePli,
  parseReceiverReport,
  parseRemb,
  parseRtcpCompound,
  parseSenderReport,
  serializeRtcpPacket
} from './rtcp-packet';

describe('RTCP parsing', () => {
  it('preserves unknown padded packets inside a compound RTCP frame', () => {
    const receiverReport = createReceiverReport({
      reporterSsrc: 333,
      reports: [
        {
          ssrc: 444,
          fractionLost: 0.5,
          packetsLost: 8,
          highestSequence: 12345,
          jitter: 42,
          lastSenderReport: 7,
          delaySinceLastSenderReport: 9
        }
      ]
    });
    const unknownPacket = createUnknownRtcpPacketWithPadding(207, 7, Buffer.from([0xde, 0xad, 0xbe]));
    const nack = createNack({
      senderSsrc: 111,
      mediaSsrc: 222,
      lostPacketIds: [10, 11, 12]
    });
    const compound = Buffer.concat([receiverReport, unknownPacket, nack]);

    const packets = parseRtcpCompound(compound);
    const roundTrip = Buffer.concat(packets.map((packet) => serializeRtcpPacket(packet)));

    expect(roundTrip.equals(compound)).toBe(true);
    expect(packets[1]?.version).toBe(2);
    expect(packets[1]?.padding).toBe(true);
    expect(packets[1]?.count).toBe(7);
    expect(packets[1]?.type).toBe(207);
    expect(packets[1]?.payload.equals(Buffer.from([0xde, 0xad, 0xbe]))).toBe(true);
    expect(packets[1]?.paddingBytes?.equals(Buffer.from([0x01]))).toBe(true);
  });

  it('creates and parses Sender Reports', () => {
    const raw = createSenderReport({
      senderSsrc: 111,
      ntpTimestamp: 0x1020304050607080n,
      rtpTimestamp: 99,
      packetCount: 12,
      octetCount: 2048,
      reports: [
        {
          ssrc: 222,
          fractionLost: 0.25,
          packetsLost: -2,
          highestSequence: 999,
          jitter: 10,
          lastSenderReport: 20,
          delaySinceLastSenderReport: 30
        }
      ]
    });

    const [packet] = parseRtcpCompound(raw);
    expect(parseSenderReport(packet!)).toEqual({
      senderSsrc: 111,
      ntpTimestamp: 0x1020304050607080n,
      rtpTimestamp: 99,
      packetCount: 12,
      octetCount: 2048,
      reports: [
        {
          ssrc: 222,
          fractionLost: 0.25,
          packetsLost: -2,
          highestSequence: 999,
          jitter: 10,
          lastSenderReport: 20,
          delaySinceLastSenderReport: 30
        }
      ]
    });
  });

  it('creates and parses Receiver Reports', () => {
    const raw = createReceiverReport({
      reporterSsrc: 333,
      reports: [
        {
          ssrc: 444,
          fractionLost: 0.5,
          packetsLost: 8,
          highestSequence: 12345,
          jitter: 42,
          lastSenderReport: 7,
          delaySinceLastSenderReport: 9
        }
      ]
    });

    const [packet] = parseRtcpCompound(raw);
    expect(parseReceiverReport(packet!)).toEqual({
      reporterSsrc: 333,
      reports: [
        {
          ssrc: 444,
          fractionLost: 0.5,
          packetsLost: 8,
          highestSequence: 12345,
          jitter: 42,
          lastSenderReport: 7,
          delaySinceLastSenderReport: 9
        }
      ]
    });
  });

  it('parses transport NACK feedback', () => {
    const raw = createNack({
      senderSsrc: 111,
      mediaSsrc: 222,
      lostPacketIds: [10, 11, 12]
    });

    const [packet] = parseRtcpCompound(raw);
    const nack = parseNack(packet!);

    expect(nack?.senderSsrc).toBe(111);
    expect(nack?.mediaSsrc).toBe(222);
    expect(nack?.lostPacketIds).toEqual([10, 11, 12]);
  });

  it('parses picture loss indication', () => {
    const raw = createPli({ senderSsrc: 111, mediaSsrc: 222 });

    const [packet] = parseRtcpCompound(raw);
    expect(parsePli(packet!)).toEqual({ senderSsrc: 111, mediaSsrc: 222 });
  });

  it('creates and parses full intra requests', () => {
    const raw = createFir({
      senderSsrc: 111,
      mediaSsrc: 0,
      entries: [{ ssrc: 222, sequenceNumber: 3 }]
    });

    const [packet] = parseRtcpCompound(raw);
    expect(parseFir(packet!)).toEqual({
      senderSsrc: 111,
      mediaSsrc: 0,
      entries: [{ ssrc: 222, sequenceNumber: 3 }]
    });
  });

  it('creates and parses REMB feedback', () => {
    const raw = createRemb({
      senderSsrc: 111,
      mediaSsrc: 0,
      bitrateBps: 1_500_000,
      ssrcs: [222, 333]
    });

    const [packet] = parseRtcpCompound(raw);
    expect(parseRemb(packet!)).toEqual({
      senderSsrc: 111,
      mediaSsrc: 0,
      bitrateBps: 1_500_000,
      ssrcs: [222, 333]
    });
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
