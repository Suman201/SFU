import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AdminRecordingsController } from './admin-recordings.controller';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

@Module({
  imports: [AuthModule, DatabaseModule, EventsModule, StudentEnrollmentsModule],
  controllers: [RecordingsController, AdminRecordingsController],
  providers: [RecordingsService],
  exports: [RecordingsService]
})
export class RecordingsModule {}
