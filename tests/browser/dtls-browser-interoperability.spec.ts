import { test, expect } from '@playwright/test';
import type { DtlsParameters, IceCandidate, IceParameters } from '@native-sfu/contracts';
import { IceAgent } from '../../packages/nest-sfu/src/ice/ice-agent';
import { createLocalDtlsCertificate } from '../../packages/nest-sfu/src/dtls/certificate';
import { DtlsTransport } from '../../packages/nest-sfu/src/dtls/dtls-transport';

test('browser DTLS 1.2 handshake establishes over the Node ICE transport', async ({ page }) => {
  const iceAgent = new IceAgent({
    transportId: 'browser-dtls',
    roomId: 'interop',
    participantId: 'server',
    role: 'controlled',
    includeLoopbackCandidates: true,
    consentIntervalMs: 1000,
    transactionTimeoutMs: 1000,
    maxConsentFailures: 2,
    taMs: 10
  });
  const certificate = await createLocalDtlsCertificate();
  let dtlsTransport: DtlsTransport | undefined;

  try {
    const candidates = await iceAgent.gatherCandidates();
    const candidate = candidates.find((item) => item.ip === '127.0.0.1') ?? candidates[0];
    expect(candidate).toBeTruthy();
    const dtlsParameters: DtlsParameters = { role: 'auto', fingerprints: certificate.fingerprints };
    dtlsTransport = new DtlsTransport('browser-dtls', iceAgent, certificate);
    dtlsTransport.on('error', () => undefined);
    await dtlsTransport.start();

    await page.exposeFunction('serverAnswer', async (offer: string) => {
      iceAgent.setRemoteParameters(parseIceParameters(offer));
      for (const remoteCandidate of parseCandidates(offer)) {
        iceAgent.addRemoteCandidate(remoteCandidate);
      }
      dtlsTransport.setRemoteParameters(parseDtlsParameters(offer));
      iceAgent.startConnectivityChecks();

      const sessionId = offer.match(/^o=.*$/m)?.[0]?.split(' ')[1] ?? `${Date.now()}`;
      return [
        'v=0',
        `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
        's=-',
        't=0 0',
        'a=group:BUNDLE 0',
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=sctp-port:5000',
        `a=ice-ufrag:${iceAgent.localParameters.usernameFragment}`,
        `a=ice-pwd:${iceAgent.localParameters.password}`,
        'a=ice-options:trickle',
        ...dtlsParameters.fingerprints.map((fingerprint) => `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`),
        'a=setup:passive',
        `a=candidate:${candidate.foundation} 1 UDP ${candidate.priority} ${candidate.ip} ${candidate.port} typ host`,
        'a=end-of-candidates',
        ''
      ].join('\r\n');
    });

    await page.evaluate(async () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      (window as unknown as { __dtlsPc?: RTCPeerConnection }).__dtlsPc = pc;
      pc.createDataChannel('dtls-probe');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve();
          }
        };
      });
      const answer = await (window as unknown as { serverAnswer: (sdp: string) => Promise<string> }).serverAnswer(pc.localDescription?.sdp ?? '');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    });

    await waitFor(() => dtlsTransport.snapshot().state === 'connected');
    const snapshot = dtlsTransport.snapshot();
    expect(snapshot.remoteFingerprintVerified).toBe(true);
    expect(snapshot.srtpKeys?.localKey.length).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => (window as unknown as { __dtlsPc?: RTCPeerConnection }).__dtlsPc?.close()).catch(() => undefined);
    dtlsTransport?.close();
    iceAgent.close();
  }
});

function parseIceParameters(sdp: string): IceParameters {
  const usernameFragment = sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim();
  const password = sdp.match(/^a=ice-pwd:(.+)$/m)?.[1]?.trim();
  if (!usernameFragment || !password) {
    throw new Error('Browser SDP did not include ICE credentials');
  }
  return { usernameFragment, password, iceLite: false };
}

function parseDtlsParameters(sdp: string): DtlsParameters {
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:(sha-256|sha-384|sha-512)\s+(.+)$/gm)].map((match) => ({
    algorithm: match[1] as 'sha-256' | 'sha-384' | 'sha-512',
    value: match[2]?.trim() ?? ''
  }));
  if (!fingerprints.length) {
    throw new Error('Browser SDP did not include a DTLS fingerprint');
  }
  return { role: 'client', fingerprints };
}

function parseCandidates(sdp: string): IceCandidate[] {
  return [...sdp.matchAll(/^a=candidate:(.+)$/gm)]
    .map((match) => match[1]?.trim().split(/\s+/) ?? [])
    .filter((parts) => parts.length >= 8)
    .map((parts) => ({
      foundation: parts[0] ?? '0',
      component: Number(parts[1] ?? 1) as 1 | 2,
      protocol: (parts[2]?.toLowerCase() ?? 'udp') as 'udp' | 'tcp',
      priority: Number(parts[3] ?? 0),
      ip: parts[4] ?? '0.0.0.0',
      port: Number(parts[5] ?? 0),
      type: (parts[7] ?? 'host') as 'host' | 'srflx' | 'prflx' | 'relay'
    }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 7000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for browser DTLS handshake');
}
