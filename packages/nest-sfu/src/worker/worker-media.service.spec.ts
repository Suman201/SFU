import { EventEmitter } from 'events';
import type { Producer } from '@native-sfu/contracts';
import { PipeTransportManager } from '@native-sfu/sfu-core';
import { MediaWorkerClient } from './media-worker-client';
import { MediaWorkerPool } from './media-worker-pool';
import { PipeTransportService } from '../pipe-transport.service';
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

  it('registers pipe producers through worker IPC when a parent pipe transport exists', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    pipe.createTransport({ id: 'pipe-1', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const service = new WorkerMediaService(workerOptions, pipe);
    await service.onModuleInit();
    try {
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

      await service.registerPipeProducer(producer, 'pipe-1');
      expect(service.getProducer('producer-1')?.transportId).toBe('pipe-1');
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
