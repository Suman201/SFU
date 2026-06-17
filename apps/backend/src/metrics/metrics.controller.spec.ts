import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('refreshes runtime snapshots before rendering Prometheus metrics', async () => {
    const workerSnapshot = {
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
    const metrics = {
      refreshClusterSnapshot: jest.fn(),
      refreshPipeSnapshot: jest.fn(),
      refreshMediaWorkerSnapshot: jest.fn(),
      markRefreshStatus: jest.fn(),
      text: jest.fn(async () => 'metrics-output')
    };
    const media = {
      workerPoolSnapshot: jest.fn(() => workerSnapshot)
    };
    const pipe = {
      snapshot: jest.fn(() => ({ activePipeTransports: 1, pipeProducers: 2, pipeConsumers: 3, rejectedRequests: 4 })),
      healthSnapshot: jest.fn(() => ({
        enabled: true,
        durable: true,
        supported: true,
        mediaWorkerMode: 'worker',
        advertiseIpConfigured: true,
        defaultProtocol: 'udp'
      }))
    };
    const clusterSnapshot = { localNode: { nodeId: 'node-a', region: 'ap-south-1', zone: 'ap-south-1a', capacity: { capacityScore: 0.4 } }, nodes: [], ownedRoomCount: 0 };
    const cluster = {
      snapshot: jest.fn(async () => clusterSnapshot)
    };
    const controller = new MetricsController(metrics as never, media as never, pipe as never, cluster as never);

    const output = await controller.prometheus();

    expect(output).toBe('metrics-output');
    expect(cluster.snapshot).toHaveBeenCalledTimes(1);
    expect(pipe.snapshot).toHaveBeenCalledTimes(1);
    expect(pipe.healthSnapshot).toHaveBeenCalledTimes(1);
    expect(media.workerPoolSnapshot).toHaveBeenCalledTimes(1);
    expect(metrics.refreshClusterSnapshot).toHaveBeenCalledWith(clusterSnapshot);
    expect(metrics.refreshPipeSnapshot).toHaveBeenCalledWith(pipe.snapshot.mock.results[0]?.value, pipe.healthSnapshot.mock.results[0]?.value);
    expect(metrics.refreshMediaWorkerSnapshot).toHaveBeenCalledWith(workerSnapshot);
    expect(metrics.markRefreshStatus).toHaveBeenCalledWith('cluster', true);
    expect(metrics.markRefreshStatus).toHaveBeenCalledWith('pipe', true);
    expect(metrics.markRefreshStatus).toHaveBeenCalledWith('media_workers', true);
  });

  it('still returns Prometheus output when a runtime refresh fails', async () => {
    const metrics = {
      refreshClusterSnapshot: jest.fn(),
      refreshPipeSnapshot: jest.fn(),
      refreshMediaWorkerSnapshot: jest.fn(),
      markRefreshStatus: jest.fn(),
      text: jest.fn(async () => 'metrics-output')
    };
    const media = {
      workerPoolSnapshot: jest.fn(() => {
        throw new Error('worker snapshot failed');
      })
    };
    const pipe = {
      snapshot: jest.fn(() => ({ activePipeTransports: 0, pipeProducers: 0, pipeConsumers: 0, rejectedRequests: 0 })),
      healthSnapshot: jest.fn(() => ({
        enabled: false,
        durable: false,
        supported: true,
        mediaWorkerMode: 'worker',
        advertiseIpConfigured: true,
        defaultProtocol: 'udp'
      }))
    };
    const cluster = {
      snapshot: jest.fn(async () => ({ localNode: { nodeId: 'node-a', region: 'ap-south-1', zone: 'ap-south-1a', capacity: { capacityScore: 0.3 } }, nodes: [], ownedRoomCount: 0 }))
    };
    const controller = new MetricsController(metrics as never, media as never, pipe as never, cluster as never);

    const output = await controller.prometheus();

    expect(output).toBe('metrics-output');
    expect(metrics.markRefreshStatus).toHaveBeenCalledWith('cluster', true);
    expect(metrics.markRefreshStatus).toHaveBeenCalledWith('pipe', true);
    expect(metrics.markRefreshStatus).toHaveBeenCalledWith('media_workers', false);
  });
});
