import { Module } from '@nestjs/common';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, OperationsTokenGuard],
  exports: [MetricsService]
})
export class MetricsModule {}
