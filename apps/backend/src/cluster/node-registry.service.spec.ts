import { NodeRegistryService, RoomOwnerRedirectException } from './node-registry.service';

describe('NodeRegistryService', () => {
  it('registers local node capacity and claims room ownership', async () => {
    const redis = new FakeRedisService();
    const service = createRegistry('node-a', redis);

    const node = await service.heartbeatNow();
    const owner = await service.claimRoom('room-1');

    expect(node.nodeId).toBe('node-a');
    expect(node.capacity.activeRooms).toBe(2);
    expect(owner.nodeId).toBe('node-a');
    expect((await service.lookupRoomOwner('room-1')).local).toBe(true);
  });

  it('prevents two nodes from owning the same room', async () => {
    const redis = new FakeRedisService();
    const nodeA = createRegistry('node-a', redis);
    const nodeB = createRegistry('node-b', redis);
    await nodeA.heartbeatNow();
    await nodeB.heartbeatNow();
    await nodeA.claimRoom('room-1');

    const error = await captureError(() => nodeB.claimRoom('room-1'));
    expect(error).toBeInstanceOf(RoomOwnerRedirectException);
    expect((error as RoomOwnerRedirectException).details.ownerNodeId).toBe('node-a');
    expect((error as RoomOwnerRedirectException).details.reason).toBe('room_owned_by_remote_node');
  });

  it('releases ownership only from the owning node', async () => {
    const redis = new FakeRedisService();
    const nodeA = createRegistry('node-a', redis);
    const nodeB = createRegistry('node-b', redis);
    await nodeA.heartbeatNow();
    await nodeB.heartbeatNow();
    await nodeA.claimRoom('room-1');

    await nodeB.releaseRoom('room-1');
    expect((await nodeA.lookupRoomOwner('room-1')).owner?.nodeId).toBe('node-a');

    await nodeA.releaseRoom('room-1');
    expect((await nodeA.lookupRoomOwner('room-1')).reason).toBe('missing');
  });

  it('refuses new room ownership while local node is draining', async () => {
    const redis = new FakeRedisService();
    const service = createRegistry('node-a', redis, { 'cluster.draining': true });
    await service.heartbeatNow();

    const error = await captureError(() => service.claimRoom('room-1'));
    expect(error).toBeInstanceOf(RoomOwnerRedirectException);
    expect((error as RoomOwnerRedirectException).details.reason).toBe('local_node_draining');
  });

  it('supports runtime drain and undrain without requiring process restart', async () => {
    const redis = new FakeRedisService();
    const service = createRegistry('node-a', redis);
    await service.heartbeatNow();

    const drainingNode = await service.beginDraining('maintenance');
    const error = await captureError(() => service.claimRoom('room-1'));

    expect(drainingNode.draining).toBe(true);
    expect(drainingNode.health).toBe('draining');
    expect(service.localDrainReason()).toBe('maintenance');
    expect(error).toBeInstanceOf(RoomOwnerRedirectException);
    expect((error as RoomOwnerRedirectException).details.reason).toBe('local_node_draining');

    const readyNode = await service.endDraining();
    const owner = await service.claimRoom('room-2');

    expect(readyNode.draining).toBe(false);
    expect(service.localDrainReason()).toBeUndefined();
    expect(owner.nodeId).toBe('node-a');
  });

  it('keeps existing owned rooms serviceable while the owner drains', async () => {
    const redis = new FakeRedisService();
    const service = createRegistry('node-a', redis);
    await service.heartbeatNow();
    await service.claimRoom('room-1');

    await service.beginDraining('sigterm');
    const lookup = await service.lookupRoomOwner('room-1');

    expect(lookup.local).toBe(true);
    expect(lookup.available).toBe(true);
    expect(lookup.reason).toBe('owner_draining');
    await service.assertLocalRoomOwner('room-1');
  });

  it('publishes a draining heartbeat during shutdown instead of deleting the node immediately', async () => {
    const redis = new FakeRedisService();
    const service = createRegistry('node-a', redis);
    await service.heartbeatNow();

    await service.beforeApplicationShutdown('SIGTERM');
    await service.onModuleDestroy();
    const storedNode = await redis.getJson<{ draining: boolean; health: string }>('sfu:node:node-a');

    expect(storedNode?.draining).toBe(true);
    expect(storedNode?.health).toBe('draining');
    const drainingEvent = redis.publish.mock.calls.find(
      ([channel, message]) =>
        channel === 'sfu:room-owner-events' &&
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string; nodeId?: string }).type === 'node-draining' &&
        (message as { type?: string; nodeId?: string }).nodeId === 'node-a'
    );
    expect(Boolean(drainingEvent)).toBe(true);
  });
});

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function createRegistry(nodeId: string, redis: FakeRedisService, extraConfig: Record<string, unknown> = {}): NodeRegistryService {
  const config = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'cluster.nodeId': nodeId,
        'cluster.publicUrl': `http://${nodeId}.example.test`,
        'cluster.region': 'test-region',
        'cluster.zone': 'test-zone-a',
        'cluster.heartbeatIntervalMs': 5000,
        'cluster.ttlMs': 15000,
        'cluster.preferLocalNode': true,
        'cluster.maxRooms': 10,
        'cluster.maxTransports': 10,
        ...extraConfig
      };
      return values[key] ?? defaultValue;
    })
  };
  const media = {
    workerPoolSnapshot: jest.fn(() => ({
      mode: 'worker',
      workerCount: 1,
      healthyWorkers: 1,
      readyWorkers: 1,
      drainingWorkers: 0,
      overloadedWorkers: 0,
      activeRooms: 2,
      failedRooms: [],
      failures: [],
      workers: [
        {
          workerId: `${nodeId}-worker-1`,
          healthy: true,
          ready: true,
          status: 'ready',
          draining: false,
          overloaded: false,
          startedAt: new Date().toISOString(),
          restarts: 0,
          crashes: 0,
          activeRooms: 2,
          activeTransports: 3,
          activeProducers: 1,
          activeConsumers: 2,
          rtpPackets: 0,
          rtcpPackets: 0,
          inflightRequests: 0,
          queueDepth: 0,
          averageIpcLatencyMs: 2,
          ipcTimeouts: 0,
          capacityScore: 0.2
        }
      ]
    }))
  };
  return new NodeRegistryService(config as never, redis as never, media as never, fakeMetrics() as never);
}

function fakeMetrics(): Record<string, unknown> {
  const counter: { inc: jest.Mock; set: jest.Mock; observe: jest.Mock; labels: jest.Mock } = {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
    labels: jest.fn()
  };
  counter.labels.mockReturnValue(counter);
  return {
    clusterNodeHeartbeatLatency: counter,
    roomOwnerLookupLatency: counter,
    remoteRoomJoinAttempts: counter,
    roomAdmissionRejections: counter,
    roomOwnershipClaims: counter,
    roomOwnershipConflicts: counter,
    staleRoomOwners: counter,
    roomOwnerRedirects: counter,
    clusterRegisteredNodes: counter,
    clusterHealthyNodes: counter,
    clusterDrainingNodes: counter,
    clusterOwnedRooms: counter,
    clusterNodeInfo: counter,
    clusterNodeCapacityScore: counter
  };
}

class FakeRedisService {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly raw = {
    sadd: jest.fn(async (key: string, value: string) => {
      const set = this.sets.get(key) ?? new Set<string>();
      set.add(value);
      this.sets.set(key, set);
      return 1;
    }),
    srem: jest.fn(async (key: string, value: string) => {
      this.sets.get(key)?.delete(value);
      return 1;
    }),
    smembers: jest.fn(async (key: string) => [...(this.sets.get(key) ?? [])]),
    set: jest.fn(async (key: string, value: string, ...args: string[]) => {
      if (args.includes('NX') && this.values.has(key)) {
        return null;
      }
      this.values.set(key, value);
      return 'OK';
    })
  };

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  publish = jest.fn(async (_channel: string, _message: unknown): Promise<void> => {
    return undefined;
  });
}
