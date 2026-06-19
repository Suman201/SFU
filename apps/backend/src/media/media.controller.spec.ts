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
        'app.publicUrl': 'https://sfu.example.com',
        'cluster.publicUrl': 'https://node-a.sfu.example.com',
        'pipe.advertiseIp': '127.0.0.1',
        'mediaWorker.ice.announcedAddress': '127.0.0.1',
        'mediaWorker.ice.stunServers': ['stun:127.0.0.1:3478', 'stuns:stun.example.com:5349'],
        'mediaWorker.ice.turnServers': [
          { url: 'turn:127.0.0.1:3478?transport=udp' },
          { url: 'turns:turn.example.com:5349?transport=tcp' }
        ],
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
    expect(diagnostics.ice).toEqual({
      announcedAddress: '127.0.0.1',
      announcedAddressIsLocalOrWildcard: true,
      hostCandidateMode: 'announced-address',
      stunServerCount: 2,
      supportedStunServerCount: 1,
      stunServerHosts: ['127.0.0.1', 'stun.example.com'],
      turnServerCount: 2,
      supportedTurnServerCount: 1,
      turnServerHosts: ['127.0.0.1', 'turn.example.com'],
      usesSharedSecretTurnCredentials: true
    });
    expect(diagnostics.addressing).toEqual({
      publicUrl: 'https://sfu.example.com',
      publicUrlHost: 'sfu.example.com',
      publicUrlIsLocalOrWildcard: false,
      nodePublicUrl: 'https://node-a.sfu.example.com',
      nodePublicUrlHost: 'node-a.sfu.example.com',
      nodePublicUrlIsLocalOrWildcard: false,
      pipeAdvertiseIp: '127.0.0.1',
      pipeAdvertiseIpIsLocalOrWildcard: true,
      turnUriHosts: ['127.0.0.1']
    });
    for (const alert of [
      'local_node_draining',
      'media_workers_not_ready',
      'media_worker_failed_rooms',
      'media_worker_overload',
      'pipe_runtime_unsupported',
      'pipe_requests_rejected',
      'turn_not_ready',
      'turn_localhost_uris',
      'ice_announced_address_localhost',
      'ice_unsupported_transport',
      'ice_localhost_servers'
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
        'app.publicUrl': 'http://localhost:3000',
        'cluster.publicUrl': 'http://localhost:3000',
        'pipe.advertiseIp': '127.0.0.1',
        'mediaWorker.ice.announcedAddress': undefined,
        'mediaWorker.ice.stunServers': [],
        'mediaWorker.ice.turnServers': [],
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
        'app.publicUrl': 'http://localhost:3000',
        'cluster.publicUrl': 'http://localhost:3000',
        'pipe.advertiseIp': '127.0.0.1',
        'mediaWorker.ice.announcedAddress': undefined,
        'mediaWorker.ice.stunServers': [],
        'mediaWorker.ice.turnServers': [],
        'turn.realm': 'native-sfu.local',
        'turn.secret': 'turn-secret-valid-length-32',
        'turn.uris': ['turn:sfu.example.com:3478?transport=udp']
      }
    });

    expect(() => controller.workerDiagnostics('missing-worker')).toThrow(NotFoundException);
  });

  it('delegates room incident snapshot exports to the rooms service', async () => {
    const snapshot = { scope: 'room', roomId: 'room-1' } as any;
    const controller = createController({
      clusterSnapshot: { localNode: { nodeId: 'node-a', health: 'healthy', draining: false, capacity: { capacityScore: 0 } } },
      workerSnapshot: { mode: 'worker', workerCount: 0, readyWorkers: 0, healthyWorkers: 0, drainingWorkers: 0, overloadedWorkers: 0, activeRooms: 0, failedRooms: [], failures: [], workers: [] },
      pipeSnapshot: { enabled: false, localNodeId: 'node-a', activePipeTransports: 0, pipeProducers: 0, pipeConsumers: 0, rejectedRequests: 0 },
      pipeHealth: { enabled: false, durable: false, supported: true, mediaWorkerMode: 'worker', advertiseIpConfigured: true, defaultProtocol: 'udp' },
      configValues: {},
      roomExports: {
        exportRoomIncidentSnapshot: jest.fn(async () => snapshot)
      }
    });

    const result = await controller.roomIncidentSnapshot('room-1');
    expect(result).toBe(snapshot);
  });

  it('delegates room incident workflow diagnostics to the rooms service', async () => {
    const state = { roomId: 'room-1', status: 'critical' } as any;
    const timeline = { roomId: 'room-1', events: [] } as any;
    const history = { roomId: 'room-1', bundles: [] } as any;
    const bundle = { bundleId: 'bundle-1', roomId: 'room-1' } as any;
    const controller = createController({
      clusterSnapshot: { localNode: { nodeId: 'node-a', health: 'healthy', draining: false, capacity: { capacityScore: 0 } } },
      workerSnapshot: { mode: 'worker', workerCount: 0, readyWorkers: 0, healthyWorkers: 0, drainingWorkers: 0, overloadedWorkers: 0, activeRooms: 0, failedRooms: [], failures: [], workers: [] },
      pipeSnapshot: { enabled: false, localNodeId: 'node-a', activePipeTransports: 0, pipeProducers: 0, pipeConsumers: 0, rejectedRequests: 0 },
      pipeHealth: { enabled: false, durable: false, supported: true, mediaWorkerMode: 'worker', advertiseIpConfigured: true, defaultProtocol: 'udp' },
      configValues: {},
      roomExports: {
        getRoomIncidentStateForOperations: jest.fn(async () => state),
        getRoomIncidentTimelineForOperations: jest.fn(async () => timeline),
        getRoomSnapshotHistoryForOperations: jest.fn(async () => history),
        getRoomSnapshotBundle: jest.fn(async () => bundle),
        generateRoomSnapshotBundleForOperations: jest.fn(async () => bundle),
        injectRoomFailureForOperations: jest.fn(async () => undefined)
      },
      platformEvents: {
        appendEvent: jest.fn(async () => ({ id: 'event-1' }))
      }
    });

    expect(await controller.roomIncidentState('room-1')).toBe(state);
    expect(await controller.roomIncidentTimeline('room-1')).toBe(timeline);
    expect(await controller.roomSnapshotHistory('room-1')).toBe(history);
    expect(await controller.roomSnapshotBundle('bundle-1')).toBe(bundle);
    expect(await controller.generateRoomIncidentSnapshot('room-1', { reason: 'manual proof' })).toBe(bundle);
    expect(await controller.injectRoomFailure('room-1', { workerId: 'worker-1' })).toEqual({ ok: true });
  });

  it('records operator action events for worker and node drain operations', async () => {
    const platformEvents = {
      appendEvent: jest.fn(async () => ({ id: 'event-1' }))
    };
    const controller = createController({
      clusterSnapshot: { localNode: { nodeId: 'node-a', health: 'healthy', draining: false, capacity: { capacityScore: 0 } } },
      workerSnapshot: { mode: 'worker', workerCount: 0, readyWorkers: 0, healthyWorkers: 0, drainingWorkers: 0, overloadedWorkers: 0, activeRooms: 0, failedRooms: [], failures: [], workers: [] },
      pipeSnapshot: { enabled: false, localNodeId: 'node-a', activePipeTransports: 0, pipeProducers: 0, pipeConsumers: 0, rejectedRequests: 0 },
      pipeHealth: { enabled: false, durable: false, supported: true, mediaWorkerMode: 'worker', advertiseIpConfigured: true, defaultProtocol: 'udp' },
      configValues: {},
      workerPoolExports: {
        drainMediaWorker: jest.fn(async () => ({ workerCount: 0 }))
      },
      clusterExports: {
        beginDraining: jest.fn(async () => ({ nodeId: 'node-a', draining: true })),
        endDraining: jest.fn(async () => ({ nodeId: 'node-a', draining: false }))
      },
      platformEvents
    });

    await controller.drainWorker('worker-1', { forceAfterMs: 1000 });
    await controller.drainNode({ reason: 'maintenance' });
    await controller.undrainNode();

    expect(platformEvents.appendEvent).toHaveBeenCalledTimes(3);
  });

  it('delegates transport incident snapshot exports to the rooms service', async () => {
    const snapshot = { scope: 'transport', transportId: 'transport-1' } as any;
    const controller = createController({
      clusterSnapshot: { localNode: { nodeId: 'node-a', health: 'healthy', draining: false, capacity: { capacityScore: 0 } } },
      workerSnapshot: { mode: 'worker', workerCount: 0, readyWorkers: 0, healthyWorkers: 0, drainingWorkers: 0, overloadedWorkers: 0, activeRooms: 0, failedRooms: [], failures: [], workers: [] },
      pipeSnapshot: { enabled: false, localNodeId: 'node-a', activePipeTransports: 0, pipeProducers: 0, pipeConsumers: 0, rejectedRequests: 0 },
      pipeHealth: { enabled: false, durable: false, supported: true, mediaWorkerMode: 'worker', advertiseIpConfigured: true, defaultProtocol: 'udp' },
      configValues: {},
      roomExports: {
        exportTransportIncidentSnapshot: jest.fn(async () => snapshot)
      }
    });

    const result = await controller.transportIncidentSnapshot('transport-1');
    expect(result).toBe(snapshot);
  });
});

function createController(options: {
  clusterSnapshot: any;
  workerSnapshot: any;
  pipeSnapshot: any;
  pipeHealth: any;
  configValues: Record<string, unknown>;
  roomExports?: {
    exportRoomIncidentSnapshot?: jest.Mock;
    getRoomIncidentStateForOperations?: jest.Mock;
    getRoomIncidentTimelineForOperations?: jest.Mock;
    getRoomSnapshotHistoryForOperations?: jest.Mock;
    getRoomSnapshotBundle?: jest.Mock;
    generateRoomSnapshotBundleForOperations?: jest.Mock;
    injectRoomFailureForOperations?: jest.Mock;
    exportTransportIncidentSnapshot?: jest.Mock;
  };
  workerPoolExports?: {
    drainMediaWorker?: jest.Mock;
  };
  clusterExports?: {
    beginDraining?: jest.Mock;
    endDraining?: jest.Mock;
  };
  platformEvents?: {
    appendEvent?: jest.Mock;
  };
}) {
  return new MediaController(
    { createTurnCredentials: jest.fn() } as never,
    {
      workerPoolSnapshot: jest.fn(() => options.workerSnapshot),
      drainMediaWorker: options.workerPoolExports?.drainMediaWorker ?? jest.fn(async () => options.workerSnapshot)
    } as never,
    {
      snapshot: jest.fn(async () => options.clusterSnapshot),
      beginDraining: options.clusterExports?.beginDraining ?? jest.fn(async () => options.clusterSnapshot.localNode),
      endDraining: options.clusterExports?.endDraining ?? jest.fn(async () => options.clusterSnapshot.localNode)
    } as never,
    {
      snapshot: jest.fn(() => options.pipeSnapshot),
      healthSnapshot: jest.fn(() => options.pipeHealth)
    } as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => options.configValues[key] ?? fallback)
    } as never,
    {
      exportRoomIncidentSnapshot: options.roomExports?.exportRoomIncidentSnapshot ?? jest.fn(),
      getRoomIncidentStateForOperations: options.roomExports?.getRoomIncidentStateForOperations ?? jest.fn(),
      getRoomIncidentTimelineForOperations: options.roomExports?.getRoomIncidentTimelineForOperations ?? jest.fn(),
      getRoomSnapshotHistoryForOperations: options.roomExports?.getRoomSnapshotHistoryForOperations ?? jest.fn(),
      getRoomSnapshotBundle: options.roomExports?.getRoomSnapshotBundle ?? jest.fn(),
      generateRoomSnapshotBundleForOperations: options.roomExports?.generateRoomSnapshotBundleForOperations ?? jest.fn(),
      injectRoomFailureForOperations: options.roomExports?.injectRoomFailureForOperations ?? jest.fn(),
      exportTransportIncidentSnapshot: options.roomExports?.exportTransportIncidentSnapshot ?? jest.fn()
    } as never,
    {
      appendEvent: options.platformEvents?.appendEvent ?? jest.fn(async () => ({ id: 'platform-event-1' }))
    } as never
  );
}
