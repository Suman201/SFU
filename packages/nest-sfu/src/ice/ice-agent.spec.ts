import type { IceCandidatePair } from './ice.types';
import { IceAgent } from './ice-agent';

describe('IceAgent nomination helpers', () => {
  it('queues a triggered connectivity check when a controlling agent discovers a new tuple', () => {
    const agent = new IceAgent({
      transportId: 'transport',
      roomId: 'room',
      participantId: 'participant',
      role: 'controlling'
    });

    try {
      const pair = fakePair('new-pair');
      const scheduleSpy = jest.spyOn(agent as unknown as { scheduleNextCheck(delay?: number): void }, 'scheduleNextCheck');
      (agent as unknown as { remoteParameters: { usernameFragment: string; password: string } }).remoteParameters = {
        usernameFragment: 'remote',
        password: 'secret'
      };

      (agent as unknown as { queueTriggeredConnectivityCheck(pair: IceCandidatePair, requestHadUseCandidate: boolean): void }).queueTriggeredConnectivityCheck(pair, false);

      expect(pair.state).toBe('waiting');
      expect(scheduleSpy).toHaveBeenCalledWith(0);
    } finally {
      agent.close();
    }
  });

  it('does not queue a triggered connectivity check for the already selected pair', () => {
    const agent = new IceAgent({
      transportId: 'transport',
      roomId: 'room',
      participantId: 'participant',
      role: 'controlling'
    });

    try {
      const pair = fakePair('selected-pair');
      const scheduleSpy = jest.spyOn(agent as unknown as { scheduleNextCheck(delay?: number): void }, 'scheduleNextCheck');
      (agent as unknown as { remoteParameters: { usernameFragment: string; password: string } }).remoteParameters = {
        usernameFragment: 'remote',
        password: 'secret'
      };
      (agent as unknown as { selectedPair?: IceCandidatePair }).selectedPair = pair;

      (agent as unknown as { queueTriggeredConnectivityCheck(pair: IceCandidatePair, requestHadUseCandidate: boolean): void }).queueTriggeredConnectivityCheck(pair, false);

      expect(pair.state).toBe('succeeded');
      expect(scheduleSpy).not.toHaveBeenCalled();
    } finally {
      agent.close();
    }
  });

  it('does not queue a triggered connectivity check for a controlled agent', () => {
    const agent = new IceAgent({
      transportId: 'transport',
      roomId: 'room',
      participantId: 'participant',
      role: 'controlled'
    });

    try {
      const pair = fakePair('controlled-pair');
      const scheduleSpy = jest.spyOn(agent as unknown as { scheduleNextCheck(delay?: number): void }, 'scheduleNextCheck');
      (agent as unknown as { remoteParameters: { usernameFragment: string; password: string } }).remoteParameters = {
        usernameFragment: 'remote',
        password: 'secret'
      };

      (agent as unknown as { queueTriggeredConnectivityCheck(pair: IceCandidatePair, requestHadUseCandidate: boolean): void }).queueTriggeredConnectivityCheck(pair, false);

      expect(pair.state).toBe('succeeded');
      expect(scheduleSpy).not.toHaveBeenCalled();
    } finally {
      agent.close();
    }
  });
});

function fakePair(id: string): IceCandidatePair {
  return {
    id,
    local: {
      transportId: 'transport',
      socketId: '127.0.0.1:5000',
      foundation: 'local',
      component: 1,
      protocol: 'udp',
      priority: 100,
      ip: '127.0.0.1',
      port: 5000,
      type: 'host',
      baseAddress: '127.0.0.1',
      basePort: 5000
    },
    remote: {
      transportId: 'transport',
      foundation: 'remote',
      component: 1,
      protocol: 'udp',
      priority: 100,
      ip: '127.0.0.1',
      port: 6000,
      type: 'host'
    },
    priority: 1n,
    state: 'succeeded',
    nominated: false,
    failures: 0
  };
}
