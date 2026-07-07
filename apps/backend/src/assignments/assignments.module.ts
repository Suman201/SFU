import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';

@Module({
  imports: [DatabaseModule, StudentEnrollmentsModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService],
  exports: [AssignmentsService]
})
export class AssignmentsModule {}
