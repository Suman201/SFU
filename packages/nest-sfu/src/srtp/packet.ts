import { RtpPacket } from '@native-sfu/sfu-core';
import { RtpHeader as WeriftRtpHeader } from 'werift-dtls/lib/rtp/src';

export interface ParsedRtp {
  packet: RtpPacket;
  packetIndex: bigint;
}

export interface SrtpSsrcState {
  ssrc: number;
  rolloverCounter: number;
  lastSequenceNumber?: number;
}

export function parseRtpForSrtp(buffer: Buffer, state: SrtpSsrcState): ParsedRtp {
  const packet = RtpPacket.parse(buffer);
  const rolloverCounter = estimateRolloverCounter(packet.sequenceNumber, state);
  return {
    packet,
    packetIndex: (BigInt(rolloverCounter) << 16n) | BigInt(packet.sequenceNumber)
  };
}

export function rtpPayloadOffset(buffer: Buffer): number {
  if (buffer.length < 12) {
    throw new Error('RTP packet too short');
  }
  const csrcCount = buffer[0]! & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (buffer[0]! & 0x10) {
    if (offset + 4 > buffer.length) {
      throw new Error('Truncated RTP header extension');
    }
    offset += 4 + buffer.readUInt16BE(offset + 2) * 4;
  }
  if (offset > buffer.length) {
    throw new Error('RTP payload offset exceeds packet length');
  }
  return offset;
}

export function acceptRtpSequence(sequenceNumber: number, state: SrtpSsrcState): void {
  state.rolloverCounter = estimateRolloverCounter(sequenceNumber, state);
  state.lastSequenceNumber = sequenceNumber;
}

export function toWeriftRtpHeader(packet: RtpPacket): WeriftRtpHeader {
  return new WeriftRtpHeader({
    version: packet.version,
    padding: packet.padding,
    extension: packet.extension,
    marker: packet.marker,
    payloadType: packet.payloadType,
    sequenceNumber: packet.sequenceNumber,
    timestamp: packet.timestamp,
    ssrc: packet.ssrc,
    csrc: packet.csrc
  });
}

export function parseSrtcpIndex(buffer: Buffer, authTagLength: number, indexAtPacketEnd: boolean): { ssrc: number; index: bigint } {
  if (buffer.length < 12) {
    throw new Error('SRTCP packet too short');
  }
  const first = buffer[0]!;
  const version = first >> 6;
  if (version !== 2) {
    throw new Error(`Unsupported RTCP version ${version}`);
  }
  const ssrc = buffer.readUInt32BE(4);
  const indexOffset = indexAtPacketEnd ? buffer.length - 4 : buffer.length - authTagLength - 4;
  if (indexOffset < 8) {
    throw new Error('SRTCP packet too short for replay index');
  }
  const encryptedIndex = buffer.readUInt32BE(indexOffset);
  return {
    ssrc,
    index: BigInt(encryptedIndex & 0x7fffffff)
  };
}

export function parseRtcpSsrcs(buffer: Buffer): Set<number> {
  if (buffer.length < 8) {
    throw new Error('RTCP packet too short');
  }
  const first = buffer[0]!;
  const version = first >> 6;
  if (version !== 2) {
    throw new Error(`Unsupported RTCP version ${version}`);
  }
  const type = buffer[1]!;
  const ssrcs = new Set<number>();
  if (type === 200 || type === 201) {
    ssrcs.add(buffer.readUInt32BE(4));
    return ssrcs;
  }
  if ((type === 205 || type === 206) && buffer.length >= 12) {
    ssrcs.add(buffer.readUInt32BE(4));
    ssrcs.add(buffer.readUInt32BE(8));
    return ssrcs;
  }
  ssrcs.add(buffer.readUInt32BE(4));
  return ssrcs;
}

function estimateRolloverCounter(sequenceNumber: number, state: SrtpSsrcState): number {
  if (state.lastSequenceNumber === undefined) {
    return state.rolloverCounter;
  }
  const maxRocDisorder = 100;
  const maxSequenceNumber = 0xffff;
  if (state.lastSequenceNumber < maxRocDisorder && sequenceNumber > maxSequenceNumber - maxRocDisorder) {
    return Math.max(0, state.rolloverCounter - 1);
  }
  if (sequenceNumber < maxRocDisorder && state.lastSequenceNumber > maxSequenceNumber - maxRocDisorder) {
    return state.rolloverCounter + 1;
  }
  return state.rolloverCounter;
}
