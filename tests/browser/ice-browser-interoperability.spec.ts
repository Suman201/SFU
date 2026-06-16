import { test, expect } from '@playwright/test';
import { IceAgent } from '../../packages/nest-sfu/src/ice/ice-agent';

test('browser ICE checks can nominate a Node ICE agent host candidate', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox does not start checks for this datachannel-only ICE smoke SDP; Firefox ICE is covered by the DTLS/media browser tests.');
  const agent = new IceAgent({
    transportId: 'browser-interop',
    roomId: 'interop',
    participantId: 'server',
    role: 'controlled',
    includeLoopbackCandidates: true,
    consentIntervalMs: 1000,
    transactionTimeoutMs: 1000,
    maxConsentFailures: 2
  });

  try {
    const candidates = await agent.gatherCandidates();
    const candidate = candidates.find((item) => item.ip === '127.0.0.1') ?? candidates[0];
    expect(candidate).toBeTruthy();

    await page.exposeFunction('serverAnswer', async (offer: string) => {
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
        `a=ice-ufrag:${agent.localParameters.usernameFragment}`,
        `a=ice-pwd:${agent.localParameters.password}`,
        'a=ice-options:trickle',
        'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
        'a=setup:passive',
        `a=candidate:${candidate.foundation} 1 UDP ${candidate.priority} ${candidate.ip} ${candidate.port} typ host`,
        'a=end-of-candidates',
        ''
      ].join('\r\n');
    });

    await page.evaluate(async () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('ice-probe');
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
      const answer = await (window as unknown as { serverAnswer: (sdp: string) => Promise<string> }).serverAnswer(pc.localDescription?.sdp ?? offer.sdp ?? '');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`ICE stayed ${pc.iceConnectionState}`)), 5000);
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
      pc.close();
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(['connected', 'completed']).toContain(agent.snapshot().state);
  } finally {
    agent.close();
  }
});
