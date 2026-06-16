import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ClusterModule } from '../cluster/cluster.module';
import { MetricsModule } from '../metrics/metrics.module';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, MetricsModule, ClusterModule],
  controllers: [HealthController]
})
export class HealthModule {}
