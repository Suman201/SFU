import type { PipeTransportAdapter, PipeTransportRtcpSendOptions, PipeTransportSnapshotLike } from '../pipe-transport.adapter';

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

export class WorkerPipeTransport implements PipeTransportAdapter {
  private readonly transports = new Map<string, PipeTransportSnapshotLike>();

  constructor(
    private readonly handlers: {
      onRtp: (event: WorkerPipeRtpEvent) => void;
      onRtcp: (event: WorkerPipeRtcpEvent) => void;
    }
  ) {}

  ensureTransport(id: string, snapshot: PipeTransportSnapshotLike): void {
    this.transports.set(id, { ...snapshot });
  }

  closeTransport(id: string): void {
    this.transports.delete(id);
  }

  hasTransport(id: string): boolean {
    return this.transports.has(id);
  }

  snapshot(id: string): PipeTransportSnapshotLike | undefined {
    return this.transports.get(id);
  }

  async sendRtp(pipeTransportId: string, producerId: string, packet: Buffer): Promise<boolean> {
    const transport = this.requireTransport(pipeTransportId);
    this.handlers.onRtp({
      pipeTransportId,
      roomId: transport.roomId,
      producerId,
      packet: Buffer.from(packet)
    });
    return true;
  }

  async sendRtcp(pipeTransportId: string, packet: Buffer, options: PipeTransportRtcpSendOptions = {}): Promise<boolean> {
    const transport = this.requireTransport(pipeTransportId);
    this.handlers.onRtcp({
      pipeTransportId,
      roomId: transport.roomId,
      packet: Buffer.from(packet),
      producerId: options.producerId,
      consumerId: options.consumerId
    });
    return true;
  }

  private requireTransport(id: string): PipeTransportSnapshotLike {
    const transport = this.transports.get(id);
    if (!transport) {
      throw new Error(`Pipe transport ${id} not registered in worker`);
    }
    return transport;
  }
}
