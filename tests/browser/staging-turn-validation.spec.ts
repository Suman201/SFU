import { test, expect } from '@playwright/test';

const baseUrl = process.env.STAGING_BASE_URL;
const email = process.env.STAGING_EMAIL;
const password = process.env.STAGING_PASSWORD;

test.describe('staging TURN validation', () => {
  test.skip(!baseUrl || !email || !password, 'Set STAGING_BASE_URL, STAGING_EMAIL, and STAGING_PASSWORD to run staging TURN validation.');

  test('browser gathers relay candidates from staged TURN credentials', async ({ page }) => {
    const loginResponse = await fetch(new URL('/api/v1/auth/login', baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    expect(loginResponse.ok).toBeTruthy();
    const auth = await loginResponse.json();

    const turnResponse = await fetch(new URL('/api/v1/media/turn-credentials', baseUrl).toString(), {
      headers: {
        authorization: `Bearer ${auth.accessToken as string}`
      }
    });
    expect(turnResponse.ok).toBeTruthy();
    const credentials = await turnResponse.json();
    const uris = Array.isArray(credentials.uris) ? credentials.uris : [];
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) {
      expect(uri.toLowerCase()).toContain('transport=udp');
      expect(uri.toLowerCase().startsWith('turn:')).toBeTruthy();
      expect(uri.toLowerCase().startsWith('turns:')).toBeFalsy();
      expect(uri.toLowerCase()).not.toContain('transport=tcp');
    }

    const result = await page.evaluate(async (turn) => {
      const collected: string[] = [];
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: turn.uris,
            username: turn.username,
            credential: turn.credential
          }
        ]
      });
      (window as unknown as { __stagingTurnPc?: RTCPeerConnection }).__stagingTurnPc = pc;
      pc.createDataChannel('turn-probe');
      pc.onicecandidate = (event) => {
        if (event.candidate?.candidate) {
          collected.push(event.candidate.candidate);
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        if (pc.iceGatheringState === 'complete') {
          done();
          return;
        }
        const timeout = window.setTimeout(done, 15_000);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            window.clearTimeout(timeout);
            done();
          }
        });
      });
      const parsed = collected
        .map((candidate) => candidate.trim().split(/\s+/))
        .filter((parts) => parts.length >= 8)
        .map((parts) => ({
          type: parts[7] ?? 'host',
          protocol: (parts[2] ?? 'udp').toLowerCase(),
          address: parts[4] ?? '0.0.0.0',
          port: Number(parts[5] ?? 0)
        }));
      return {
        gatheredCandidates: parsed,
        relayCount: parsed.filter((candidate) => candidate.type === 'relay').length,
        candidateTypes: [...new Set(parsed.map((candidate) => candidate.type))]
      };
    }, credentials);

    expect(result.gatheredCandidates.length).toBeGreaterThan(0);
    expect(result.relayCount).toBeGreaterThan(0);
    expect(
      result.gatheredCandidates
        .filter((candidate) => candidate.type === 'relay')
        .every((candidate) => !isLocalOrWildcardHost(candidate.address))
    ).toBeTruthy();

    await page.evaluate(() => {
      (window as unknown as { __stagingTurnPc?: RTCPeerConnection }).__stagingTurnPc?.close();
    });
  });
});

function isLocalOrWildcardHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host.trim().toLowerCase());
}
