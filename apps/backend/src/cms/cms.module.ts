import { MongooseModule } from '@nestjs/mongoose';
import { CmsMediaController, CmsPublicMediaController } from './cms-media.controller';
import { CmsMediaService } from './cms-media.service';
import { CmsMediaDocument, CmsMediaSchema } from './cms-media.schema';
import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AdminCmsController } from './admin-cms.controller';
import { CmsPublicController } from './cms-public.controller';
import { CmsService } from './cms.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: CmsMediaDocument.name, schema: CmsMediaSchema }]), AuthModule, DatabaseModule, AuditLogsModule],
  controllers: [CmsMediaController, CmsPublicMediaController, AdminCmsController, CmsPublicController],
  providers: [CmsService, CmsMediaService],
  exports: [CmsService]
})
export class CmsModule {}
