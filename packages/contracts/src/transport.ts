export interface IceCandidate {
  foundation: string;
  component: 1 | 2;
  protocol: 'udp' | 'tcp';
  priority: number;
  ip: string;
  port: number;
  type: 'host' | 'srflx' | 'prflx' | 'relay';
  relatedAddress?: string;
  relatedPort?: number;
  tcpType?: 'active' | 'passive' | 'so';
}

export interface IceParameters {
  usernameFragment: string;
  password: string;
  iceLite: boolean;
}

export interface DtlsFingerprint {
  algorithm: 'sha-256' | 'sha-384' | 'sha-512';
  value: string;
}

export interface DtlsParameters {
  role: 'auto' | 'client' | 'server';
  fingerprints: DtlsFingerprint[];
}

export interface TransportOptions {
  id: string;
  roomId: string;
  participantId: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
}
