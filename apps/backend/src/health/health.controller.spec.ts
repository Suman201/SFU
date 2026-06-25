import { HealthController } from './health.controller';
import { HealthCheckError } from '@nestjs/terminus';

describe('HealthController', () => {
  it('checks MongoDB health', async () => {
    const controller = new HealthController(
      { check: jest.fn((checks) => checks[0]()) } as never,
      {} as never,
      { pingCheck: jest.fn().mockResolvedValue({ mongodb: { status: 'up' } }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await controller.db();

    expect(result as any).toEqual({ mongodb: { status: 'up' } });
  });

  it('checks Redis health', async () => {
    const controller = new HealthController(
      { check: jest.fn((checks) => checks[0]()) } as never,
      {} as never,
      {} as never,
      { ping: jest.fn().mockResolvedValue('PONG') } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await controller.redisHealth();

    expect(result as any).toEqual({ redis: { status: 'up' } });
  });

  it('reports readiness when the local node can still accept traffic', async () => {
    const controller = createController({
      clusterSnapshot: clusterSnapshot({ health: 'healthy', draining: false, capacityScore: 0.4 }),
      workerSnapshot: workerSnapshot(),
      pipeHealth: pipeHealth(),
      memoryHeap: { memory_heap: { status: 'up' } },
      memoryRss: { memory_rss: { status: 'up' } },
      mongodb: { mongodb: { status: 'up' } }
    });

    const result = await controller.ready();

    expect((result as any).readiness).toEqual({
      status: 'up',
      acceptingTraffic: true,
      reason: undefined
    });
  });

  it('keeps public health details sanitized', async () => {
    const controller = createController({
      clusterSnapshot: clusterSnapshot({ health: 'healthy', draining: false, capacityScore: 0.4 }),
      workerSnapshot: {
        ...workerSnapshot(),
        failures: [{ reason: 'worker_crash' }],
        workers: [{ workerId: 'worker-1', pid: 1234, lastError: 'boom' }]
      },
      pipeHealth: pipeHealth(),
      memoryHeap: { memory_heap: { status: 'up' } },
      memoryRss: { memory_rss: { status: 'up' } },
      mongodb: { mongodb: { status: 'up' } }
    });

    const result = await controller.check();

    expect((result as any).cluster.nodes).toBeUndefined();
    expect((result as any).cluster.localNode).toBeUndefined();
    expect((result as any).media_workers.workers).toBeUndefined();
    expect((result as any).media_workers.failures).toBeUndefined();
    expect((result as any).media_workers.failedRooms).toBeUndefined();
    expect((result as any).media_workers.failedRoomCount).toBe(0);
  });

  it('marks readiness down while the local node is draining', async () => {
    const controller = createController({
      clusterSnapshot: clusterSnapshot({ health: 'draining', draining: true, capacityScore: 0.2 }),
      workerSnapshot: workerSnapshot(),
      pipeHealth: pipeHealth(),
      memoryHeap: { memory_heap: { status: 'up' } },
      memoryRss: { memory_rss: { status: 'up' } },
      mongodb: { mongodb: { status: 'up' } }
    });

    let thrown: unknown;
    try {
      await controller.ready();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HealthCheckError);
  });

  it('marks readiness down while the local node is overloaded', async () => {
    const controller = createController({
      clusterSnapshot: clusterSnapshot({ health: 'overloaded', draining: false, capacityScore: 1.1 }),
      workerSnapshot: workerSnapshot(),
      pipeHealth: pipeHealth(),
      memoryHeap: { memory_heap: { status: 'up' } },
      memoryRss: { memory_rss: { status: 'up' } },
      mongodb: { mongodb: { status: 'up' } }
    });

    let thrown: unknown;
    try {
      await controller.ready();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HealthCheckError);
    expect((thrown as HealthCheckError).causes.readiness.reason).toBe('node_overloaded');
  });
});

function createController(options: {
  clusterSnapshot: any;
  workerSnapshot: any;
  pipeHealth: any;
  memoryHeap: any;
  memoryRss: any;
  mongodb: any;
}) {
  return new HealthController(
    {
      check: jest.fn(async (checks) => {
        const merged: Record<string, unknown> = {};
        for (const check of checks) {
          Object.assign(merged, await check());
        }
        return merged;
      })
    } as never,
    {
      checkHeap: jest.fn().mockResolvedValue(options.memoryHeap),
      checkRSS: jest.fn().mockResolvedValue(options.memoryRss)
    } as never,
    { pingCheck: jest.fn().mockResolvedValue(options.mongodb) } as never,
    { ping: jest.fn().mockResolvedValue('PONG') } as never,
    { workerPoolSnapshot: jest.fn(() => options.workerSnapshot) } as never,
    { healthSnapshot: jest.fn(() => options.pipeHealth) } as never,
    { snapshot: jest.fn(async () => options.clusterSnapshot) } as never,
    {
      refreshMediaWorkerSnapshot: jest.fn(),
      clusterNodeCapacityScore: {
        labels: jest.fn(() => ({ set: jest.fn() }))
      }
    } as never
  );
}

function clusterSnapshot(overrides: { health: string; draining: boolean; capacityScore: number }) {
  return {
    localNode: {
      nodeId: 'node-a',
      health: overrides.health,
      draining: overrides.draining,
      capacity: { capacityScore: overrides.capacityScore }
    },
    nodes: [
      {
        nodeId: 'node-a',
        health: overrides.health,
        draining: overrides.draining
      }
    ],
    ownedRoomCount: 2
  };
}

function workerSnapshot() {
  return {
    mode: 'worker',
    workerCount: 1,
    readyWorkers: 1,
    healthyWorkers: 1,
    drainingWorkers: 0,
    overloadedWorkers: 0,
    activeRooms: 0,
    failedRooms: [],
    failures: [],
    workers: []
  };
}

function pipeHealth() {
  return {
    enabled: true,
    durable: true,
    supported: true,
    mediaWorkerMode: 'worker',
    advertiseIpConfigured: true,
    defaultProtocol: 'udp'
  };
}
