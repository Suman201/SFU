import { DtlsClient } from 'werift-dtls/lib/dtls/src';
import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import { IceAgent } from '../ice/ice-agent';
import { createLocalDtlsCertificate } from './certificate';
import { DtlsTransport, isDtlsPacket } from './dtls-transport';
import { IceDatagramTransport } from './ice-datagram-transport';

describe('DtlsTransport integration', () => {
  jest.setTimeout(15_000);

  it('establishes DTLS 1.2 over a nominated ICE candidate pair and exports SRTP keys', async () => {
    const controlling = new IceAgent({
      transportId: 'dtls-client',
      roomId: 'room',
      participantId: 'browser',
      role: 'controlling',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });
    const controlled = new IceAgent({
      transportId: 'dtls-server',
      roomId: 'room',
      participantId: 'server',
      role: 'controlled',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });

    let serverTransport: DtlsTransport | undefined;
    let client: DtlsClient | undefined;
    let clientIceHandler: ((event: { message: Buffer; remote: { address: string; port: number } }) => void) | undefined;

    try {
      await connectIce(controlling, controlled);

      const [serverCertificate, clientCertificate] = await Promise.all([createLocalDtlsCertificate(), createLocalDtlsCertificate()]);
      serverTransport = new DtlsTransport('dtls-server', controlled, serverCertificate);
      let serverError: Error | undefined;
      serverTransport.on('error', (error) => {
        serverError = error;
      });
      serverTransport.setRemoteParameters({ role: 'client', fingerprints: clientCertificate.fingerprints });
      await serverTransport.start();

      const clientDatagramTransport = new IceDatagramTransport(controlling);
      clientIceHandler = (event) => {
        if (isDtlsPacket(event.message)) {
          clientDatagramTransport.push(event.message, [event.remote.address, event.remote.port]);
        }
      };
      controlling.on('data', clientIceHandler);

      client = new DtlsClient({
        transport: clientDatagramTransport,
        cert: clientCertificate.certPem,
        key: clientCertificate.keyPem,
        signatureHash: clientCertificate.signatureHash,
        certificateRequest: true,
        extendedMasterSecret: true,
        srtpProfiles: [ProtectionProfileAes128CmHmacSha1_80, ProtectionProfileAeadAes128Gcm]
      });

      const clientConnected = new Promise<void>((resolve, reject) => {
        client?.onConnect.subscribe(() => resolve());
        client?.onError.subscribe((error) => reject(error));
      });

      await client.connect();
      await clientConnected;
      await waitFor(() => serverTransport?.snapshot().state === 'connected');

      expect(serverError).toBeUndefined();
      const snapshot = serverTransport.snapshot();
      expect(snapshot.remoteFingerprintVerified).toBe(true);
      expect(snapshot.srtpKeys?.localKey.length).toBeGreaterThan(0);
      expect(snapshot.srtpKeys?.remoteKey.length).toBeGreaterThan(0);
      expect(snapshot.srtpKeys?.localSalt.length).toBeGreaterThan(0);
      expect(snapshot.srtpKeys?.remoteSalt.length).toBeGreaterThan(0);
    } finally {
      if (clientIceHandler) {
        controlling.off('data', clientIceHandler);
      }
      client?.close();
      serverTransport?.close();
      controlling.close();
      controlled.close();
    }
  });
});

async function connectIce(controlling: IceAgent, controlled: IceAgent): Promise<void> {
  const [controllingCandidates, controlledCandidates] = await Promise.all([controlling.gatherCandidates(), controlled.gatherCandidates()]);

  controlling.setRemoteParameters(controlled.localParameters);
  controlled.setRemoteParameters(controlling.localParameters);
  controlledCandidates.forEach((candidate) => controlling.addRemoteCandidate(candidate));
  controllingCandidates.forEach((candidate) => controlled.addRemoteCandidate(candidate));

  controlling.startConnectivityChecks();
  controlled.startConnectivityChecks();

  await waitFor(() => controlling.snapshot().state === 'connected' || controlling.snapshot().state === 'completed');
  await waitFor(() => controlled.snapshot().state === 'connected' || controlled.snapshot().state === 'completed');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 7000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for DTLS state');
}
