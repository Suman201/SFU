const createSocket = jest.fn();

jest.mock('os', () => ({
  networkInterfaces: jest.fn(() => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  }))
}));

jest.mock('dgram', () => ({
  __esModule: true,
  default: { createSocket },
  createSocket
}));

import { IceAgent } from './ice-agent';

describe('IceAgent announced address', () => {
  beforeEach(() => {
    createSocket.mockImplementation(() => {
      const onceHandlers = new Map<string, (...args: any[]) => void>();
      return {
        once: jest.fn((event: string, handler: (...args: any[]) => void) => {
          onceHandlers.set(event, handler);
          return undefined;
        }),
        off: jest.fn((event: string, handler: (...args: any[]) => void) => {
          if (onceHandlers.get(event) === handler) {
            onceHandlers.delete(event);
          }
          return undefined;
        }),
        bind: jest.fn(() => {
          onceHandlers.get('listening')?.();
        }),
        address: jest.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 47000 })),
        on: jest.fn(),
        close: jest.fn()
      };
    });
  });

  afterEach(() => {
    createSocket.mockReset();
  });

  it('advertises the configured announced address for host candidates', async () => {
    const agent = new IceAgent({
      transportId: 'transport-1',
      roomId: 'room-1',
      participantId: 'participant-1',
      includeLoopbackCandidates: true,
      gatherInterfaces: ['lo'],
      announcedAddress: '203.0.113.10'
    });

    try {
      const candidates = await agent.gatherCandidates();
      const hostCandidates = candidates.filter((candidate) => candidate.type === 'host');

      expect(hostCandidates.length).toBe(1);
      expect(hostCandidates[0]?.ip).toBe('203.0.113.10');
      expect(hostCandidates[0]?.baseAddress).toBe('127.0.0.1');
      expect(hostCandidates[0]?.port).toBe(47000);
      expect(hostCandidates[0]?.type).toBe('host');
    } finally {
      agent.close();
    }
  });
});
