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

  @Get('ready')
  @HealthCheck()
  ready() {
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
      () => this.checkCluster(),
      () => this.checkTrafficReadiness()
    ]);
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
        localNodeHealth: snapshot.localNode.health,
        localNodeDraining: snapshot.localNode.draining,
        registeredNodes: snapshot.nodes.length,
        healthyNodes: snapshot.nodes.filter((node) => node.health === 'healthy').length,
        drainingNodes: snapshot.nodes.filter((node) => node.draining).length,
        ownedRoomCount: snapshot.ownedRoomCount
      }
    };
    if (!isHealthy) {
      throw new HealthCheckError('Cluster node registry health check failed', result);
    }
    return result;
  }

  private async checkMediaWorkers(): Promise<HealthIndicatorResult> {
    const snapshot = this.media.workerPoolSnapshot();
    this.metrics.refreshMediaWorkerSnapshot(snapshot);
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
        failedRoomCount: snapshot.failedRooms.length
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

  private async checkTrafficReadiness(): Promise<HealthIndicatorResult> {
    const snapshot = await this.cluster.snapshot();
    const acceptingTraffic =
      snapshot.localNode.health === 'healthy'
      && !snapshot.localNode.draining
      && snapshot.localNode.capacity.capacityScore < 1;
    const reason = acceptingTraffic
      ? undefined
      : snapshot.localNode.draining
        ? 'node_draining'
        : snapshot.localNode.capacity.capacityScore >= 1
          ? 'node_overloaded'
          : `node_${snapshot.localNode.health}`;
    const result: HealthIndicatorResult = {
      readiness: {
        status: acceptingTraffic ? 'up' : 'down',
        acceptingTraffic,
        reason
      }
    };
    if (!acceptingTraffic) {
      throw new HealthCheckError('Traffic readiness check failed', result);
    }
    return result;
  }
}
