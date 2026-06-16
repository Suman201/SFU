import { RtpPacket } from './rtp-packet';
import { addSequenceNumber, sequenceDelta, sequenceDistance } from './rtp-sequence';

export type RtpPacketDropReason =
  | 'invalid_packet'
  | 'invalid_version'
  | 'invalid_payload_type'
  | 'invalid_ssrc'
  | 'invalid_sequence'
  | 'duplicate_packet'
  | 'late_packet'
  | 'reorder_buffer_overflow'
  | 'unknown_ssrc'
  | 'producer_paused'
  | 'no_consumers';

export interface RtpSourceStreamStateOptions {
  ssrc: number;
  allowedPayloadTypes: Iterable<number>;
  maxReorderPackets?: number;
  maxReorderDelayMs?: number;
  restartSequenceGap?: number;
  duplicateWindowSize?: number;
  now?: () => number;
}

export interface RtpStreamSnapshot {
  ssrc: number;
  started: boolean;
  highestSequenceNumber?: number;
  expectedSequenceNumber?: number;
  lastTimestamp?: number;
  packetsReceived: number;
  packetsForwarded: number;
  packetsBuffered: number;
  duplicatePackets: number;
  latePackets: number;
  restartCount: number;
  expiredGaps: number;
  bufferedSequences: number[];
  oldestBufferedAt?: number;
}

export interface RtpReorderGapExpiration {
  ssrc: number;
  previousExpectedSequenceNumber: number;
  releasedSequenceNumber: number;
  bufferedForMs: number;
  expiredAt: number;
}

export interface RtpReorderDrainResult {
  packets: RtpPacket[];
  expiredGap?: RtpReorderGapExpiration;
}

export interface RtpSourceStreamAcceptResult {
  packets: RtpPacket[];
  buffered: boolean;
  restarted: boolean;
  dropReason?: RtpPacketDropReason;
  expiredGap?: RtpReorderGapExpiration;
}

export class RtpSourceStreamState {
  private readonly allowedPayloadTypes: Set<number>;
  private readonly maxReorderPackets: number;
  private readonly maxReorderDelayMs: number;
  private readonly restartSequenceGap: number;
  private readonly duplicateWindowSize: number;
  private started = false;
  private highestSequenceNumber?: number;
  private expectedSequenceNumber?: number;
  private lastTimestamp?: number;
  private readonly reorderBuffer = new Map<number, { packet: RtpPacket; bufferedAt: number }>();
  private readonly deliveredWindow: number[] = [];
  private readonly deliveredSet = new Set<number>();
  private packetsReceived = 0;
  private packetsForwarded = 0;
  private duplicatePackets = 0;
  private latePackets = 0;
  private restartCount = 0;
  private expiredGaps = 0;

  constructor(private readonly options: RtpSourceStreamStateOptions) {
    this.allowedPayloadTypes = new Set([...options.allowedPayloadTypes].map((value) => value & 0x7f));
    this.maxReorderPackets = options.maxReorderPackets ?? 64;
    this.maxReorderDelayMs = Math.max(0, options.maxReorderDelayMs ?? 0);
    this.restartSequenceGap = options.restartSequenceGap ?? 3000;
    this.duplicateWindowSize = options.duplicateWindowSize ?? 128;
  }

  accept(packet: RtpPacket): RtpSourceStreamAcceptResult {
    const validation = this.validate(packet);
    if (validation) {
      return { packets: [], buffered: false, restarted: false, dropReason: validation };
    }
    this.packetsReceived += 1;
    if (!this.started) {
      return { packets: this.start(packet, false), buffered: false, restarted: false };
    }
    if (this.deliveredSet.has(packet.sequenceNumber) || this.reorderBuffer.has(packet.sequenceNumber)) {
      this.duplicatePackets += 1;
      return { packets: [], buffered: false, restarted: false, dropReason: 'duplicate_packet' };
    }
    const expected = this.expectedSequenceNumber!;
    const deltaFromExpected = sequenceDelta(packet.sequenceNumber, expected);
    if (deltaFromExpected < 0) {
      this.latePackets += 1;
      return { packets: [], buffered: false, restarted: false, dropReason: 'late_packet' };
    }
    if (deltaFromExpected >= this.restartSequenceGap) {
      this.restartCount += 1;
      return { packets: this.start(packet, true), buffered: false, restarted: true };
    }
    if (deltaFromExpected === 0) {
      return { packets: this.release(packet), buffered: false, restarted: false };
    }
    this.reorderBuffer.set(packet.sequenceNumber, { packet, bufferedAt: this.now() });
    if (this.reorderBuffer.size > this.maxReorderPackets) {
      return { packets: this.releaseFromSmallestBuffered().packets, buffered: false, restarted: false, dropReason: 'reorder_buffer_overflow' };
    }
    const expired = this.releaseExpiredGap();
    if (expired.packets.length > 0) {
      return { packets: expired.packets, buffered: false, restarted: false, expiredGap: expired.expiredGap };
    }
    return { packets: [], buffered: true, restarted: false };
  }

  drainExpired(): RtpReorderDrainResult {
    return this.releaseExpiredGap();
  }

  snapshot(): RtpStreamSnapshot {
    const oldestBufferedAt = this.oldestBufferedEntry()?.bufferedAt;
    return {
      ssrc: this.options.ssrc,
      started: this.started,
      highestSequenceNumber: this.highestSequenceNumber,
      expectedSequenceNumber: this.expectedSequenceNumber,
      lastTimestamp: this.lastTimestamp,
      packetsReceived: this.packetsReceived,
      packetsForwarded: this.packetsForwarded,
      packetsBuffered: this.reorderBuffer.size,
      duplicatePackets: this.duplicatePackets,
      latePackets: this.latePackets,
      restartCount: this.restartCount,
      expiredGaps: this.expiredGaps,
      bufferedSequences: [...this.reorderBuffer.keys()].sort((left, right) => sequenceDelta(left, right)),
      oldestBufferedAt
    };
  }

  private validate(packet: RtpPacket): RtpPacketDropReason | undefined {
    if (packet.version !== 2) {
      return 'invalid_version';
    }
    if (packet.ssrc !== this.options.ssrc) {
      return 'invalid_ssrc';
    }
    if (!this.allowedPayloadTypes.has(packet.payloadType)) {
      return 'invalid_payload_type';
    }
    return undefined;
  }

  private start(packet: RtpPacket, restarted: boolean): RtpPacket[] {
    this.started = true;
    this.highestSequenceNumber = packet.sequenceNumber;
    this.expectedSequenceNumber = addSequenceNumber(packet.sequenceNumber, 1);
    this.lastTimestamp = packet.timestamp;
    this.reorderBuffer.clear();
    this.deliveredWindow.length = 0;
    this.deliveredSet.clear();
    if (restarted) {
      this.restartCount = Math.max(1, this.restartCount);
    }
    this.recordDelivered(packet.sequenceNumber);
    this.packetsForwarded += 1;
    return [packet];
  }

  private release(packet: RtpPacket): RtpPacket[] {
    const released: RtpPacket[] = [packet];
    this.recordDelivered(packet.sequenceNumber);
    this.highestSequenceNumber = packet.sequenceNumber;
    this.expectedSequenceNumber = addSequenceNumber(packet.sequenceNumber, 1);
    this.lastTimestamp = packet.timestamp;
    while (this.reorderBuffer.has(this.expectedSequenceNumber)) {
      const buffered = this.reorderBuffer.get(this.expectedSequenceNumber)!.packet;
      this.reorderBuffer.delete(this.expectedSequenceNumber);
      released.push(buffered);
      this.recordDelivered(buffered.sequenceNumber);
      this.highestSequenceNumber = buffered.sequenceNumber;
      this.expectedSequenceNumber = addSequenceNumber(buffered.sequenceNumber, 1);
      this.lastTimestamp = buffered.timestamp;
    }
    this.packetsForwarded += released.length;
    return released;
  }

  private releaseFromSmallestBuffered(): RtpReorderDrainResult {
    const previousExpectedSequenceNumber = this.expectedSequenceNumber!;
    const next = [...this.reorderBuffer.values()].sort(
      (left, right) => sequenceDistance(previousExpectedSequenceNumber, left.packet.sequenceNumber) - sequenceDistance(previousExpectedSequenceNumber, right.packet.sequenceNumber)
    )[0];
    if (!next) {
      return { packets: [] };
    }
    this.reorderBuffer.delete(next.packet.sequenceNumber);
    const packets = this.release(next.packet);
    this.expiredGaps += 1;
    return {
      packets,
      expiredGap: {
        ssrc: this.options.ssrc,
        previousExpectedSequenceNumber,
        releasedSequenceNumber: next.packet.sequenceNumber,
        bufferedForMs: Math.max(0, this.now() - next.bufferedAt),
        expiredAt: this.now()
      }
    };
  }

  private releaseExpiredGap(): RtpReorderDrainResult {
    if (this.maxReorderDelayMs <= 0 || !this.started || this.expectedSequenceNumber === undefined || this.reorderBuffer.size === 0) {
      return { packets: [] };
    }
    const oldest = this.oldestBufferedEntry();
    if (!oldest || this.now() - oldest.bufferedAt < this.maxReorderDelayMs) {
      return { packets: [] };
    }
    return this.releaseFromSmallestBuffered();
  }

  private oldestBufferedEntry(): { packet: RtpPacket; bufferedAt: number } | undefined {
    let oldest: { packet: RtpPacket; bufferedAt: number } | undefined;
    for (const entry of this.reorderBuffer.values()) {
      if (!oldest || entry.bufferedAt < oldest.bufferedAt) {
        oldest = entry;
      }
    }
    return oldest;
  }

  private recordDelivered(sequenceNumber: number): void {
    this.deliveredWindow.push(sequenceNumber);
    this.deliveredSet.add(sequenceNumber);
    while (this.deliveredWindow.length > this.duplicateWindowSize) {
      const removed = this.deliveredWindow.shift();
      if (removed !== undefined) {
        this.deliveredSet.delete(removed);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
