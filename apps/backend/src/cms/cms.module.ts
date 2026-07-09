import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AdminCmsController } from './admin-cms.controller';
import { CmsPublicController } from './cms-public.controller';
import { CmsService } from './cms.service';

@Module({
  imports: [AuthModule, DatabaseModule, AuditLogsModule],
  controllers: [AdminCmsController, CmsPublicController],
  providers: [CmsService],
  exports: [CmsService]
})
export class CmsModule {}
