import { EventEmitter } from 'node:events';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import {
  type TrustedIngestRemoteEndpoint,
  type TrustedIngestTransportConfig,
  type TrustedIngestTransportCounters,
  type TrustedIngestTransportOptions,
  type TrustedIngestTransportSnapshot
} from './ingest-transport.types';

type TrustedIngestTransportEventMap = {
  rtp: [Buffer, TrustedIngestRemoteEndpoint];
  rtcp: [Buffer, TrustedIngestRemoteEndpoint];
};

interface TrustedIngestTransportInit extends TrustedIngestTransportConfig {
  id: string;
}

const DEFAULT_LISTEN_ADDRESS = '127.0.0.1';

export class TrustedIngestTransport extends EventEmitter<TrustedIngestTransportEventMap> {
  private readonly counters: TrustedIngestTransportCounters = {
    inboundRtpPackets: 0,
    inboundRtcpPackets: 0,
    forwardedRtpPackets: 0,
    forwardedRtcpPackets: 0,
    rejectedPackets: 0,
    outboundRtcpPackets: 0
  };
  private readonly rtpSocket: Socket;
  private readonly rtcpSocket: Socket;
  private readonly family: 'udp4' | 'udp6';
  private closed = false;
  private lastRtpRemoteEndpoint?: TrustedIngestRemoteEndpoint;
  private lastRtcpRemoteEndpoint?: TrustedIngestRemoteEndpoint;
  private options?: TrustedIngestTransportOptions;

  constructor(private readonly config: TrustedIngestTransportInit) {
    super();
    const listenAddress = config.listenAddress?.trim() || DEFAULT_LISTEN_ADDRESS;
    assertTrustedBindAddress(listenAddress, Boolean(config.allowPrivateAddresses));
    this.family = listenAddress.includes(':') ? 'udp6' : 'udp4';
    this.rtpSocket = createSocket(this.family);
    this.rtcpSocket = createSocket(this.family);
    this.rtpSocket.on('message', (message, remote) => this.handleMessage('rtp', message, remote));
    this.rtcpSocket.on('message', (message, remote) => this.handleMessage('rtcp', message, remote));
  }

  async bind(): Promise<TrustedIngestTransportOptions> {
    const listenAddress = this.config.listenAddress?.trim() || DEFAULT_LISTEN_ADDRESS;
    await Promise.all([bindSocket(this.rtpSocket, listenAddress), bindSocket(this.rtcpSocket, listenAddress)]);
    this.options = {
      id: this.config.id,
      roomId: this.config.roomId,
      participantId: this.config.participantId,
      protocol: 'trusted-rtp-local',
      listenAddress,
      rtpPort: socketPort(this.rtpSocket),
      rtcpPort: socketPort(this.rtcpSocket),
      allowPrivateAddresses: Boolean(this.config.allowPrivateAddresses)
    };
    return this.options;
  }

  snapshot(): TrustedIngestTransportSnapshot {
    const options = this.requireOptions();
    return {
      ...options,
      counters: { ...this.counters },
      lastRtpRemoteEndpoint: this.lastRtpRemoteEndpoint ? { ...this.lastRtpRemoteEndpoint } : undefined,
      lastRtcpRemoteEndpoint: this.lastRtcpRemoteEndpoint ? { ...this.lastRtcpRemoteEndpoint } : undefined
    };
  }

  recordForwardedRtp(): void {
    this.counters.forwardedRtpPackets += 1;
  }

  recordForwardedRtcp(count = 1): void {
    this.counters.forwardedRtcpPackets += count;
  }

  async sendRtcp(packet: Buffer): Promise<void> {
    const endpoint = this.lastRtcpRemoteEndpoint ?? this.lastRtpRemoteEndpoint;
    if (!endpoint) {
      throw new Error('Trusted ingest transport has no remote endpoint for RTCP egress');
    }
    await sendSocket(this.rtcpSocket, packet, endpoint.port, endpoint.address);
    this.counters.outboundRtcpPackets += 1;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all([closeSocket(this.rtpSocket), closeSocket(this.rtcpSocket)]);
    this.removeAllListeners();
  }

  private handleMessage(kind: 'rtp' | 'rtcp', message: Buffer, remote: RemoteInfo): void {
    if (this.closed) {
      return;
    }
    if (!isTrustedSourceAddress(remote.address, Boolean(this.config.allowPrivateAddresses))) {
      this.counters.rejectedPackets += 1;
      return;
    }
    const endpoint = toRemoteEndpoint(this.family, remote);
    if (kind === 'rtp') {
      this.counters.inboundRtpPackets += 1;
      this.lastRtpRemoteEndpoint = endpoint;
      this.emit('rtp', Buffer.from(message), endpoint);
      return;
    }
    this.counters.inboundRtcpPackets += 1;
    this.lastRtcpRemoteEndpoint = endpoint;
    this.emit('rtcp', Buffer.from(message), endpoint);
  }

  private requireOptions(): TrustedIngestTransportOptions {
    if (!this.options) {
      throw new Error('Trusted ingest transport has not been bound');
    }
    return this.options;
  }
}

function socketPort(socket: Socket): number {
  const address = socket.address();
  if (typeof address === 'string') {
    throw new Error('Expected UDP socket address information');
  }
  return address.port;
}

function bindSocket(socket: Socket, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('listening', onListening);
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(0, address);
  });
}

function sendSocket(socket: Socket, packet: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, address, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.close(() => resolve());
  });
}

function toRemoteEndpoint(family: 'udp4' | 'udp6', remote: RemoteInfo): TrustedIngestRemoteEndpoint {
  return {
    address: remote.address,
    port: remote.port,
    family
  };
}

function assertTrustedBindAddress(address: string, allowPrivateAddresses: boolean): void {
  if (isLoopbackAddress(address)) {
    return;
  }
  if (allowPrivateAddresses && isPrivateAddress(address)) {
    return;
  }
  throw new Error(`Trusted ingest transport listen address ${address} must be loopback${allowPrivateAddresses ? ' or private' : ''}`);
}

function isTrustedSourceAddress(address: string, allowPrivateAddresses: boolean): boolean {
  return isLoopbackAddress(address) || (allowPrivateAddresses && isPrivateAddress(address));
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isPrivateAddress(address: string): boolean {
  if (address.startsWith('10.') || address.startsWith('192.168.')) {
    return true;
  }
  if (address.startsWith('172.')) {
    const octet = Number(address.split('.')[1] ?? NaN);
    return Number.isInteger(octet) && octet >= 16 && octet <= 31;
  }
  if (address.startsWith('fc') || address.startsWith('fd')) {
    return true;
  }
  return false;
}
