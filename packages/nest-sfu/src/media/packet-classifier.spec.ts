import { encodeStunMessage, STUN_BINDING_REQUEST } from '../ice/stun-message';
import { classifyIceDatagram } from './packet-classifier';

describe('classifyIceDatagram', () => {
  it('classifies STUN packets', () => {
    const packet = encodeStunMessage({ type: STUN_BINDING_REQUEST, transactionId: Buffer.alloc(12), attributes: [] });

    expect(classifyIceDatagram(packet)).toBe('stun');
  });

  it('classifies DTLS records', () => {
    const packet = Buffer.alloc(13);
    packet[0] = 22;
    packet.writeUInt16BE(0xfefd, 1);

    expect(classifyIceDatagram(packet)).toBe('dtls');
  });

  it('classifies RTP and SRTP by session context', () => {
    const packet = rtpPacket(1111);

    expect(classifyIceDatagram(packet)).toBe('rtp');
    expect(classifyIceDatagram(packet, { srtpEstablished: true })).toBe('srtp');
  });

  it('classifies RTCP and SRTCP by session context', () => {
    const packet = receiverReport(1111);

    expect(classifyIceDatagram(packet)).toBe('rtcp');
    expect(classifyIceDatagram(packet, { srtpEstablished: true })).toBe('srtcp');
  });
});

function rtpPacket(ssrc: number): Buffer {
  const packet = Buffer.alloc(13);
  packet[0] = 0x80;
  packet[1] = 96;
  packet.writeUInt32BE(ssrc, 8);
  return packet;
}

function receiverReport(ssrc: number): Buffer {
  const packet = Buffer.alloc(8);
  packet[0] = 0x80;
  packet[1] = 201;
  packet.writeUInt16BE(1, 2);
  packet.writeUInt32BE(ssrc, 4);
  return packet;
}
