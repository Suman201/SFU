import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DatabaseModule } from '../database/database.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AdminBatchesController, AdminCoursesController } from './admin-course-batches.controller';
import { TeacherBatchesController } from './teacher-batches.controller';
import { TeacherBatchesService } from './teacher-batches.service';

@Module({
  imports: [AuthModule, DatabaseModule, StudentEnrollmentsModule, AuditLogsModule, ProfilesModule],
  controllers: [TeacherBatchesController, AdminCoursesController, AdminBatchesController],
  providers: [TeacherBatchesService],
  exports: [TeacherBatchesService]
})
export class TeacherBatchesModule {}
