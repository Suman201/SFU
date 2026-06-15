import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Consumer, IceCandidate, Producer, RtpLayerSelection, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { RtcpFeedback, RtcpProcessor, RtpRouter } from '@native-sfu/sfu-core';
import { DtlsService } from './dtls.service';
import { IceService } from './ice.service';
import { MediaPacketBridge, type MediaPacketBridgeCounters } from './media/media-packet-bridge';
import { SrtpService } from './srtp.service';

interface ManagedTransport {
  id: string;
  roomId: string;
  participantId: string;
  options: TransportOptions;
  remoteCandidates: IceCandidate[];
  iceAgentId: string;
  dtlsTransportId: string;
  producerRtp?: RtpParameters;
  inboundSsrcs: number[];
  outboundSsrcs: number[];
  bridge: MediaPacketBridge;
  closed: boolean;
}

@Injectable()
export class MediaService {
  private readonly transports = new Map<string, ManagedTransport>();

  constructor(
    private readonly ice: IceService,
    private readonly dtls: DtlsService,
    private readonly srtp: SrtpService,
    private readonly rtcp: RtcpProcessor,
    private readonly router: RtpRouter
  ) {}

  async createWebRtcTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    const id = randomUUID();
    const agent = await this.ice.createAgent(id, roomId, participantId);
    const snapshot = agent.snapshot();
    const iceParameters = snapshot.localParameters;
    const iceCandidates = snapshot.localCandidates.map(toPublicCandidate);
    const dtlsTransport = await this.dtls.createTransport(id, agent);
    const bridge = new MediaPacketBridge({
      transportId: id,
      participantId,
      ice: agent,
      getSrtpSession: () => this.srtp.getSession(id),
      onRtp: (packet) => this.router.route(packet, { sourceTransportId: id, sourceParticipantId: participantId }),
      onRtcp: (packet) => this.handleRtcp(id, participantId, packet).then((result) => result.forwarded),
      onError: () => undefined
    });
    bridge.on('error', () => undefined);
    dtlsTransport.on('connect', (keyingMaterial) => {
      const session = this.srtp.createSession(id, keyingMaterial);
      const transport = this.transports.get(id);
      if (transport) {
        session.setInboundSsrcs(transport.inboundSsrcs);
        session.setOutboundSsrcs(transport.outboundSsrcs);
      }
    });
    const dtlsParameters = await this.dtls.createParameters();
    const options: TransportOptions = {
      id,
      roomId,
      participantId,
      iceParameters,
      iceCandidates,
      dtlsParameters
    };
    this.transports.set(id, {
      id,
      roomId,
      participantId,
      options,
      iceAgentId: id,
      dtlsTransportId: dtlsTransport.transportId,
      remoteCandidates: [],
      inboundSsrcs: [],
      outboundSsrcs: [],
      bridge,
      closed: false
    });
    return options;
  }

  assertTransportOwner(transportId: string, participantId: string): void {
    this.requireTransport(transportId, participantId);
  }

  async addRemoteCandidate(transportId: string, participantId: string, candidate: IceCandidate): Promise<void> {
    const transport = this.requireTransport(transportId, participantId);
    this.ice.validateCandidate(candidate);
    transport.remoteCandidates.push(candidate);
    this.ice.addRemoteCandidate(transportId, participantId, candidate);
  }

  async setRemoteIceParameters(transportId: string, participantId: string, parameters: TransportOptions['iceParameters']): Promise<void> {
    this.requireTransport(transportId, participantId);
    this.ice.setRemoteParameters(transportId, participantId, parameters);
  }

  async setRemoteDtlsParameters(transportId: string, participantId: string, parameters: TransportOptions['dtlsParameters']): Promise<void> {
    this.requireTransport(transportId, participantId);
    this.dtls.setRemoteParameters(transportId, parameters);
  }

  async restartIce(transportId: string, participantId: string): Promise<TransportOptions> {
    const transport = this.requireTransport(transportId, participantId);
    const snapshot = await this.ice.restartAgent(transportId, participantId);
    transport.options = {
      ...transport.options,
      iceParameters: snapshot.localParameters,
      iceCandidates: snapshot.localCandidates.map(toPublicCandidate)
    };
    transport.remoteCandidates = [];
    return transport.options;
  }

  async bindProducer(transportId: string, participantId: string, rtpParameters: RtpParameters): Promise<void> {
    const transport = this.requireTransport(transportId, participantId);
    transport.producerRtp = rtpParameters;
    const inboundSsrcs = rtpSsrcs(rtpParameters);
    transport.inboundSsrcs = inboundSsrcs;
    const session = this.srtp.getSession(transportId);
    if (session) {
      session.setInboundSsrcs(inboundSsrcs);
    }
  }

  async registerProducer(producer: Producer): Promise<void> {
    const transport = this.transports.get(producer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Producer transport not found');
    }
    this.router.addProducer(producer, async (packet, target) => {
      await this.sendRtcpToTransport(target.transportId, packet);
    });
  }

  async unregisterProducer(producerId: string): Promise<void> {
    this.router.removeProducer(producerId);
  }

  async setProducerPaused(producerId: string, paused: boolean): Promise<void> {
    this.router.setProducerPaused(producerId, paused);
  }

  async registerConsumer(consumer: Consumer): Promise<void> {
    const transport = this.transports.get(consumer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Consumer transport not found');
    }
    const outboundSsrcs = rtpSsrcs(consumer.rtpParameters);
    transport.outboundSsrcs = mergeUnique(transport.outboundSsrcs, outboundSsrcs);
    const session = this.srtp.getSession(consumer.transportId);
    if (session) {
      session.setOutboundSsrcs(transport.outboundSsrcs);
    }
    this.router.addConsumer(
      consumer,
      async (packet, target) => {
        await this.sendRtpToConsumer(target, packet.serialize());
      },
      async (packet, target) => {
        await this.sendRtcpToTransport(target.transportId, packet);
      }
    );
  }

  async handleRtcp(transportId: string, participantId: string, packet: Buffer): Promise<{ feedback: RtcpFeedback; forwarded: number }> {
    const transport = this.requireTransport(transportId, participantId);
    const feedback = this.rtcp.process(transport.roomId, participantId, packet);
    const forwarded = await this.router.routeRtcp(packet, { sourceTransportId: transportId, sourceParticipantId: participantId });
    return { feedback, forwarded };
  }

  async unregisterConsumer(consumerId: string): Promise<void> {
    this.router.removeConsumer(consumerId);
  }

  async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    this.router.setConsumerPaused(consumerId, paused);
  }

  async setConsumerPreferredLayers(
    consumerId: string,
    preferredLayers: RtpLayerSelection
  ): Promise<{ preferredLayers?: RtpLayerSelection; currentLayers?: RtpLayerSelection; targetLayers?: RtpLayerSelection } | undefined> {
    this.router.setConsumerPreferredLayers(consumerId, preferredLayers);
    return this.router.consumerLayerSnapshot(consumerId);
  }

  mediaCounters(transportId: string, participantId: string): MediaPacketBridgeCounters {
    return this.requireTransport(transportId, participantId).bridge.snapshot();
  }

  adaptiveTransportMetrics(): { bandwidth: ReturnType<RtpRouter['bandwidthEstimates']>; pacing: ReturnType<RtpRouter['pacingSnapshots']> } {
    return {
      bandwidth: this.router.bandwidthEstimates(),
      pacing: this.router.pacingSnapshots()
    };
  }

  async waitForMediaIdle(transportId: string, participantId: string, timeoutMs?: number): Promise<void> {
    await this.requireTransport(transportId, participantId).bridge.waitForIdle(timeoutMs);
  }

  async closeParticipantTransports(participantId: string): Promise<void> {
    for (const transport of this.transports.values()) {
      if (transport.participantId === participantId) {
        transport.closed = true;
        transport.bridge.close();
        this.srtp.closeSession(transport.id);
        this.dtls.closeTransport(transport.id);
        this.ice.closeAgent(transport.id);
        this.transports.delete(transport.id);
      }
    }
    this.router.removeParticipant(participantId);
  }

  async closeRoom(roomId: string): Promise<void> {
    for (const transport of this.transports.values()) {
      if (transport.roomId === roomId) {
        transport.closed = true;
        transport.bridge.close();
        this.srtp.closeSession(transport.id);
        this.dtls.closeTransport(transport.id);
        this.ice.closeAgent(transport.id);
        this.transports.delete(transport.id);
      }
    }
    this.router.removeRoom(roomId);
  }

  private requireTransport(transportId: string, participantId: string): ManagedTransport {
    const transport = this.transports.get(transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Transport not found');
    }
    if (transport.participantId !== participantId) {
      throw new ForbiddenException('Transport belongs to another participant');
    }
    return transport;
  }

  private async sendRtpToConsumer(consumer: Consumer, packet: Buffer): Promise<void> {
    const transport = this.transports.get(consumer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Consumer transport not found');
    }
    await transport.bridge.sendRtp(packet, consumer);
  }

  private async sendRtcpToTransport(transportId: string, packet: Buffer): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('RTCP target transport not found');
    }
    await transport.bridge.sendRtcp(packet, { transportId });
  }
}

function toPublicCandidate(candidate: IceCandidate): IceCandidate {
  return {
    foundation: candidate.foundation,
    component: candidate.component,
    protocol: candidate.protocol,
    priority: candidate.priority,
    ip: candidate.ip,
    port: candidate.port,
    type: candidate.type,
    relatedAddress: candidate.relatedAddress,
    relatedPort: candidate.relatedPort,
    tcpType: candidate.tcpType
  };
}

function mergeUnique(left: number[], right: number[]): number[] {
  return [...new Set([...left, ...right].map((value) => value >>> 0))];
}

function rtpSsrcs(rtpParameters: RtpParameters): number[] {
  return rtpParameters.encodings
    .flatMap((encoding) => (encoding.rtx?.ssrc !== undefined ? [encoding.ssrc, encoding.rtx.ssrc] : [encoding.ssrc]))
    .filter((ssrc): ssrc is number => typeof ssrc === 'number' && Number.isFinite(ssrc) && ssrc > 0);
}
