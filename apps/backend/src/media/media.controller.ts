import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ClusterNodeInfo } from '@native-sfu/contracts';
import { IceService, MediaService, type MediaWorkerPoolSnapshot, TurnCredentials } from '@native-sfu/nest-sfu';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { PipeCoordinatorService, type PipeCoordinatorSnapshot } from '../cluster/pipe-coordinator.service';

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
