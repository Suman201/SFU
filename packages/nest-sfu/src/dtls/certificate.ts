import { X509Certificate } from 'crypto';
import { CipherContext, HashAlgorithm, NamedCurveAlgorithm, SignatureAlgorithm } from 'werift-dtls/lib/dtls/src';
import { createFingerprint } from './fingerprint';
import type { LocalDtlsCertificate } from './dtls.types';

const WEBRTC_SIGNATURE_HASH = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.ecdsa_3
} as const;

export async function createLocalDtlsCertificate(): Promise<LocalDtlsCertificate> {
  const certificate = await CipherContext.createSelfSignedCertificateWithKey(WEBRTC_SIGNATURE_HASH, NamedCurveAlgorithm.secp256r1_23);
  const certDer = new X509Certificate(certificate.certPem).raw;
  return {
    certPem: certificate.certPem,
    keyPem: certificate.keyPem,
    certDer,
    signatureHash: certificate.signatureHash,
    fingerprints: [createFingerprint(certDer, 'sha-256')]
  };
}
