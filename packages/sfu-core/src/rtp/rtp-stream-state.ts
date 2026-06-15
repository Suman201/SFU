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
  restartSequenceGap?: number;
  duplicateWindowSize?: number;
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
  bufferedSequences: number[];
}

export interface RtpSourceStreamAcceptResult {
  packets: RtpPacket[];
  buffered: boolean;
  restarted: boolean;
  dropReason?: RtpPacketDropReason;
}

export class RtpSourceStreamState {
  private readonly allowedPayloadTypes: Set<number>;
  private readonly maxReorderPackets: number;
  private readonly restartSequenceGap: number;
  private readonly duplicateWindowSize: number;
  private started = false;
  private highestSequenceNumber?: number;
  private expectedSequenceNumber?: number;
  private lastTimestamp?: number;
  private readonly reorderBuffer = new Map<number, RtpPacket>();
  private readonly deliveredWindow: number[] = [];
  private readonly deliveredSet = new Set<number>();
  private packetsReceived = 0;
  private packetsForwarded = 0;
  private duplicatePackets = 0;
  private latePackets = 0;
  private restartCount = 0;

  constructor(private readonly options: RtpSourceStreamStateOptions) {
    this.allowedPayloadTypes = new Set([...options.allowedPayloadTypes].map((value) => value & 0x7f));
    this.maxReorderPackets = options.maxReorderPackets ?? 64;
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
    this.reorderBuffer.set(packet.sequenceNumber, packet);
    if (this.reorderBuffer.size > this.maxReorderPackets) {
      return { packets: this.releaseFromSmallestBuffered(), buffered: false, restarted: false, dropReason: 'reorder_buffer_overflow' };
    }
    return { packets: [], buffered: true, restarted: false };
  }

  snapshot(): RtpStreamSnapshot {
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
      bufferedSequences: [...this.reorderBuffer.keys()].sort((left, right) => sequenceDelta(left, right))
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
      const buffered = this.reorderBuffer.get(this.expectedSequenceNumber)!;
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

  private releaseFromSmallestBuffered(): RtpPacket[] {
    const next = [...this.reorderBuffer.values()].sort((left, right) => sequenceDistance(this.expectedSequenceNumber!, left.sequenceNumber) - sequenceDistance(this.expectedSequenceNumber!, right.sequenceNumber))[0];
    if (!next) {
      return [];
    }
    this.reorderBuffer.delete(next.sequenceNumber);
    return this.release(next);
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
}
