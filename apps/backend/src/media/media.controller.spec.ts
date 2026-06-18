import { NotFoundException } from '@nestjs/common';
import { MediaController } from './media.controller';

describe('MediaController', () => {
  it('surfaces node diagnostics with derived operational alerts', async () => {
    const controller = createController({
      clusterSnapshot: {
        localNode: {
          nodeId: 'node-a',
          health: 'draining',
          draining: true,
          capacity: { capacityScore: 0.8 }
        }
      },
      workerSnapshot: {
        mode: 'worker',
        workerCount: 2,
        readyWorkers: 1,
        healthyWorkers: 1,
        drainingWorkers: 1,
        overloadedWorkers: 1,
        activeRooms: 1,
        failedRooms: ['room-1'],
        failures: [],
        workers: []
      },
      pipeSnapshot: {
        enabled: true,
        localNodeId: 'node-a',
        activePipeTransports: 2,
        pipeProducers: 3,
        pipeConsumers: 4,
        rejectedRequests: 1
      },
      pipeHealth: {
        enabled: true,
        durable: true,
        supported: false,
        mediaWorkerMode: 'worker',
        advertiseIpConfigured: false,
        defaultProtocol: 'udp',
        reason: 'udp_advertise_ip_required'
      },
      configValues: {
        'app.nodeEnv': 'production',
        'turn.realm': 'turn.example.com',
        'turn.secret': '',
        'turn.uris': ['turn:127.0.0.1:3478?transport=udp']
      }
    });

    const diagnostics = await controller.nodeDiagnostics();

    expect(diagnostics.trafficReady).toBe(false);
    expect(diagnostics.turn).toEqual({
      requiredInProduction: true,
      realm: 'turn.example.com',
      secretConfigured: false,
      uriCount: 1,
      supportedUriCount: 1,
      localhostUriCount: 1,
      udpOnly: true
    });
    for (const alert of [
      'local_node_draining',
      'media_workers_not_ready',
      'media_worker_failed_rooms',
      'media_worker_overload',
      'pipe_runtime_unsupported',
      'pipe_requests_rejected',
      'turn_not_ready',
      'turn_localhost_uris'
    ]) {
      expect(diagnostics.alerts).toContain(alert);
    }
  });

  it('returns worker diagnostics for a specific worker', () => {
    const controller = createController({
      clusterSnapshot: {
        localNode: {
          nodeId: 'node-a',
          health: 'healthy',
          draining: false,
          capacity: { capacityScore: 0.2 }
        }
      },
      workerSnapshot: {
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
            healthy: false,
            ready: false,
            draining: true,
            overloaded: true,
            droppedRtpPackets: 3,
            lastError: 'boom'
          }
        ]
      },
      pipeSnapshot: {
        enabled: false,
        localNodeId: 'node-a',
        activePipeTransports: 0,
        pipeProducers: 0,
        pipeConsumers: 0,
        rejectedRequests: 0
      },
      pipeHealth: {
        enabled: false,
        durable: false,
        supported: true,
        mediaWorkerMode: 'worker',
        advertiseIpConfigured: true,
        defaultProtocol: 'udp'
      },
      configValues: {
        'app.nodeEnv': 'development',
        'turn.realm': 'native-sfu.local',
        'turn.secret': 'turn-secret-valid-length-32',
        'turn.uris': ['turn:sfu.example.com:3478?transport=udp']
      }
    });

    const diagnostics = controller.workerDiagnostics('worker-1');

    expect(diagnostics.worker.workerId).toBe('worker-1');
    for (const alert of [
      'worker_not_ready',
      'worker_unhealthy',
      'worker_draining',
      'worker_overloaded',
      'worker_rtp_drops',
      'worker_last_error_present'
    ]) {
      expect(diagnostics.alerts).toContain(alert);
    }
  });

  it('fails worker diagnostics lookups for unknown workers', () => {
    const controller = createController({
      clusterSnapshot: {
        localNode: {
          nodeId: 'node-a',
          health: 'healthy',
          draining: false,
          capacity: { capacityScore: 0.2 }
        }
      },
      workerSnapshot: {
        mode: 'worker',
        workerCount: 0,
        readyWorkers: 0,
        healthyWorkers: 0,
        drainingWorkers: 0,
        overloadedWorkers: 0,
        activeRooms: 0,
        failedRooms: [],
        failures: [],
        workers: []
      },
      pipeSnapshot: {
        enabled: false,
        localNodeId: 'node-a',
        activePipeTransports: 0,
        pipeProducers: 0,
        pipeConsumers: 0,
        rejectedRequests: 0
      },
      pipeHealth: {
        enabled: false,
        durable: false,
        supported: true,
        mediaWorkerMode: 'worker',
        advertiseIpConfigured: true,
        defaultProtocol: 'udp'
      },
      configValues: {
        'app.nodeEnv': 'development',
        'turn.realm': 'native-sfu.local',
        'turn.secret': 'turn-secret-valid-length-32',
        'turn.uris': ['turn:sfu.example.com:3478?transport=udp']
      }
    });

    expect(() => controller.workerDiagnostics('missing-worker')).toThrow(NotFoundException);
  });
});

function createController(options: {
  clusterSnapshot: any;
  workerSnapshot: any;
  pipeSnapshot: any;
  pipeHealth: any;
  configValues: Record<string, unknown>;
}) {
  return new MediaController(
    { createTurnCredentials: jest.fn() } as never,
    {
      workerPoolSnapshot: jest.fn(() => options.workerSnapshot)
    } as never,
    {
      snapshot: jest.fn(async () => options.clusterSnapshot)
    } as never,
    {
      snapshot: jest.fn(() => options.pipeSnapshot),
      healthSnapshot: jest.fn(() => options.pipeHealth)
    } as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => options.configValues[key] ?? fallback)
    } as never
  );
}
