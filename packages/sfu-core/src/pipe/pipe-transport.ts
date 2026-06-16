import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RtpParameters } from '@native-sfu/contracts';
import { parseRtcpCompound, RTCP_PSFB, RTCP_RR, RTCP_RTPFB, RTCP_SR, serializeRtcpPacket, type RtcpPacket } from '../rtcp/rtcp-packet';
import { RtpPacket } from '../rtp/rtp-packet';
import { sequenceDelta } from '../rtp/rtp-sequence';

export type PipePacketKind = 'rtp' | 'rtcp';
export type PipeDropReason = 'closed' | 'missing_peer' | 'unknown_producer' | 'unknown_consumer' | 'invalid_packet' | 'invalid_ssrc' | 'replay' | 'backpressure';

export interface PipeTransportOptions {
  id?: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  maxQueuePackets?: number;
  maxQueueBytes?: number;
  replayWindowSize?: number;
  now?: () => number;
}

export interface PipeProducerOptions {
  id: string;
  participantId: string;
  rtpParameters: RtpParameters;
  ssrcMappings?: PipeSsrcMapping[];
}

export interface PipeConsumerOptions {
  id: string;
  producerId: string;
  participantId: string;
  rtpParameters: RtpParameters;
  ssrcMappings?: PipeSsrcMapping[];
}

export interface PipeSsrcMapping {
  sourceSsrc: number;
  targetSsrc: number;
}

export interface PipePacketEvent {
  transportId: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  producerId?: string;
  consumerId?: string;
  kind: PipePacketKind;
  packet: Buffer;
  ssrc?: number;
  sequenceNumber?: number;
  timestamp?: number;
  receivedAt: number;
}

export interface PipeDropEvent {
  transportId: string;
  roomId: string;
  producerId?: string;
  consumerId?: string;
  kind?: PipePacketKind;
  reason: PipeDropReason;
}

export interface PipeTransportSnapshot {
  id: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  active: boolean;
  producers: number;
  consumers: number;
  rtpPackets: number;
  rtpBytes: number;
  rtcpPackets: number;
  rtcpBytes: number;
  droppedPackets: number;
  dropReasons: Record<PipeDropReason, number>;
  backpressureEvents: number;
  queueDepthPackets: number;
  queueDepthBytes: number;
  createdAt: string;
  closedAt?: string;
}

interface PipeProducerState extends PipeProducerOptions {
  ssrcs: Set<number>;
  outboundSsrcMap: Map<number, number>;
}

interface PipeConsumerState extends PipeConsumerOptions {
  ssrcs: Set<number>;
  inboundSsrcMap: Map<number, number>;
}

interface PipePacketEnvelope {
  kind: PipePacketKind;
  packet: Buffer;
  producerId?: string;
  consumerId?: string;
}

export class PipeTransport extends EventEmitter {
  readonly id: string;
  private readonly createdAt = new Date().toISOString();
  private readonly now: () => number;
  private readonly replayWindowSize: number;
  private readonly maxQueuePackets: number;
  private readonly maxQueueBytes: number;
  private readonly producers = new Map<string, PipeProducerState>();
  private readonly consumers = new Map<string, PipeConsumerState>();
  private readonly inboundReplay = new Map<number, PipeReplayWindow>();
  private readonly stats: Omit<PipeTransportSnapshot, 'id' | 'roomId' | 'localNodeId' | 'remoteNodeId' | 'active' | 'producers' | 'consumers' | 'createdAt' | 'closedAt'> = {
    rtpPackets: 0,
    rtpBytes: 0,
    rtcpPackets: 0,
    rtcpBytes: 0,
    droppedPackets: 0,
    dropReasons: {
      closed: 0,
      missing_peer: 0,
      unknown_producer: 0,
      unknown_consumer: 0,
      invalid_packet: 0,
      invalid_ssrc: 0,
      replay: 0,
      backpressure: 0
    },
    backpressureEvents: 0,
    queueDepthPackets: 0,
    queueDepthBytes: 0
  };
  private peer?: PipeTransport;
  private closedAt?: string;

  constructor(private readonly options: PipeTransportOptions) {
    super();
    this.id = options.id ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.replayWindowSize = options.replayWindowSize ?? 128;
    this.maxQueuePackets = options.maxQueuePackets ?? 1024;
    this.maxQueueBytes = options.maxQueueBytes ?? 4 * 1024 * 1024;
  }

  connect(peer: PipeTransport): void {
    this.peer = peer;
  }

  createProducer(options: PipeProducerOptions): void {
    const mappings = new Map((options.ssrcMappings ?? []).map((mapping) => [mapping.sourceSsrc >>> 0, mapping.targetSsrc >>> 0]));
    this.producers.set(options.id, {
      ...options,
      ssrcs: new Set(rtpSsrcs(options.rtpParameters)),
      outboundSsrcMap: mappings
    });
  }

  closeProducer(producerId: string): void {
    this.producers.delete(producerId);
  }

  createConsumer(options: PipeConsumerOptions): void {
    const mappings = new Map((options.ssrcMappings ?? []).map((mapping) => [mapping.sourceSsrc >>> 0, mapping.targetSsrc >>> 0]));
    this.consumers.set(options.id, {
      ...options,
      ssrcs: new Set(rtpSsrcs(options.rtpParameters)),
      inboundSsrcMap: mappings
    });
  }

  closeConsumer(consumerId: string): void {
    this.consumers.delete(consumerId);
  }

  async sendRtp(producerId: string, packet: Buffer): Promise<boolean> {
    if (this.closedAt) {
      this.drop('closed', { kind: 'rtp', producerId });
      return false;
    }
    const producer = this.producers.get(producerId);
    if (!producer) {
      this.drop('unknown_producer', { kind: 'rtp', producerId });
      return false;
    }
    const rewritten = this.rewriteOutboundRtp(packet, producer);
    if (!rewritten) {
      return false;
    }
    return this.dispatchToPeer({ kind: 'rtp', packet: rewritten, producerId });
  }

  async sendRtcp(packet: Buffer, options: { producerId?: string; consumerId?: string; ssrcMappings?: PipeSsrcMapping[] } = {}): Promise<boolean> {
    if (this.closedAt) {
      this.drop('closed', { kind: 'rtcp', producerId: options.producerId, consumerId: options.consumerId });
      return false;
    }
    if (options.consumerId && !this.consumers.has(options.consumerId)) {
      this.drop('unknown_consumer', { kind: 'rtcp', consumerId: options.consumerId });
      return false;
    }
    if (options.producerId && !this.producers.has(options.producerId)) {
      this.drop('unknown_producer', { kind: 'rtcp', producerId: options.producerId });
      return false;
    }
    const rewritten = this.rewriteRtcp(packet, options.ssrcMappings ?? this.inferRtcpSsrcMappings(options));
    if (!rewritten) {
      this.drop('invalid_packet', { kind: 'rtcp', producerId: options.producerId, consumerId: options.consumerId });
      return false;
    }
    return this.dispatchToPeer({ kind: 'rtcp', packet: rewritten, producerId: options.producerId, consumerId: options.consumerId });
  }

  close(reason = 'manual'): void {
    if (this.closedAt) {
      return;
    }
    this.closedAt = new Date(this.now()).toISOString();
    this.producers.clear();
    this.consumers.clear();
    this.emit('close', { transportId: this.id, reason });
  }

  snapshot(): PipeTransportSnapshot {
    return {
      id: this.id,
      roomId: this.options.roomId,
      localNodeId: this.options.localNodeId,
      remoteNodeId: this.options.remoteNodeId,
      active: !this.closedAt,
      producers: this.producers.size,
      consumers: this.consumers.size,
      rtpPackets: this.stats.rtpPackets,
      rtpBytes: this.stats.rtpBytes,
      rtcpPackets: this.stats.rtcpPackets,
      rtcpBytes: this.stats.rtcpBytes,
      droppedPackets: this.stats.droppedPackets,
      dropReasons: { ...this.stats.dropReasons },
      backpressureEvents: this.stats.backpressureEvents,
      queueDepthPackets: this.stats.queueDepthPackets,
      queueDepthBytes: this.stats.queueDepthBytes,
      createdAt: this.createdAt,
      closedAt: this.closedAt
    };
  }

  private async dispatchToPeer(envelope: PipePacketEnvelope): Promise<boolean> {
    if (!this.peer || this.peer.closedAt) {
      this.drop('missing_peer', { kind: envelope.kind, producerId: envelope.producerId, consumerId: envelope.consumerId });
      return false;
    }
    if (!this.reserveQueue(envelope.packet.length)) {
      this.drop('backpressure', { kind: envelope.kind, producerId: envelope.producerId, consumerId: envelope.consumerId });
      this.stats.backpressureEvents += 1;
      this.emit('backpressure', this.snapshot());
      return false;
    }
    try {
      await this.peer.receive(envelope);
      return true;
    } finally {
      this.releaseQueue(envelope.packet.length);
    }
  }

  private async receive(envelope: PipePacketEnvelope): Promise<void> {
    if (this.closedAt) {
      this.drop('closed', { kind: envelope.kind, producerId: envelope.producerId, consumerId: envelope.consumerId });
      return;
    }
    if (envelope.kind === 'rtp') {
      this.receiveRtp(envelope);
      return;
    }
    this.receiveRtcp(envelope);
  }

  private receiveRtp(envelope: PipePacketEnvelope): void {
    let packet: RtpPacket;
    try {
      packet = RtpPacket.parse(envelope.packet);
    } catch {
      this.drop('invalid_packet', { kind: 'rtp', producerId: envelope.producerId });
      return;
    }
    const replay = this.inboundReplay.get(packet.ssrc) ?? new PipeReplayWindow(this.replayWindowSize);
    this.inboundReplay.set(packet.ssrc, replay);
    if (!replay.accept(packet.sequenceNumber)) {
      this.drop('replay', { kind: 'rtp', producerId: envelope.producerId });
      return;
    }
    this.stats.rtpPackets += 1;
    this.stats.rtpBytes += envelope.packet.length;
    this.emit('rtp', this.packetEvent(envelope, packet));
  }

  private receiveRtcp(envelope: PipePacketEnvelope): void {
    try {
      parseRtcpCompound(envelope.packet);
    } catch {
      this.drop('invalid_packet', { kind: 'rtcp', producerId: envelope.producerId, consumerId: envelope.consumerId });
      return;
    }
    this.stats.rtcpPackets += 1;
    this.stats.rtcpBytes += envelope.packet.length;
    this.emit('rtcp', this.packetEvent(envelope));
  }

  private rewriteOutboundRtp(packet: Buffer, producer: PipeProducerState): Buffer | undefined {
    let rtp: RtpPacket;
    try {
      rtp = RtpPacket.parse(packet);
    } catch {
      this.drop('invalid_packet', { kind: 'rtp', producerId: producer.id });
      return undefined;
    }
    if (producer.ssrcs.size > 0 && !producer.ssrcs.has(rtp.ssrc)) {
      this.drop('invalid_ssrc', { kind: 'rtp', producerId: producer.id });
      return undefined;
    }
    const mappedSsrc = producer.outboundSsrcMap.get(rtp.ssrc) ?? rtp.ssrc;
    if (mappedSsrc === rtp.ssrc) {
      return packet;
    }
    return new RtpPacket(rtp.version, rtp.padding, rtp.extension, rtp.marker, rtp.payloadType, rtp.sequenceNumber, rtp.timestamp, mappedSsrc, rtp.csrc, rtp.headerExtension, rtp.payload).serialize();
  }

  private rewriteRtcp(packet: Buffer, mappings: PipeSsrcMapping[] | undefined): Buffer | undefined {
    if (!mappings || mappings.length === 0) {
      return packet;
    }
    const map = new Map(mappings.map((mapping) => [mapping.sourceSsrc >>> 0, mapping.targetSsrc >>> 0]));
    try {
      return Buffer.concat(parseRtcpCompound(packet).map((rtcp) => serializeRtcpPacket(rewriteRtcpPacketSsrcs(rtcp, map))));
    } catch {
      return undefined;
    }
  }

  private inferRtcpSsrcMappings(options: { producerId?: string; consumerId?: string }): PipeSsrcMapping[] | undefined {
    if (options.consumerId) {
      const consumer = this.consumers.get(options.consumerId);
      return consumer ? mapToSsrcMappings(consumer.inboundSsrcMap) : undefined;
    }
    if (options.producerId) {
      const producer = this.producers.get(options.producerId);
      return producer ? mapToSsrcMappings(producer.outboundSsrcMap) : undefined;
    }
    return undefined;
  }

  private reserveQueue(bytes: number): boolean {
    if (this.stats.queueDepthPackets + 1 > this.maxQueuePackets || this.stats.queueDepthBytes + bytes > this.maxQueueBytes) {
      return false;
    }
    this.stats.queueDepthPackets += 1;
    this.stats.queueDepthBytes += bytes;
    return true;
  }

  private releaseQueue(bytes: number): void {
    this.stats.queueDepthPackets = Math.max(0, this.stats.queueDepthPackets - 1);
    this.stats.queueDepthBytes = Math.max(0, this.stats.queueDepthBytes - bytes);
  }

  private drop(reason: PipeDropReason, event: Partial<PipeDropEvent>): void {
    this.stats.droppedPackets += 1;
    this.stats.dropReasons[reason] += 1;
    this.emit('drop', {
      transportId: this.id,
      roomId: this.options.roomId,
      reason,
      ...event
    } satisfies PipeDropEvent);
  }

  private packetEvent(envelope: PipePacketEnvelope, packet?: RtpPacket): PipePacketEvent {
    return {
      transportId: this.id,
      roomId: this.options.roomId,
      localNodeId: this.options.localNodeId,
      remoteNodeId: this.options.remoteNodeId,
      producerId: envelope.producerId,
      consumerId: envelope.consumerId,
      kind: envelope.kind,
      packet: envelope.packet,
      ssrc: packet?.ssrc,
      sequenceNumber: packet?.sequenceNumber,
      timestamp: packet?.timestamp,
      receivedAt: this.now()
    };
  }
}

export class PipeTransportManager {
  private readonly transports = new Map<string, PipeTransport>();

  createTransport(options: PipeTransportOptions): PipeTransport {
    const transport = new PipeTransport(options);
    this.transports.set(transport.id, transport);
    transport.once('close', () => {
      this.transports.delete(transport.id);
    });
    return transport;
  }

  getTransport(id: string): PipeTransport | undefined {
    return this.transports.get(id);
  }

  connect(leftId: string, right: PipeTransport): void {
    const left = this.requireTransport(leftId);
    left.connect(right);
    right.connect(left);
  }

  closeTransport(id: string, reason?: string): void {
    this.transports.get(id)?.close(reason);
    this.transports.delete(id);
  }

  closeRoom(roomId: string): void {
    for (const transport of [...this.transports.values()]) {
      if (transport.snapshot().roomId === roomId) {
        transport.close('room_closed');
      }
    }
  }

  snapshots(): PipeTransportSnapshot[] {
    return [...this.transports.values()].map((transport) => transport.snapshot());
  }

  private requireTransport(id: string): PipeTransport {
    const transport = this.transports.get(id);
    if (!transport) {
      throw new Error(`Pipe transport ${id} not found`);
    }
    return transport;
  }
}

export function connectPipeTransports(left: PipeTransport, right: PipeTransport): void {
  left.connect(right);
  right.connect(left);
}

class PipeReplayWindow {
  private highestSequence: number | undefined;
  private window = 0n;

  constructor(private readonly size: number) {}

  accept(sequenceNumber: number): boolean {
    const normalized = sequenceNumber & 0xffff;
    if (this.highestSequence === undefined) {
      this.highestSequence = normalized;
      this.window = 1n;
      return true;
    }
    const delta = sequenceDelta(normalized, this.highestSequence);
    if (delta > 0) {
      const shift = BigInt(delta);
      this.window = shift >= BigInt(this.size) ? 1n : ((this.window << shift) | 1n) & this.mask;
      this.highestSequence = normalized;
      return true;
    }
    const behind = BigInt(-delta);
    if (behind >= BigInt(this.size)) {
      return false;
    }
    const bit = 1n << behind;
    if (this.window & bit) {
      return false;
    }
    this.window |= bit;
    return true;
  }

  private get mask(): bigint {
    return (1n << BigInt(this.size)) - 1n;
  }
}

function rtpSsrcs(rtpParameters: RtpParameters): number[] {
  return rtpParameters.encodings
    .flatMap((encoding) => (encoding.rtx?.ssrc !== undefined ? [encoding.ssrc, encoding.rtx.ssrc] : [encoding.ssrc]))
    .filter((ssrc): ssrc is number => typeof ssrc === 'number' && Number.isFinite(ssrc) && ssrc > 0)
    .map((ssrc) => ssrc >>> 0);
}

function mapToSsrcMappings(map: Map<number, number>): PipeSsrcMapping[] | undefined {
  if (map.size === 0) {
    return undefined;
  }
  return [...map.entries()].map(([sourceSsrc, targetSsrc]) => ({ sourceSsrc, targetSsrc }));
}

function rewriteRtcpPacketSsrcs(packet: RtcpPacket, mappings: Map<number, number>): RtcpPacket {
  const payload = Buffer.from(packet.payload);
  const rewrite = (offset: number): void => {
    if (offset + 4 <= payload.length) {
      const mapped = mappings.get(payload.readUInt32BE(offset));
      if (mapped !== undefined) {
        payload.writeUInt32BE(mapped >>> 0, offset);
      }
    }
  };
  if (packet.type === RTCP_SR) {
    rewrite(0);
    for (let offset = 24; offset + 24 <= payload.length; offset += 24) {
      rewrite(offset);
    }
  } else if (packet.type === RTCP_RR) {
    rewrite(0);
    for (let offset = 4; offset + 24 <= payload.length; offset += 24) {
      rewrite(offset);
    }
  } else if (packet.type === RTCP_RTPFB || packet.type === RTCP_PSFB) {
    rewrite(0);
    rewrite(4);
    if (packet.type === RTCP_PSFB && packet.count === 4) {
      for (let offset = 8; offset + 8 <= payload.length; offset += 8) {
        rewrite(offset);
      }
    }
    if (packet.type === RTCP_PSFB && packet.count === 15 && payload.subarray(8, 12).toString('ascii') === 'REMB') {
      for (let offset = 16; offset + 4 <= payload.length; offset += 4) {
        rewrite(offset);
      }
    }
  }
  return { ...packet, payload };
}
