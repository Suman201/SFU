import type { AddressInfo } from 'net';
import type { IceAgent } from '../ice/ice-agent';

export type DtlsAddress = Readonly<[string, number]>;

export interface DtlsDatagramTransport {
  type: string;
  address: AddressInfo;
  onData: (data: Buffer, addr: DtlsAddress) => void;
  send(data: Buffer, addr?: DtlsAddress): Promise<void>;
  close(): Promise<void>;
}

export class IceDatagramTransport implements DtlsDatagramTransport {
  readonly type = 'udp';
  onData: (data: Buffer, addr: DtlsAddress) => void = () => undefined;

  constructor(private readonly ice: IceAgent) {}

  get address(): AddressInfo {
    const pair = this.ice.selectedCandidatePair();
    return {
      address: pair?.local.ip ?? '0.0.0.0',
      family: 'IPv4',
      port: pair?.local.port ?? 0
    };
  }

  async send(data: Buffer): Promise<void> {
    await this.ice.sendSelectedDatagram(data);
  }

  async close(): Promise<void> {
    // The ICE agent owns the UDP socket lifecycle.
  }

  push(data: Buffer, addr: DtlsAddress): void {
    this.onData(data, addr);
  }
}
