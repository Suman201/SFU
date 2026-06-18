import { test, expect } from '@playwright/test';
import { IceAgent } from '../../packages/nest-sfu/src/ice/ice-agent';

test('browser aggressive nomination can select a Node ICE agent host candidate', async ({ page, browserName }) => {
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
    expect(agent.selectedCandidatePair()).toMatchObject({
      nominated: true
    });
  } finally {
    agent.close();
  }
});

test('browser ICE restart can reconnect a Node ICE agent with fresh credentials', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox does not start checks for this datachannel-only ICE smoke SDP; Firefox ICE is covered by the DTLS/media browser tests.');
  const agent = new IceAgent({
    transportId: 'browser-interop-restart',
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
    const initialUfrag = agent.localParameters.usernameFragment;

    await page.exposeFunction('serverAnswer', async (payload: { offer: string; restart: boolean }) => {
      if (payload.restart) {
        await agent.restart();
      }
      const sessionId = payload.offer.match(/^o=.*$/m)?.[0]?.split(' ')[1] ?? `${Date.now()}`;
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
    await page.exposeFunction('serverIceState', () => agent.snapshot().state);

    const browserOfferUfrags = await page.evaluate(async () => {
      const getLocalUfrag = (pc: RTCPeerConnection): string | null => {
        const sdp = pc.localDescription?.sdp ?? '';
        return sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1] ?? null;
      };
      const waitForGathering = async (pc: RTCPeerConnection): Promise<void> => {
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
      };
      const waitForConnected = async (pc: RTCPeerConnection): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            resolve();
            return;
          }
          const timeout = setTimeout(() => reject(new Error(`ICE stayed ${pc.iceConnectionState}`)), 5000);
          pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
              clearTimeout(timeout);
              resolve();
            }
          };
        });
      };
      const waitForServerIceState = async (): Promise<void> => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 5000) {
          const state = await (window as unknown as { serverIceState: () => Promise<string> }).serverIceState();
          if (state === 'connected' || state === 'completed') {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Server ICE state did not recover after restart');
      };
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('ice-restart-probe');

      const negotiate = async (restart: boolean): Promise<string | null> => {
        if (restart && typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
        const offer = restart ? await pc.createOffer({ iceRestart: true }) : await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForGathering(pc);
        const answer = await (window as unknown as { serverAnswer: (payload: { offer: string; restart: boolean }) => Promise<string> }).serverAnswer({
          offer: pc.localDescription?.sdp ?? offer.sdp ?? '',
          restart
        });
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        await waitForConnected(pc);
        if (restart) {
          await waitForServerIceState();
        }
        return getLocalUfrag(pc);
      };

      const firstUfrag = await negotiate(false);
      const secondUfrag = await negotiate(true);
      pc.close();
      return { firstUfrag, secondUfrag };
    });

    expect(browserOfferUfrags.firstUfrag).toBeTruthy();
    expect(browserOfferUfrags.secondUfrag).toBeTruthy();
    expect(browserOfferUfrags.secondUfrag).not.toBe(browserOfferUfrags.firstUfrag);
    expect(agent.localParameters.usernameFragment).not.toBe(initialUfrag);
    await waitFor(() => {
      const state = agent.snapshot().state;
      return state === 'connected' || state === 'completed';
    });
    expect(['connected', 'completed']).toContain(agent.snapshot().state);
    expect(agent.selectedCandidatePair()).toMatchObject({
      nominated: true
    });
  } finally {
    agent.close();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for ICE browser state');
}
