import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RoomsModule } from '../rooms/rooms.module';
import { AdminIngestsController, AdminRoomIngestsController } from './ingest.controller';
import { IngestPolicyService } from './ingest-policy.service';
import { IngestService } from './ingest.service';
import { IngestSupervisorService } from './ingest-supervisor.service';

@Module({
  imports: [AuthModule, DatabaseModule, RoomsModule, EventsModule, AuditLogsModule, MetricsModule],
  controllers: [AdminIngestsController, AdminRoomIngestsController],
  providers: [IngestService, IngestPolicyService, IngestSupervisorService],
  exports: [IngestService]
})
export class IngestModule {}
