import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RoomsModule } from '../rooms/rooms.module';
import { AdminIngestsController, AdminRoomIngestsController } from './ingest.controller';
import { IngestPolicyService } from './ingest-policy.service';
import { IngestService } from './ingest.service';
import { IngestSupervisorService } from './ingest-supervisor.service';

@Module({
  imports: [AuthModule, DatabaseModule, RoomsModule],
  controllers: [AdminIngestsController, AdminRoomIngestsController],
  providers: [IngestService, IngestPolicyService, IngestSupervisorService],
  exports: [IngestService]
})
export class IngestModule {}
