import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { AdminClassLibraryController } from './admin-class-library.controller';
import { ClassLibraryController } from './class-library.controller';
import { ClassLibraryService } from './class-library.service';

@Module({
  imports: [AuthModule, DatabaseModule, StudentEnrollmentsModule],
  controllers: [ClassLibraryController, AdminClassLibraryController],
  providers: [ClassLibraryService],
  exports: [ClassLibraryService]
})
export class ClassLibraryModule {}
