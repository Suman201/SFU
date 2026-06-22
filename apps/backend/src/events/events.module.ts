import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClusterModule } from '../cluster/cluster.module';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { DatabaseModule } from '../database/database.module';
import { MetricsModule } from '../metrics/metrics.module';
import { EventDeliveryAdapterRegistry } from './adapters/event-delivery-adapter.registry';
import { RedisStreamDeliveryAdapter } from './adapters/redis-stream-delivery.adapter';
import { WebhookDeliveryAdapter } from './adapters/webhook-delivery.adapter';
import { RedisModule } from '../redis/redis.module';
import { EventsController } from './events.controller';
import { PlatformEventsService } from './platform-events.service';

@Module({
  imports: [ConfigModule, DatabaseModule, MetricsModule, ClusterModule, RedisModule],
  controllers: [EventsController],
  providers: [
    PlatformEventsService,
    OperationsTokenGuard,
    EventDeliveryAdapterRegistry,
    WebhookDeliveryAdapter,
    RedisStreamDeliveryAdapter
  ],
  exports: [PlatformEventsService]
})
export class EventsModule {}
