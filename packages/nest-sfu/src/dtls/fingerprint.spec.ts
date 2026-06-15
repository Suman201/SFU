import { createLocalDtlsCertificate } from './certificate';
import { DtlsFingerprintMismatchError, validateFingerprint } from './fingerprint';

describe('DTLS certificate fingerprints', () => {
  it('generates a self-signed certificate with a matching SHA-256 fingerprint', async () => {
    const certificate = await createLocalDtlsCertificate();

    expect(certificate.certPem).toContain('BEGIN CERTIFICATE');
    expect(certificate.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(certificate.certDer.length).toBeGreaterThan(0);
    expect(certificate.fingerprints[0]?.algorithm).toBe('sha-256');
    expect(certificate.fingerprints[0]?.value).toMatch(/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);

    expect(() => validateFingerprint({ role: 'client', fingerprints: certificate.fingerprints }, certificate.certDer)).not.toThrow();
  });

  it('rejects certificates that do not match the signaled fingerprint', async () => {
    const [local, remote] = await Promise.all([createLocalDtlsCertificate(), createLocalDtlsCertificate()]);

    expect(() => validateFingerprint({ role: 'client', fingerprints: local.fingerprints }, remote.certDer)).toThrow(DtlsFingerprintMismatchError);
  });
});
