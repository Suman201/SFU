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
  AdminTeachingCatalogController,
  AdminTutorApplicationsController,
  TeachingCatalogController,
  TutorApplicationController,
} from './catalog.controller';
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    AuditLogsModule,
    MongooseModule.forFeature([
      { name: TeachingCatalogDocument.name, schema: TeachingCatalogSchema },
    ]),
  ],
  controllers: [
    TutorIntroVideoController,
    AdminTutorIntroVideoController,
    PublicTutorIntroVideoController,
    TeachingCatalogController,
    AdminTeachingCatalogController,
    TutorApplicationController,
    AdminTutorApplicationsController,
  ],
  providers: [
    TeachingCatalogService,
    TutorApplicationsService,
    IntroVideoService,
  ],
  exports: [TeachingCatalogService, IntroVideoService],
})
export class TeachingCatalogModule {}
