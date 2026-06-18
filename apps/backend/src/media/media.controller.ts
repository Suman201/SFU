import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ClusterNodeInfo } from '@native-sfu/contracts';
import { IceService, MediaService, type MediaWorkerPoolSnapshot, TurnCredentials } from '@native-sfu/nest-sfu';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { PipeCoordinatorService, type PipeCoordinatorHealthSnapshot, type PipeCoordinatorSnapshot } from '../cluster/pipe-coordinator.service';

interface MediaNodeDiagnostics {
  observedAt: string;
  localNodeId: string;
  trafficReady: boolean;
  alerts: string[];
  turn: TurnRuntimeDiagnostics;
  cluster: Awaited<ReturnType<NodeRegistryService['snapshot']>>;
  workers: MediaWorkerPoolSnapshot;
  pipe: {
    summary: PipeCoordinatorSnapshot;
    health: PipeCoordinatorHealthSnapshot;
  };
}

interface TurnRuntimeDiagnostics {
  requiredInProduction: boolean;
  realm: string;
  secretConfigured: boolean;
  uriCount: number;
  supportedUriCount: number;
  localhostUriCount: number;
  udpOnly: boolean;
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
@Controller({ path: 'media', version: '1' })
export class MediaController {
  constructor(
    private readonly ice: IceService,
    private readonly media: MediaService,
    private readonly cluster: NodeRegistryService,
    private readonly pipeCoordinator: PipeCoordinatorService,
    private readonly config: ConfigService
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('turn-credentials')
  turnCredentials(@CurrentUser() user: AuthenticatedUser): TurnCredentials {
    return this.ice.createTurnCredentials(user.sub);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
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
      reason:
        'ICE host candidates, browser TURN credential generation, DTLS, SRTP/SRTCP, RTP validation/reordering/rewriting, RTCP routing, NACK retransmission, PLI/FIR aggregation, RTP header-extension negotiation, TWCC, bandwidth estimation, pacing, keyframe-gated joins, first-class consumer layer reporting, Dynacast producer layer demand signaling, production scoring, priority allocation, adaptive quality snapshots, SDP interoperability helpers, and the live media packet bridge are available for browser publisher-to-subscriber media flow. Optional STUN server-reflexive and TURN relay gathering exist in the transport module when explicitly configured.'
    };
  }

  @UseGuards(OperationsTokenGuard)
  @Get('statistics')
  statistics(): ReturnType<MediaService['adaptiveTransportMetrics']> {
    return this.media.adaptiveTransportMetrics();
  }

  @UseGuards(OperationsTokenGuard)
  @Get('workers')
  workers(): MediaWorkerPoolSnapshot {
    return this.media.workerPoolSnapshot();
  }

  @UseGuards(OperationsTokenGuard)
  @Get('pipe')
  pipe(): PipeCoordinatorSnapshot {
    return this.pipeCoordinator.snapshot();
  }

  @UseGuards(OperationsTokenGuard)
  @Get('diagnostics/node')
  async nodeDiagnostics(): Promise<MediaNodeDiagnostics> {
    const [cluster, workers] = await Promise.all([this.cluster.snapshot(), Promise.resolve(this.media.workerPoolSnapshot())]);
    const pipeSummary = this.pipeCoordinator.snapshot();
    const pipeHealth = this.pipeCoordinator.healthSnapshot();
    const turn = buildTurnDiagnostics(this.config);
    return {
      observedAt: new Date().toISOString(),
      localNodeId: cluster.localNode.nodeId,
      trafficReady: cluster.localNode.health === 'healthy' && !cluster.localNode.draining && cluster.localNode.capacity.capacityScore < 1,
      alerts: collectNodeAlerts(cluster, workers, pipeSummary, pipeHealth, turn),
      turn,
      cluster,
      workers,
      pipe: {
        summary: pipeSummary,
        health: pipeHealth
      }
    };
  }

  @UseGuards(OperationsTokenGuard)
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

  @UseGuards(OperationsTokenGuard)
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

  @UseGuards(OperationsTokenGuard)
  @Post('workers/:workerId/drain')
  drainWorker(@Param('workerId') workerId: string, @Body() body: { forceAfterMs?: number }): Promise<MediaWorkerPoolSnapshot> {
    return this.media.drainMediaWorker(workerId, body?.forceAfterMs);
  }

  @UseGuards(OperationsTokenGuard)
  @Post('node/drain')
  drainNode(@Body() body: { reason?: string }): Promise<ClusterNodeInfo> {
    return this.cluster.beginDraining(body?.reason ?? 'api');
  }

  @UseGuards(OperationsTokenGuard)
  @Post('node/undrain')
  undrainNode(): Promise<ClusterNodeInfo> {
    return this.cluster.endDraining();
  }
}

function collectNodeAlerts(
  cluster: Awaited<ReturnType<NodeRegistryService['snapshot']>>,
  workers: MediaWorkerPoolSnapshot,
  pipeSummary: PipeCoordinatorSnapshot,
  pipeHealth: PipeCoordinatorHealthSnapshot,
  turn: TurnRuntimeDiagnostics
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
  if (turn.requiredInProduction && (!turn.secretConfigured || turn.supportedUriCount === 0)) {
    alerts.add('turn_not_ready');
  }
  if (turn.localhostUriCount > 0) {
    alerts.add('turn_localhost_uris');
  }
  if (turn.uriCount > 0 && !turn.udpOnly) {
    alerts.add('turn_unsupported_transport');
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

function buildTurnDiagnostics(config: ConfigService): TurnRuntimeDiagnostics {
  const uris = config.get<string[]>('turn.uris', []).map((value) => value.trim()).filter(Boolean);
  const supportedUriCount = uris.filter(isSupportedTurnUri).length;
  const localhostUriCount = uris.filter((uri) => {
    const host = parseTurnUriHost(uri);
    return host ? isLocalOrWildcardHost(host) : false;
  }).length;
  return {
    requiredInProduction: config.get<string>('app.nodeEnv', 'development') === 'production',
    realm: config.get<string>('turn.realm', 'native-sfu.local'),
    secretConfigured: Boolean(config.get<string | undefined>('turn.secret')),
    uriCount: uris.length,
    supportedUriCount,
    localhostUriCount,
    udpOnly: uris.length === supportedUriCount
  };
}

function isSupportedTurnUri(uri: string): boolean {
  const normalized = uri.trim().toLowerCase();
  return normalized.startsWith('turn:') && normalized.includes('transport=udp') && !normalized.startsWith('turns:') && !normalized.includes('transport=tcp');
}

function parseTurnUriHost(uri: string): string | undefined {
  const withoutScheme = uri.replace(/^turns?:/i, '').trim();
  const authority = withoutScheme.split('?')[0]?.split('/')[0]?.trim();
  if (!authority) {
    return undefined;
  }
  const hostPort = authority.split('@').pop()?.trim() ?? authority;
  if (!hostPort) {
    return undefined;
  }
  if (hostPort.startsWith('[')) {
    const closingBracket = hostPort.indexOf(']');
    return closingBracket > 1 ? hostPort.slice(1, closingBracket).toLowerCase() : undefined;
  }
  const segments = hostPort.split(':');
  if (segments.length <= 2) {
    return segments[0]?.toLowerCase();
  }
  return hostPort.toLowerCase();
}

function isLocalOrWildcardHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host.toLowerCase());
}
