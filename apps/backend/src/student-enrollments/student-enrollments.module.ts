import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AdminEnrollmentsController } from './admin-enrollments.controller';
import { StudentEnrollmentsController } from './student-enrollments.controller';
import { StudentEnrollmentsService } from './student-enrollments.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [StudentEnrollmentsController, AdminEnrollmentsController],
  providers: [StudentEnrollmentsService],
  exports: [StudentEnrollmentsService]
})
export class StudentEnrollmentsModule {}
