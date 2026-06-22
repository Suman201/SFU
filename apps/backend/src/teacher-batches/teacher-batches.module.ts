import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { TeacherBatchesController } from './teacher-batches.controller';
import { TeacherBatchesService } from './teacher-batches.service';

@Module({
  imports: [AuthModule, DatabaseModule, StudentEnrollmentsModule],
  controllers: [TeacherBatchesController],
  providers: [TeacherBatchesService],
  exports: [TeacherBatchesService]
})
export class TeacherBatchesModule {}
