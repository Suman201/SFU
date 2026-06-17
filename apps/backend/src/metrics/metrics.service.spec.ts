import client from 'prom-client';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  beforeEach(() => {
    client.register.clear();
  });

  afterEach(() => {
    client.register.clear();
  });

  it('removes stale worker metrics and dropped-reason labels between refreshes', async () => {
    const service = new MetricsService();
    service.onModuleInit();

    service.refreshMediaWorkerSnapshot({
      mode: 'worker',
      workerCount: 1,
      readyWorkers: 1,
      healthyWorkers: 1,
      drainingWorkers: 0,
      overloadedWorkers: 0,
      activeRooms: 1,
      failedRooms: [],
      failures: [],
      workers: [
        {
          workerId: 'worker-1',
          healthy: true,
          ready: true,
          status: 'ready',
          draining: false,
          overloaded: false,
          startedAt: '2026-06-17T00:00:00.000Z',
          lastHeartbeatAt: new Date().toISOString(),
          restarts: 0,
          crashes: 0,
          activeRooms: 1,
          activeTransports: 1,
          activeProducers: 1,
          activeConsumers: 1,
          rtpPackets: 12,
          rtcpPackets: 3,
          inflightRequests: 0,
          queueDepth: 0,
          averageIpcLatencyMs: 1,
          ipcTimeouts: 0,
          droppedRtpPackets: 2,
          droppedRtpReasons: { queue_full: 2 }
        }
      ]
    } as any);

    let output = await service.text();
    expect(output).toContain('workerId="worker-1"');
    expect(output).toContain('reason="queue_full"');

    service.refreshMediaWorkerSnapshot({
      mode: 'worker',
      workerCount: 1,
      readyWorkers: 1,
      healthyWorkers: 1,
      drainingWorkers: 0,
      overloadedWorkers: 0,
      activeRooms: 0,
      failedRooms: [],
      failures: [],
      workers: [
        {
          workerId: 'worker-2',
          healthy: true,
          ready: true,
          status: 'ready',
          draining: false,
          overloaded: false,
          startedAt: '2026-06-17T00:00:00.000Z',
          lastHeartbeatAt: new Date().toISOString(),
          restarts: 0,
          crashes: 0,
          activeRooms: 0,
          activeTransports: 0,
          activeProducers: 0,
          activeConsumers: 0,
          rtpPackets: 0,
          rtcpPackets: 0,
          inflightRequests: 0,
          queueDepth: 0,
          averageIpcLatencyMs: 1,
          ipcTimeouts: 0,
          droppedRtpPackets: 0,
          droppedRtpReasons: {}
        }
      ]
    } as any);

    output = await service.text();
    expect(output).not.toContain('workerId="worker-1"');
    expect(output).not.toContain('reason="queue_full"');
    expect(output).toContain('workerId="worker-2"');
  });

  it('removes stale pipe transport metric series after teardown', async () => {
    const service = new MetricsService();
    service.onModuleInit();

    service.refreshPipeTransportMetrics([{ id: 'pipe-1', rtpPackets: 20, droppedPackets: 4 }]);
    service.updatePipeTransportMetrics('pipe-1', { packetLoss: 0.2, jitterMs: 11, rttMs: 18 });

    let output = await service.text();
    expect(output).toContain('pipeTransportId="pipe-1"');

    service.refreshPipeTransportMetrics([{ id: 'pipe-2', rtpPackets: 5, droppedPackets: 0 }]);

    output = await service.text();
    expect(output).not.toContain('pipeTransportId="pipe-1"');
    expect(output).toContain('pipeTransportId="pipe-2"');

    service.updatePipeTransportMetrics('pipe-2', { packetLoss: 0, jitterMs: 2, rttMs: 4 });
    service.clearPipeTransportMetrics('pipe-2');

    output = await service.text();
    expect(output).not.toContain('pipeTransportId="pipe-2"');
  });
});
