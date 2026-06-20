import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLogDocument, AuditLogMongoDocument } from '../database/schemas';

export interface AuditLogInput {
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogsService {
  private readonly logger = new Logger(AuditLogsService.name);

  constructor(@InjectModel(AuditLogDocument.name) private readonly auditLogs: Model<AuditLogMongoDocument>) {}

  async record(input: AuditLogInput): Promise<void> {
    try {
      await this.auditLogs.create(input);
    } catch (error) {
      this.logger.error('Failed to write audit log', error instanceof Error ? error.stack : String(error));
    }
  }
}
