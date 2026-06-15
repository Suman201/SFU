import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Consumer, IceCandidate, Producer, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { RtpRouter } from '@native-sfu/sfu-core';
import { DtlsService } from './dtls.service';
import { IceService } from './ice.service';

interface ManagedTransport {
  id: string;
  roomId: string;
  participantId: string;
  options: TransportOptions;
  remoteCandidates: IceCandidate[];
  iceAgentId: string;
  producerRtp?: RtpParameters;
  closed: boolean;
}

@Injectable()
export class MediaService {
  private readonly transports = new Map<string, ManagedTransport>();

  constructor(
    private readonly ice: IceService,
    private readonly dtls: DtlsService,
    private readonly router: RtpRouter
  ) {}

  async createWebRtcTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    const id = randomUUID();
    const agent = await this.ice.createAgent(id, roomId, participantId);
    const snapshot = agent.snapshot();
    const iceParameters = snapshot.localParameters;
    const iceCandidates = snapshot.localCandidates.map(toPublicCandidate);
    const dtlsParameters = this.dtls.createParameters();
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
      remoteCandidates: [],
      closed: false
    });
    return options;
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
  }

  async registerProducer(producer: Producer): Promise<void> {
    const transport = this.transports.get(producer.transportId);
    if (!transport || transport.closed) {
      throw new NotFoundException('Producer transport not found');
    }
    this.router.addProducer(producer);
  }

  async unregisterProducer(producerId: string): Promise<void> {
    this.router.removeProducer(producerId);
  }

  async setProducerPaused(producerId: string, paused: boolean): Promise<void> {
    this.router.setProducerPaused(producerId, paused);
  }

  async registerConsumer(consumer: Consumer): Promise<void> {
    this.router.addConsumer(consumer, async () => {
      // The DTLS-SRTP transport boundary owns actual packet writes.
      // Native secure egress must be provided by a hardened SrtpSession implementation.
    });
  }

  async unregisterConsumer(consumerId: string): Promise<void> {
    this.router.removeConsumer(consumerId);
  }

  async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    this.router.setConsumerPaused(consumerId, paused);
  }

  async closeParticipantTransports(participantId: string): Promise<void> {
    for (const transport of this.transports.values()) {
      if (transport.participantId === participantId) {
        transport.closed = true;
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
