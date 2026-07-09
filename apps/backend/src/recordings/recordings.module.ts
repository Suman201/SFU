import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ClassSessionActivityModule } from '../class-session-activity/class-session-activity.module';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AdminRecordingsController } from './admin-recordings.controller';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

@Module({
  imports: [AuthModule, DatabaseModule, EventsModule, StudentEnrollmentsModule, AuditLogsModule, ClassSessionActivityModule, MetricsModule],
  controllers: [RecordingsController, AdminRecordingsController],
  providers: [RecordingsService],
  exports: [RecordingsService]
})
export class RecordingsModule {}
