import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AuditLogsModule } from './audit-logs.module';

@Module({
  imports: [AuthModule, AuditLogsModule],
  controllers: [AdminAuditLogsController]
})
export class AdminAuditLogsModule {}
