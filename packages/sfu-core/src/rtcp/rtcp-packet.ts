export const RTCP_SR = 200;
export const RTCP_RR = 201;
export const RTCP_RTPFB = 205;
export const RTCP_PSFB = 206;

export type KnownRtcpPacketType = typeof RTCP_SR | typeof RTCP_RR | typeof RTCP_RTPFB | typeof RTCP_PSFB;
export type RtcpPacketType = number;

export interface RtcpPacket {
  version: number;
  padding: boolean;
  count: number;
  type: RtcpPacketType;
  length: number;
  payload: Buffer;
  paddingBytes?: Buffer;
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

export interface SenderReport {
  senderSsrc: number;
  ntpTimestamp: bigint;
  rtpTimestamp: number;
  packetCount: number;
  octetCount: number;
  reports: ReceiverReport[];
}

export interface ReceiverReportPacket {
  reporterSsrc: number;
  reports: ReceiverReport[];
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

export interface FullIntraRequestEntry {
  ssrc: number;
  sequenceNumber: number;
}

export interface FullIntraRequest {
  senderSsrc: number;
  mediaSsrc: number;
  entries: FullIntraRequestEntry[];
}

export interface ReceiverEstimatedMaximumBitrate {
  senderSsrc: number;
  mediaSsrc: number;
  bitrateBps: number;
  ssrcs: number[];
}

export interface SenderReportInput {
  senderSsrc: number;
  ntpTimestamp: bigint;
  rtpTimestamp: number;
  packetCount: number;
  octetCount: number;
  reports?: ReceiverReport[];
}

export interface ReceiverReportInput {
  reporterSsrc: number;
  reports?: ReceiverReport[];
}

export interface RtcpFeedbackInput {
  senderSsrc: number;
  mediaSsrc: number;
}

export interface NackFeedbackInput extends RtcpFeedbackInput {
  lostPacketIds: number[];
}

export interface FullIntraRequestInput extends RtcpFeedbackInput {
  entries?: FullIntraRequestEntry[];
  sequenceNumber?: number;
}

export interface RembInput extends RtcpFeedbackInput {
  bitrateBps: number;
  ssrcs: number[];
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
    let payloadEnd = offset + byteLength;
    let paddingBytes: Buffer | undefined;
    if (padding) {
      const paddingLength = buffer[payloadEnd - 1]!;
      if (paddingLength === 0 || paddingLength > byteLength - 4) {
        throw new Error('Invalid RTCP padding length');
      }
      paddingBytes = buffer.subarray(payloadEnd - paddingLength, payloadEnd);
      payloadEnd -= paddingLength;
    }
    packets.push({
      version,
      padding,
      count,
      type,
      length,
      payload: buffer.subarray(offset + 4, payloadEnd),
      paddingBytes
    });
    offset += byteLength;
  }
  if (offset !== buffer.length) {
    throw new Error('Trailing RTCP bytes');
  }
  return packets;
}

export function serializeRtcpPacket(packet: RtcpPacket): Buffer {
  const paddingBytes = packet.paddingBytes ?? Buffer.alloc(0);
  if (paddingBytes.length > 0) {
    if (paddingBytes[paddingBytes.length - 1] !== paddingBytes.length) {
      throw new Error('Invalid RTCP padding bytes');
    }
  } else if (packet.padding) {
    throw new Error('RTCP padding flag set without padding bytes');
  }
  const payloadLength = packet.payload.length + paddingBytes.length;
  if (payloadLength % 4 !== 0) {
    throw new Error('RTCP payload must be 32-bit aligned');
  }
  const buffer = Buffer.alloc(payloadLength + 4);
  const padding = paddingBytes.length > 0;
  buffer[0] = (packet.version << 6) | (padding ? 0x20 : 0) | (packet.count & 0x1f);
  buffer[1] = packet.type;
  buffer.writeUInt16BE(buffer.length / 4 - 1, 2);
  packet.payload.copy(buffer, 4);
  paddingBytes.copy(buffer, 4 + packet.payload.length);
  return buffer;
}

export function createSenderReport(input: SenderReportInput): Buffer {
  const reports = input.reports ?? [];
  assertReportCount(reports.length);
  const payload = Buffer.alloc(24 + reports.length * 24);
  payload.writeUInt32BE(input.senderSsrc, 0);
  payload.writeBigUInt64BE(input.ntpTimestamp, 4);
  payload.writeUInt32BE(input.rtpTimestamp, 12);
  payload.writeUInt32BE(input.packetCount, 16);
  payload.writeUInt32BE(input.octetCount, 20);
  writeReportBlocks(payload, 24, reports);
  return createRtcpPacket(RTCP_SR, reports.length, payload);
}

export function createReceiverReport(input: ReceiverReportInput): Buffer {
  const reports = input.reports ?? [];
  assertReportCount(reports.length);
  const payload = Buffer.alloc(4 + reports.length * 24);
  payload.writeUInt32BE(input.reporterSsrc, 0);
  writeReportBlocks(payload, 4, reports);
  return createRtcpPacket(RTCP_RR, reports.length, payload);
}

export function createNack(input: NackFeedbackInput): Buffer {
  const pairs = createNackPairs(input.lostPacketIds);
  const payload = Buffer.alloc(8 + pairs.length * 4);
  payload.writeUInt32BE(input.senderSsrc, 0);
  payload.writeUInt32BE(input.mediaSsrc, 4);
  pairs.forEach((pair, index) => {
    const offset = 8 + index * 4;
    payload.writeUInt16BE(pair.pid, offset);
    payload.writeUInt16BE(pair.blp, offset + 2);
  });
  return createRtcpPacket(RTCP_RTPFB, 1, payload);
}

export function createPli(input: RtcpFeedbackInput): Buffer {
  return createFeedbackPacket(1, input);
}

export function createFir(input: FullIntraRequestInput): Buffer {
  const entries = input.entries?.length
    ? input.entries
    : [
        {
          ssrc: input.mediaSsrc,
          sequenceNumber: input.sequenceNumber ?? 1
        }
      ];
  const payload = Buffer.alloc(8 + entries.length * 8);
  payload.writeUInt32BE(input.senderSsrc, 0);
  payload.writeUInt32BE(input.mediaSsrc, 4);
  entries.forEach((entry, index) => {
    const offset = 8 + index * 8;
    payload.writeUInt32BE(entry.ssrc, offset);
    payload[offset + 4] = entry.sequenceNumber & 0xff;
  });
  return createRtcpPacket(RTCP_PSFB, 4, payload);
}

export function createRemb(input: RembInput): Buffer {
  const bitrate = encodeRembBitrate(input.bitrateBps);
  const payload = Buffer.alloc(16 + input.ssrcs.length * 4);
  payload.writeUInt32BE(input.senderSsrc, 0);
  payload.writeUInt32BE(input.mediaSsrc, 4);
  payload.write('REMB', 8, 4, 'ascii');
  payload[12] = input.ssrcs.length & 0xff;
  payload[13] = ((bitrate.exponent & 0x3f) << 2) | ((bitrate.mantissa >> 16) & 0x03);
  payload.writeUInt16BE(bitrate.mantissa & 0xffff, 14);
  input.ssrcs.forEach((ssrc, index) => payload.writeUInt32BE(ssrc, 16 + index * 4));
  return createRtcpPacket(RTCP_PSFB, 15, payload);
}

export function parseSenderReport(packet: RtcpPacket): SenderReport | null {
  if (packet.type !== RTCP_SR) {
    return null;
  }
  if (packet.payload.length < 24) {
    throw new Error('Sender Report packet too short');
  }
  return {
    senderSsrc: packet.payload.readUInt32BE(0),
    ntpTimestamp: packet.payload.readBigUInt64BE(4),
    rtpTimestamp: packet.payload.readUInt32BE(12),
    packetCount: packet.payload.readUInt32BE(16),
    octetCount: packet.payload.readUInt32BE(20),
    reports: parseReportBlocks(packet.payload, 24, packet.count)
  };
}

export function parseReceiverReport(packet: RtcpPacket): ReceiverReportPacket | null {
  if (packet.type !== RTCP_RR) {
    return null;
  }
  if (packet.payload.length < 4) {
    throw new Error('Receiver Report packet too short');
  }
  return {
    reporterSsrc: packet.payload.readUInt32BE(0),
    reports: parseReportBlocks(packet.payload, 4, packet.count)
  };
}

export function parseReceiverReports(packet: RtcpPacket): ReceiverReport[] {
  return parseReceiverReport(packet)?.reports ?? [];
}

export function parseNack(packet: RtcpPacket): NackFeedback | null {
  if (packet.type !== RTCP_RTPFB || packet.count !== 1) {
    return null;
  }
  if (packet.payload.length < 12) {
    throw new Error('NACK packet too short');
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
  if (packet.type !== RTCP_PSFB || packet.count !== 1) {
    return null;
  }
  if (packet.payload.length < 8) {
    throw new Error('PLI packet too short');
  }
  return {
    senderSsrc: packet.payload.readUInt32BE(0),
    mediaSsrc: packet.payload.readUInt32BE(4)
  };
}

export function parseFir(packet: RtcpPacket): FullIntraRequest | null {
  if (packet.type !== RTCP_PSFB || packet.count !== 4) {
    return null;
  }
  if (packet.payload.length < 16) {
    throw new Error('FIR packet too short');
  }
  const entries: FullIntraRequestEntry[] = [];
  for (let offset = 8; offset + 8 <= packet.payload.length; offset += 8) {
    entries.push({
      ssrc: packet.payload.readUInt32BE(offset),
      sequenceNumber: packet.payload[offset + 4]!
    });
  }
  return {
    senderSsrc: packet.payload.readUInt32BE(0),
    mediaSsrc: packet.payload.readUInt32BE(4),
    entries
  };
}

export function parseRemb(packet: RtcpPacket): ReceiverEstimatedMaximumBitrate | null {
  if (packet.type !== RTCP_PSFB || packet.count !== 15) {
    return null;
  }
  if (packet.payload.length < 16) {
    throw new Error('REMB packet too short');
  }
  if (packet.payload.subarray(8, 12).toString('ascii') !== 'REMB') {
    return null;
  }
  const ssrcCount = packet.payload[12]!;
  if (packet.payload.length < 16 + ssrcCount * 4) {
    throw new Error('REMB packet missing SSRC entries');
  }
  const exponent = packet.payload[13]! >> 2;
  const mantissa = ((packet.payload[13]! & 0x03) << 16) | packet.payload.readUInt16BE(14);
  const ssrcs: number[] = [];
  for (let index = 0; index < ssrcCount; index += 1) {
    ssrcs.push(packet.payload.readUInt32BE(16 + index * 4));
  }
  return {
    senderSsrc: packet.payload.readUInt32BE(0),
    mediaSsrc: packet.payload.readUInt32BE(4),
    bitrateBps: mantissa * 2 ** exponent,
    ssrcs
  };
}

function createRtcpPacket(type: KnownRtcpPacketType, count: number, payload: Buffer): Buffer {
  if (payload.length % 4 !== 0) {
    throw new Error('RTCP payload must be 32-bit aligned');
  }
  if (count < 0 || count > 31) {
    throw new Error('RTCP count must fit in 5 bits');
  }
  const buffer = Buffer.alloc(payload.length + 4);
  buffer[0] = 0x80 | count;
  buffer[1] = type;
  buffer.writeUInt16BE(buffer.length / 4 - 1, 2);
  payload.copy(buffer, 4);
  return buffer;
}

function createFeedbackPacket(count: number, input: RtcpFeedbackInput): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(input.senderSsrc, 0);
  payload.writeUInt32BE(input.mediaSsrc, 4);
  return createRtcpPacket(RTCP_PSFB, count, payload);
}

function parseReportBlocks(payload: Buffer, offset: number, count: number): ReceiverReport[] {
  const reports: ReceiverReport[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 24 > payload.length) {
      throw new Error('RTCP report block truncated');
    }
    reports.push({
      ssrc: payload.readUInt32BE(offset),
      fractionLost: payload[offset + 4]! / 256,
      packetsLost: readSigned24(payload, offset + 5),
      highestSequence: payload.readUInt32BE(offset + 8),
      jitter: payload.readUInt32BE(offset + 12),
      lastSenderReport: payload.readUInt32BE(offset + 16),
      delaySinceLastSenderReport: payload.readUInt32BE(offset + 20)
    });
    offset += 24;
  }
  return reports;
}

function writeReportBlocks(buffer: Buffer, offset: number, reports: ReceiverReport[]): void {
  for (const report of reports) {
    buffer.writeUInt32BE(report.ssrc, offset);
    buffer[offset + 4] = Math.round(report.fractionLost * 256) & 0xff;
    writeSigned24(buffer, offset + 5, report.packetsLost);
    buffer.writeUInt32BE(report.highestSequence, offset + 8);
    buffer.writeUInt32BE(report.jitter, offset + 12);
    buffer.writeUInt32BE(report.lastSenderReport, offset + 16);
    buffer.writeUInt32BE(report.delaySinceLastSenderReport, offset + 20);
    offset += 24;
  }
}

function readSigned24(buffer: Buffer, offset: number): number {
  const value = buffer.readUIntBE(offset, 3);
  return value & 0x800000 ? value - 0x1000000 : value;
}

function writeSigned24(buffer: Buffer, offset: number, value: number): void {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new Error('RTCP packetsLost must fit in signed 24 bits');
  }
  buffer.writeUIntBE(value < 0 ? value + 0x1000000 : value, offset, 3);
}

function assertReportCount(count: number): void {
  if (count > 31) {
    throw new Error('RTCP report count exceeds 31');
  }
}

function createNackPairs(packetIds: number[]): Array<{ pid: number; blp: number }> {
  const sorted = [...new Set(packetIds.map((packetId) => packetId & 0xffff))].sort((a, b) => a - b);
  const pairs: Array<{ pid: number; blp: number }> = [];
  while (sorted.length > 0) {
    const pid = sorted.shift()!;
    let blp = 0;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const candidate = sorted[index]!;
      const delta = candidate - pid;
      if (delta >= 1 && delta <= 16) {
        blp |= 1 << (delta - 1);
        sorted.splice(index, 1);
      }
    }
    pairs.push({ pid, blp });
  }
  return pairs;
}

function encodeRembBitrate(bitrateBps: number): { exponent: number; mantissa: number } {
  if (!Number.isFinite(bitrateBps) || bitrateBps < 0) {
    throw new Error('REMB bitrate must be a non-negative finite number');
  }
  let exponent = 0;
  let mantissa = Math.ceil(bitrateBps);
  while (mantissa > 0x3ffff && exponent < 63) {
    exponent += 1;
    mantissa = Math.ceil(bitrateBps / 2 ** exponent);
  }
  if (mantissa > 0x3ffff) {
    throw new Error('REMB bitrate exceeds encodable range');
  }
  return { exponent, mantissa };
}
