import type { PipeNodeEndpoint, PipeTransportProtocol } from '@native-sfu/contracts';
import { PipeTransportManager, RtpPacket } from '@native-sfu/sfu-core';
import type { PipeTransportAdapter, PipeTransportRtcpSendOptions, PipeTransportSnapshotLike } from '../pipe-transport.adapter';
import { PipeTransportService } from '../pipe-transport.service';
import type { MediaWorkerPipeTransportSnapshot } from './ipc';

export interface WorkerPipeRtpEvent {
  pipeTransportId: string;
  roomId: string;
  producerId: string;
  packet: Buffer;
}

export interface WorkerPipeRtcpEvent {
  pipeTransportId: string;
  roomId: string;
  packet: Buffer;
  producerId?: string;
  consumerId?: string;
}

export interface WorkerPipeTransportBindingRequest {
  pipeTransportId: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  protocol: PipeTransportProtocol;
  listenPort?: number;
  advertisedIp?: string;
  peerToken?: string;
  remoteEndpoint?: PipeNodeEndpoint;
}

interface WorkerPipeTransportState extends PipeTransportSnapshotLike {
  protocol: PipeTransportProtocol;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  localEndpoint?: PipeNodeEndpoint;
  remoteEndpoint?: PipeNodeEndpoint;
  lastRtpSsrc?: number;
  lastRtpSequenceNumber?: number;
  lastRtpTimestamp?: number;
  lastSentRtpSsrc?: number;
  lastSentRtpSequenceNumber?: number;
  lastSentRtpTimestamp?: number;
}

export class WorkerPipeTransport implements PipeTransportAdapter {
  private readonly service = new PipeTransportService(new PipeTransportManager());
  private readonly transports = new Map<string, WorkerPipeTransportState>();
  private readonly udpListenersAttached = new Set<string>();

  constructor(
    private readonly handlers: {
      onInboundRtp: (event: WorkerPipeRtpEvent) => void;
      onInboundRtcp: (event: WorkerPipeRtcpEvent) => void;
      onOutboundIpcRtp: (event: WorkerPipeRtpEvent) => void;
      onOutboundIpcRtcp: (event: WorkerPipeRtcpEvent) => void;
    }
  ) {}

  async ensureTransport(request: WorkerPipeTransportBindingRequest): Promise<MediaWorkerPipeTransportSnapshot> {
    const existing = this.transports.get(request.pipeTransportId);
    if (existing) {
      if (existing.protocol !== request.protocol) {
        throw new Error(`Pipe transport ${request.pipeTransportId} already exists with protocol ${existing.protocol}`);
      }
      if (request.remoteEndpoint) {
        existing.remoteEndpoint = request.remoteEndpoint;
        if (existing.protocol === 'udp') {
          this.service.connectUdpTransport(request.pipeTransportId, toUdpRemoteEndpoint(request.remoteEndpoint));
        }
      }
      return this.transportSnapshot(request.pipeTransportId)!;
    }

    const baseState: WorkerPipeTransportState = {
      active: true,
      protocol: request.protocol,
      roomId: request.roomId,
      localNodeId: request.localNodeId,
      remoteNodeId: request.remoteNodeId,
      remoteEndpoint: request.remoteEndpoint
    };

    if (request.protocol === 'udp') {
      const transport = this.service.createUdpTransport({
        id: request.pipeTransportId,
        roomId: request.roomId,
        localNodeId: request.localNodeId,
        remoteNodeId: request.remoteNodeId,
        listenPort: request.listenPort,
        advertisedIp: request.advertisedIp,
        peerToken: request.peerToken,
        authMode: request.peerToken ? 'token' : 'transport-id'
      });
      const localEndpoint = await this.service.listenUdpTransport(transport.id);
      const state: WorkerPipeTransportState = {
        ...baseState,
        localEndpoint: {
          nodeId: localEndpoint.nodeId,
          advertiseIp: localEndpoint.advertisedIp,
          port: localEndpoint.advertisedPort
        }
      };
      this.transports.set(request.pipeTransportId, state);
      if (request.remoteEndpoint) {
        this.service.connectUdpTransport(request.pipeTransportId, toUdpRemoteEndpoint(request.remoteEndpoint));
      }
      this.attachUdpListeners(request.pipeTransportId);
      return this.transportSnapshot(request.pipeTransportId)!;
    }

    this.transports.set(request.pipeTransportId, baseState);
    return this.transportSnapshot(request.pipeTransportId)!;
  }

  async closeTransport(id: string, reason = 'manual'): Promise<void> {
    const state = this.transports.get(id);
    if (!state) {
      return;
    }
    this.transports.delete(id);
    this.udpListenersAttached.delete(id);
    if (state.protocol === 'udp') {
      await this.service.closeUdpTransport(id, reason);
      return;
    }
    if (this.service.hasTransport(id)) {
      this.service.closeTransport(id, reason);
    }
  }

  async closeRoom(roomId: string): Promise<void> {
    const pendingUdpCloses: Promise<void>[] = [];
    for (const [pipeTransportId, state] of this.transports) {
      if (state.roomId === roomId) {
        this.transports.delete(pipeTransportId);
        this.udpListenersAttached.delete(pipeTransportId);
        if (state.protocol === 'udp') {
          pendingUdpCloses.push(this.service.closeUdpTransport(pipeTransportId, 'room_closed'));
          continue;
        }
        if (this.service.hasTransport(pipeTransportId)) {
          this.service.closeTransport(pipeTransportId, 'room_closed');
        }
      }
    }
    await Promise.all(pendingUdpCloses);
  }

  hasTransport(id: string): boolean {
    return this.transports.has(id);
  }

  snapshot(id: string): PipeTransportSnapshotLike | undefined {
    const state = this.transports.get(id);
    if (!state) {
      return undefined;
    }
    return {
      roomId: state.roomId,
      localNodeId: state.localNodeId,
      remoteNodeId: state.remoteNodeId,
      active: state.active
    };
  }

  transportSnapshot(id: string): MediaWorkerPipeTransportSnapshot | undefined {
    const state = this.transports.get(id);
    if (!state) {
      return undefined;
    }
    if (state.protocol === 'udp') {
      const snapshot = this.service.getUdpTransport(id)?.snapshot();
      if (!snapshot) {
        return {
          pipeTransportId: id,
          roomId: state.roomId,
          localNodeId: state.localNodeId,
          remoteNodeId: state.remoteNodeId,
          protocol: state.protocol,
          active: state.active,
          localEndpoint: state.localEndpoint,
          remoteEndpoint: state.remoteEndpoint
        };
      }
      return {
        pipeTransportId: id,
        roomId: snapshot.roomId,
        localNodeId: snapshot.localNodeId,
        remoteNodeId: snapshot.remoteNodeId,
        protocol: 'udp',
        active: snapshot.active,
        listening: snapshot.listening,
        localEndpoint: snapshot.localEndpoint
          ? {
              nodeId: snapshot.localEndpoint.nodeId,
              advertiseIp: snapshot.localEndpoint.advertisedIp,
              port: snapshot.localEndpoint.advertisedPort
            }
          : state.localEndpoint,
        remoteEndpoint: snapshot.remoteEndpoint
          ? {
              nodeId: snapshot.remoteEndpoint.nodeId ?? state.remoteNodeId,
              advertiseIp: snapshot.remoteEndpoint.address,
              port: snapshot.remoteEndpoint.port
            }
          : state.remoteEndpoint,
        rtpPackets: snapshot.rtpPackets,
        rtcpPackets: snapshot.rtcpPackets,
        sentRtpPackets: snapshot.sentRtpPackets,
        sentRtcpPackets: snapshot.sentRtcpPackets,
        droppedPackets: snapshot.droppedPackets,
        backpressureEvents: snapshot.backpressureEvents,
        errors: snapshot.errors,
        lastRtpSsrc: state.lastRtpSsrc,
        lastRtpSequenceNumber: state.lastRtpSequenceNumber,
        lastRtpTimestamp: state.lastRtpTimestamp,
        lastSentRtpSsrc: state.lastSentRtpSsrc,
        lastSentRtpSequenceNumber: state.lastSentRtpSequenceNumber,
        lastSentRtpTimestamp: state.lastSentRtpTimestamp
      };
    }
    return {
      pipeTransportId: id,
      roomId: state.roomId,
      localNodeId: state.localNodeId,
      remoteNodeId: state.remoteNodeId,
      protocol: state.protocol,
      active: state.active,
      localEndpoint: state.localEndpoint,
      remoteEndpoint: state.remoteEndpoint,
      lastRtpSsrc: state.lastRtpSsrc,
      lastRtpSequenceNumber: state.lastRtpSequenceNumber,
      lastRtpTimestamp: state.lastRtpTimestamp,
      lastSentRtpSsrc: state.lastSentRtpSsrc,
      lastSentRtpSequenceNumber: state.lastSentRtpSequenceNumber,
      lastSentRtpTimestamp: state.lastSentRtpTimestamp
    };
  }

  async sendRtp(pipeTransportId: string, producerId: string, packet: Buffer): Promise<boolean> {
    const transport = this.requireTransport(pipeTransportId);
    const parsed = safeParseRtp(packet);
    if (parsed) {
      transport.lastSentRtpSsrc = parsed.ssrc;
      transport.lastSentRtpSequenceNumber = parsed.sequenceNumber;
      transport.lastSentRtpTimestamp = parsed.timestamp;
    }
    if (transport.protocol === 'udp') {
      return this.service.sendUdpRtp(pipeTransportId, producerId, packet);
    }
    this.handlers.onOutboundIpcRtp({
      pipeTransportId,
      roomId: transport.roomId,
      producerId,
      packet: Buffer.from(packet)
    });
    return true;
  }

  async sendRtcp(pipeTransportId: string, packet: Buffer, options: PipeTransportRtcpSendOptions = {}): Promise<boolean> {
    const transport = this.requireTransport(pipeTransportId);
    if (transport.protocol === 'udp') {
      return this.service.sendUdpRtcp(pipeTransportId, packet, options);
    }
    this.handlers.onOutboundIpcRtcp({
      pipeTransportId,
      roomId: transport.roomId,
      packet: Buffer.from(packet),
      producerId: options.producerId,
      consumerId: options.consumerId
    });
    return true;
  }

  private attachUdpListeners(pipeTransportId: string): void {
    if (this.udpListenersAttached.has(pipeTransportId)) {
      return;
    }
    this.udpListenersAttached.add(pipeTransportId);
    this.service.onUdpRtp(pipeTransportId, (event) => {
      const transport = this.transports.get(pipeTransportId);
      if (transport) {
        transport.lastRtpSsrc = event.ssrc;
        transport.lastRtpSequenceNumber = event.sequenceNumber;
        transport.lastRtpTimestamp = event.timestamp;
      }
      this.handlers.onInboundRtp({
        pipeTransportId,
        roomId: event.roomId,
        producerId: event.producerId ?? '',
        packet: Buffer.from(event.packet)
      });
    });
    this.service.onUdpRtcp(pipeTransportId, (event) => {
      this.handlers.onInboundRtcp({
        pipeTransportId,
        roomId: event.roomId,
        packet: Buffer.from(event.packet),
        producerId: event.producerId,
        consumerId: event.consumerId
      });
    });
  }

  private requireTransport(id: string): WorkerPipeTransportState {
    const transport = this.transports.get(id);
    if (!transport) {
      throw new Error(`Pipe transport ${id} not registered in worker`);
    }
    return transport;
  }
}

function toUdpRemoteEndpoint(endpoint: PipeNodeEndpoint): { address: string; port: number; nodeId?: string } {
  if (!endpoint.advertiseIp || !endpoint.port) {
    throw new Error('Pipe remote endpoint is missing advertiseIp or port');
  }
  return {
    address: endpoint.advertiseIp,
    port: endpoint.port,
    nodeId: endpoint.nodeId
  };
}

function safeParseRtp(packet: Buffer): { ssrc: number; sequenceNumber: number; timestamp: number } | undefined {
  try {
    const parsed = RtpPacket.parse(packet);
    return {
      ssrc: parsed.ssrc,
      sequenceNumber: parsed.sequenceNumber,
      timestamp: parsed.timestamp
    };
  } catch {}
  return undefined;
}
