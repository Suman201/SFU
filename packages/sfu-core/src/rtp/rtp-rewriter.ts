import { RtpPacket } from './rtp-packet';
import { addSequenceNumber, addTimestamp, sequenceDelta, timestampDistance } from './rtp-sequence';

export interface RtpRewriteMapping {
  sourceSsrc: number;
  targetSsrc: number;
  sourcePayloadType: number;
  targetPayloadType: number;
}

export interface RtpRewriteSnapshot {
  sourceSsrc: number;
  targetSsrc: number;
  sourceBaseSequenceNumber: number;
  targetBaseSequenceNumber: number;
  sourceBaseTimestamp: number;
  targetBaseTimestamp: number;
  packetsRewritten: number;
}

export interface RtpRewriteTargetInfo {
  sourceSsrc: number;
  targetSsrc: number;
  targetTimestamp: number;
}

export interface ConsumerRtpRewriterOptions {
  sequenceNumberGenerator?: () => number;
  timestampGenerator?: () => number;
}

interface TargetContinuity {
  lastSequenceNumber?: number;
  lastTimestamp?: number;
  nextSequenceNumber?: number;
  nextTimestamp?: number;
}

export class ConsumerRtpRewriter {
  private readonly streams = new Map<number, RtpStreamRewriter>();
  private readonly targetToSource = new Map<number, number>();
  private readonly targetContinuity = new Map<number, TargetContinuity>();

  constructor(private readonly options: ConsumerRtpRewriterOptions = {}) {}

  rewrite(packet: RtpPacket, mapping: RtpRewriteMapping): RtpPacket {
    let stream = this.streams.get(mapping.sourceSsrc);
    if (!stream || stream.targetSsrc !== mapping.targetSsrc) {
      stream = new RtpStreamRewriter(packet, mapping, this.options, this.targetContinuity.get(mapping.targetSsrc));
      this.streams.set(mapping.sourceSsrc, stream);
      this.targetToSource.set(mapping.targetSsrc, mapping.sourceSsrc);
    }
    const rewritten = stream.rewrite(packet, mapping);
    this.targetContinuity.set(mapping.targetSsrc, {
      lastSequenceNumber: rewritten.sequenceNumber,
      lastTimestamp: rewritten.timestamp,
      nextSequenceNumber: addSequenceNumber(rewritten.sequenceNumber, 1),
      nextTimestamp: addTimestamp(rewritten.timestamp, 3000)
    });
    return rewritten;
  }

  preview(packet: RtpPacket, mapping: RtpRewriteMapping): RtpPacket {
    const stream = this.streams.get(mapping.sourceSsrc);
    if (!stream || stream.targetSsrc !== mapping.targetSsrc) {
      return this.rewrite(packet, mapping);
    }
    return stream.rewrite(packet, mapping, false);
  }

  resetSource(sourceSsrc: number): void {
    const stream = this.streams.get(sourceSsrc);
    if (stream) {
      this.targetToSource.delete(stream.targetSsrc);
      this.targetContinuity.delete(stream.targetSsrc);
      this.streams.delete(sourceSsrc);
    }
  }

  sourceSsrcForTarget(targetSsrc: number): number | undefined {
    return this.targetToSource.get(targetSsrc);
  }

  sourceSequenceForTarget(targetSsrc: number, targetSequenceNumber: number): { sourceSsrc: number; sequenceNumber: number } | undefined {
    const sourceSsrc = this.targetToSource.get(targetSsrc);
    if (sourceSsrc === undefined) {
      return undefined;
    }
    const stream = this.streams.get(sourceSsrc);
    if (!stream || stream.targetSsrc !== targetSsrc) {
      return undefined;
    }
    return {
      sourceSsrc,
      sequenceNumber: stream.sourceSequenceForTarget(targetSequenceNumber)
    };
  }

  targetInfoForSource(sourceSsrc: number, sourceTimestamp: number): RtpRewriteTargetInfo | undefined {
    const stream = this.streams.get(sourceSsrc);
    if (!stream) {
      return undefined;
    }
    return {
      sourceSsrc,
      targetSsrc: stream.targetSsrc,
      targetTimestamp: stream.targetTimestampForSource(sourceTimestamp)
    };
  }

  snapshot(): RtpRewriteSnapshot[] {
    return [...this.streams.values()].map((stream) => stream.snapshot());
  }
}

class RtpStreamRewriter {
  readonly sourceSsrc: number;
  readonly targetSsrc: number;
  private readonly sourceBaseSequenceNumber: number;
  private readonly targetBaseSequenceNumber: number;
  private readonly sourceBaseTimestamp: number;
  private readonly targetBaseTimestamp: number;
  private readonly sourceToTargetSequence = new Map<number, number>();
  private readonly targetToSourceSequence = new Map<number, number>();
  private nextTargetSequenceNumber: number;
  private packetsRewritten = 0;

  constructor(packet: RtpPacket, mapping: RtpRewriteMapping, options: ConsumerRtpRewriterOptions, continuity?: TargetContinuity) {
    this.sourceSsrc = mapping.sourceSsrc;
    this.targetSsrc = mapping.targetSsrc;
    this.sourceBaseSequenceNumber = packet.sequenceNumber;
    this.targetBaseSequenceNumber = continuity?.nextSequenceNumber ?? options.sequenceNumberGenerator?.() ?? packet.sequenceNumber;
    this.sourceBaseTimestamp = packet.timestamp;
    this.targetBaseTimestamp = continuity?.nextTimestamp ?? options.timestampGenerator?.() ?? packet.timestamp;
    this.nextTargetSequenceNumber = this.targetBaseSequenceNumber;
  }

  rewrite(packet: RtpPacket, mapping: RtpRewriteMapping, record = true): RtpPacket {
    const timestampOffset = timestampDistance(this.sourceBaseTimestamp, packet.timestamp);
    const targetSequenceNumber = record ? this.targetSequenceNumberForRecord(packet.sequenceNumber) : this.targetSequenceNumberForPreview(packet.sequenceNumber);
    if (record) {
      this.packetsRewritten += 1;
    }
    return new RtpPacket(
      packet.version,
      packet.padding,
      packet.extension,
      packet.marker,
      mapping.targetPayloadType,
      targetSequenceNumber,
      addTimestamp(this.targetBaseTimestamp, timestampOffset),
      mapping.targetSsrc,
      [...packet.csrc],
      packet.headerExtension ? { profile: packet.headerExtension.profile, value: Buffer.from(packet.headerExtension.value) } : null,
      Buffer.from(packet.payload)
    );
  }

  sourceSequenceForTarget(targetSequenceNumber: number): number {
    const mapped = this.targetToSourceSequence.get(targetSequenceNumber & 0xffff);
    if (mapped !== undefined) {
      return mapped;
    }
    return addSequenceNumber(this.sourceBaseSequenceNumber, sequenceDelta(targetSequenceNumber, this.targetBaseSequenceNumber));
  }

  targetTimestampForSource(sourceTimestamp: number): number {
    return addTimestamp(this.targetBaseTimestamp, timestampDistance(this.sourceBaseTimestamp, sourceTimestamp));
  }

  snapshot(): RtpRewriteSnapshot {
    return {
      sourceSsrc: this.sourceSsrc,
      targetSsrc: this.targetSsrc,
      sourceBaseSequenceNumber: this.sourceBaseSequenceNumber,
      targetBaseSequenceNumber: this.targetBaseSequenceNumber,
      sourceBaseTimestamp: this.sourceBaseTimestamp,
      targetBaseTimestamp: this.targetBaseTimestamp,
      packetsRewritten: this.packetsRewritten
    };
  }

  private targetSequenceNumberForRecord(sourceSequenceNumber: number): number {
    const normalizedSource = sourceSequenceNumber & 0xffff;
    const existing = this.sourceToTargetSequence.get(normalizedSource);
    if (existing !== undefined) {
      return existing;
    }
    const target = this.nextTargetSequenceNumber & 0xffff;
    this.sourceToTargetSequence.set(normalizedSource, target);
    this.targetToSourceSequence.set(target, normalizedSource);
    this.nextTargetSequenceNumber = addSequenceNumber(target, 1);
    return target;
  }

  private targetSequenceNumberForPreview(sourceSequenceNumber: number): number {
    const existing = this.sourceToTargetSequence.get(sourceSequenceNumber & 0xffff);
    return existing ?? this.nextTargetSequenceNumber;
  }
}
