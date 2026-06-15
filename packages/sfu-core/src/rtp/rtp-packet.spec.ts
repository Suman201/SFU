import { RtpPacket } from './rtp-packet';

describe('RtpPacket', () => {
  it('parses and serializes RTP packets', () => {
    const raw = Buffer.alloc(16);
    raw[0] = 0x80;
    raw[1] = 96;
    raw.writeUInt16BE(345, 2);
    raw.writeUInt32BE(123456, 4);
    raw.writeUInt32BE(0xdecafbad, 8);
    raw.writeUInt32BE(0x01020304, 12);

    const packet = RtpPacket.parse(raw);

    expect(packet.version).toBe(2);
    expect(packet.payloadType).toBe(96);
    expect(packet.sequenceNumber).toBe(345);
    expect(packet.timestamp).toBe(123456);
    expect(packet.ssrc).toBe(0xdecafbad);
    expect(packet.payload.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(packet.serialize().equals(raw)).toBe(true);
  });

  it('rejects invalid versions', () => {
    const raw = Buffer.alloc(12);
    raw[0] = 0x40;
    expect(() => RtpPacket.parse(raw)).toThrow(/Unsupported RTP version/);
  });
});
