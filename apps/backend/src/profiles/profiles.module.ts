import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ProfilesController, PublicTeacherProfilesController, TeacherLiveSettingsController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ProfilesController, PublicTeacherProfilesController, TeacherLiveSettingsController],
  providers: [ProfilesService],
  exports: [ProfilesService]
})
export class ProfilesModule {}
