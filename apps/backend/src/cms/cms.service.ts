import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  CMS_AUDIENCES,
  CMS_BLOCK_TYPES,
  CMS_PAGE_STATUSES,
  CMS_PAGE_TYPES,
  type CmsAudience,
  type CmsBlockItem,
  type CmsBlockType,
  type CmsLink,
  type CmsPage,
  type CmsPageBlock,
  type CmsPageListQuery,
  type CmsPageListResponse,
  type CmsPageStatus,
  type CmsPageType,
  type CmsPageWriteRequest,
  type CmsSeoMetadata
} from '@native-sfu/contracts';
import type { FilterQuery, Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CmsPageDocument, CmsPageMongoDocument } from '../database/schemas';

const DEFAULT_LOCALE = 'en';
const MAX_SECTIONS = 30;
const MAX_BLOCK_ITEMS = 24;
const MAX_LINKS = 8;
const UNSAFE_TAG_PATTERN = /<(script|style|iframe|object|embed|form|input|meta|link)\b[\s\S]*?<\/\1>|<(script|style|iframe|object|embed|form|input|meta|link)\b[^>]*\/?>/gi;
const HTML_TAG_PATTERN = /<\/?[^>]+>/g;
const EVENT_HANDLER_PATTERN = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const UNSAFE_URL_PATTERN = /\b(?:javascript|data|vbscript):/gi;

@Injectable()
export class CmsService {
  constructor(
    @InjectModel(CmsPageDocument.name) private readonly pages: Model<CmsPageMongoDocument>,
    private readonly auditLogs: AuditLogsService
  ) {}

  async listAdminPages(query: CmsPageListQuery, user: AuthenticatedUser): Promise<CmsPageListResponse> {
    this.assertAdmin(user);
    const page = this.clampNumber(query.page, 1, 10_000, 1);
    const limit = this.clampNumber(query.limit, 1, 100, 25);
    const filter = this.toAdminFilter(query);
    const [items, total] = await Promise.all([
      this.pages
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.pages.countDocuments(filter).exec()
    ]);
    return { items: items.map((doc) => this.toPage(doc)), page, limit, total };
  }

  async createAdminPage(request: CmsPageWriteRequest, user: AuthenticatedUser): Promise<CmsPage> {
    this.assertAdmin(user);
    const payload = this.normalizeWriteRequest(request, true);
    try {
      const created = await this.pages.create({
        ...payload,
        status: 'draft',
        createdByUserId: user.sub,
        updatedByUserId: user.sub
      });
      await this.recordAudit(user, 'cms.page.created', created, {
        summary: `Created CMS page ${created.slug}`,
        status: created.status,
        pageType: created.pageType,
        audience: created.audience
      });
      return this.toPage(created);
    } catch (error) {
      this.handlePersistenceError(error);
    }
  }

  async getAdminPage(pageId: string, user: AuthenticatedUser): Promise<CmsPage> {
    this.assertAdmin(user);
    return this.toPage(await this.findPage(pageId));
  }

  async updateAdminPage(pageId: string, request: CmsPageWriteRequest, user: AuthenticatedUser): Promise<CmsPage> {
    this.assertAdmin(user);
    const page = await this.findPage(pageId);
    const before = this.auditSnapshot(page);
    const patch = this.normalizeWriteRequest(request, false);
    Object.assign(page, patch, { updatedByUserId: user.sub });
    try {
      await page.save();
    } catch (error) {
      this.handlePersistenceError(error);
    }
    await this.recordAudit(user, 'cms.page.updated', page, {
      summary: `Updated CMS page ${page.slug}`,
      before,
      after: this.auditSnapshot(page)
    });
    return this.toPage(page);
  }

  async publishAdminPage(pageId: string, user: AuthenticatedUser): Promise<CmsPage> {
    this.assertAdmin(user);
    const page = await this.findPage(pageId);
    if (page.status === 'archived') {
      throw new BadRequestException('Archived CMS pages cannot be published.');
    }
    page.status = 'published';
    page.publishedAt = new Date();
    page.publishedByUserId = user.sub;
    page.archivedAt = undefined;
    page.updatedByUserId = user.sub;
    await page.save();
    await this.recordAudit(user, 'cms.page.published', page, {
      summary: `Published CMS page ${page.slug}`,
      status: page.status,
      publishedAt: page.publishedAt?.toISOString()
    });
    return this.toPage(page);
  }

  async unpublishAdminPage(pageId: string, user: AuthenticatedUser): Promise<CmsPage> {
    this.assertAdmin(user);
    const page = await this.findPage(pageId);
    if (page.status === 'archived') {
      throw new BadRequestException('Archived CMS pages cannot be unpublished.');
    }
    page.status = 'draft';
    page.updatedByUserId = user.sub;
    await page.save();
    await this.recordAudit(user, 'cms.page.unpublished', page, {
      summary: `Unpublished CMS page ${page.slug}`,
      status: page.status
    });
    return this.toPage(page);
  }

  async archiveAdminPage(pageId: string, user: AuthenticatedUser): Promise<CmsPage> {
    this.assertAdmin(user);
    const page = await this.findPage(pageId);
    page.status = 'archived';
    page.archivedAt = new Date();
    page.updatedByUserId = user.sub;
    await page.save();
    await this.recordAudit(user, 'cms.page.archived', page, {
      summary: `Archived CMS page ${page.slug}`,
      status: page.status,
      archivedAt: page.archivedAt?.toISOString()
    });
    return this.toPage(page);
  }

  async getPublicPage(slug: string, query: Pick<CmsPageListQuery, 'locale'> = {}): Promise<CmsPage> {
    const normalizedSlug = this.normalizeSlug(slug);
    const locale = this.normalizeLocale(query.locale);
    const page = await this.pages
      .findOne({
        slug: normalizedSlug,
        locale,
        status: 'published',
        audience: { $in: ['public', 'all'] }
      })
      .sort({ audience: 1, publishedAt: -1 })
      .exec();
    if (!page) {
      throw new NotFoundException('CMS page not found.');
    }
    return this.toPage(page);
  }

  async listPublicPages(query: CmsPageListQuery = {}): Promise<CmsPageListResponse> {
    const page = this.clampNumber(query.page, 1, 10_000, 1);
    const limit = this.clampNumber(query.limit, 1, 100, 25);
    const filter: FilterQuery<CmsPageMongoDocument> = {
      status: 'published',
      audience: { $in: ['public', 'all'] },
      locale: this.normalizeLocale(query.locale)
    };
    if (query.pageType && query.pageType !== 'all') {
      filter.pageType = this.assertOneOf(query.pageType, CMS_PAGE_TYPES, 'pageType');
    }
    const [items, total] = await Promise.all([
      this.pages
        .find(filter)
        .sort({ publishedAt: -1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.pages.countDocuments(filter).exec()
    ]);
    return { items: items.map((doc) => this.toPage(doc)), page, limit, total };
  }

  private toAdminFilter(query: CmsPageListQuery): FilterQuery<CmsPageMongoDocument> {
    const filter: FilterQuery<CmsPageMongoDocument> = {};
    if (query.status && query.status !== 'all') filter.status = this.assertOneOf(query.status, CMS_PAGE_STATUSES, 'status');
    if (query.pageType && query.pageType !== 'all') filter.pageType = this.assertOneOf(query.pageType, CMS_PAGE_TYPES, 'pageType');
    if (query.audience && query.audience !== 'all') filter.audience = this.assertOneOf(query.audience, CMS_AUDIENCES, 'audience');
    if (query.locale) filter.locale = this.normalizeLocale(query.locale);
    const search = query.search?.trim();
    if (search) {
      const expression = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [{ slug: expression }, { title: expression }, { summary: expression }, { tags: expression }];
    }
    return filter;
  }

  private normalizeWriteRequest(request: CmsPageWriteRequest, creating: boolean): Partial<CmsPageDocument> {
    const output: Partial<CmsPageDocument> = {};
    if (creating || request.slug !== undefined) output.slug = this.normalizeSlug(request.slug ?? '');
    if (creating || request.title !== undefined) output.title = this.requiredText(request.title, 'title', 180);
    if (creating || request.pageType !== undefined) output.pageType = this.assertOneOf(request.pageType ?? 'page', CMS_PAGE_TYPES, 'pageType');
    if (creating || request.audience !== undefined) output.audience = this.assertOneOf(request.audience ?? 'public', CMS_AUDIENCES, 'audience');
    if (creating || request.locale !== undefined) output.locale = this.normalizeLocale(request.locale);
    if (request.summary !== undefined) output.summary = this.optionalText(request.summary, 500);
    if (request.bodyMarkdown !== undefined) output.bodyMarkdown = this.optionalText(request.bodyMarkdown, 20000);
    if (request.sections !== undefined) output.sections = this.normalizeSections(request.sections);
    if (request.seo !== undefined) output.seo = this.normalizeSeo(request.seo);
    if (request.tags !== undefined) output.tags = this.normalizeTags(request.tags);
    if (creating && !output.sections) output.sections = [];
    if (creating && !output.seo) output.seo = {};
    if (creating && !output.tags) output.tags = [];
    return output;
  }

  private normalizeSections(sections: CmsPageBlock[]): CmsPageBlock[] {
    if (!Array.isArray(sections)) {
      throw new BadRequestException('sections must be an array.');
    }
    if (sections.length > MAX_SECTIONS) {
      throw new BadRequestException(`CMS pages can have at most ${MAX_SECTIONS} sections.`);
    }
    return sections.map((section, index) => ({
      blockId: this.optionalText(section.blockId, 80) || `block-${index + 1}`,
      type: this.assertOneOf(section.type, CMS_BLOCK_TYPES, `sections[${index}].type`),
      ...(section.title !== undefined ? { title: this.optionalText(section.title, 180) } : {}),
      ...(section.eyebrow !== undefined ? { eyebrow: this.optionalText(section.eyebrow, 80) } : {}),
      ...(section.body !== undefined ? { body: this.optionalText(section.body, 5000) } : {}),
      ...(section.imageUrl !== undefined ? { imageUrl: this.normalizeUrl(section.imageUrl, `sections[${index}].imageUrl`) } : {}),
      ...(section.links !== undefined ? { links: this.normalizeLinks(section.links, `sections[${index}].links`) } : {}),
      ...(section.items !== undefined ? { items: this.normalizeItems(section.items, `sections[${index}].items`) } : {})
    }));
  }

  private normalizeItems(items: CmsBlockItem[], field: string): CmsBlockItem[] {
    if (!Array.isArray(items)) {
      throw new BadRequestException(`${field} must be an array.`);
    }
    if (items.length > MAX_BLOCK_ITEMS) {
      throw new BadRequestException(`${field} can include at most ${MAX_BLOCK_ITEMS} items.`);
    }
    return items.map((item, index) => ({
      ...(item.title !== undefined ? { title: this.optionalText(item.title, 180) } : {}),
      ...(item.body !== undefined ? { body: this.optionalText(item.body, 1200) } : {}),
      ...(item.label !== undefined ? { label: this.optionalText(item.label, 120) } : {}),
      ...(item.url !== undefined ? { url: this.normalizeUrl(item.url, `${field}[${index}].url`) } : {}),
      ...(item.imageUrl !== undefined ? { imageUrl: this.normalizeUrl(item.imageUrl, `${field}[${index}].imageUrl`) } : {})
    }));
  }

  private normalizeLinks(links: CmsLink[], field: string): CmsLink[] {
    if (!Array.isArray(links)) {
      throw new BadRequestException(`${field} must be an array.`);
    }
    if (links.length > MAX_LINKS) {
      throw new BadRequestException(`${field} can include at most ${MAX_LINKS} links.`);
    }
    return links.map((link, index) => ({
      label: this.requiredText(link.label, `${field}[${index}].label`, 120),
      url: this.normalizeUrl(link.url, `${field}[${index}].url`),
      ...(link.variant ? { variant: this.assertOneOf(link.variant, ['primary', 'secondary', 'link'] as const, `${field}[${index}].variant`) } : {})
    }));
  }

  private normalizeSeo(seo: CmsSeoMetadata): CmsSeoMetadata {
    return {
      ...(seo.metaTitle !== undefined ? { metaTitle: this.optionalText(seo.metaTitle, 180) } : {}),
      ...(seo.metaDescription !== undefined ? { metaDescription: this.optionalText(seo.metaDescription, 300) } : {}),
      ...(seo.canonicalUrl !== undefined ? { canonicalUrl: this.normalizeUrl(seo.canonicalUrl, 'seo.canonicalUrl') } : {})
    };
  }

  private normalizeTags(tags: string[]): string[] {
    if (!Array.isArray(tags)) {
      throw new BadRequestException('tags must be an array.');
    }
    return Array.from(new Set(tags.map((tag) => this.cleanText(tag, 40).toLowerCase()).filter(Boolean))).slice(0, 20);
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    const text = this.cleanText(value, maxLength);
    if (!text) {
      throw new BadRequestException(`${field} is required.`);
    }
    return text;
  }

  private optionalText(value: unknown, maxLength: number): string | undefined {
    const text = this.cleanText(value, maxLength);
    return text || undefined;
  }

  private cleanText(value: unknown, maxLength: number): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('CMS text fields must be strings.');
    }
    const cleaned = value
      .replace(UNSAFE_TAG_PATTERN, '')
      .replace(EVENT_HANDLER_PATTERN, '')
      .replace(UNSAFE_URL_PATTERN, '')
      .replace(HTML_TAG_PATTERN, '')
      .replace(/\u0000/g, '')
      .trim();
    if (cleaned.length > maxLength) {
      throw new BadRequestException(`CMS text field exceeds ${maxLength} characters.`);
    }
    return cleaned;
  }

  private normalizeUrl(value: unknown, field: string): string {
    const url = this.requiredText(value, field, 2048);
    if (url.startsWith('/')) {
      if (url.startsWith('//')) {
        throw new BadRequestException(`${field} must not be protocol-relative.`);
      }
      return url;
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
        throw new BadRequestException(`${field} has an unsupported URL protocol.`);
      }
      return parsed.toString();
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`${field} must be an absolute http(s), mailto, tel, or site-relative URL.`);
    }
  }

  private normalizeSlug(value: unknown): string {
    if (typeof value !== 'string') {
      throw new BadRequestException('slug is required.');
    }
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
      throw new BadRequestException('slug must contain lowercase letters, numbers, and hyphens only.');
    }
    return slug;
  }

  private normalizeLocale(value: unknown): string {
    const locale = typeof value === 'string' && value.trim() ? value.trim().toLowerCase().replace('_', '-') : DEFAULT_LOCALE;
    if (!/^[a-z]{2}(?:-[a-z0-9]{2,8})?$/.test(locale)) {
      throw new BadRequestException('locale must be a valid short locale such as en or en-us.');
    }
    return locale;
  }

  private assertOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}.`);
    }
    return value as T;
  }

  private async findPage(pageId: string): Promise<CmsPageMongoDocument> {
    const page = await this.pages.findOne({ pageId }).exec();
    if (!page) {
      throw new NotFoundException('CMS page not found.');
    }
    return page;
  }

  private toPage(doc: CmsPageMongoDocument): CmsPage {
    const timestamps = doc as CmsPageMongoDocument & { createdAt?: Date; updatedAt?: Date };
    return {
      pageId: doc.pageId,
      slug: doc.slug,
      title: doc.title,
      pageType: doc.pageType,
      status: doc.status,
      audience: doc.audience,
      locale: doc.locale,
      ...(doc.summary ? { summary: doc.summary } : {}),
      ...(doc.bodyMarkdown ? { bodyMarkdown: doc.bodyMarkdown } : {}),
      sections: doc.sections ?? [],
      seo: doc.seo ?? {},
      tags: doc.tags ?? [],
      ...(doc.publishedAt ? { publishedAt: doc.publishedAt.toISOString() } : {}),
      ...(doc.publishedByUserId ? { publishedByUserId: doc.publishedByUserId } : {}),
      ...(doc.archivedAt ? { archivedAt: doc.archivedAt.toISOString() } : {}),
      ...(doc.createdByUserId ? { createdByUserId: doc.createdByUserId } : {}),
      ...(doc.updatedByUserId ? { updatedByUserId: doc.updatedByUserId } : {}),
      createdAt: (timestamps.createdAt ?? new Date()).toISOString(),
      updatedAt: (timestamps.updatedAt ?? new Date()).toISOString()
    };
  }

  private auditSnapshot(doc: CmsPageMongoDocument): Record<string, unknown> {
    return {
      pageId: doc.pageId,
      slug: doc.slug,
      title: doc.title,
      pageType: doc.pageType,
      status: doc.status,
      audience: doc.audience,
      locale: doc.locale,
      tags: doc.tags ?? []
    };
  }

  private async recordAudit(user: AuthenticatedUser, action: string, page: CmsPageMongoDocument, metadata: Record<string, unknown>): Promise<void> {
    await this.auditLogs.record({
      actor: user,
      action,
      resourceType: 'cms_page',
      resourceId: page.pageId,
      resourceLabel: page.slug,
      metadata
    });
  }

  private handlePersistenceError(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000) {
      throw new BadRequestException('A CMS page with this slug, locale, and audience already exists.');
    }
    throw error;
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
