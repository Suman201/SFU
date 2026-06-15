import { parseNack, parsePli, parseRtcpCompound } from './rtcp-packet';

describe('RTCP parsing', () => {
  it('parses transport NACK feedback', () => {
    const raw = Buffer.alloc(16);
    raw[0] = 0x81;
    raw[1] = 205;
    raw.writeUInt16BE(3, 2);
    raw.writeUInt32BE(111, 4);
    raw.writeUInt32BE(222, 8);
    raw.writeUInt16BE(10, 12);
    raw.writeUInt16BE(0b0000000000000011, 14);

    const [packet] = parseRtcpCompound(raw);
    const nack = parseNack(packet!);

    expect(nack?.senderSsrc).toBe(111);
    expect(nack?.mediaSsrc).toBe(222);
    expect(nack?.lostPacketIds).toEqual([10, 11, 12]);
  });

  it('parses picture loss indication', () => {
    const raw = Buffer.alloc(12);
    raw[0] = 0x81;
    raw[1] = 206;
    raw.writeUInt16BE(2, 2);
    raw.writeUInt32BE(111, 4);
    raw.writeUInt32BE(222, 8);

    const [packet] = parseRtcpCompound(raw);
    expect(parsePli(packet!)).toEqual({ senderSsrc: 111, mediaSsrc: 222 });
  });
});
