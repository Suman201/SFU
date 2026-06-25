import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DatabaseModule } from '../database/database.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { RoomsModule } from '../rooms/rooms.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AdminAttendanceController } from './admin-attendance.controller';
import { AdminClassSessionsController } from './admin-class-sessions.controller';
import { ClassSessionsController } from './class-sessions.controller';
import { ClassSessionsService } from './class-sessions.service';

@Module({
  imports: [AuthModule, DatabaseModule, RoomsModule, RecordingsModule, StudentEnrollmentsModule, AuditLogsModule, MetricsModule, ProfilesModule],
  controllers: [ClassSessionsController, AdminClassSessionsController, AdminAttendanceController],
  providers: [ClassSessionsService],
  exports: [ClassSessionsService]
})
export class ClassSessionsModule {}
