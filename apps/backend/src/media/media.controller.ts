import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ClusterNodeInfo } from '@native-sfu/contracts';
import { IceService, MediaService, type MediaWorkerPoolSnapshot, TurnCredentials } from '@native-sfu/nest-sfu';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { PipeCoordinatorService, type PipeCoordinatorHealthSnapshot, type PipeCoordinatorSnapshot } from '../cluster/pipe-coordinator.service';

interface MediaNodeDiagnostics {
  observedAt: string;
  localNodeId: string;
  trafficReady: boolean;
  alerts: string[];
  cluster: Awaited<ReturnType<NodeRegistryService['snapshot']>>;
  workers: MediaWorkerPoolSnapshot;
  pipe: {
    summary: PipeCoordinatorSnapshot;
    health: PipeCoordinatorHealthSnapshot;
  };
}

interface MediaWorkerDiagnostics {
  observedAt: string;
  mode: MediaWorkerPoolSnapshot['mode'];
  worker: MediaWorkerPoolSnapshot['workers'][number];
  alerts: string[];
}

interface PipeRuntimeDiagnostics {
  observedAt: string;
  summary: PipeCoordinatorSnapshot;
  health: PipeCoordinatorHealthSnapshot;
  alerts: string[];
}

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'media', version: '1' })
export class MediaController {
  constructor(
    private readonly ice: IceService,
    private readonly media: MediaService,
    private readonly cluster: NodeRegistryService,
    private readonly pipeCoordinator: PipeCoordinatorService
  ) {}

  @Get('turn-credentials')
  turnCredentials(@CurrentUser() user: AuthenticatedUser): TurnCredentials {
    return this.ice.createTurnCredentials(user.sub);
  }

  @Get('transport-capabilities')
  capabilities(): {
    dtlsSrtpReady: boolean;
    rtcpReady: boolean;
    mediaBridgeReady: boolean;
    retransmissionReady: boolean;
    keyframeRequestAggregationReady: boolean;
    forwardingCorrectnessReady: boolean;
    adaptiveTransportReady: boolean;
    layerReportingReady: boolean;
    dynacastReady: boolean;
    qualityScoringReady: boolean;
    iceProductionReady: boolean;
    sdpInteropReady: boolean;
    reason: string;
  } {
    return {
      dtlsSrtpReady: true,
      rtcpReady: true,
      mediaBridgeReady: true,
      retransmissionReady: true,
      keyframeRequestAggregationReady: true,
      forwardingCorrectnessReady: true,
      adaptiveTransportReady: true,
      layerReportingReady: true,
      dynacastReady: true,
      qualityScoringReady: true,
      iceProductionReady: true,
      sdpInteropReady: true,
      reason: 'ICE host/srflx/TURN candidates, DTLS, SRTP/SRTCP, RTP validation/reordering/rewriting, RTCP routing, NACK retransmission, PLI/FIR aggregation, RTP header-extension negotiation, TWCC, bandwidth estimation, pacing, keyframe-gated joins, first-class consumer layer reporting, Dynacast producer layer demand signaling, production scoring, priority allocation, adaptive quality snapshots, SDP interoperability helpers, and the live media packet bridge are available for browser publisher-to-subscriber media flow.'
    };
  }

  @Get('statistics')
  statistics(): ReturnType<MediaService['adaptiveTransportMetrics']> {
    return this.media.adaptiveTransportMetrics();
  }

  @Get('workers')
  workers(): MediaWorkerPoolSnapshot {
    return this.media.workerPoolSnapshot();
  }

  @Get('pipe')
  pipe(): PipeCoordinatorSnapshot {
    return this.pipeCoordinator.snapshot();
  }

  @Get('diagnostics/node')
  async nodeDiagnostics(): Promise<MediaNodeDiagnostics> {
    const [cluster, workers] = await Promise.all([this.cluster.snapshot(), Promise.resolve(this.media.workerPoolSnapshot())]);
    const pipeSummary = this.pipeCoordinator.snapshot();
    const pipeHealth = this.pipeCoordinator.healthSnapshot();
    return {
      observedAt: new Date().toISOString(),
      localNodeId: cluster.localNode.nodeId,
      trafficReady: cluster.localNode.health === 'healthy' && !cluster.localNode.draining && cluster.localNode.capacity.capacityScore < 1,
      alerts: collectNodeAlerts(cluster, workers, pipeSummary, pipeHealth),
      cluster,
      workers,
      pipe: {
        summary: pipeSummary,
        health: pipeHealth
      }
    };
  }

  @Get('diagnostics/workers/:workerId')
  workerDiagnostics(@Param('workerId') workerId: string): MediaWorkerDiagnostics {
    const snapshot = this.media.workerPoolSnapshot();
    const worker = snapshot.workers.find((entry) => entry.workerId === workerId);
    if (!worker) {
      throw new NotFoundException('Media worker not found');
    }
    return {
      observedAt: new Date().toISOString(),
      mode: snapshot.mode,
      worker,
      alerts: collectWorkerAlerts(worker)
    };
  }

  @Get('diagnostics/pipe')
  pipeDiagnostics(): PipeRuntimeDiagnostics {
    const summary = this.pipeCoordinator.snapshot();
    const health = this.pipeCoordinator.healthSnapshot();
    return {
      observedAt: new Date().toISOString(),
      summary,
      health,
      alerts: collectPipeAlerts(summary, health)
    };
  }

  @Post('workers/:workerId/drain')
  drainWorker(@Param('workerId') workerId: string, @Body() body: { forceAfterMs?: number }): Promise<MediaWorkerPoolSnapshot> {
    return this.media.drainMediaWorker(workerId, body?.forceAfterMs);
  }

  @Post('node/drain')
  drainNode(@Body() body: { reason?: string }): Promise<ClusterNodeInfo> {
    return this.cluster.beginDraining(body?.reason ?? 'api');
  }

  @Post('node/undrain')
  undrainNode(): Promise<ClusterNodeInfo> {
    return this.cluster.endDraining();
  }
}

function collectNodeAlerts(
  cluster: Awaited<ReturnType<NodeRegistryService['snapshot']>>,
  workers: MediaWorkerPoolSnapshot,
  pipeSummary: PipeCoordinatorSnapshot,
  pipeHealth: PipeCoordinatorHealthSnapshot
): string[] {
  const alerts = new Set<string>();
  if (cluster.localNode.draining) {
    alerts.add('local_node_draining');
  }
  if (cluster.localNode.health !== 'healthy') {
    alerts.add(`local_node_${cluster.localNode.health}`);
  }
  if (workers.mode === 'worker' && workers.readyWorkers < workers.workerCount) {
    alerts.add('media_workers_not_ready');
  }
  if (workers.failedRooms.length > 0) {
    alerts.add('media_worker_failed_rooms');
  }
  if (workers.overloadedWorkers > 0) {
    alerts.add('media_worker_overload');
  }
  if (pipeHealth.enabled && !pipeHealth.supported) {
    alerts.add('pipe_runtime_unsupported');
  }
  if (pipeSummary.rejectedRequests > 0) {
    alerts.add('pipe_requests_rejected');
  }
  return [...alerts];
}

function collectWorkerAlerts(worker: MediaWorkerPoolSnapshot['workers'][number]): string[] {
  const alerts = new Set<string>();
  if (!worker.ready) {
    alerts.add('worker_not_ready');
  }
  if (!worker.healthy) {
    alerts.add('worker_unhealthy');
  }
  if (worker.draining) {
    alerts.add('worker_draining');
  }
  if (worker.overloaded) {
    alerts.add('worker_overloaded');
  }
  if ((worker.droppedRtpPackets ?? 0) > 0) {
    alerts.add('worker_rtp_drops');
  }
  if (worker.lastError) {
    alerts.add('worker_last_error_present');
  }
  return [...alerts];
}

function collectPipeAlerts(summary: PipeCoordinatorSnapshot, health: PipeCoordinatorHealthSnapshot): string[] {
  const alerts = new Set<string>();
  if (health.enabled && !health.supported) {
    alerts.add('pipe_runtime_unsupported');
  }
  if (summary.rejectedRequests > 0) {
    alerts.add('pipe_requests_rejected');
  }
  if (health.reason) {
    alerts.add(health.reason);
  }
  return [...alerts];
}
