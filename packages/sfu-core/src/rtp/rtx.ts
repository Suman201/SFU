import { RtpPacket } from './rtp-packet';

export interface RtxPacketOptions {
  rtxSsrc: number;
  rtxPayloadType: number;
  sequenceNumber: number;
  timestamp?: number;
}

export function createRtxPacket(original: RtpPacket, options: RtxPacketOptions): RtpPacket {
  const osn = Buffer.alloc(2);
  osn.writeUInt16BE(original.sequenceNumber & 0xffff, 0);
  return new RtpPacket(
    original.version,
    false,
    Boolean(original.headerExtension),
    original.marker,
    options.rtxPayloadType & 0x7f,
    options.sequenceNumber & 0xffff,
    options.timestamp ?? original.timestamp,
    options.rtxSsrc >>> 0,
    [...original.csrc],
    original.headerExtension ? { profile: original.headerExtension.profile, value: Buffer.from(original.headerExtension.value) } : null,
    Buffer.concat([osn, Buffer.from(original.payload)])
  );
}

export function originalSequenceNumberFromRtx(packet: RtpPacket): number | undefined {
  if (packet.payload.length < 2) {
    return undefined;
  }
  return packet.payload.readUInt16BE(0);
}
