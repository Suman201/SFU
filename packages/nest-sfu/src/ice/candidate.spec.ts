import { computeCandidatePairPriority, computeCandidatePriority } from './candidate';

describe('ICE candidate priority', () => {
  it('uses RFC 8445 candidate type preference ordering', () => {
    const host = computeCandidatePriority({ type: 'host', component: 1 });
    const peerReflexive = computeCandidatePriority({ type: 'prflx', component: 1 });
    const serverReflexive = computeCandidatePriority({ type: 'srflx', component: 1 });
    const relay = computeCandidatePriority({ type: 'relay', component: 1 });

    expect(host).toBeGreaterThan(peerReflexive);
    expect(peerReflexive).toBeGreaterThan(serverReflexive);
    expect(serverReflexive).toBeGreaterThan(relay);
  });

  it('computes pair priorities deterministically', () => {
    expect(computeCandidatePairPriority(100, 50, true).toString()).toBe('214748365001');
    expect(computeCandidatePairPriority(100, 50, false).toString()).toBe('214748365000');
  });
});
