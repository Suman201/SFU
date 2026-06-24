import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { AdminAuditLogDetail, AdminAuditLogListItem, AdminAuditLogListResponse, AdminAuditLogQuery } from '@native-sfu/contracts';
import { FilterQuery, Model } from 'mongoose';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogDocument, AuditLogMongoDocument } from '../database/schemas';

export interface AuditLogInput {
  actor?: AuthenticatedUser;
  actorId?: string;
  actorEmail?: string;
  actorName?: string;
  actorRoles?: string[];
  action: string;
  status?: 'success' | 'failure';
  resourceType?: string;
  resourceId?: string;
  resourceLabel?: string;
  targetUserId?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN = /(password|passcode|token|secret|authorization|cookie|credential|content|message|body|file|hash|privatekey|api[-_]?key)/i;
const MAX_REDACTION_DEPTH = 6;

@Injectable()
export class AuditLogsService {
  private readonly logger = new Logger(AuditLogsService.name);

  constructor(@InjectModel(AuditLogDocument.name) private readonly auditLogs: Model<AuditLogMongoDocument>) {}

  async record(input: AuditLogInput): Promise<void> {
    try {
      const actor = input.actor;
      await this.auditLogs.create({
        actorId: input.actorId ?? actor?.sub,
        actorEmail: input.actorEmail ?? actor?.email,
        actorName: input.actorName,
        actorRoles: input.actorRoles ?? actor?.roles ?? [],
        action: input.action,
        status: input.status ?? 'success',
        resourceType: input.resourceType ?? input.targetType,
        resourceId: input.resourceId ?? input.targetId,
        resourceLabel: input.resourceLabel,
        targetUserId: input.targetUserId,
        targetType: input.targetType ?? input.resourceType,
        targetId: input.targetId ?? input.resourceId,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: this.redactRecord(input.metadata),
        before: this.redactRecord(input.before),
        after: this.redactRecord(input.after)
      });
    } catch (error) {
      this.logger.error('Failed to write audit log', error instanceof Error ? error.stack : String(error));
    }
  }

  async listAdminAuditLogs(query: AdminAuditLogQuery, actor: AuthenticatedUser): Promise<AdminAuditLogListResponse> {
    this.assertAdmin(actor);
    const page = this.clampNumber(query.page, 1, 10_000, 1);
    const limit = this.clampNumber(query.limit, 1, 100, 25);
    const filter = this.toFilter(query);
    const [items, total] = await Promise.all([
      this.auditLogs
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.auditLogs.countDocuments(filter).exec()
    ]);
    return {
      items: items.map((item) => this.toListItem(item)),
      page,
      limit,
      total
    };
  }

  async getAdminAuditLog(auditLogId: string, actor: AuthenticatedUser): Promise<AdminAuditLogDetail> {
    this.assertAdmin(actor);
    const doc = await this.auditLogs.findById(auditLogId).exec();
    if (!doc) {
      throw new NotFoundException('Audit log not found.');
    }
    return {
      ...this.toListItem(doc),
      ...(doc.metadata ? { metadata: this.redactRecord(doc.metadata) } : {}),
      ...(doc.before ? { before: this.redactRecord(doc.before) } : {}),
      ...(doc.after ? { after: this.redactRecord(doc.after) } : {})
    };
  }

  private toFilter(query: AdminAuditLogQuery): FilterQuery<AuditLogMongoDocument> {
    const filter: FilterQuery<AuditLogMongoDocument> = {};
    if (query.actorId) filter.actorId = query.actorId;
    if (query.action) filter.action = query.action;
    if (query.resourceType) filter.resourceType = query.resourceType;
    if (query.resourceId) filter.resourceId = query.resourceId;
    if (query.status && query.status !== 'all') filter.status = query.status;
    const dateFilter: Record<string, Date> = {};
    if (query.dateFrom) dateFilter.$gte = this.parseDate(query.dateFrom, 'dateFrom');
    if (query.dateTo) dateFilter.$lte = this.parseDate(query.dateTo, 'dateTo');
    if (Object.keys(dateFilter).length) {
      filter.createdAt = dateFilter;
    }
    const search = query.search?.trim();
    if (search) {
      const expression = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [
        { action: expression },
        { resourceType: expression },
        { resourceId: expression },
        { resourceLabel: expression },
        { actorEmail: expression },
        { actorName: expression },
        { requestId: expression }
      ];
    }
    return filter;
  }

  private toListItem(doc: AuditLogMongoDocument): AdminAuditLogListItem {
    const timestamps = doc as AuditLogMongoDocument & { createdAt?: Date };
    const resourceType = doc.resourceType ?? doc.targetType;
    const resourceId = doc.resourceId ?? doc.targetId;
    return {
      id: doc.id,
      createdAt: (timestamps.createdAt ?? new Date()).toISOString(),
      ...(doc.actorId ? { actorId: doc.actorId } : {}),
      ...(doc.actorEmail ? { actorEmail: doc.actorEmail } : {}),
      ...(doc.actorName ? { actorName: doc.actorName } : {}),
      actorRoles: doc.actorRoles ?? [],
      action: doc.action,
      ...(resourceType ? { resourceType } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(doc.resourceLabel ? { resourceLabel: doc.resourceLabel } : {}),
      ...(doc.targetUserId ? { targetUserId: doc.targetUserId } : {}),
      status: doc.status ?? 'success',
      ...(doc.ipAddress ? { ipAddress: doc.ipAddress } : {}),
      ...(doc.userAgent ? { userAgent: doc.userAgent } : {}),
      ...(doc.requestId ? { requestId: doc.requestId } : {}),
      summary: this.summaryFor(doc, resourceType, resourceId)
    };
  }

  private summaryFor(doc: AuditLogMongoDocument, resourceType?: string, resourceId?: string): string {
    const summary = doc.metadata?.summary;
    if (typeof summary === 'string' && summary.trim()) {
      return summary;
    }
    if (doc.resourceLabel) {
      return doc.resourceLabel;
    }
    return [resourceType, resourceId].filter(Boolean).join(' · ') || doc.action;
  }

  private redactRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!record) {
      return undefined;
    }
    return this.redactValue(record, 0) as Record<string, unknown>;
  }

  private redactValue(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (depth > MAX_REDACTION_DEPTH) {
      return '[redacted-depth]';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactValue(entry, depth + 1));
    }
    if (typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : this.redactValue(entry, depth + 1);
      }
      return output;
    }
    return value;
  }

  private parseDate(value: string, field: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid date.`);
    }
    return parsed;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value as number)));
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!user.roles.includes('ADMIN') && !user.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Admin access required.');
    }
  }
}
