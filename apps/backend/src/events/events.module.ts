import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClusterModule } from '../cluster/cluster.module';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { DatabaseModule } from '../database/database.module';
import { MetricsModule } from '../metrics/metrics.module';
import { EventsController } from './events.controller';
import { PlatformEventsService } from './platform-events.service';

@Module({
  imports: [ConfigModule, DatabaseModule, MetricsModule, ClusterModule],
  controllers: [EventsController],
  providers: [PlatformEventsService, OperationsTokenGuard],
  exports: [PlatformEventsService]
})
export class EventsModule {}
