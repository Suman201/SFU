export type RtcpPacketType = 200 | 201 | 205 | 206;

export interface RtcpPacket {
  version: number;
  padding: boolean;
  count: number;
  type: RtcpPacketType;
  length: number;
  payload: Buffer;
}

export interface ReceiverReport {
  ssrc: number;
  fractionLost: number;
  packetsLost: number;
  highestSequence: number;
  jitter: number;
  lastSenderReport: number;
  delaySinceLastSenderReport: number;
}

export interface NackFeedback {
  senderSsrc: number;
  mediaSsrc: number;
  lostPacketIds: number[];
}

export interface PictureLossIndication {
  senderSsrc: number;
  mediaSsrc: number;
}

export function parseRtcpCompound(buffer: Buffer): RtcpPacket[] {
  const packets: RtcpPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const first = buffer[offset]!;
    const version = first >> 6;
    if (version !== 2) {
      throw new Error(`Unsupported RTCP version ${version}`);
    }
    const padding = Boolean(first & 0x20);
    const count = first & 0x1f;
    const type = buffer[offset + 1]! as RtcpPacketType;
    const length = buffer.readUInt16BE(offset + 2);
    const byteLength = (length + 1) * 4;
    if (offset + byteLength > buffer.length) {
      throw new Error('Truncated RTCP packet');
    }
    packets.push({
      version,
      padding,
      count,
      type,
      length,
      payload: buffer.subarray(offset + 4, offset + byteLength)
    });
    offset += byteLength;
  }
  return packets;
}

export function parseReceiverReports(packet: RtcpPacket): ReceiverReport[] {
  if (packet.type !== 201 || packet.payload.length < 4) {
    return [];
  }
  const reports: ReceiverReport[] = [];
  let offset = 4;
  for (let index = 0; index < packet.count; index += 1) {
    if (offset + 24 > packet.payload.length) {
      break;
    }
    const lost = packet.payload.readUInt32BE(offset + 4);
    reports.push({
      ssrc: packet.payload.readUInt32BE(offset),
      fractionLost: packet.payload[offset + 4]! / 256,
      packetsLost: lost & 0x00ffffff,
      highestSequence: packet.payload.readUInt32BE(offset + 8),
      jitter: packet.payload.readUInt32BE(offset + 12),
      lastSenderReport: packet.payload.readUInt32BE(offset + 16),
      delaySinceLastSenderReport: packet.payload.readUInt32BE(offset + 20)
    });
    offset += 24;
  }
  return reports;
}

export function parseNack(packet: RtcpPacket): NackFeedback | null {
  if (packet.type !== 205 || packet.count !== 1 || packet.payload.length < 12) {
    return null;
  }
  const lostPacketIds: number[] = [];
  for (let offset = 8; offset + 4 <= packet.payload.length; offset += 4) {
    const pid = packet.payload.readUInt16BE(offset);
    const blp = packet.payload.readUInt16BE(offset + 2);
    lostPacketIds.push(pid);
    for (let bit = 0; bit < 16; bit += 1) {
      if (blp & (1 << bit)) {
        lostPacketIds.push((pid + bit + 1) & 0xffff);
      }
    }
  }
  return {
    senderSsrc: packet.payload.readUInt32BE(0),
    mediaSsrc: packet.payload.readUInt32BE(4),
    lostPacketIds
  };
}

export function parsePli(packet: RtcpPacket): PictureLossIndication | null {
  if (packet.type !== 206 || packet.count !== 1 || packet.payload.length < 8) {
    return null;
  }
  return {
    senderSsrc: packet.payload.readUInt32BE(0),
    mediaSsrc: packet.payload.readUInt32BE(4)
  };
}
