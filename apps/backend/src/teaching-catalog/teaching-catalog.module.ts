import { OnboardingReadinessService } from './onboarding-readiness.service';
import { VerificationDocumentsService } from './verification-documents.service';
import {
  TutorVerificationDocumentsController,
  AdminTutorVerificationDocumentsController,
} from './verification-documents.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { TutorNoticesService } from './tutor-notices.service';
import { IntroVideoService } from './intro-video.service';
import {
  TutorIntroVideoController,
  AdminTutorIntroVideoController,
  PublicTutorIntroVideoController,
} from './intro-video.controller';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import {
  TeachingCatalogDocument,
  TeachingCatalogSchema,
} from './catalog.schema';
import { TeachingCatalogService } from './catalog.service';
import { TutorApplicationsService } from './applications.service';
import {
  TutorOnboardingReadinessController,
  AdminTeachingCatalogController,
  AdminTutorApplicationsController,
  TeachingCatalogController,
  TutorApplicationController,
} from './catalog.controller';
@Module({
  imports: [
    AuthModule,
    NotificationsModule,
    DatabaseModule,
    AuditLogsModule,
    MongooseModule.forFeature([
      { name: TeachingCatalogDocument.name, schema: TeachingCatalogSchema },
    ]),
  ],
  controllers: [
    TutorVerificationDocumentsController,
    AdminTutorVerificationDocumentsController,
    TutorIntroVideoController,
    AdminTutorIntroVideoController,
    PublicTutorIntroVideoController,
    TeachingCatalogController,
    TutorOnboardingReadinessController,
    AdminTeachingCatalogController,
    TutorApplicationController,
    AdminTutorApplicationsController,
  ],
  providers: [
    TeachingCatalogService,
    TutorApplicationsService,
    IntroVideoService,
    TutorNoticesService,
    VerificationDocumentsService,
    OnboardingReadinessService,
  ],
  exports: [TeachingCatalogService, IntroVideoService],
})
export class TeachingCatalogModule {}
