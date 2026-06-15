import { isStunMessage } from '../ice/stun-message';
import { isDtlsPacket } from '../dtls/dtls-transport';

export type IceDatagramKind = 'stun' | 'dtls' | 'rtp' | 'rtcp' | 'srtp' | 'srtcp' | 'unknown';

export interface PacketClassificationContext {
  srtpEstablished?: boolean;
}

export function classifyIceDatagram(packet: Buffer, context: PacketClassificationContext = {}): IceDatagramKind {
  if (packet.length === 0) {
    return 'unknown';
  }
  if (isStunMessage(packet)) {
    return 'stun';
  }
  if (isDtlsPacket(packet)) {
    return 'dtls';
  }
  if (!hasRtpVersion(packet)) {
    return 'unknown';
  }
  if (isRtcpMuxPacket(packet)) {
    return context.srtpEstablished ? 'srtcp' : 'rtcp';
  }
  return context.srtpEstablished ? 'srtp' : 'rtp';
}

export function isRtpLikeDatagram(packet: Buffer): boolean {
  return hasRtpVersion(packet) && !isRtcpMuxPacket(packet);
}

export function isRtcpLikeDatagram(packet: Buffer): boolean {
  return hasRtpVersion(packet) && isRtcpMuxPacket(packet);
}

function hasRtpVersion(packet: Buffer): boolean {
  return packet.length >= 2 && packet[0]! >> 6 === 2;
}

function isRtcpMuxPacket(packet: Buffer): boolean {
  const packetType = packet[1]!;
  return packetType >= 192 && packetType <= 223;
}
