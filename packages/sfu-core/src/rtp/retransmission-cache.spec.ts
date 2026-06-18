import { RtpPacket } from './rtp-packet';
import { RtpRetransmissionCache } from './retransmission-cache';

describe('RtpRetransmissionCache', () => {
  it('stores packets by SSRC and sequence number', () => {
    const cache = new RtpRetransmissionCache(2);
    const first = RtpPacket.parse(rtpPacket(1111, 10));
    const second = RtpPacket.parse(rtpPacket(1111, 11));

    cache.store(first);
    cache.store(second);

    expect(cache.get(1111, 10)?.sequenceNumber).toBe(10);
    expect(cache.get(1111, 11)?.sequenceNumber).toBe(11);
    expect(cache.snapshot().sequencesBySsrc[1111]).toEqual([10, 11]);
  });

  it('evicts oldest packets when size is exceeded', () => {
    const cache = new RtpRetransmissionCache(2);

    cache.store(RtpPacket.parse(rtpPacket(1111, 10)));
    cache.store(RtpPacket.parse(rtpPacket(1111, 11)));
    cache.store(RtpPacket.parse(rtpPacket(1111, 12)));

    expect(cache.has(1111, 10)).toBe(false);
    expect(cache.has(1111, 11)).toBe(true);
    expect(cache.has(1111, 12)).toBe(true);
  });

  it('refreshes insertion order when a 16-bit sequence slot is reused after wrap', () => {
    let now = 1000;
    const cache = new RtpRetransmissionCache(2, () => now);

    cache.store(RtpPacket.parse(rtpPacket(1111, 10, 'old-10')));
    now += 1;
    cache.store(RtpPacket.parse(rtpPacket(1111, 11, 'pkt-11')));
    now += 1;
    cache.store(RtpPacket.parse(rtpPacket(1111, 10, 'wrapped-10')));
    now += 1;
    cache.store(RtpPacket.parse(rtpPacket(1111, 12, 'pkt-12')));

    expect(cache.get(1111, 10)?.payload.toString()).toBe('wrapped-10');
    expect(cache.has(1111, 11)).toBe(false);
    expect(cache.snapshot().sequencesBySsrc[1111]).toEqual([10, 12]);
  });
});

function rtpPacket(ssrc: number, sequenceNumber: number, payload = 'x'): Buffer {
  const payloadBuffer = Buffer.from(payload);
  const packet = Buffer.alloc(12 + payloadBuffer.length);
  packet[0] = 0x80;
  packet[1] = 96;
  packet.writeUInt16BE(sequenceNumber, 2);
  packet.writeUInt32BE(90_000, 4);
  packet.writeUInt32BE(ssrc, 8);
  payloadBuffer.copy(packet, 12);
  return packet;
}
