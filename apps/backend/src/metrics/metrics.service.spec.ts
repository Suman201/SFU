import type { RoomMediaProfileId, RoomQualitySummaryState } from '@native-sfu/contracts';
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

  it('tracks room autopilot summary gauges and clears prior state on update', async () => {
    const service = new MetricsService();
    service.onModuleInit();

    const previous = summaryFixture({ profile: { id: 'meeting' }, health: 'degraded', recommendations: [{ code: 'throttle_new_joins', severity: 'warn' }] });
    const next = summaryFixture({ profile: { id: 'webinar' }, health: 'critical', recommendations: [{ code: 'restrict_new_publishers', severity: 'critical' }] });

    service.updateRoomAutopilotSummary(previous);
    service.updateRoomAutopilotSummary(next, previous);

    let output = await service.text();
    expect(output).toContain('profile="webinar",health="critical"');
    expect(output).toContain('profile="webinar",scope="publish",action="reject"');
    expect(output).toContain('profile="webinar",code="restrict_new_publishers",severity="critical"');

    service.clearRoomAutopilotSummary(next);

    output = await service.text();
    expect(output).toContain('profile="webinar",health="critical"');
  });
});

function summaryFixture(overrides: {
  profile?: { id: RoomMediaProfileId };
  health?: 'stable' | 'degraded' | 'critical';
  recommendations?: Array<{ code: string; severity: 'info' | 'warn' | 'critical' }>;
} = {}): RoomQualitySummaryState {
  const profileId = overrides.profile?.id ?? 'meeting';
  return {
    roomId: 'room-1',
    health: overrides.health ?? 'stable',
    profile: {
      id: profileId,
      label: profileId,
      description: profileId,
      policy: {
        consumerPriorityWeights: { audio: 1, video: 1, screen: 1 },
        producerPriorityWeights: { audio: 1, video: 1, screen: 1 },
        bitrateFloorBps: {},
        bitrateCeilingBps: {},
        defaultLayerPreferences: {},
        screenSharePreference: 'balanced',
        congestionResponse: 'balanced',
        dynacastEnabled: true,
        admissionProtection: {
          join: { stable: 'allow', degraded: 'warn', critical: 'reject' },
          publish: { stable: 'allow', degraded: 'soft-throttle', critical: 'reject' },
          screenShare: { stable: 'allow', degraded: 'warn', critical: 'reject' }
        }
      }
    },
    qualitySource: 'local-owner',
    ownerAuthoritativeQuality: true,
    score: {
      score: 80,
      level: 'good',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 80,
        rttScore: 80,
        jitterScore: 80,
        congestionScore: 80,
        retransmissionScore: 80,
        allocationScore: 80
      },
      updatedAt: '2026-06-19T00:00:00.000Z'
    },
    congestionState: 'normal',
    bitrate: {
      target: 1_000_000,
      allocated: 900_000,
      actual: 850_000,
      maxAvailable: 1_100_000,
      avgAvailable: 1_000_000,
      maxRecommended: 950_000,
      avgRecommended: 900_000
    },
    participantCount: 3,
    admittedParticipantCount: 3,
    pendingParticipantCount: 0,
    activeProducerCount: 2,
    activeScreenShareCount: 0,
    degradedConsumers: overrides.health === 'stable' ? 0 : 1,
    degradedProducers: 0,
    degradedTransports: 0,
    degradedEntityIds: {
      consumers: [],
      producers: [],
      transports: []
    },
    protections: {
      join: {
        scope: 'join',
        health: overrides.health ?? 'stable',
        action: overrides.health === 'critical' ? 'reject' : overrides.health === 'degraded' ? 'warn' : 'allow',
        code: overrides.health === 'critical' ? 'node_overloaded' : overrides.health === 'degraded' ? 'room_degraded' : 'stable',
        message: 'join',
        triggeredBy: ['room'],
        updatedAt: '2026-06-19T00:00:00.000Z'
      },
      publish: {
        scope: 'publish',
        health: overrides.health ?? 'stable',
        action: overrides.health === 'critical' ? 'reject' : overrides.health === 'degraded' ? 'soft-throttle' : 'allow',
        code: overrides.health === 'critical' ? 'publisher_protected' : overrides.health === 'degraded' ? 'room_degraded' : 'stable',
        message: 'publish',
        triggeredBy: ['room'],
        updatedAt: '2026-06-19T00:00:00.000Z'
      },
      screenShare: {
        scope: 'screen-share',
        health: overrides.health ?? 'stable',
        action: overrides.health === 'critical' ? 'reject' : overrides.health === 'degraded' ? 'warn' : 'allow',
        code: overrides.health === 'critical' ? 'screen_share_protected' : overrides.health === 'degraded' ? 'room_degraded' : 'stable',
        message: 'screen',
        triggeredBy: ['room'],
        updatedAt: '2026-06-19T00:00:00.000Z'
      }
    },
    recommendations: (overrides.recommendations ?? []).map((recommendation) => ({
      ...recommendation,
      title: recommendation.code,
      detail: recommendation.code
    })),
    warnings: [],
    updatedAt: '2026-06-19T00:00:00.000Z'
  } as RoomQualitySummaryState;
}
