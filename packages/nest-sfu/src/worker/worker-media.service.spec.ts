import { EventEmitter } from 'events';
import type { Producer } from '@native-sfu/contracts';
import { MediaWorkerClient } from './media-worker-client';
import { MediaWorkerPool } from './media-worker-pool';
import { WorkerMediaService } from './worker-media.service';
import type { NestSfuOptions } from '../nest-sfu.options';
import type { MediaWorkerHealth } from './ipc';

const workerOptions: NestSfuOptions = {
  turnSecret: 'worker-test-secret',
  turnUris: [],
  mediaWorkerMode: 'worker',
  mediaWorkerCount: 1,
  mediaWorkerRequestTimeoutMs: 3000,
  mediaWorkerStartupTimeoutMs: 10000,
  mediaWorkerHeartbeatIntervalMs: 250,
  mediaWorkerHeartbeatTimeoutMs: 2000,
  mediaWorkerRestartBackoffMs: 50,
  mediaWorkerExecArgv: ['-r', 'ts-node/register'],
  hostCandidatePortRange: { min: 49000, max: 49010 }
};

describe('media worker runtime', () => {
  jest.setTimeout(20000);

  it('responds to typed IPC health requests', async () => {
    const client = new MediaWorkerClient({
      workerId: 'media-worker-ipc-test',
      options: workerOptions,
      requestTimeoutMs: 3000,
      startupTimeoutMs: 10000,
      heartbeatTimeoutMs: 2000,
      execArgv: ['-r', 'ts-node/register']
    });
    await client.start();
    try {
      const health = (await client.request({ type: 'workerHealth' })) as MediaWorkerHealth;
      expect(health.workerId).toBe('media-worker-ipc-test');
      expect(health.ready).toBe(true);
      expect(health.activeRooms).toBe(0);
      expect(health.activeTransports).toBe(0);
    } finally {
      await client.stop('test complete');
    }
  });

  it('preserves the MediaService facade in worker mode', async () => {
    const service = new WorkerMediaService(workerOptions);
    await service.onModuleInit();
    try {
      const snapshot = service.workerPoolSnapshot();
      expect(snapshot.mode).toBe('worker');
      expect(snapshot.workerCount).toBe(1);
      expect(snapshot.readyWorkers).toBe(1);
      expect(snapshot.healthyWorkers).toBe(1);
      expect(service.adaptiveTransportMetrics().consumerLayers).toEqual([]);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('returns cached-or-undefined consumer state without touching worker mappings before registration', async () => {
    const service = new WorkerMediaService(workerOptions);
    await service.onModuleInit();
    try {
      expect(service.consumerLayerState('missing-consumer')).toBeUndefined();
      expect(service.consumerQualityState('missing-consumer')).toBeUndefined();
      expect(service.producerLayerState('missing-producer')).toBeUndefined();
      expect(service.transportQualityState('missing-transport')).toBeUndefined();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('provisions worker-owned UDP pipe transports and registers pipe producers through worker IPC', async () => {
    const service = new WorkerMediaService(workerOptions);
    await service.onModuleInit();
    try {
      const snapshot = await service.ensurePipeTransport({
        pipeTransportId: 'pipe-1',
        roomId: 'room-1',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        protocol: 'udp',
        listenPort: 0,
        advertisedIp: '127.0.0.1',
        peerToken: 'worker-pipe-token'
      });
      const producer: Producer = {
        id: 'producer-1',
        roomId: 'room-1',
        participantId: 'publisher',
        kind: 'video',
        transportId: 'pipe-1',
        rtpParameters: {
          codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
          encodings: [{ ssrc: 1111 }],
          rtcp: { cname: 'worker-pipe', reducedSize: true }
        },
        status: 'live',
        createdAt: new Date().toISOString()
      };
      const consumer = {
        id: 'consumer-1',
        producerId: 'producer-1',
        participantId: 'subscriber',
        roomId: 'room-1',
        transportId: 'pipe-1',
        rtpParameters: producer.rtpParameters,
        status: 'live' as const,
        createdAt: new Date().toISOString()
      };

      await service.registerPipeProducer(producer, 'pipe-1');
      await service.registerPipeConsumer(consumer, 'pipe-1');
      service.adaptiveTransportMetrics();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const adaptiveMetrics = service.adaptiveTransportMetrics();
      expect(snapshot.localEndpoint?.advertiseIp).toBe('127.0.0.1');
      expect(snapshot.listening).toBe(true);
      expect(service.getProducer('producer-1')?.transportId).toBe('pipe-1');
      expect(adaptiveMetrics.quality.transports.map((state) => state.transportId)).toContain('pipe-1');
      expect(adaptiveMetrics.quality.rooms.map((state) => state.roomId)).toContain('room-1');
      expect((await service.pipeTransportSnapshot('pipe-1'))?.active).toBe(true);
      await service.closePipeTransport('pipe-1');
      expect(await service.pipeTransportSnapshot('pipe-1')).toBeUndefined();
      expect(service.getProducer('producer-1')).toBeUndefined();
      expect(() => (service as any).pool.workerForProducer('producer-1')).toThrow('producer producer-1 is not assigned');
      expect(() => (service as any).pool.workerForConsumer('consumer-1')).toThrow('consumer consumer-1 is not assigned');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('schedules new rooms onto the least loaded healthy worker', async () => {
    const workers = new Map<string, FakeWorkerClient>();
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 2,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 1,
      maxRoomsPerWorker: 10,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => {
        const worker = new FakeWorkerClient(workerId);
        workers.set(workerId, worker);
        return worker as unknown as MediaWorkerClient;
      }
    });
    await pool.start();
    pool.bindTransport('busy-room', 'transport-busy', 'media-worker-1');

    const selected = pool.workerForRoom('new-room');

    expect(selected.workerId).toBe('media-worker-2');
    await pool.stop();
  });

  it('rejects new room placement when all workers are saturated', async () => {
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 1,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 1,
      maxRoomsPerWorker: 1,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => new FakeWorkerClient(workerId) as unknown as MediaWorkerClient
    });
    await pool.start();
    pool.bindTransport('room-1', 'transport-1', 'media-worker-1');

    expect(() => pool.workerForRoom('room-2')).toThrow('No media worker has capacity');
    await pool.stop();
  });

  it('drains workers and excludes them from new room placement', async () => {
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 2,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 1,
      maxRoomsPerWorker: 10,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => new FakeWorkerClient(workerId) as unknown as MediaWorkerClient
    });
    await pool.start();
    pool.bindTransport('existing-room', 'existing-transport', 'media-worker-1');
    await pool.drainWorker('media-worker-1', 1000);

    const selected = pool.workerForRoom('room-after-drain');

    expect(selected.workerId).toBe('media-worker-2');
    expect(pool.snapshot().drainingWorkers).toBe(1);
    await pool.stop();
  });

  it('releases only the requested room bindings on a shared worker', async () => {
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 1,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 1,
      maxRoomsPerWorker: 10,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => new FakeWorkerClient(workerId) as unknown as MediaWorkerClient
    });
    await pool.start();
    pool.bindTransport('room-a', 'transport-a', 'media-worker-1');
    pool.bindTransport('room-b', 'transport-b', 'media-worker-1');

    pool.releaseRoom('room-a');

    expect(() => pool.workerForTransport('transport-a')).toThrow('is not assigned');
    expect(pool.workerForTransport('transport-b').workerId).toBe('media-worker-1');
    expect(pool.snapshot().activeRooms).toBe(1);
    await pool.stop();
  });

  it('marks rooms failed when a worker crashes and keeps failure details', async () => {
    const workers = new Map<string, FakeWorkerClient>();
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 1,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 1,
      maxRoomsPerWorker: 10,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => {
        const worker = new FakeWorkerClient(workerId);
        workers.set(workerId, worker);
        return worker as unknown as MediaWorkerClient;
      }
    });
    await pool.start();
    pool.bindTransport('room-crash', 'transport-crash', 'media-worker-1');
    pool.bindTransport('room-other', 'transport-other', 'media-worker-1');
    const failures = new Map<string, string[]>();
    pool.on('roomFailure', (event) => failures.set(event.roomId, event.affectedTransports ?? []));

    workers.get('media-worker-1')!.crash();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const snapshot = pool.snapshot();
    expect([...failures.keys()].sort()).toEqual(['room-crash', 'room-other']);
    expect(failures.get('room-crash')).toEqual(['transport-crash']);
    expect(failures.get('room-other')).toEqual(['transport-other']);
    expect(snapshot.failedRooms.sort()).toEqual(['room-crash', 'room-other']);
    await pool.stop();
  });

  it('clears failed room quarantine once the failure is acknowledged', async () => {
    const workers = new Map<string, FakeWorkerClient>();
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 1,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 1,
      maxRoomsPerWorker: 10,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => {
        const worker = new FakeWorkerClient(workerId);
        workers.set(workerId, worker);
        return worker as unknown as MediaWorkerClient;
      }
    });
    await pool.start();
    pool.bindTransport('room-crash', 'transport-crash', 'media-worker-1');

    workers.get('media-worker-1')!.crash();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pool.snapshot().failedRooms).toEqual(['room-crash']);

    pool.clearRoomFailure('room-crash');

    expect(pool.snapshot().failedRooms).toEqual([]);
    await pool.stop();
  });

  it('restarts a crashed worker and admits fresh rooms once replacement is ready', async () => {
    const workers = new Map<string, FakeWorkerClient>();
    const restartEvents: Array<{ workerId: string; reason: string }> = [];
    const pool = new MediaWorkerPool({
      options: workerOptions,
      workerCount: 1,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      restartBackoffMs: 5,
      maxRoomsPerWorker: 10,
      maxTransportsPerWorker: 10,
      maxInFlightRequestsPerWorker: 10,
      softIpcLatencyMs: 100,
      hardIpcLatencyMs: 1000,
      drainTimeoutMs: 1000,
      workerFactory: (workerId) => {
        const worker = new FakeWorkerClient(workerId);
        workers.set(workerId, worker);
        return worker as unknown as MediaWorkerClient;
      }
    });
    pool.on('restart', (event) => restartEvents.push(event));
    await pool.start();
    pool.bindTransport('room-crash', 'transport-crash', 'media-worker-1');

    workers.get('media-worker-1')!.crash();
    await waitFor(() => restartEvents.length > 0 && pool.snapshot().workers[0]?.restarts === 1);

    const selected = pool.workerForRoom('room-recovered');

    expect(restartEvents).toEqual([{ workerId: 'media-worker-1', reason: 'crash' }]);
    expect(selected.workerId).toBe('media-worker-1');
    expect(pool.snapshot().workers[0]?.status).toBe('ready');
    await pool.stop();
  });
});

class FakeWorkerClient extends EventEmitter {
  private draining = false;
  private restarted = 0;

  constructor(readonly workerId: string) {
    super();
  }

  async start(): Promise<void> {
    return undefined;
  }

  async stop(): Promise<void> {
    return undefined;
  }

  markDraining(draining = true): void {
    this.draining = draining;
  }

  markRestarted(): void {
    this.restarted += 1;
  }

  snapshot(): MediaWorkerHealth {
    return {
      workerId: this.workerId,
      healthy: true,
      ready: true,
      status: this.draining ? 'draining' : 'ready',
      draining: this.draining,
      startedAt: '2026-06-16T00:00:00.000Z',
      lastHeartbeatAt: new Date().toISOString(),
      restarts: this.restarted,
      crashes: 0,
      activeRooms: 0,
      activeTransports: 0,
      activeProducers: 0,
      activeConsumers: 0,
      rtpPackets: 0,
      rtcpPackets: 0,
      inflightRequests: 0,
      queueDepth: 0,
      averageIpcLatencyMs: 0,
      ipcTimeouts: 0
    };
  }

  crash(): void {
    this.emit('crash', { workerId: this.workerId, code: 1, signal: null });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for worker recovery state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
