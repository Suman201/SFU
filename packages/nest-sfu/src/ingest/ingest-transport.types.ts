export type TrustedIngestTransportProtocol = 'trusted-rtp-local';

export interface TrustedIngestTransportConfig {
  roomId: string;
  participantId: string;
  listenAddress?: string;
  allowPrivateAddresses?: boolean;
}

export interface TrustedIngestRemoteEndpoint {
  address: string;
  port: number;
  family: 'udp4' | 'udp6';
}

export interface TrustedIngestTransportOptions {
  id: string;
  roomId: string;
  participantId: string;
  protocol: TrustedIngestTransportProtocol;
  listenAddress: string;
  rtpPort: number;
  rtcpPort: number;
  allowPrivateAddresses: boolean;
}

export interface TrustedIngestTransportCounters {
  inboundRtpPackets: number;
  inboundRtcpPackets: number;
  forwardedRtpPackets: number;
  forwardedRtcpPackets: number;
  rejectedPackets: number;
  outboundRtcpPackets: number;
}

export interface TrustedIngestTransportSnapshot extends TrustedIngestTransportOptions {
  counters: TrustedIngestTransportCounters;
  lastRtpRemoteEndpoint?: TrustedIngestRemoteEndpoint;
  lastRtcpRemoteEndpoint?: TrustedIngestRemoteEndpoint;
}

export interface TrustedIngestTransportRegistration {
  id: string;
  roomId: string;
  participantId: string;
  protocol: TrustedIngestTransportProtocol;
  onRtcp: (packet: Buffer) => Promise<void>;
  onClose?: () => Promise<void> | void;
}
