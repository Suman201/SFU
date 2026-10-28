import { TeachingCatalogModule } from '../teaching-catalog/teaching-catalog.module';
import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import {
  AdminTeacherPromotionsController,
  ProfilesController,
  PublicTeacherProfilesController,
  TeacherLiveSettingsController,
  TeacherPromotionsController
} from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [TeachingCatalogModule, AuthModule, DatabaseModule, AuditLogsModule],
  controllers: [
    ProfilesController,
    PublicTeacherProfilesController,
    TeacherLiveSettingsController,
    TeacherPromotionsController,
    AdminTeacherPromotionsController
  ],
  providers: [ProfilesService],
  exports: [ProfilesService]
})
export class ProfilesModule {}
