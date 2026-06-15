import { IceAgent } from './ice-agent';

describe('IceAgent integration', () => {
  jest.setTimeout(10_000);

  it('connects two RFC 8445 full agents over localhost and refreshes consent', async () => {
    const controlling = new IceAgent({
      transportId: 'a',
      roomId: 'room',
      participantId: 'alice',
      role: 'controlling',
      includeLoopbackCandidates: true,
      consentIntervalMs: 1000,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });
    const controlled = new IceAgent({
      transportId: 'b',
      roomId: 'room',
      participantId: 'bob',
      role: 'controlled',
      includeLoopbackCandidates: true,
      consentIntervalMs: 1000,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });

    try {
      const [controllingCandidates, controlledCandidates] = await Promise.all([controlling.gatherCandidates(), controlled.gatherCandidates()]);

      controlling.setRemoteParameters(controlled.localParameters);
      controlled.setRemoteParameters(controlling.localParameters);
      controlledCandidates.forEach((candidate) => controlling.addRemoteCandidate(candidate));
      controllingCandidates.forEach((candidate) => controlled.addRemoteCandidate(candidate));

      controlling.startConnectivityChecks();
      controlled.startConnectivityChecks();

      await waitFor(() => controlling.snapshot().state === 'connected' || controlling.snapshot().state === 'completed');
      await waitFor(() => controlled.snapshot().state === 'connected' || controlled.snapshot().state === 'completed');

      expect(controlling.selectedCandidatePair()).toBeDefined();
      expect(controlled.selectedCandidatePair()).toBeDefined();
      const consentRefreshed = await controlling.refreshConsentOnce();
      expect(consentRefreshed).toBe(true);
    } finally {
      controlling.close();
      controlled.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for ICE state');
}
