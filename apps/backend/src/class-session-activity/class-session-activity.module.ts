import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ClassSessionActivityService } from './class-session-activity.service';

@Module({
  imports: [DatabaseModule],
  providers: [ClassSessionActivityService],
  exports: [ClassSessionActivityService]
})
export class ClassSessionActivityModule {}
