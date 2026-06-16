import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ClusterModule } from '../cluster/cluster.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, MetricsModule, ClusterModule, RedisModule],
  controllers: [HealthController]
})
export class HealthModule {}
