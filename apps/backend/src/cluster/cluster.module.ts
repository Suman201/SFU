import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsModule } from '../metrics/metrics.module';
import { RedisModule } from '../redis/redis.module';
import { NodeRegistryService } from './node-registry.service';
import { PipeCoordinatorService } from './pipe-coordinator.service';

@Global()
@Module({
  imports: [ConfigModule, RedisModule, MetricsModule],
  providers: [NodeRegistryService, PipeCoordinatorService],
  exports: [NodeRegistryService, PipeCoordinatorService]
})
export class ClusterModule {}
