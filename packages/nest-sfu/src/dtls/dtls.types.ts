import type { DtlsParameters } from '@native-sfu/contracts';
import type { SignatureHash } from 'werift-dtls/lib/dtls/src/cipher/const';

export type DtlsTransportState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed';
export type DtlsTransportRole = 'server';

export interface LocalDtlsCertificate {
  certPem: string;
  keyPem: string;
  certDer: Buffer;
  signatureHash: SignatureHash;
  fingerprints: DtlsParameters['fingerprints'];
}

export interface DtlsSrtpKeyingMaterial {
  profile: number;
  localKey: Buffer;
  localSalt: Buffer;
  remoteKey: Buffer;
  remoteSalt: Buffer;
}

export interface DtlsTransportSnapshot {
  transportId: string;
  state: DtlsTransportState;
  role: DtlsTransportRole;
  localParameters: DtlsParameters;
  remoteParameters?: DtlsParameters;
  remoteFingerprintVerified: boolean;
  srtpKeys?: DtlsSrtpKeyingMaterial;
}
