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

  it('preserves RTP padding bytes across parse and serialize', () => {
    const payload = Buffer.from('padded-media');
    const padding = Buffer.from([0, 0, 0, 4]);
    const raw = Buffer.alloc(12 + payload.length + padding.length);
    raw[0] = 0xa0;
    raw[1] = 96;
    raw.writeUInt16BE(346, 2);
    raw.writeUInt32BE(123456, 4);
    raw.writeUInt32BE(0xdecafbad, 8);
    payload.copy(raw, 12);
    padding.copy(raw, 12 + payload.length);

    const packet = RtpPacket.parse(raw);

    expect(packet.payload).toEqual(payload);
    expect(packet.paddingBytes).toEqual(padding);
    expect(packet.serialize()).toEqual(raw);
  });

  it('rejects an RTP padding bit with a zero padding length', () => {
    const raw = Buffer.alloc(13);
    raw[0] = 0xa0;
    raw[1] = 96;
    expect(() => RtpPacket.parse(raw)).toThrow(/padding length/);
  });
});
