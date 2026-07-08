import { Inject, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MediaService } from '../media.service';
import { TrustedIngestTransport } from './trusted-ingest-transport';
import type {
  TrustedIngestTransportConfig,
  TrustedIngestTransportRegistration,
  TrustedIngestTransportSnapshot,
  TrustedIngestTransportOptions
} from './ingest-transport.types';

interface TrustedIngestMediaController {
  registerTrustedIngestTransport?: (transport: TrustedIngestTransportRegistration) => Promise<void> | void;
  unregisterTrustedIngestTransport?: (transportId: string) => Promise<void> | void;
  handleTrustedIngestRtp?: (transportId: string, packet: Buffer) => Promise<number>;
  handleTrustedIngestRtcp?: (transportId: string, packet: Buffer) => Promise<{ forwarded: number }>;
}

interface ManagedTrustedIngestTransport {
  transport: TrustedIngestTransport;
}

@Injectable()
export class IngestTransportService implements OnModuleDestroy {
  private readonly transports = new Map<string, ManagedTrustedIngestTransport>();

  constructor(@Inject(MediaService) private readonly media: TrustedIngestMediaController) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.transports.keys()].map((transportId) => this.closeTransport(transportId)));
  }

  async createTransport(config: TrustedIngestTransportConfig): Promise<TrustedIngestTransportOptions> {
    const media = this.requireMediaController();
    const transport = new TrustedIngestTransport({
      id: randomUUID(),
      ...config
    });
    const options = await transport.bind();
    transport.on('rtp', (packet) => {
      void this.handleInboundRtp(media, options.id, transport, packet).catch(() => undefined);
    });
    transport.on('rtcp', (packet) => {
      void this.handleInboundRtcp(media, options.id, transport, packet).catch(() => undefined);
    });
    await Promise.resolve(
      media.registerTrustedIngestTransport({
        id: options.id,
        roomId: options.roomId,
        participantId: options.participantId,
        protocol: options.protocol,
        onRtcp: (packet) => transport.sendRtcp(packet),
        onClose: () => this.closeTransport(options.id, false)
      })
    );
    this.transports.set(options.id, { transport });
    return options;
  }

  snapshot(transportId: string): TrustedIngestTransportSnapshot | undefined {
    return this.transports.get(transportId)?.transport.snapshot();
  }

  async closeTransport(transportId: string, unregisterMedia = true): Promise<void> {
    const managed = this.transports.get(transportId);
    if (!managed) {
      return;
    }
    this.transports.delete(transportId);
    if (unregisterMedia) {
      const media = this.requireMediaController();
      await Promise.resolve(media.unregisterTrustedIngestTransport(transportId));
    }
    await managed.transport.close();
  }

  private requireMediaController(): Required<TrustedIngestMediaController> {
    if (
      typeof this.media.registerTrustedIngestTransport !== 'function'
      || typeof this.media.unregisterTrustedIngestTransport !== 'function'
      || typeof this.media.handleTrustedIngestRtp !== 'function'
      || typeof this.media.handleTrustedIngestRtcp !== 'function'
    ) {
      throw new ServiceUnavailableException('Trusted ingest transport is not available for the active media worker mode.');
    }
    return this.media as Required<TrustedIngestMediaController>;
  }

  private async handleInboundRtp(
    media: Required<TrustedIngestMediaController>,
    transportId: string,
    transport: TrustedIngestTransport,
    packet: Buffer
  ): Promise<void> {
    const forwarded = await media.handleTrustedIngestRtp(transportId, packet);
    if (forwarded > 0) {
      transport.recordForwardedRtp();
    }
  }

  private async handleInboundRtcp(
    media: Required<TrustedIngestMediaController>,
    transportId: string,
    transport: TrustedIngestTransport,
    packet: Buffer
  ): Promise<void> {
    const result = await media.handleTrustedIngestRtcp(transportId, packet);
    if (result.forwarded > 0) {
      transport.recordForwardedRtcp(result.forwarded);
    }
  }
}
