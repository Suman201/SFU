import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ClusterModule } from '../cluster/cluster.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RedisModule } from '../redis/redis.module';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomSignalService } from './room-signal.service';
import { RoomsService } from './rooms.service';

@Module({
  imports: [DatabaseModule, RedisModule, MetricsModule, ClusterModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomsGateway, RoomSignalService],
  exports: [RoomsService]
})
export class RoomsModule {}
