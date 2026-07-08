import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { ClassSessionActivityModule } from '../class-session-activity/class-session-activity.module';
import { DatabaseModule } from '../database/database.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AdminSupportController, SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [AuthModule, DatabaseModule, StudentEnrollmentsModule, AuditLogsModule, ClassSessionActivityModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
  exports: [SupportService]
})
export class SupportModule {}
