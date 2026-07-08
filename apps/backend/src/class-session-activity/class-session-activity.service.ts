import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type {
  ClassSessionTimelineCategory,
  ClassSessionTimelineEvent,
  ClassSessionTimelineEventVisibility,
  ClassSessionTimelineResponse,
  ClassSessionTimelineSource,
  ClassSessionTimelineTarget,
  ClassSessionTimelineVisibility
} from '@native-sfu/contracts';
import { FilterQuery, Model } from 'mongoose';
import { ClassSessionActivityEventDocument, ClassSessionActivityEventMongoDocument } from '../database/schemas';

const SENSITIVE_TIMELINE_KEY_PATTERN =
  /(password|passcode|token|secret|authorization|cookie|credential|content|message|body|file|path|url|storage|download|privatekey|api[-_]?key)/i;
const MAX_METADATA_DEPTH = 5;

export interface ClassSessionActivityActor {
  id?: string;
  name?: string;
  email?: string;
  roles?: string[];
}

export interface ClassSessionActivityInput {
  sessionId: string;
  batchId: string;
  roomId?: string;
  eventType: string;
  category: ClassSessionTimelineCategory;
  summary: string;
  actor?: ClassSessionActivityActor;
  target?: ClassSessionTimelineTarget;
  source?: ClassSessionTimelineSource;
  visibility?: ClassSessionTimelineEventVisibility;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ClassSessionTimelineListOptions {
  sessionId: string;
  batchId?: string;
  before?: string;
  limit?: number;
  category?: ClassSessionTimelineCategory | 'all';
  visibility: ClassSessionTimelineVisibility;
  audienceIds?: string[];
}

export interface ClassSessionAnalyticsEventListOptions {
  sessionIds: string[];
  batchIds?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
}

@Injectable()
export class ClassSessionActivityService {
  private readonly logger = new Logger(ClassSessionActivityService.name);

  constructor(
    @InjectModel(ClassSessionActivityEventDocument.name)
    private readonly activityEvents: Model<ClassSessionActivityEventMongoDocument>
  ) {}

  async record(input: ClassSessionActivityInput): Promise<void> {
    try {
      await this.activityEvents.create({
        sessionId: input.sessionId,
        batchId: input.batchId,
        roomId: input.roomId,
        eventType: input.eventType,
        category: input.category,
        summary: input.summary,
        actorId: input.actor?.id,
        actorName: input.actor?.name,
        actorEmail: input.actor?.email,
        actorRoles: input.actor?.roles ?? [],
        targetId: input.target?.id,
        targetUserId: input.target?.userId,
        targetName: input.target?.name,
        targetRole: input.target?.role,
        targetType: input.target?.type,
        sourceCollection: input.source?.collection,
        sourceId: input.source?.id,
        visibility: input.visibility ?? 'full',
        metadata: this.redactRecord(input.metadata),
        createdAt: input.createdAt ?? new Date()
      });
    } catch (error) {
      this.logger.warn(`Failed to write class-session activity event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listTimeline(options: ClassSessionTimelineListOptions): Promise<ClassSessionTimelineResponse> {
    const limit = this.clampLimit(options.limit);
    const filter: FilterQuery<ClassSessionActivityEventMongoDocument> = {
      sessionId: options.sessionId
    };
    if (options.batchId) {
      filter.batchId = options.batchId;
    }
    if (options.category && options.category !== 'all') {
      filter.category = options.category;
    }
    if (options.before) {
      filter.createdAt = { $lt: this.parseDate(options.before, 'before') };
    }
    if (options.visibility === 'student_safe') {
      const audienceIds = [...new Set((options.audienceIds ?? []).filter(Boolean))];
      filter.$or = [
        { visibility: 'student_safe' },
        ...(audienceIds.length
          ? [
              { visibility: 'actor_only', actorId: { $in: audienceIds } },
              { visibility: 'actor_only', targetUserId: { $in: audienceIds } },
              { visibility: 'actor_only', targetId: { $in: audienceIds } }
            ]
          : [])
      ];
    }

    const docs = await this.activityEvents
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .exec();
    const page = docs.slice(0, limit);
    return {
      sessionId: options.sessionId,
      ...(options.batchId ? { batchId: options.batchId } : {}),
      visibility: options.visibility,
      items: page.map((doc) => this.toTimelineEvent(doc)),
      limit,
      hasMore: docs.length > limit,
      ...(docs.length > limit && page[page.length - 1]?.createdAt ? { nextBefore: page[page.length - 1]!.createdAt.toISOString() } : {})
    };
  }

  async listEventsForAnalytics(options: ClassSessionAnalyticsEventListOptions): Promise<ClassSessionTimelineEvent[]> {
    const sessionIds = [...new Set(options.sessionIds.filter(Boolean))];
    if (!sessionIds.length) {
      return [];
    }
    const filter: FilterQuery<ClassSessionActivityEventMongoDocument> = {
      sessionId: { $in: sessionIds }
    };
    const batchIds = [...new Set((options.batchIds ?? []).filter(Boolean))];
    if (batchIds.length) {
      filter.batchId = { $in: batchIds };
    }
    const createdAt: Record<string, Date> = {};
    if (options.dateFrom) {
      createdAt.$gte = options.dateFrom;
    }
    if (options.dateTo) {
      createdAt.$lte = options.dateTo;
    }
    if (createdAt.$gte || createdAt.$lte) {
      filter.createdAt = createdAt;
    }
    const limit = this.clampAnalyticsLimit(options.limit);
    const docs = await this.activityEvents.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
    return docs.map((doc) => this.toTimelineEvent(doc));
  }

  private toTimelineEvent(doc: ClassSessionActivityEventMongoDocument): ClassSessionTimelineEvent {
    const actorRoles = doc.actorRoles ?? [];
    return {
      id: doc.id,
      sessionId: doc.sessionId,
      ...(doc.batchId ? { batchId: doc.batchId } : {}),
      ...(doc.roomId ? { roomId: doc.roomId } : {}),
      eventType: doc.eventType,
      category: doc.category,
      summary: doc.summary,
      ...(doc.actorId || doc.actorName || doc.actorEmail || actorRoles.length
        ? {
            actor: {
              ...(doc.actorId ? { id: doc.actorId } : {}),
              ...(doc.actorName ? { name: doc.actorName } : {}),
              ...(doc.actorEmail ? { email: doc.actorEmail } : {}),
              roles: actorRoles
            }
          }
        : {}),
      ...(doc.targetId || doc.targetUserId || doc.targetName || doc.targetRole || doc.targetType
        ? {
            target: {
              ...(doc.targetId ? { id: doc.targetId } : {}),
              ...(doc.targetUserId ? { userId: doc.targetUserId } : {}),
              ...(doc.targetName ? { name: doc.targetName } : {}),
              ...(doc.targetRole ? { role: doc.targetRole } : {}),
              ...(doc.targetType ? { type: doc.targetType } : {})
            }
          }
        : {}),
      ...(doc.sourceCollection && doc.sourceId ? { source: { collection: doc.sourceCollection, id: doc.sourceId } } : {}),
      visibility: doc.visibility,
      ...(doc.metadata ? { metadata: this.redactRecord(doc.metadata) } : {}),
      createdAt: doc.createdAt.toISOString()
    };
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
    if (depth > MAX_METADATA_DEPTH) {
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
        output[key] = SENSITIVE_TIMELINE_KEY_PATTERN.test(key) ? '[redacted]' : this.redactValue(entry, depth + 1);
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

  private clampLimit(value: number | undefined): number {
    if (!Number.isFinite(value)) {
      return 50;
    }
    return Math.min(100, Math.max(1, Math.trunc(value as number)));
  }

  private clampAnalyticsLimit(value: number | undefined): number {
    if (!Number.isFinite(value)) {
      return 5000;
    }
    return Math.min(10000, Math.max(1, Math.trunc(value as number)));
  }
}
