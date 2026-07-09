import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  CONTACT_SUBMISSION_CATEGORIES,
  CONTACT_SUBMISSION_PRIORITIES,
  CONTACT_SUBMISSION_STATUSES,
  type ContactReplyDeliveryStatus,
  type ContactSubmission,
  type ContactSubmissionAck,
  type ContactSubmissionListQuery,
  type ContactSubmissionListResponse,
  type ContactSubmissionStatus,
  type CreateContactSubmissionRequest,
  type ReplyToContactSubmissionRequest,
  type UpdateContactSubmissionRequest
} from '@native-sfu/contracts';
import type { FilterQuery, Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ContactSubmissionDocument, ContactSubmissionMongoDocument } from '../database/schemas';
import { EmailNotificationService } from '../notifications/email-notification.service';

interface PublicContext {
  userAgent?: string;
  ipAddress?: string;
}

const UNSAFE_TAG_PATTERN = /<(script|style|iframe|object|embed|form|input|meta|link)\b[\s\S]*?<\/\1>|<(script|style|iframe|object|embed|form|input|meta|link)\b[^>]*\/?>/gi;
const HTML_TAG_PATTERN = /<\/?[^>]+>/g;
const EVENT_HANDLER_PATTERN = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const SECRET_PATTERN = /(bearer\s+[a-z0-9._-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|mongodb(?:\+srv)?:\/\/\S+|redis:\/\/\S+|smtp:\/\/\S+)/gi;

@Injectable()
export class ContactInboxService {
  constructor(
    @InjectModel(ContactSubmissionDocument.name) private readonly submissions: Model<ContactSubmissionMongoDocument>,
    private readonly auditLogs: AuditLogsService,
    private readonly email: EmailNotificationService
  ) {}

  async createPublicSubmission(request: CreateContactSubmissionRequest, context: PublicContext = {}): Promise<ContactSubmissionAck> {
    const doc = await this.submissions.create({
      name: this.requiredText(request.name, 'name', 160),
      email: this.emailAddress(request.email),
      phone: this.optionalText(request.phone, 40),
      subject: this.requiredText(request.subject, 'subject', 180),
      message: this.requiredText(request.message, 'message', 5000),
      category: this.oneOf(request.category ?? 'general', CONTACT_SUBMISSION_CATEGORIES, 'category'),
      status: 'new',
      priority: 'normal',
      sourcePageSlug: this.optionalSlug(request.sourcePageSlug) ?? 'contact-us',
      userAgent: this.optionalText(context.userAgent, 500),
      ipHash: context.ipAddress ? this.hashIp(context.ipAddress) : undefined
    });
    await this.auditLogs.record({
      action: 'contact.submission.created',
      resourceType: 'contact_submission',
      resourceId: doc.submissionId,
      resourceLabel: doc.subject,
      metadata: {
        summary: `New contact submission ${doc.submissionId}`,
        category: doc.category,
        sourcePageSlug: doc.sourcePageSlug
      }
    });
    return {
      submissionId: doc.submissionId,
      status: doc.status,
      createdAt: ((doc as ContactSubmissionMongoDocument & { createdAt?: Date }).createdAt ?? new Date()).toISOString()
    };
  }

  async listAdminSubmissions(user: AuthenticatedUser, query: ContactSubmissionListQuery = {}): Promise<ContactSubmissionListResponse> {
    this.assertAdmin(user);
    const page = this.clampNumber(query.page, 1, 10_000, 1);
    const limit = this.clampNumber(query.limit, 1, 100, 25);
    const filter = this.toFilter(query);
    const [items, total, summary] = await Promise.all([
      this.submissions
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.submissions.countDocuments(filter).exec(),
      this.summary({})
    ]);
    return { items: items.map((doc) => this.toContactSubmission(doc)), page, limit, total, summary };
  }

  async getAdminSubmission(user: AuthenticatedUser, submissionId: string): Promise<ContactSubmission> {
    this.assertAdmin(user);
    return this.toContactSubmission(await this.findBySubmissionId(submissionId));
  }

  async updateAdminSubmission(user: AuthenticatedUser, submissionId: string, request: UpdateContactSubmissionRequest): Promise<ContactSubmission> {
    this.assertAdmin(user);
    const doc = await this.findBySubmissionId(submissionId);
    const before = this.auditSnapshot(doc);
    if (request.status !== undefined) {
      doc.status = this.oneOf(request.status, CONTACT_SUBMISSION_STATUSES, 'status');
      if (doc.status === 'archived' && !doc.archivedAt) {
        doc.archivedAt = new Date();
      }
      if (doc.status !== 'archived') {
        doc.archivedAt = undefined;
      }
    }
    if (request.priority !== undefined) {
      doc.priority = this.oneOf(request.priority, CONTACT_SUBMISSION_PRIORITIES, 'priority');
    }
    if (request.assignedToUserId !== undefined) {
      doc.assignedToUserId = this.optionalText(request.assignedToUserId, 120);
    }
    if (request.assignedToName !== undefined) {
      doc.assignedToName = this.optionalText(request.assignedToName, 160);
    }
    if (request.internalNotes !== undefined) {
      doc.internalNotes = this.optionalText(request.internalNotes, 5000);
    }
    await doc.save();
    await this.recordAdminAudit(user, 'contact.submission.updated', doc, {
      summary: `Updated contact submission ${doc.submissionId}`,
      before,
      after: this.auditSnapshot(doc)
    });
    return this.toContactSubmission(doc);
  }

  async replyToSubmission(user: AuthenticatedUser, submissionId: string, request: ReplyToContactSubmissionRequest): Promise<ContactSubmission> {
    this.assertAdmin(user);
    const doc = await this.findBySubmissionId(submissionId);
    const message = this.requiredText(request.message, 'message', 5000);
    const delivery = await this.email.sendEmail({
      to: doc.email,
      subject: `Re: ${doc.subject}`,
      text: message
    });
    const deliveryStatus = this.deliveryStatus(delivery);
    doc.replies.push({
      replyId: randomUUID(),
      adminUserId: user.sub,
      adminName: user.email,
      message,
      sentAt: new Date(),
      deliveryStatus,
      ...(delivery.errors[0] ? { deliveryError: this.optionalText(delivery.errors[0], 500) } : {})
    });
    doc.status = deliveryStatus === 'sent' ? 'replied' : 'open';
    await doc.save();
    await this.recordAdminAudit(user, 'contact.submission.replied', doc, {
      summary: `Replied to contact submission ${doc.submissionId}`,
      deliveryStatus,
      deliveryError: delivery.errors[0]
    });
    return this.toContactSubmission(doc);
  }

  async archiveSubmission(user: AuthenticatedUser, submissionId: string): Promise<ContactSubmission> {
    return this.transition(user, submissionId, 'archived', 'contact.submission.archived');
  }

  async markSpam(user: AuthenticatedUser, submissionId: string): Promise<ContactSubmission> {
    return this.transition(user, submissionId, 'spam', 'contact.submission.marked_spam');
  }

  private async transition(
    user: AuthenticatedUser,
    submissionId: string,
    status: ContactSubmissionStatus,
    action: string
  ): Promise<ContactSubmission> {
    this.assertAdmin(user);
    const doc = await this.findBySubmissionId(submissionId);
    doc.status = status;
    doc.archivedAt = status === 'archived' ? new Date() : doc.archivedAt;
    await doc.save();
    await this.recordAdminAudit(user, action, doc, {
      summary: `${status} contact submission ${doc.submissionId}`,
      status
    });
    return this.toContactSubmission(doc);
  }

  private toFilter(query: ContactSubmissionListQuery): FilterQuery<ContactSubmissionMongoDocument> {
    const filter: FilterQuery<ContactSubmissionMongoDocument> = {};
    if (query.status && query.status !== 'all') filter.status = this.oneOf(query.status, CONTACT_SUBMISSION_STATUSES, 'status');
    if (query.category && query.category !== 'all') filter.category = this.oneOf(query.category, CONTACT_SUBMISSION_CATEGORIES, 'category');
    if (query.priority && query.priority !== 'all') filter.priority = this.oneOf(query.priority, CONTACT_SUBMISSION_PRIORITIES, 'priority');
    if (query.assignedToUserId) filter.assignedToUserId = query.assignedToUserId;
    const dateFilter: Record<string, Date> = {};
    if (query.dateFrom) dateFilter.$gte = this.date(query.dateFrom, 'dateFrom');
    if (query.dateTo) dateFilter.$lte = this.date(query.dateTo, 'dateTo');
    if (Object.keys(dateFilter).length) filter.createdAt = dateFilter;
    const search = query.search?.trim();
    if (search) {
      const expression = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [{ name: expression }, { email: expression }, { subject: expression }, { message: expression }, { submissionId: expression }];
    }
    return filter;
  }

  private async summary(baseFilter: FilterQuery<ContactSubmissionMongoDocument>): Promise<ContactSubmissionListResponse['summary']> {
    const [newCount, open, replied, waitingForUser, resolved, archived, spam] = await Promise.all([
      this.submissions.countDocuments({ ...baseFilter, status: 'new' }).exec(),
      this.submissions.countDocuments({ ...baseFilter, status: 'open' }).exec(),
      this.submissions.countDocuments({ ...baseFilter, status: 'replied' }).exec(),
      this.submissions.countDocuments({ ...baseFilter, status: 'waiting_for_user' }).exec(),
      this.submissions.countDocuments({ ...baseFilter, status: 'resolved' }).exec(),
      this.submissions.countDocuments({ ...baseFilter, status: 'archived' }).exec(),
      this.submissions.countDocuments({ ...baseFilter, status: 'spam' }).exec()
    ]);
    return { new: newCount, open, replied, waitingForUser, resolved, archived, spam };
  }

  private deliveryStatus(result: { delivered: number; failed: number; skipped: number }): ContactReplyDeliveryStatus {
    if (result.delivered > 0) return 'sent';
    if (result.failed > 0) return 'failed';
    if (result.skipped > 0) return 'skipped';
    return 'pending';
  }

  private async findBySubmissionId(submissionId: string): Promise<ContactSubmissionMongoDocument> {
    const doc = await this.submissions.findOne({ submissionId }).exec();
    if (!doc) {
      throw new NotFoundException('Contact submission not found.');
    }
    return doc;
  }

  private toContactSubmission(doc: ContactSubmissionMongoDocument): ContactSubmission {
    const timestamps = doc as ContactSubmissionMongoDocument & { createdAt?: Date; updatedAt?: Date };
    return {
      id: doc.id,
      submissionId: doc.submissionId,
      name: doc.name,
      email: doc.email,
      ...(doc.phone ? { phone: doc.phone } : {}),
      subject: doc.subject,
      message: doc.message,
      category: doc.category,
      status: doc.status,
      priority: doc.priority,
      ...(doc.assignedToUserId ? { assignedToUserId: doc.assignedToUserId } : {}),
      ...(doc.assignedToName ? { assignedToName: doc.assignedToName } : {}),
      ...(doc.sourcePageSlug ? { sourcePageSlug: doc.sourcePageSlug } : {}),
      ...(doc.userId ? { userId: doc.userId } : {}),
      ...(doc.userAgent ? { userAgent: doc.userAgent } : {}),
      ...(doc.ipHash ? { ipHash: doc.ipHash } : {}),
      replies: (doc.replies ?? []).map((reply) => ({
        replyId: reply.replyId,
        adminUserId: reply.adminUserId,
        ...(reply.adminName ? { adminName: reply.adminName } : {}),
        message: reply.message,
        sentAt: reply.sentAt.toISOString(),
        deliveryStatus: reply.deliveryStatus,
        ...(reply.deliveryError ? { deliveryError: reply.deliveryError } : {})
      })),
      ...(doc.internalNotes ? { internalNotes: doc.internalNotes } : {}),
      createdAt: (timestamps.createdAt ?? new Date()).toISOString(),
      updatedAt: (timestamps.updatedAt ?? new Date()).toISOString(),
      ...(doc.archivedAt ? { archivedAt: doc.archivedAt.toISOString() } : {})
    };
  }

  private auditSnapshot(doc: ContactSubmissionMongoDocument): Record<string, unknown> {
    return {
      submissionId: doc.submissionId,
      category: doc.category,
      status: doc.status,
      priority: doc.priority,
      assignedToUserId: doc.assignedToUserId,
      assignedToName: doc.assignedToName
    };
  }

  private async recordAdminAudit(user: AuthenticatedUser, action: string, doc: ContactSubmissionMongoDocument, metadata: Record<string, unknown>): Promise<void> {
    await this.auditLogs.record({
      actor: user,
      action,
      resourceType: 'contact_submission',
      resourceId: doc.submissionId,
      resourceLabel: doc.subject,
      metadata
    });
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    const text = this.cleanText(value, maxLength);
    if (!text) throw new BadRequestException(`${field} is required.`);
    return text;
  }

  private optionalText(value: unknown, maxLength: number): string | undefined {
    const text = this.cleanText(value, maxLength);
    return text || undefined;
  }

  private cleanText(value: unknown, maxLength: number): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new BadRequestException('Contact fields must be strings.');
    const cleaned = value
      .replace(UNSAFE_TAG_PATTERN, '')
      .replace(EVENT_HANDLER_PATTERN, '')
      .replace(SECRET_PATTERN, '[redacted]')
      .replace(HTML_TAG_PATTERN, '')
      .replace(/\u0000/g, '')
      .trim();
    if (cleaned.length > maxLength) throw new BadRequestException(`Contact field exceeds ${maxLength} characters.`);
    return cleaned;
  }

  private emailAddress(value: unknown): string {
    const email = this.requiredText(value, 'email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('email must be a valid email address.');
    return email;
  }

  private optionalSlug(value: unknown): string | undefined {
    const slug = this.optionalText(value, 120)?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || undefined;
  }

  private oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}.`);
    }
    return value as T;
  }

  private date(value: string, field: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${field} must be a valid date.`);
    return parsed;
  }

  private hashIp(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value as number)));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!user.roles.includes('ADMIN') && !user.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Admin access required.');
    }
  }
}
