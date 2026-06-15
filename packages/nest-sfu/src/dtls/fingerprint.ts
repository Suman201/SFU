import { createHash } from 'crypto';
import type { DtlsFingerprint, DtlsParameters } from '@native-sfu/contracts';

const HASH_BY_ALGORITHM: Record<DtlsFingerprint['algorithm'], string> = {
  'sha-256': 'sha256',
  'sha-384': 'sha384',
  'sha-512': 'sha512'
};

export class DtlsFingerprintMismatchError extends Error {
  constructor() {
    super('Remote DTLS certificate fingerprint does not match signaled DTLS parameters.');
  }
}

export function createFingerprint(certificateDer: Buffer, algorithm: DtlsFingerprint['algorithm'] = 'sha-256'): DtlsFingerprint {
  return {
    algorithm,
    value: formatFingerprint(createHash(HASH_BY_ALGORITHM[algorithm]).update(certificateDer).digest('hex'))
  };
}

export function validateFingerprint(parameters: DtlsParameters, certificateDer: Buffer): void {
  const matched = parameters.fingerprints.some((fingerprint) => {
    const digest = createHash(HASH_BY_ALGORITHM[fingerprint.algorithm]).update(certificateDer).digest('hex');
    return formatFingerprint(digest) === normalizeFingerprint(fingerprint.value);
  });
  if (!matched) {
    throw new DtlsFingerprintMismatchError();
  }
}

export function normalizeFingerprint(value: string): string {
  return formatFingerprint(value.replace(/[^a-fA-F0-9]/g, ''));
}

function formatFingerprint(hex: string): string {
  return hex.toUpperCase().match(/.{1,2}/g)?.join(':') ?? '';
}
