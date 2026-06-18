import { RtpPacket } from './rtp-packet';

export interface CachedRtpPacket {
  ssrc: number;
  sequenceNumber: number;
  packet: RtpPacket;
  storedAt: number;
}

export interface RtpRetransmissionCacheSnapshot {
  size: number;
  maxPackets: number;
  sequencesBySsrc: Record<number, number[]>;
}

export class RtpRetransmissionCache {
  private readonly packets = new Map<string, CachedRtpPacket>();
  private readonly insertionOrder: string[] = [];

  constructor(
    private readonly maxPackets = 512,
    private readonly now: () => number = () => Date.now()
  ) {
    if (!Number.isInteger(maxPackets) || maxPackets < 0) {
      throw new Error('RTP retransmission cache size must be a non-negative integer');
    }
  }

  store(packet: RtpPacket): void {
    if (this.maxPackets === 0) {
      return;
    }
    const key = cacheKey(packet.ssrc, packet.sequenceNumber);
    const existingIndex = this.insertionOrder.indexOf(key);
    if (existingIndex >= 0) {
      this.insertionOrder.splice(existingIndex, 1);
    }
    this.insertionOrder.push(key);
    this.packets.set(key, {
      ssrc: packet.ssrc,
      sequenceNumber: packet.sequenceNumber,
      packet,
      storedAt: this.now()
    });
    this.evict();
  }

  get(ssrc: number, sequenceNumber: number): RtpPacket | undefined {
    return this.packets.get(cacheKey(ssrc, sequenceNumber))?.packet;
  }

  has(ssrc: number, sequenceNumber: number): boolean {
    return this.packets.has(cacheKey(ssrc, sequenceNumber));
  }

  clear(): void {
    this.packets.clear();
    this.insertionOrder.length = 0;
  }

  snapshot(): RtpRetransmissionCacheSnapshot {
    const sequencesBySsrc: Record<number, number[]> = {};
    const orderedPackets = [...this.packets.values()].sort((left, right) => {
      if (left.storedAt !== right.storedAt) {
        return left.storedAt - right.storedAt;
      }
      return left.sequenceNumber - right.sequenceNumber;
    });
    for (const packet of orderedPackets) {
      sequencesBySsrc[packet.ssrc] ??= [];
      sequencesBySsrc[packet.ssrc]!.push(packet.sequenceNumber);
    }
    return {
      size: this.packets.size,
      maxPackets: this.maxPackets,
      sequencesBySsrc
    };
  }

  private evict(): void {
    while (this.packets.size > this.maxPackets) {
      const key = this.insertionOrder.shift();
      if (!key) {
        return;
      }
      this.packets.delete(key);
    }
  }
}

function cacheKey(ssrc: number, sequenceNumber: number): string {
  return `${ssrc >>> 0}:${sequenceNumber & 0xffff}`;
}
