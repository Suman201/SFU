import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ClusterModule } from '../cluster/cluster.module';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { RedisModule } from '../redis/redis.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomSignalService } from './room-signal.service';
import { RoomsService } from './rooms.service';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule, MetricsModule, ClusterModule, EventsModule, RecordingsModule, StudentEnrollmentsModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomsGateway, RoomSignalService],
  exports: [RoomsService]
})
export class RoomsModule {}
