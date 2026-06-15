import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import type { IceCandidate, IceParameters } from '@native-sfu/contracts';
import { computeCandidatePriority } from './ice/candidate';
import { IceAgent } from './ice/ice-agent';
import type { IceAgentSnapshot } from './ice/ice.types';
import { UdpPortAllocator } from './ice/udp-port-allocator';
import type { NestSfuOptions } from './nest-sfu.options';
import { NEST_SFU_OPTIONS } from './tokens';

export interface TurnCredentials {
  username: string;
  credential: string;
  ttl: number;
  uris: string[];
}

@Injectable()
export class IceService {
  private readonly agents = new Map<string, IceAgent>();

  constructor(
    @Inject(NEST_SFU_OPTIONS) private readonly options: NestSfuOptions,
    private readonly portAllocator: UdpPortAllocator
  ) {}

  createParameters(): IceParameters {
    return {
      usernameFragment: randomBytes(12).toString('base64url'),
      password: randomBytes(24).toString('base64url'),
      iceLite: false
    };
  }

  async gatherCandidates(): Promise<IceCandidate[]> {
    const agent = new IceAgent(
      {
        transportId: `standalone-${randomBytes(8).toString('hex')}`,
        roomId: 'standalone',
        participantId: 'standalone',
        role: this.options.iceRole ?? 'controlled',
        hostPortRange: this.options.hostCandidatePortRange,
        includeLoopbackCandidates: this.options.includeLoopbackCandidates,
        gatherInterfaces: this.options.gatherInterfaces,
        consentIntervalMs: this.options.consentIntervalMs,
        consentTimeoutMs: this.options.consentTimeoutMs,
        maxConsentFailures: this.options.maxConsentFailures,
        transactionTimeoutMs: this.options.iceTransactionTimeoutMs,
        taMs: this.options.iceTaMs
      },
      this.portAllocator
    );
    const candidates = await agent.gatherCandidates();
    agent.close();
    return candidates.map(toPublicCandidate);
  }

  async createAgent(transportId: string, roomId: string, participantId: string): Promise<IceAgent> {
    const existing = this.agents.get(transportId);
    if (existing) {
      return existing;
    }
    const agent = new IceAgent(
      {
        transportId,
        roomId,
        participantId,
        role: this.options.iceRole ?? 'controlled',
        hostPortRange: this.options.hostCandidatePortRange,
        includeLoopbackCandidates: this.options.includeLoopbackCandidates,
        gatherInterfaces: this.options.gatherInterfaces,
        consentIntervalMs: this.options.consentIntervalMs,
        consentTimeoutMs: this.options.consentTimeoutMs,
        maxConsentFailures: this.options.maxConsentFailures,
        transactionTimeoutMs: this.options.iceTransactionTimeoutMs,
        taMs: this.options.iceTaMs
      },
      this.portAllocator
    );
    await agent.gatherCandidates();
    this.agents.set(transportId, agent);
    return agent;
  }

  getAgent(transportId: string): IceAgent | undefined {
    return this.agents.get(transportId);
  }

  getAgentSnapshot(transportId: string): IceAgentSnapshot | undefined {
    return this.agents.get(transportId)?.snapshot();
  }

  setRemoteParameters(transportId: string, participantId: string, parameters: IceParameters): void {
    const agent = this.requireAgent(transportId, participantId);
    agent.setRemoteParameters(parameters);
    agent.startConnectivityChecks();
  }

  addRemoteCandidate(transportId: string, participantId: string, candidate: IceCandidate): void {
    const agent = this.requireAgent(transportId, participantId);
    agent.addRemoteCandidate(candidate);
    agent.startConnectivityChecks();
  }

  async restartAgent(transportId: string, participantId: string): Promise<IceAgentSnapshot> {
    const agent = this.requireAgent(transportId, participantId);
    await agent.restart();
    return agent.snapshot();
  }

  closeAgent(transportId: string): void {
    const agent = this.agents.get(transportId);
    if (!agent) {
      return;
    }
    agent.close();
    this.agents.delete(transportId);
  }

  validateCandidate(candidate: IceCandidate): void {
    if (!candidate.ip || candidate.port <= 0 || candidate.port > 65535) {
      throw new Error('Invalid ICE candidate address');
    }
    if (!['host', 'srflx', 'prflx', 'relay'].includes(candidate.type)) {
      throw new Error('Invalid ICE candidate type');
    }
    if (candidate.protocol !== 'udp') {
      throw new Error('Only UDP ICE candidates are currently supported');
    }
    candidate.priority ||= computeCandidatePriority(candidate);
  }

  createTurnCredentials(userId: string, ttlSeconds = this.options.turnCredentialTtlSeconds ?? 3600): TurnCredentials {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expires}:${userId}`;
    return {
      username,
      credential: createHmac('sha1', this.options.turnSecret).update(username).digest('base64'),
      ttl: ttlSeconds,
      uris: this.options.turnUris
    };
  }

  private requireAgent(transportId: string, participantId: string): IceAgent {
    const agent = this.agents.get(transportId);
    if (!agent || agent.participantId !== participantId) {
      throw new Error('ICE agent not found for participant transport');
    }
    return agent;
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
