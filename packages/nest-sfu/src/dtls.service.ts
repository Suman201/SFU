import { Injectable } from '@nestjs/common';
import { createHash, generateKeyPairSync } from 'crypto';
import type { DtlsParameters } from '@native-sfu/contracts';

export class DtlsTransportUnavailableError extends Error {
  constructor() {
    super('Native DTLS-SRTP transport is not available in Node.js core; provide a hardened native transport adapter before accepting browser media.');
  }
}

@Injectable()
export class DtlsService {
  private readonly keyPair = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });

  createParameters(): DtlsParameters {
    const fingerprint = createHash('sha256').update(this.keyPair.publicKey).digest('hex').match(/.{2}/g)?.join(':').toUpperCase() ?? '';
    return {
      role: 'auto',
      fingerprints: [
        {
          algorithm: 'sha-256',
          value: fingerprint
        }
      ]
    };
  }

  async handshake(): Promise<never> {
    throw new DtlsTransportUnavailableError();
  }
}
