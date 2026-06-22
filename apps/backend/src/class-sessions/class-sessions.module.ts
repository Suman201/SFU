import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RoomsModule } from '../rooms/rooms.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { ClassSessionsController } from './class-sessions.controller';
import { ClassSessionsService } from './class-sessions.service';

@Module({
  imports: [AuthModule, DatabaseModule, RoomsModule, StudentEnrollmentsModule],
  controllers: [ClassSessionsController],
  providers: [ClassSessionsService],
  exports: [ClassSessionsService]
})
export class ClassSessionsModule {}
