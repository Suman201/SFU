import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditLogDocument, AuditLogSchema } from '../database/schemas';
import { AuditLogsService } from './audit-logs.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: AuditLogDocument.name, schema: AuditLogSchema }])],
  providers: [AuditLogsService],
  exports: [AuditLogsService]
})
export class AuditLogsModule {}
