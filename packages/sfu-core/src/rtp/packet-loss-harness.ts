import { RtpPacket } from './rtp-packet';

export interface DeterministicPacketLossHarnessOptions {
  lossPercentage: number;
  seed?: number;
  dropRetransmissions?: boolean;
  classifyRetransmission?: (packet: RtpPacket) => boolean;
  onDroppedPacket?: (packet: RtpPacket) => void;
}

export interface PacketLossHarnessSnapshot {
  lossPercentage: number;
  examinedPackets: number;
  droppedPackets: number;
  forwardedPackets: number;
  retransmissionPackets: number;
  effectiveLossRate: number;
}

export class DeterministicPacketLossHarness {
  private examinedPackets = 0;
  private droppedPackets = 0;
  private forwardedPackets = 0;
  private retransmissionPackets = 0;
  private readonly lossPercentage: number;
  private readonly seed: number;

  constructor(private readonly options: DeterministicPacketLossHarnessOptions) {
    this.lossPercentage = clamp(Math.floor(options.lossPercentage), 0, 100);
    this.seed = options.seed ?? 0x9e3779b9;
  }

  shouldDrop(packet: RtpPacket): boolean {
    this.examinedPackets += 1;
    const retransmission = this.options.classifyRetransmission?.(packet) ?? false;
    if (retransmission) {
      this.retransmissionPackets += 1;
    }
    const drop = (!retransmission || this.options.dropRetransmissions === true) && this.lossPercentage > 0 && hashPacket(packet, this.seed) % 100 < this.lossPercentage;
    if (drop) {
      this.droppedPackets += 1;
      this.options.onDroppedPacket?.(packet);
      return true;
    }
    this.forwardedPackets += 1;
    return false;
  }

  snapshot(): PacketLossHarnessSnapshot {
    return {
      lossPercentage: this.lossPercentage,
      examinedPackets: this.examinedPackets,
      droppedPackets: this.droppedPackets,
      forwardedPackets: this.forwardedPackets,
      retransmissionPackets: this.retransmissionPackets,
      effectiveLossRate: this.examinedPackets === 0 ? 0 : this.droppedPackets / this.examinedPackets
    };
  }
}

function hashPacket(packet: RtpPacket, seed: number): number {
  let value = (packet.ssrc ^ (packet.sequenceNumber << 16) ^ packet.payloadType ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
