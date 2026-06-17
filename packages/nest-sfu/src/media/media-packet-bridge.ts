import { EventEmitter } from 'events';
import type { Consumer, Producer } from '@native-sfu/contracts';
import { RtpPacket } from '@native-sfu/sfu-core';
import type { IceAgent } from '../ice/ice-agent';
import type { SrtpSession } from '../srtp.service';
import { classifyIceDatagram, type IceDatagramKind } from './packet-classifier';

interface IceDataEvent {
  message: Buffer;
}

export interface MediaPacketBridgeCounters {
  inboundPackets: number;
  inboundStunPackets: number;
  inboundDtlsPackets: number;
  inboundRtpPackets: number;
  inboundRtcpPackets: number;
  inboundSrtpPackets: number;
  inboundSrtcpPackets: number;
  inboundUnknownPackets: number;
  inboundDecryptedRtpPackets: number;
  inboundDecryptedRtcpPackets: number;
  inboundErrors: number;
  outboundRtpPackets: number;
  outboundRtcpPackets: number;
  outboundDatagrams: number;
  outboundErrors: number;
  routedRtpPackets: number;
  routedRtcpPackets: number;
  inboundRtpPaddingOnlyPackets: number;
  inboundRtpSsrcCounts: Record<string, number>;
  inboundRtpPayloadTypeCounts: Record<string, number>;
  queueDepth: number;
  maxQueueDepth: number;
}

export interface MediaPacketBridgeOptions {
  transportId: string;
  participantId: string;
  ice: IceAgent;
  getSrtpSession: () => SrtpSession | undefined;
  onRtp: (packet: Buffer) => Promise<number>;
  onRtcp: (packet: Buffer) => Promise<number>;
  onError?: (error: Error, kind: IceDatagramKind) => void;
}

export class MediaPacketBridge extends EventEmitter {
  private readonly queue: Buffer[] = [];
  private processing = false;
  private closed = false;
  private readonly counters: MediaPacketBridgeCounters = {
    inboundPackets: 0,
    inboundStunPackets: 0,
    inboundDtlsPackets: 0,
    inboundRtpPackets: 0,
    inboundRtcpPackets: 0,
    inboundSrtpPackets: 0,
    inboundSrtcpPackets: 0,
    inboundUnknownPackets: 0,
    inboundDecryptedRtpPackets: 0,
    inboundDecryptedRtcpPackets: 0,
    inboundErrors: 0,
    outboundRtpPackets: 0,
    outboundRtcpPackets: 0,
    outboundDatagrams: 0,
    outboundErrors: 0,
    routedRtpPackets: 0,
    routedRtcpPackets: 0,
    inboundRtpPaddingOnlyPackets: 0,
    inboundRtpSsrcCounts: {},
    inboundRtpPayloadTypeCounts: {},
    queueDepth: 0,
    maxQueueDepth: 0
  };
  private readonly iceDataHandler = (event: IceDataEvent) => this.enqueue(event.message);

  constructor(private readonly options: MediaPacketBridgeOptions) {
    super();
    this.options.ice.on('data', this.iceDataHandler);
  }

  snapshot(): MediaPacketBridgeCounters {
    return { ...this.counters, queueDepth: this.queue.length };
  }

  async sendRtp(packet: RtpPacket | Buffer, consumer: Consumer): Promise<void> {
    await this.sendProtectedDatagram('rtp', Buffer.isBuffer(packet) ? packet : packet.serialize(), consumer.transportId);
  }

  async sendRtcp(packet: Buffer, target: Pick<Producer | Consumer, 'transportId'>): Promise<void> {
    await this.sendProtectedDatagram('rtcp', packet, target.transportId);
  }

  async waitForIdle(timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();
    while (this.processing || this.queue.length > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Timed out waiting for media packet bridge to drain');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.options.ice.off('data', this.iceDataHandler);
    this.queue.length = 0;
    this.counters.queueDepth = 0;
  }

  private enqueue(packet: Buffer): void {
    if (this.closed) {
      return;
    }
    this.counters.inboundPackets += 1;
    this.queue.push(Buffer.from(packet));
    this.counters.queueDepth = this.queue.length;
    this.counters.maxQueueDepth = Math.max(this.counters.maxQueueDepth, this.queue.length);
    if (!this.processing) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.processing = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const packet = this.queue.shift()!;
        this.counters.queueDepth = this.queue.length;
        await this.handleDatagram(packet);
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleDatagram(packet: Buffer): Promise<void> {
    const session = this.options.getSrtpSession();
    const kind = classifyIceDatagram(packet, { srtpEstablished: Boolean(session) });
    this.countInboundKind(kind);
    try {
      if (kind === 'srtp') {
        if (!session) {
          return;
        }
        const decrypted = await session.unprotectRtp(packet);
        const parsed = RtpPacket.parse(decrypted);
        this.recordInboundRtpPacket(parsed);
        this.counters.inboundDecryptedRtpPackets += 1;
        this.counters.routedRtpPackets += await this.options.onRtp(decrypted);
        return;
      }
      if (kind === 'srtcp') {
        if (!session) {
          return;
        }
        const decrypted = await session.unprotectRtcp(packet);
        this.counters.inboundDecryptedRtcpPackets += 1;
        this.counters.routedRtcpPackets += await this.options.onRtcp(decrypted);
        return;
      }
      if (kind === 'rtp') {
        const parsed = RtpPacket.parse(packet);
        this.recordInboundRtpPacket(parsed);
        this.counters.routedRtpPackets += await this.options.onRtp(packet);
        return;
      }
      if (kind === 'rtcp') {
        this.counters.routedRtcpPackets += await this.options.onRtcp(packet);
      }
    } catch (error) {
      this.counters.inboundErrors += 1;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onError?.(normalized, kind);
      this.emit('error', normalized);
    }
  }

  private async sendProtectedDatagram(kind: 'rtp' | 'rtcp', packet: Buffer, transportId: string): Promise<void> {
    try {
      const protectedPacket = kind === 'rtp' ? await this.protectOutboundRtp(packet) : await this.protectOutboundRtcp(packet);
      await this.options.ice.sendSelectedDatagram(protectedPacket);
      this.counters.outboundDatagrams += 1;
      if (kind === 'rtp') {
        this.counters.outboundRtpPackets += 1;
      } else {
        this.counters.outboundRtcpPackets += 1;
      }
    } catch (error) {
      this.counters.outboundErrors += 1;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onError?.(normalized, kind === 'rtp' ? 'srtp' : 'srtcp');
      this.emit('error', normalized);
      throw new Error(`Failed to send protected ${kind.toUpperCase()} on transport ${transportId}: ${normalized.message}`);
    }
  }

  private async protectOutboundRtp(packet: Buffer): Promise<Buffer> {
    const session = this.options.getSrtpSession();
    if (!session) {
      throw new Error('SRTP session is required before RTP egress');
    }
    return session.protectRtp(packet);
  }

  private async protectOutboundRtcp(packet: Buffer): Promise<Buffer> {
    const session = this.options.getSrtpSession();
    if (!session) {
      throw new Error('SRTP session is required before RTCP egress');
    }
    return session.protectRtcp(packet);
  }

  private countInboundKind(kind: IceDatagramKind): void {
    switch (kind) {
      case 'stun':
        this.counters.inboundStunPackets += 1;
        break;
      case 'dtls':
        this.counters.inboundDtlsPackets += 1;
        break;
      case 'rtp':
        this.counters.inboundRtpPackets += 1;
        break;
      case 'rtcp':
        this.counters.inboundRtcpPackets += 1;
        break;
      case 'srtp':
        this.counters.inboundSrtpPackets += 1;
        break;
      case 'srtcp':
        this.counters.inboundSrtcpPackets += 1;
        break;
      case 'unknown':
        this.counters.inboundUnknownPackets += 1;
        break;
    }
  }

  private recordInboundRtpPacket(packet: RtpPacket): void {
    incrementCounter(this.counters.inboundRtpSsrcCounts, String(packet.ssrc));
    incrementCounter(this.counters.inboundRtpPayloadTypeCounts, String(packet.payloadType));
    if (packet.padding && packet.payload.length === 0) {
      this.counters.inboundRtpPaddingOnlyPackets += 1;
    }
  }
}

function incrementCounter(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}
