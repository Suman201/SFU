import { RtpPacket } from './rtp-packet';

export interface DeterministicPacketImpairmentHarnessOptions<T = Buffer> {
  lossPercentage?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  maxThroughputBps?: number;
  seed?: number;
  now?: () => number;
  packetKey?: (packet: T) => string;
  packetSize?: (packet: T) => number;
  onDroppedPacket?: (packet: T) => void;
}

export interface ImpairedPacket<T> {
  packet: T;
  sentAt: number;
  releaseAt: number;
  sizeBytes: number;
  sequence: number;
}

export interface PacketImpairmentEnqueueResult {
  dropped: boolean;
  releaseAt?: number;
  sequence: number;
}

export interface PacketImpairmentHarnessSnapshot {
  lossPercentage: number;
  baseDelayMs: number;
  jitterMs: number;
  maxThroughputBps?: number;
  enqueuedPackets: number;
  droppedPackets: number;
  releasedPackets: number;
  queuedPackets: number;
  queuedBytes: number;
  effectiveLossRate: number;
  nextReleaseAt?: number;
}

interface ScheduledPacket<T> extends ImpairedPacket<T> {}

export class DeterministicPacketImpairmentHarness<T = Buffer> {
  private readonly lossPercentage: number;
  private readonly baseDelayMs: number;
  private readonly jitterMs: number;
  private readonly maxThroughputBps?: number;
  private readonly seed: number;
  private readonly now: () => number;
  private readonly packetKey: (packet: T) => string;
  private readonly packetSize: (packet: T) => number;
  private readonly queue: Array<ScheduledPacket<T>> = [];
  private enqueuedPackets = 0;
  private droppedPackets = 0;
  private releasedPackets = 0;
  private queuedBytes = 0;
  private sequence = 0;
  private nextTransmitAt = 0;

  constructor(private readonly options: DeterministicPacketImpairmentHarnessOptions<T> = {}) {
    this.lossPercentage = clamp(Math.floor(options.lossPercentage ?? 0), 0, 100);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 0);
    this.jitterMs = Math.max(0, options.jitterMs ?? 0);
    this.maxThroughputBps = options.maxThroughputBps && options.maxThroughputBps > 0 ? options.maxThroughputBps : undefined;
    this.seed = options.seed ?? 0x517cc1b7;
    this.now = options.now ?? Date.now;
    this.packetKey = options.packetKey ?? defaultPacketKey;
    this.packetSize = options.packetSize ?? defaultPacketSize;
  }

  enqueue(packet: T, sentAt = this.now()): PacketImpairmentEnqueueResult {
    const sequence = ++this.sequence;
    this.enqueuedPackets += 1;

    const key = this.packetKey(packet);
    if (shouldDropPacket(key, this.seed, this.lossPercentage)) {
      this.droppedPackets += 1;
      this.options.onDroppedPacket?.(packet);
      return { dropped: true, sequence };
    }

    const sizeBytes = Math.max(1, Math.floor(this.packetSize(packet)));
    const jitterOffset = deterministicJitterOffset(key, this.seed, this.jitterMs);
    const delayedAt = Math.max(sentAt, sentAt + this.baseDelayMs + jitterOffset);
    const serialDurationMs = this.maxThroughputBps ? (sizeBytes * 8 * 1000) / this.maxThroughputBps : 0;
    const releaseAt = Math.max(delayedAt, this.nextTransmitAt);
    this.nextTransmitAt = releaseAt + serialDurationMs;

    this.queue.push({ packet, sentAt, releaseAt, sizeBytes, sequence });
    this.queue.sort((left, right) => left.releaseAt - right.releaseAt || left.sequence - right.sequence);
    this.queuedBytes += sizeBytes;
    return { dropped: false, releaseAt, sequence };
  }

  drain(now = this.now()): Array<ImpairedPacket<T>> {
    const released: Array<ImpairedPacket<T>> = [];
    while (this.queue.length > 0 && this.queue[0]!.releaseAt <= now) {
      const packet = this.queue.shift()!;
      this.queuedBytes = Math.max(0, this.queuedBytes - packet.sizeBytes);
      this.releasedPackets += 1;
      released.push(packet);
    }
    return released;
  }

  flushAll(): Array<ImpairedPacket<T>> {
    if (this.queue.length === 0) {
      return [];
    }
    return this.drain(this.queue[this.queue.length - 1]!.releaseAt);
  }

  snapshot(): PacketImpairmentHarnessSnapshot {
    return {
      lossPercentage: this.lossPercentage,
      baseDelayMs: this.baseDelayMs,
      jitterMs: this.jitterMs,
      maxThroughputBps: this.maxThroughputBps,
      enqueuedPackets: this.enqueuedPackets,
      droppedPackets: this.droppedPackets,
      releasedPackets: this.releasedPackets,
      queuedPackets: this.queue.length,
      queuedBytes: this.queuedBytes,
      effectiveLossRate: this.enqueuedPackets === 0 ? 0 : this.droppedPackets / this.enqueuedPackets,
      nextReleaseAt: this.queue[0]?.releaseAt
    };
  }
}

function defaultPacketKey(packet: unknown): string {
  if (packet instanceof RtpPacket) {
    return `${packet.ssrc}:${packet.sequenceNumber}:${packet.timestamp}:${packet.payloadType}`;
  }
  if (Buffer.isBuffer(packet)) {
    return packet.toString('hex');
  }
  if (packet && typeof packet === 'object') {
    const candidate = packet as { ssrc?: unknown; sequenceNumber?: unknown; timestamp?: unknown; payloadType?: unknown };
    if (
      typeof candidate.ssrc === 'number' &&
      typeof candidate.sequenceNumber === 'number' &&
      typeof candidate.timestamp === 'number'
    ) {
      return `${candidate.ssrc}:${candidate.sequenceNumber}:${candidate.timestamp}:${typeof candidate.payloadType === 'number' ? candidate.payloadType : 0}`;
    }
  }
  return JSON.stringify(packet);
}

function defaultPacketSize(packet: unknown): number {
  if (packet instanceof RtpPacket) {
    return packet.serialize().length;
  }
  if (Buffer.isBuffer(packet)) {
    return packet.length;
  }
  return Buffer.byteLength(JSON.stringify(packet));
}

function shouldDropPacket(key: string, seed: number, lossPercentage: number): boolean {
  return lossPercentage > 0 && hashKey(key, seed) % 100 < lossPercentage;
}

function deterministicJitterOffset(key: string, seed: number, jitterMs: number): number {
  if (jitterMs <= 0) {
    return 0;
  }
  const span = jitterMs * 2 + 1;
  return (hashKey(key, seed ^ 0x9e3779b9) % span) - jitterMs;
}

function hashKey(key: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
