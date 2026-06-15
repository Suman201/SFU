import { Injectable } from '@nestjs/common';
import type { DtlsParameters } from '@native-sfu/contracts';
import type { IceAgent } from './ice/ice-agent';
import { createLocalDtlsCertificate } from './dtls/certificate';
import { DtlsTransport } from './dtls/dtls-transport';
import type { DtlsTransportSnapshot, LocalDtlsCertificate } from './dtls/dtls.types';

export class DtlsTransportNotFoundError extends Error {
  constructor() {
    super('DTLS transport not found.');
  }
}

@Injectable()
export class DtlsService {
  private readonly certificatePromise = createLocalDtlsCertificate();
  private readonly transports = new Map<string, DtlsTransport>();

  async createParameters(): Promise<DtlsParameters> {
    const certificate = await this.localCertificate();
    return {
      role: 'auto',
      fingerprints: certificate.fingerprints
    };
  }

  async createTransport(transportId: string, iceAgent: IceAgent): Promise<DtlsTransport> {
    const existing = this.transports.get(transportId);
    if (existing) {
      return existing;
    }
    const transport = new DtlsTransport(transportId, iceAgent, await this.localCertificate());
    transport.on('error', () => undefined);
    await transport.start();
    this.transports.set(transportId, transport);
    return transport;
  }

  setRemoteParameters(transportId: string, parameters: DtlsParameters): void {
    this.requireTransport(transportId).setRemoteParameters(parameters);
  }

  getTransport(transportId: string): DtlsTransport | undefined {
    return this.transports.get(transportId);
  }

  getTransportSnapshot(transportId: string): DtlsTransportSnapshot | undefined {
    return this.transports.get(transportId)?.snapshot();
  }

  closeTransport(transportId: string): void {
    const transport = this.transports.get(transportId);
    if (!transport) {
      return;
    }
    transport.close();
    this.transports.delete(transportId);
  }

  async localCertificate(): Promise<LocalDtlsCertificate> {
    return this.certificatePromise;
  }

  private requireTransport(transportId: string): DtlsTransport {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new DtlsTransportNotFoundError();
    }
    return transport;
  }
}
