import { Injectable } from '@nestjs/common';
import {
  connectPipeTransports,
  PipeTransport,
  PipeTransportManager,
  UdpPipeTransport,
  RTCP_PSFB,
  RTCP_RR,
  RTCP_RTPFB,
  RTCP_SR,
  parseRtcpCompound,
  serializeRtcpPacket,
  type PipeConsumerOptions,
  type PipePacketEvent,
  type PipeProducerOptions,
  type PipeSsrcMapping,
  type PipeTransportOptions,
  type PipeTransportSnapshot,
  type RtcpPacket,
  type UdpPipeEndpoint,
  type UdpPipePacketEvent,
  type UdpPipeRemoteEndpoint,
  type UdpPipeTransportOptions,
  type UdpPipeTransportSnapshot
} from '@native-sfu/sfu-core';

@Injectable()
export class PipeTransportService {
  private readonly udpTransports = new Map<string, UdpPipeTransport>();
  private readonly udpProducers = new Map<string, Map<string, PipeProducerOptions>>();
  private readonly udpConsumers = new Map<string, Map<string, PipeConsumerOptions>>();

  constructor(private readonly manager: PipeTransportManager) {}

  createTransport(options: PipeTransportOptions): PipeTransport {
    return this.manager.createTransport(options);
  }

  getTransport(id: string): PipeTransport | undefined {
    return this.manager.getTransport(id);
  }

  hasTransport(id: string): boolean {
    return Boolean(this.manager.getTransport(id) ?? this.udpTransports.get(id));
  }

  snapshot(id: string): { roomId: string; localNodeId: string; remoteNodeId: string; active: boolean } | undefined {
    const transport = this.manager.getTransport(id);
    if (transport) {
      return transport.snapshot();
    }
    return this.udpTransports.get(id)?.snapshot();
  }

  transportProtocol(id: string): 'internal' | 'udp' | undefined {
    if (this.manager.getTransport(id)) {
      return 'internal';
    }
    if (this.udpTransports.has(id)) {
      return 'udp';
    }
    return undefined;
  }

  connectTransports(left: PipeTransport, right: PipeTransport): void {
    connectPipeTransports(left, right);
  }

  createProducer(transportId: string, options: PipeProducerOptions): void {
    const transport = this.manager.getTransport(transportId);
    if (transport) {
      transport.createProducer(options);
      return;
    }
    this.requireUdpTransport(transportId);
    let producers = this.udpProducers.get(transportId);
    if (!producers) {
      producers = new Map<string, PipeProducerOptions>();
      this.udpProducers.set(transportId, producers);
    }
    producers.set(options.id, {
      ...options,
      ssrcMappings: options.ssrcMappings ? [...options.ssrcMappings] : undefined
    });
  }

  closeProducer(transportId: string, producerId: string): void {
    const transport = this.manager.getTransport(transportId);
    if (transport) {
      transport.closeProducer(producerId);
      return;
    }
    this.udpProducers.get(transportId)?.delete(producerId);
  }

  createConsumer(transportId: string, options: PipeConsumerOptions): void {
    const transport = this.manager.getTransport(transportId);
    if (transport) {
      transport.createConsumer(options);
      return;
    }
    this.requireUdpTransport(transportId);
    let consumers = this.udpConsumers.get(transportId);
    if (!consumers) {
      consumers = new Map<string, PipeConsumerOptions>();
      this.udpConsumers.set(transportId, consumers);
    }
    consumers.set(options.id, {
      ...options,
      ssrcMappings: options.ssrcMappings ? [...options.ssrcMappings] : undefined
    });
  }

  closeConsumer(transportId: string, consumerId: string): void {
    const transport = this.manager.getTransport(transportId);
    if (transport) {
      transport.closeConsumer(consumerId);
      return;
    }
    this.udpConsumers.get(transportId)?.delete(consumerId);
  }

  sendRtp(transportId: string, producerId: string, packet: Buffer): Promise<boolean> {
    const transport = this.manager.getTransport(transportId);
    if (transport) {
      return transport.sendRtp(producerId, packet);
    }
    return this.requireUdpTransport(transportId).sendRtp(producerId, packet);
  }

  sendRtcp(transportId: string, packet: Buffer, options: Parameters<PipeTransport['sendRtcp']>[1] = {}): Promise<boolean> {
    const transport = this.manager.getTransport(transportId);
    if (transport) {
      return transport.sendRtcp(packet, options);
    }
    return this.sendUdpRtcp(transportId, packet, options);
  }

  onRtp(transportId: string, listener: (event: PipePacketEvent) => void): () => void {
    return this.on(transportId, 'rtp', listener);
  }

  onRtcp(transportId: string, listener: (event: PipePacketEvent) => void): () => void {
    return this.on(transportId, 'rtcp', listener);
  }

  closeTransport(id: string, reason?: string): void {
    this.udpProducers.delete(id);
    this.udpConsumers.delete(id);
    if (this.manager.getTransport(id)) {
      this.manager.closeTransport(id, reason);
      return;
    }
    void this.closeUdpTransport(id, reason);
  }

  closeRoom(roomId: string): void {
    this.manager.closeRoom(roomId);
    for (const transport of [...this.udpTransports.values()]) {
      if (transport.snapshot().roomId === roomId) {
        this.udpProducers.delete(transport.id);
        this.udpConsumers.delete(transport.id);
        void transport.close('room_closed');
        this.udpTransports.delete(transport.id);
      }
    }
  }

  snapshots(): PipeTransportSnapshot[] {
    return this.manager.snapshots();
  }

  createUdpTransport(options: UdpPipeTransportOptions): UdpPipeTransport {
    const existing = this.udpTransports.get(options.id ?? '');
    if (existing) {
      return existing;
    }
    const transport = new UdpPipeTransport(options);
    this.udpTransports.set(transport.id, transport);
    transport.once('close', () => {
      if (this.udpTransports.get(transport.id) === transport) {
        this.udpTransports.delete(transport.id);
      }
    });
    return transport;
  }

  getUdpTransport(id: string): UdpPipeTransport | undefined {
    return this.udpTransports.get(id);
  }

  async listenUdpTransport(id: string): Promise<UdpPipeEndpoint> {
    return this.requireUdpTransport(id).listen();
  }

  connectUdpTransport(id: string, endpoint: UdpPipeRemoteEndpoint): void {
    this.requireUdpTransport(id).connect(endpoint);
  }

  sendUdpRtp(transportId: string, producerId: string, packet: Buffer): Promise<boolean> {
    return this.requireUdpTransport(transportId).sendRtp(producerId, packet);
  }

  sendUdpRtcp(transportId: string, packet: Buffer, metadata: Parameters<UdpPipeTransport['sendRtcp']>[1] = {}): Promise<boolean> {
    return this.requireUdpTransport(transportId).sendRtcp(this.rewriteUdpRtcp(transportId, packet, metadata), metadata);
  }

  onUdpRtp(transportId: string, listener: (event: UdpPipePacketEvent) => void): () => void {
    return this.onUdp(transportId, 'rtp', listener);
  }

  onUdpRtcp(transportId: string, listener: (event: UdpPipePacketEvent) => void): () => void {
    return this.onUdp(transportId, 'rtcp', listener);
  }

  async closeUdpTransport(id: string, reason?: string): Promise<void> {
    await this.udpTransports.get(id)?.close(reason);
    this.udpTransports.delete(id);
    this.udpProducers.delete(id);
    this.udpConsumers.delete(id);
  }

  udpSnapshots(): UdpPipeTransportSnapshot[] {
    return [...this.udpTransports.values()].map((transport) => transport.snapshot());
  }

  private on(transportId: string, event: 'rtp' | 'rtcp', listener: (packet: PipePacketEvent) => void): () => void {
    const transport = this.manager.getTransport(transportId);
    if (!transport) {
      throw new Error(`Pipe transport ${transportId} not found`);
    }
    transport.on(event, listener);
    return () => transport.off(event, listener);
  }

  private requireTransport(id: string): PipeTransport {
    const transport = this.manager.getTransport(id);
    if (!transport) {
      throw new Error(`Pipe transport ${id} not found`);
    }
    return transport;
  }

  private onUdp(transportId: string, event: 'rtp' | 'rtcp', listener: (packet: UdpPipePacketEvent) => void): () => void {
    const transport = this.requireUdpTransport(transportId);
    transport.on(event, listener);
    return () => transport.off(event, listener);
  }

  private requireUdpTransport(id: string): UdpPipeTransport {
    const transport = this.udpTransports.get(id);
    if (!transport) {
      throw new Error(`UDP pipe transport ${id} not found`);
    }
    return transport;
  }

  private rewriteUdpRtcp(
    transportId: string,
    packet: Buffer,
    options: { producerId?: string; consumerId?: string; ssrcMappings?: PipeSsrcMapping[] } = {}
  ): Buffer {
    const mappings = options.ssrcMappings ?? this.inferUdpRtcpMappings(transportId, options);
    if (!mappings || mappings.length === 0) {
      return packet;
    }
    const map = new Map(mappings.map((mapping) => [mapping.sourceSsrc >>> 0, mapping.targetSsrc >>> 0]));
    try {
      return Buffer.concat(parseRtcpCompound(packet).map((rtcp) => serializeRtcpPacket(rewriteRtcpPacketSsrcs(rtcp, map))));
    } catch {
      return packet;
    }
  }

  private inferUdpRtcpMappings(
    transportId: string,
    options: { producerId?: string; consumerId?: string }
  ): PipeSsrcMapping[] | undefined {
    if (options.consumerId) {
      const mappings = this.udpConsumers.get(transportId)?.get(options.consumerId)?.ssrcMappings;
      if (mappings && mappings.length > 0) {
        return mappings;
      }
    }
    if (options.producerId) {
      const mappings = this.udpProducers.get(transportId)?.get(options.producerId)?.ssrcMappings;
      if (mappings && mappings.length > 0) {
        return mappings;
      }
    }
    return undefined;
  }
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
