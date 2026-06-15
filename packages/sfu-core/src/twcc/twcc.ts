import { RTCP_RTPFB, type RtcpPacket } from '../rtcp/rtcp-packet';
import { addSequenceNumber, sequenceDistance } from '../rtp/rtp-sequence';

export const RTCP_TRANSPORT_WIDE_CC_FORMAT = 15;
const TWCC_DELTA_UNIT_MS = 0.25;

export interface TwccArrival {
  sequenceNumber: number;
  arrivalTimeMs: number;
  size: number;
  ssrc?: number;
}

export interface TwccFeedbackStatus {
  sequenceNumber: number;
  received: boolean;
  deltaMs?: number;
  arrivalTimeMs?: number;
}

export interface TransportWideCcFeedback {
  senderSsrc: number;
  mediaSsrc: number;
  baseSequenceNumber: number;
  packetStatusCount: number;
  referenceTime64Ms: number;
  feedbackPacketCount: number;
  statuses: TwccFeedbackStatus[];
}

export interface CreateTransportWideCcFeedbackInput {
  senderSsrc: number;
  mediaSsrc: number;
  arrivals: TwccArrival[];
  feedbackPacketCount: number;
  baseSequenceNumber?: number;
  referenceTimeMs?: number;
}

export interface TwccArrivalTimelineEntry extends TwccArrival {
  interArrivalDeltaMs?: number;
}

export interface TwccArrivalSnapshot {
  timeline: TwccArrivalTimelineEntry[];
  packetLoss: number;
  delayVariationMs: number;
  receivedPackets: number;
  expectedPackets: number;
}

export class TransportWideSequenceNumber {
  private nextValue: number;

  constructor(initialValue = Math.floor(Math.random() * 0x10000)) {
    this.nextValue = initialValue & 0xffff;
  }

  next(): number {
    const value = this.nextValue;
    this.nextValue = (this.nextValue + 1) & 0xffff;
    return value;
  }

  snapshot(): number {
    return this.nextValue;
  }
}

export class TwccArrivalTracker {
  private readonly arrivals = new Map<number, TwccArrival>();
  private readonly order: number[] = [];
  private feedbackPacketCount = 0;

  constructor(private readonly maxWindowSize = 512) {}

  recordArrival(arrival: TwccArrival): void {
    const sequenceNumber = arrival.sequenceNumber & 0xffff;
    if (!this.arrivals.has(sequenceNumber)) {
      this.order.push(sequenceNumber);
    }
    this.arrivals.set(sequenceNumber, {
      sequenceNumber,
      arrivalTimeMs: arrival.arrivalTimeMs,
      size: Math.max(0, arrival.size),
      ssrc: arrival.ssrc
    });
    while (this.order.length > this.maxWindowSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) {
        this.arrivals.delete(evicted);
      }
    }
  }

  createFeedback(senderSsrc: number, mediaSsrc: number): Buffer | null {
    const arrivals = this.orderedArrivals();
    if (arrivals.length === 0) {
      return null;
    }
    const packet = createTransportWideCcFeedback({
      senderSsrc,
      mediaSsrc,
      arrivals,
      feedbackPacketCount: this.feedbackPacketCount
    });
    this.feedbackPacketCount = (this.feedbackPacketCount + 1) & 0xff;
    return packet;
  }

  snapshot(): TwccArrivalSnapshot {
    const timeline = this.timeline();
    if (timeline.length === 0) {
      return {
        timeline,
        packetLoss: 0,
        delayVariationMs: 0,
        receivedPackets: 0,
        expectedPackets: 0
      };
    }
    const base = timeline[0]!.sequenceNumber;
    const last = timeline[timeline.length - 1]!.sequenceNumber;
    const expectedPackets = sequenceDistance(base, last) + 1;
    const receivedPackets = timeline.length;
    const deltas = timeline.map((entry) => entry.interArrivalDeltaMs).filter((value): value is number => value !== undefined);
    const meanDelta = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
    const delayVariationMs = deltas.length > 0 ? deltas.reduce((sum, value) => sum + Math.abs(value - meanDelta), 0) / deltas.length : 0;
    return {
      timeline,
      packetLoss: expectedPackets > 0 ? Math.max(0, expectedPackets - receivedPackets) / expectedPackets : 0,
      delayVariationMs,
      receivedPackets,
      expectedPackets
    };
  }

  private timeline(): TwccArrivalTimelineEntry[] {
    const ordered = this.orderedArrivals();
    return ordered.map((arrival, index) => ({
      ...arrival,
      interArrivalDeltaMs: index === 0 ? undefined : arrival.arrivalTimeMs - ordered[index - 1]!.arrivalTimeMs
    }));
  }

  private orderedArrivals(): TwccArrival[] {
    if (this.order.length === 0) {
      return [];
    }
    const base = this.order[0]!;
    return [...this.order]
      .sort((left, right) => sequenceDistance(base, left) - sequenceDistance(base, right))
      .map((sequenceNumber) => this.arrivals.get(sequenceNumber))
      .filter((arrival): arrival is TwccArrival => Boolean(arrival));
  }
}

export function createTransportWideCcFeedback(input: CreateTransportWideCcFeedbackInput): Buffer {
  const arrivals = normalizeArrivals(input.arrivals);
  if (arrivals.length === 0) {
    throw new Error('TWCC feedback requires at least one arrival');
  }
  const baseSequenceNumber = input.baseSequenceNumber ?? arrivals[0]!.sequenceNumber;
  const lastSequenceNumber = arrivals[arrivals.length - 1]!.sequenceNumber;
  const packetStatusCount = sequenceDistance(baseSequenceNumber, lastSequenceNumber) + 1;
  if (packetStatusCount > 0xffff) {
    throw new Error('TWCC packet status count exceeds 16 bits');
  }
  const bySequence = new Map(arrivals.map((arrival) => [arrival.sequenceNumber, arrival]));
  const referenceTime64Ms = Math.floor((input.referenceTimeMs ?? arrivals[0]!.arrivalTimeMs) / 64) & 0xffffff;
  const referenceTimeMs = referenceTime64Ms * 64;
  const symbols: number[] = [];
  const deltas: Buffer[] = [];
  let previousArrivalTimeMs = referenceTimeMs;
  for (let index = 0; index < packetStatusCount; index += 1) {
    const sequenceNumber = addSequenceNumber(baseSequenceNumber, index);
    const arrival = bySequence.get(sequenceNumber);
    if (!arrival) {
      symbols.push(0);
      continue;
    }
    const deltaUnits = Math.round((arrival.arrivalTimeMs - previousArrivalTimeMs) / TWCC_DELTA_UNIT_MS);
    previousArrivalTimeMs = previousArrivalTimeMs + deltaUnits * TWCC_DELTA_UNIT_MS;
    if (deltaUnits >= 0 && deltaUnits <= 0xff) {
      symbols.push(1);
      deltas.push(Buffer.from([deltaUnits]));
    } else if (deltaUnits >= -0x8000 && deltaUnits <= 0x7fff) {
      const delta = Buffer.alloc(2);
      delta.writeInt16BE(deltaUnits, 0);
      symbols.push(2);
      deltas.push(delta);
    } else {
      throw new Error('TWCC receive delta exceeds encodable range');
    }
  }
  const chunks = encodePacketStatusChunks(symbols);
  const payload = Buffer.alloc(20 + chunks.length * 2 + deltas.reduce((sum, delta) => sum + delta.length, 0));
  payload.writeUInt32BE(input.senderSsrc >>> 0, 0);
  payload.writeUInt32BE(input.mediaSsrc >>> 0, 4);
  payload.writeUInt16BE(baseSequenceNumber & 0xffff, 8);
  payload.writeUInt16BE(packetStatusCount, 10);
  payload.writeUIntBE(referenceTime64Ms, 12, 3);
  payload[15] = input.feedbackPacketCount & 0xff;
  let offset = 16;
  for (const chunk of chunks) {
    payload.writeUInt16BE(chunk, offset);
    offset += 2;
  }
  for (const delta of deltas) {
    delta.copy(payload, offset);
    offset += delta.length;
  }
  const alignedPayload = padToWordBoundary(payload.subarray(0, offset));
  const packet = Buffer.alloc(4 + alignedPayload.length);
  packet[0] = 0x80 | RTCP_TRANSPORT_WIDE_CC_FORMAT;
  packet[1] = RTCP_RTPFB;
  packet.writeUInt16BE(packet.length / 4 - 1, 2);
  alignedPayload.copy(packet, 4);
  return packet;
}

export function parseTransportWideCcFeedback(packet: RtcpPacket): TransportWideCcFeedback | null {
  if (packet.type !== RTCP_RTPFB || packet.count !== RTCP_TRANSPORT_WIDE_CC_FORMAT) {
    return null;
  }
  if (packet.payload.length < 16) {
    throw new Error('TWCC feedback packet too short');
  }
  const senderSsrc = packet.payload.readUInt32BE(0);
  const mediaSsrc = packet.payload.readUInt32BE(4);
  const baseSequenceNumber = packet.payload.readUInt16BE(8);
  const packetStatusCount = packet.payload.readUInt16BE(10);
  const referenceTime64Ms = packet.payload.readUIntBE(12, 3);
  const feedbackPacketCount = packet.payload[15]!;
  const symbols: number[] = [];
  let offset = 16;
  while (symbols.length < packetStatusCount) {
    if (offset + 2 > packet.payload.length) {
      throw new Error('TWCC feedback status chunks truncated');
    }
    const chunk = packet.payload.readUInt16BE(offset);
    offset += 2;
    symbols.push(...decodePacketStatusChunk(chunk, packetStatusCount - symbols.length));
  }
  const statuses: TwccFeedbackStatus[] = [];
  let currentArrivalTimeMs = referenceTime64Ms * 64;
  for (let index = 0; index < packetStatusCount; index += 1) {
    const symbol = symbols[index] ?? 0;
    const sequenceNumber = addSequenceNumber(baseSequenceNumber, index);
    if (symbol === 0) {
      statuses.push({ sequenceNumber, received: false });
      continue;
    }
    const deltaUnits = symbol === 1 ? readUnsignedDelta(packet.payload, offset) : readSignedDelta(packet.payload, offset);
    offset += symbol === 1 ? 1 : 2;
    const deltaMs = deltaUnits * TWCC_DELTA_UNIT_MS;
    currentArrivalTimeMs += deltaMs;
    statuses.push({ sequenceNumber, received: true, deltaMs, arrivalTimeMs: currentArrivalTimeMs });
  }
  return {
    senderSsrc,
    mediaSsrc,
    baseSequenceNumber,
    packetStatusCount,
    referenceTime64Ms,
    feedbackPacketCount,
    statuses
  };
}

export function twccMetricsFromFeedback(feedback: TransportWideCcFeedback): Pick<TwccArrivalSnapshot, 'packetLoss' | 'delayVariationMs' | 'receivedPackets' | 'expectedPackets'> {
  const received = feedback.statuses.filter((status) => status.received);
  const deltas = received.map((status) => status.deltaMs).filter((delta): delta is number => delta !== undefined);
  const meanDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : 0;
  const delayVariationMs = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + Math.abs(delta - meanDelta), 0) / deltas.length : 0;
  return {
    packetLoss: feedback.packetStatusCount > 0 ? Math.max(0, feedback.packetStatusCount - received.length) / feedback.packetStatusCount : 0,
    delayVariationMs,
    receivedPackets: received.length,
    expectedPackets: feedback.packetStatusCount
  };
}

function normalizeArrivals(arrivals: TwccArrival[]): TwccArrival[] {
  if (arrivals.length === 0) {
    return [];
  }
  const base = arrivals[0]!.sequenceNumber & 0xffff;
  const latestBySequence = new Map<number, TwccArrival>();
  for (const arrival of arrivals) {
    latestBySequence.set(arrival.sequenceNumber & 0xffff, {
      sequenceNumber: arrival.sequenceNumber & 0xffff,
      arrivalTimeMs: arrival.arrivalTimeMs,
      size: Math.max(0, arrival.size),
      ssrc: arrival.ssrc
    });
  }
  return [...latestBySequence.values()].sort((left, right) => sequenceDistance(base, left.sequenceNumber) - sequenceDistance(base, right.sequenceNumber));
}

function encodePacketStatusChunks(symbols: number[]): number[] {
  const chunks: number[] = [];
  let index = 0;
  while (index < symbols.length) {
    const symbol = symbols[index]!;
    let runLength = 1;
    while (index + runLength < symbols.length && symbols[index + runLength] === symbol && runLength < 0x1fff) {
      runLength += 1;
    }
    chunks.push(((symbol & 0x03) << 13) | runLength);
    index += runLength;
  }
  return chunks;
}

function decodePacketStatusChunk(chunk: number, remaining: number): number[] {
  const symbols: number[] = [];
  if ((chunk & 0x8000) === 0) {
    const symbol = (chunk >> 13) & 0x03;
    const runLength = Math.min(chunk & 0x1fff, remaining);
    for (let index = 0; index < runLength; index += 1) {
      symbols.push(symbol);
    }
    return symbols;
  }
  if ((chunk & 0x4000) === 0) {
    for (let bit = 13; bit >= 0 && symbols.length < remaining; bit -= 1) {
      symbols.push((chunk >> bit) & 0x01);
    }
    return symbols;
  }
  for (let bit = 12; bit >= 0 && symbols.length < remaining; bit -= 2) {
    symbols.push((chunk >> bit) & 0x03);
  }
  return symbols;
}

function readUnsignedDelta(buffer: Buffer, offset: number): number {
  if (offset >= buffer.length) {
    throw new Error('TWCC feedback small delta truncated');
  }
  return buffer[offset]!;
}

function readSignedDelta(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) {
    throw new Error('TWCC feedback large delta truncated');
  }
  return buffer.readInt16BE(offset);
}

function padToWordBoundary(value: Buffer): Buffer {
  const padding = (4 - (value.length % 4)) % 4;
  if (padding === 0) {
    return value;
  }
  return Buffer.concat([value, Buffer.alloc(padding)]);
}
