import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckError, HealthCheckService, MemoryHealthIndicator, MongooseHealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { MediaService } from '@native-sfu/nest-sfu';
import { PipeCoordinatorService } from '../cluster/pipe-coordinator.service';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly redis: RedisService,
    private readonly media: MediaService,
    private readonly pipe: PipeCoordinatorService,
    private readonly cluster: NodeRegistryService,
    private readonly metrics: MetricsService
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024),
      () => this.mongoose.pingCheck('mongodb'),
      async () => {
        await this.redis.ping();
        return { redis: { status: 'up' } };
      },
      () => this.checkMediaWorkers(),
      () => this.checkPipeTransport(),
      () => this.checkCluster()
    ]);
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('db')
  @HealthCheck()
  db() {
    return this.health.check([() => this.mongoose.pingCheck('mongodb')]);
  }

  @Get('redis')
  @HealthCheck()
  redisHealth() {
    return this.health.check([
      async () => {
        await this.redis.ping();
        return { redis: { status: 'up' } };
      }
    ]);
  }

  private async checkCluster(): Promise<HealthIndicatorResult> {
    const snapshot = await this.cluster.snapshot();
    this.metrics.clusterNodeCapacityScore.labels(snapshot.localNode.nodeId).set(snapshot.localNode.capacity.capacityScore);
    const isHealthy = snapshot.nodes.some((node) => node.nodeId === snapshot.localNode.nodeId) && snapshot.localNode.health !== 'unhealthy';
    const result: HealthIndicatorResult = {
      cluster: {
        status: isHealthy ? 'up' : 'down',
        localNode: snapshot.localNode,
        registeredNodes: snapshot.nodes.length,
        healthyNodes: snapshot.nodes.filter((node) => node.health === 'healthy').length,
        drainingNodes: snapshot.nodes.filter((node) => node.draining).length,
        ownedRoomCount: snapshot.ownedRoomCount,
        nodes: snapshot.nodes
      }
    };
    if (!isHealthy) {
      throw new HealthCheckError('Cluster node registry health check failed', result);
    }
    return result;
  }

  private async checkMediaWorkers(): Promise<HealthIndicatorResult> {
    const snapshot = this.media.workerPoolSnapshot();
    this.metrics.mediaWorkerModeInfo.labels('in-process').set(snapshot.mode === 'in-process' ? 1 : 0);
    this.metrics.mediaWorkerModeInfo.labels('worker').set(snapshot.mode === 'worker' ? 1 : 0);
    this.metrics.mediaWorkersConfigured.set(snapshot.workerCount);
    this.metrics.mediaWorkersReady.set(snapshot.readyWorkers);
    this.metrics.mediaWorkerFailedRooms.set(snapshot.failedRooms.length);
    for (const worker of snapshot.workers) {
      this.metrics.mediaWorkerUp.labels(worker.workerId).set(worker.healthy ? 1 : 0);
      this.metrics.mediaWorkerDraining.labels(worker.workerId).set(worker.draining ? 1 : 0);
      this.metrics.mediaWorkerOverloaded.labels(worker.workerId).set(worker.overloaded ? 1 : 0);
      this.metrics.mediaWorkerCapacityScore.labels(worker.workerId).set(worker.capacityScore ?? 0);
      if (worker.pid) {
        this.metrics.mediaWorkerPid.labels(worker.workerId).set(worker.pid);
      }
      this.metrics.mediaWorkerUptimeMs.labels(worker.workerId).set(worker.uptimeMs ?? 0);
      this.metrics.mediaWorkerRooms.labels(worker.workerId).set(worker.activeRooms);
      this.metrics.mediaWorkerTransports.labels(worker.workerId).set(worker.activeTransports);
      this.metrics.mediaWorkerProducers.labels(worker.workerId).set(worker.activeProducers);
      this.metrics.mediaWorkerConsumers.labels(worker.workerId).set(worker.activeConsumers);
      this.metrics.mediaWorkerRtpPackets.labels(worker.workerId).set(worker.rtpPackets);
      this.metrics.mediaWorkerRtcpPackets.labels(worker.workerId).set(worker.rtcpPackets);
      this.metrics.mediaWorkerRtpPacketRate.labels(worker.workerId).set(worker.rtpPacketRate ?? 0);
      this.metrics.mediaWorkerRtcpPacketRate.labels(worker.workerId).set(worker.rtcpPacketRate ?? 0);
      this.metrics.mediaWorkerIpcInflight.labels(worker.workerId).set(worker.inflightRequests);
      this.metrics.mediaWorkerIpcQueueDepth.labels(worker.workerId).set(worker.queueDepth);
      this.metrics.mediaWorkerIpcTimeouts.labels(worker.workerId).set(worker.ipcTimeouts);
      this.metrics.mediaWorkerRssBytes.labels(worker.workerId).set(worker.memory?.rss ?? 0);
      this.metrics.mediaWorkerHeapUsedBytes.labels(worker.workerId).set(worker.memory?.heapUsed ?? 0);
      this.metrics.mediaWorkerCpuUserMicros.labels(worker.workerId).set(worker.cpu?.user ?? 0);
      this.metrics.mediaWorkerCpuSystemMicros.labels(worker.workerId).set(worker.cpu?.system ?? 0);
    }
    const isHealthy =
      snapshot.mode === 'in-process' ||
      (snapshot.readyWorkers === snapshot.workerCount && snapshot.drainingWorkers === 0 && snapshot.overloadedWorkers < snapshot.workerCount && snapshot.failedRooms.length === 0);
    const result: HealthIndicatorResult = {
      media_workers: {
        status: isHealthy ? 'up' : 'down',
        mode: snapshot.mode,
        workerCount: snapshot.workerCount,
        readyWorkers: snapshot.readyWorkers,
        healthyWorkers: snapshot.healthyWorkers,
        drainingWorkers: snapshot.drainingWorkers,
        overloadedWorkers: snapshot.overloadedWorkers,
        activeRooms: snapshot.activeRooms,
        failedRooms: snapshot.failedRooms,
        failures: snapshot.failures,
        workers: snapshot.workers.map((worker) => ({
          workerId: worker.workerId,
          pid: worker.pid,
          status: worker.status,
          healthy: worker.healthy,
          ready: worker.ready,
          draining: worker.draining,
          overloaded: worker.overloaded,
          capacityScore: worker.capacityScore,
          activeRooms: worker.activeRooms,
          activeTransports: worker.activeTransports,
          activeProducers: worker.activeProducers,
          activeConsumers: worker.activeConsumers,
          inflightRequests: worker.inflightRequests,
          queueDepth: worker.queueDepth,
          averageIpcLatencyMs: worker.averageIpcLatencyMs,
          ipcTimeouts: worker.ipcTimeouts,
          uptimeMs: worker.uptimeMs,
          rtpPacketRate: worker.rtpPacketRate,
          rtcpPacketRate: worker.rtcpPacketRate,
          memory: worker.memory,
          cpu: worker.cpu,
          lastHeartbeatAt: worker.lastHeartbeatAt,
          lastError: worker.lastError
        }))
      }
    };
    if (!isHealthy) {
      throw new HealthCheckError('Media worker health check failed', result);
    }
    return result;
  }

  private async checkPipeTransport(): Promise<HealthIndicatorResult> {
    const snapshot = this.pipe.healthSnapshot();
    const result: HealthIndicatorResult = {
      pipe_transport: {
        status: snapshot.supported ? 'up' : 'down',
        enabled: snapshot.enabled,
        durable: snapshot.durable,
        supported: snapshot.supported,
        mediaWorkerMode: snapshot.mediaWorkerMode,
        advertiseIpConfigured: snapshot.advertiseIpConfigured,
        defaultProtocol: snapshot.defaultProtocol,
        reason: snapshot.reason
      }
    };
    if (!snapshot.supported) {
      throw new HealthCheckError('Pipe transport runtime health check failed', result);
    }
    return result;
  }
}
