import { DtlsClient } from 'werift-dtls/lib/dtls/src';
import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80, keyLength, saltLength } from 'werift-dtls/lib/rtp/src/srtp/const';
import { IceAgent } from '../ice/ice-agent';
import { createLocalDtlsCertificate } from '../dtls/certificate';
import { DtlsTransport, isDtlsPacket } from '../dtls/dtls-transport';
import { IceDatagramTransport } from '../dtls/ice-datagram-transport';
import { NativeSrtpSession } from './srtp-session';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';

describe('SRTP integration with DTLS key extraction', () => {
  jest.setTimeout(15_000);

  it('uses DTLS-exported keying material to protect and unprotect RTP/SRTCP', async () => {
    const serverIce = new IceAgent({
      transportId: 'srtp-server',
      roomId: 'room',
      participantId: 'server',
      role: 'controlled',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });
    const clientIce = new IceAgent({
      transportId: 'srtp-client',
      roomId: 'room',
      participantId: 'client',
      role: 'controlling',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });

    let serverTransport: DtlsTransport | undefined;
    let client: DtlsClient | undefined;
    let clientIceHandler: ((event: { message: Buffer; remote: { address: string; port: number } }) => void) | undefined;

    try {
      await connectIce(clientIce, serverIce);
      const [serverCertificate, clientCertificate] = await Promise.all([createLocalDtlsCertificate(), createLocalDtlsCertificate()]);
      serverTransport = new DtlsTransport('srtp-server', serverIce, serverCertificate);
      serverTransport.on('error', () => undefined);
      serverTransport.setRemoteParameters({ role: 'client', fingerprints: clientCertificate.fingerprints });
      await serverTransport.start();

      const clientDatagramTransport = new IceDatagramTransport(clientIce);
      clientIceHandler = (event) => {
        if (isDtlsPacket(event.message)) {
          clientDatagramTransport.push(event.message, [event.remote.address, event.remote.port]);
        }
      };
      clientIce.on('data', clientIceHandler);

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

      const serverKeys = serverTransport.snapshot().srtpKeys;
      const profile = client.srtp.srtpProfile;
      expect(serverKeys).toBeDefined();
      expect(profile).toBeDefined();
      const clientKeys = client.extractSessionKeys(keyLength(profile!), saltLength(profile!));
      const clientMaterial: DtlsSrtpKeyingMaterial = {
        profile: profile!,
        localKey: Buffer.from(clientKeys.localKey),
        localSalt: Buffer.from(clientKeys.localSalt),
        remoteKey: Buffer.from(clientKeys.remoteKey),
        remoteSalt: Buffer.from(clientKeys.remoteSalt)
      };

      const clientSrtp = new NativeSrtpSession(clientMaterial);
      const serverSrtp = new NativeSrtpSession(serverKeys!);
      clientSrtp.setOutboundSsrcs([9001]);
      serverSrtp.setInboundSsrcs([9001]);
      serverSrtp.setOutboundSsrcs([9002]);
      clientSrtp.setInboundSsrcs([9002]);

      const clientRtp = rtpPacket(9001, 22, 123456);
      const serverRtp = rtpPacket(9002, 23, 654321);
      expect(await serverSrtp.unprotectRtp(await clientSrtp.protectRtp(clientRtp))).toEqual(clientRtp);
      expect(await clientSrtp.unprotectRtp(await serverSrtp.protectRtp(serverRtp))).toEqual(serverRtp);

      const clientRtcp = receiverReport(9001);
      expect(await serverSrtp.unprotectRtcp(await clientSrtp.protectRtcp(clientRtcp))).toEqual(clientRtcp);
    } finally {
      if (clientIceHandler) {
        clientIce.off('data', clientIceHandler);
      }
      client?.close();
      serverTransport?.close();
      clientIce.close();
      serverIce.close();
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
  throw new Error('Timed out waiting for SRTP integration state');
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  const payload = Buffer.from('dtls-derived-srtp');
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = 96;
  packet.writeUInt16BE(sequenceNumber, 2);
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(ssrc, 8);
  payload.copy(packet, 12);
  return packet;
}

function receiverReport(ssrc: number): Buffer {
  const packet = Buffer.alloc(8);
  packet[0] = 0x80;
  packet[1] = 201;
  packet.writeUInt16BE(1, 2);
  packet.writeUInt32BE(ssrc, 4);
  return packet;
}
