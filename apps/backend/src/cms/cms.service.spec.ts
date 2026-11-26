import { expect, it } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CmsService } from './cms.service';

describe('CmsService', () => {
  it('lets admins create a sanitized draft CMS page and writes an audit log', async () => {
    const { service, pages, auditLogs } = createService();
    pages.create.mockImplementation(async (payload: unknown) => pageDoc(payload as Record<string, unknown>));

    const created = await service.createAdminPage(
      {
        slug: 'About Us',
        title: '<b>About Native SFU</b>',
        pageType: 'page',
        bodyMarkdown: '<script>alert(1)</script>Safe copy',
        sections: [
          {
            type: 'hero',
            title: 'Teach live',
            links: [{ label: 'Start', url: '/register', variant: 'primary' }]
          }
        ],
        tags: ['Learning', 'Learning']
      },
      adminUser()
    );

    const createPayload = pages.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createPayload.slug).toBe('about-us');
    expect(createPayload.title).toBe('About Native SFU');
    expect(createPayload.status).toBe('draft');
    expect(createPayload.createdByUserId).toBe('admin-1');
    expect(created.bodyMarkdown).toBe('Safe copy');
    expect(created.tags).toEqual(['learning']);
    const auditPayload = auditLogs.record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditPayload.action).toBe('cms.page.created');
    expect(auditPayload.resourceType).toBe('cms_page');
  });

  it('rejects CMS management for non-admins', async () => {
    const { service, pages } = createService();

    let thrown: unknown;
    try {
      await service.listAdminPages({}, studentUser());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(pages.find).not.toHaveBeenCalled();
  });

  it('serves only published public pages', async () => {
    const published = pageDoc({ slug: 'privacy-policy', status: 'published', audience: 'public' });
    const { service, pages } = createService();
    pages.findOne.mockReturnValue(query(published));

    const page = await service.getPublicPage('privacy-policy');

    expect(page.slug).toBe('privacy-policy');
    const filter = pages.findOne.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(filter).toEqual({
      slug: 'privacy-policy',
      locale: 'en',
      status: 'published',
      audience: { $in: ['public', 'all'] }
    });
  });

  it('does not leak draft or archived pages publicly', async () => {
    const { service, pages } = createService();
    pages.findOne.mockReturnValue(query(null));

    let thrown: unknown;
    try {
      await service.getPublicPage('draft-page');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('publishes and archives pages with audit events', async () => {
    const draft = pageDoc({ pageId: 'page-1', slug: 'faq', status: 'draft' }) as ReturnType<typeof pageDoc> & {
      publishedAt?: Date;
      archivedAt?: Date;
    };
    const { service, pages, auditLogs } = createService();
    pages.findOne.mockReturnValueOnce(query(draft));

    const published = await service.publishAdminPage('page-1', adminUser());

    expect(published.status).toBe('published');
    expect(draft.publishedAt).toBeInstanceOf(Date);
    expect(draft.save).toHaveBeenCalled();
    const publishAuditPayload = auditLogs.record.mock.calls[auditLogs.record.mock.calls.length - 1]?.[0] as Record<string, unknown>;
    expect(publishAuditPayload.action).toBe('cms.page.published');

    pages.findOne.mockReturnValueOnce(query(draft));
    const archived = await service.archiveAdminPage('page-1', adminUser());
    expect(archived.status).toBe('archived');
    const archiveAuditPayload = auditLogs.record.mock.calls[auditLogs.record.mock.calls.length - 1]?.[0] as Record<string, unknown>;
    expect(archiveAuditPayload.action).toBe('cms.page.archived');
  });

  it('keeps published copy stable while a newer draft is edited', async () => {
    const { service, pages } = createService();
    const document = pageDoc({ status: 'published', bodyMarkdown: 'Public version', __v: 4 });
    pages.findOne.mockReturnValue(query(document));
    const draft = await service.updateAdminPage('page-1', { expectedRevision: 4, title: 'Draft title', bodyMarkdown: 'Draft version' }, adminUser());
    expect(draft.hasUnpublishedChanges).toBe(true);
    expect(draft.bodyMarkdown).toBe('Draft version');
    const published = await service.getPublicPage('home');
    expect(published.bodyMarkdown).toBe('Public version');
    expect(published.title).toBe('Home');
    expect(published.hasUnpublishedChanges).toBeUndefined();
  });

  it('rejects stale draft edits and published routing changes before persistence', async () => {
    const { service, pages } = createService(); const document = pageDoc({ status: 'published', __v: 2 });
    pages.findOne.mockReturnValue(query(document));
    await expect(service.updateAdminPage('page-1', { expectedRevision: 1, bodyMarkdown: 'stale' }, adminUser())).rejects.toBeInstanceOf(ConflictException);
    await expect(service.updateAdminPage('page-1', { expectedRevision: 2, slug: 'new-slug' }, adminUser())).rejects.toBeInstanceOf(ConflictException);
    expect(document.save).not.toHaveBeenCalled();
  });

  it('publishes an immutable version once and makes unchanged publication retries idempotent', async () => {
    const { service, pages, revisions, transaction } = createService(); const document = pageDoc();
    pages.findOne.mockReturnValue(query(document));
    await service.publishAdminPage('page-1', adminUser());
    // Storage may omit empty objects or return object keys in a different order.
    const stored = (document as Record<string, any>).publishedContent;
    delete stored.seo;
    (document as Record<string, any>).publishedContent = Object.fromEntries(Object.entries(stored).reverse());
    await service.publishAdminPage('page-1', adminUser());
    expect(revisions.create).toHaveBeenCalledTimes(1);
    const snapshot = revisions.create.mock.calls[0][0][0];
    expect(snapshot.version).toBe(1); expect(snapshot.content.bodyMarkdown).toBe('Welcome');
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(revisions.create.mock.calls[0][1]).toEqual({ session: transaction });
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(transaction.endSession).toHaveBeenCalledTimes(2);
  });

  it('does not publish if immutable-history persistence fails', async () => {
    const { service, pages, revisions, transaction, auditLogs } = createService(); const document = pageDoc();
    pages.findOne.mockReturnValue(query(document)); revisions.create.mockRejectedValue(new Error('Database unavailable'));
    await expect(service.publishAdminPage('page-1', adminUser())).rejects.toThrow('Database unavailable');
    expect(document.status).toBe('draft'); expect(document.save).not.toHaveBeenCalled();
    expect(auditLogs.record).not.toHaveBeenCalled(); expect(transaction.endSession).toHaveBeenCalledTimes(1);
  });

  it('restores a publication into the working draft without changing public copy', async () => {
    const { service, pages, revisions, auditLogs } = createService();
    const liveContent = { slug: 'home', title: 'Current', pageType: 'landing', audience: 'public', locale: 'en', bodyMarkdown: 'Current public copy', summary: '', sections: [], seo: {}, tags: [] };
    const document = pageDoc({ status: 'published', publishedContent: liveContent, bodyMarkdown: 'Current public copy', __v: 3 });
    pages.findOne.mockReturnValue(query(document));
    revisions.findOne.mockReturnValue(query({ revisionId: 'revision-old', pageId: 'page-1', version: 1, digest: 'digest', publishedAt: new Date(), publishedByUserId: 'admin-1', content: { ...liveContent, bodyMarkdown: 'Older copy' } }));
    const restored = await service.restorePageRevision('page-1', 'revision-old', 3, adminUser());
    expect(restored.bodyMarkdown).toBe('Older copy');
    expect((await service.getPublicPage('home')).bodyMarkdown).toBe('Current public copy');
    expect(revisions.findOne).toHaveBeenCalledWith({ pageId: 'page-1', revisionId: 'revision-old' });
    expect(revisions.create).not.toHaveBeenCalled();
    expect(auditLogs.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'cms.page.revision_restored' }));
    expect(JSON.stringify(auditLogs.record.mock.calls)).not.toContain('Older copy');
  });

  it('restores an archived publication to an unpublished draft', async () => {
    const { service, pages, revisions } = createService();
    const document = pageDoc({ status: 'archived', archivedAt: new Date(), __v: 3 });
    pages.findOne.mockReturnValue(query(document));
    revisions.findOne.mockReturnValue(query({ revisionId: 'old', pageId: 'page-1', version: 1, digest: 'digest', publishedAt: new Date(), publishedByUserId: 'admin-1', content: { slug: 'home', title: 'Restored', pageType: 'landing', audience: 'public', locale: 'en', sections: [], seo: {}, tags: [] } }));
    const restored = await service.restorePageRevision('page-1', 'old', 3, adminUser());
    expect(restored.status).toBe('draft'); expect(restored.archivedAt).toBeUndefined();
    expect(revisions.create).not.toHaveBeenCalled();
  });

  it('rejects non-admin publication history and malformed sections', async () => {
    const { service, revisions } = createService();
    await expect(service.listPageRevisions('page-1', {}, studentUser())).rejects.toBeInstanceOf(ForbiddenException);
    expect(revisions.find).not.toHaveBeenCalled();
    await expect(service.createAdminPage({ title: 'Bad section', slug: 'bad-section', sections: [null] as never }, adminUser())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate slug, locale, and audience combinations', async () => {
    const { service, pages } = createService();
    pages.create.mockRejectedValue({ code: 11000 });

    let thrown: unknown;
    try {
      await service.createAdminPage({ slug: 'home', title: 'Home' }, adminUser());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('rejects unsafe CMS URLs', async () => {
    const { service } = createService();

    let thrown: unknown;
    try {
      await service.createAdminPage(
        {
          slug: 'home',
          title: 'Home',
          sections: [{ type: 'cta', title: 'Bad link', links: [{ label: 'Click', url: 'javascript:alert(1)' }] }]
        },
        adminUser()
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
  });
});

function createService() {
  const findChain = queryChain([]);
  const transaction = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn(async () => undefined) };
  const revisions: any = { create: jest.fn(async () => []), find: jest.fn(() => queryChain([])), countDocuments: jest.fn(() => query(0)), findOne: jest.fn(() => query(null)) };
  const pages: any = {
    db: { startSession: jest.fn(async () => transaction) },
    create: jest.fn(),
    find: jest.fn((_filter?: unknown) => findChain),
    findOne: jest.fn((_filter?: unknown) => query(pageDoc())),
    countDocuments: jest.fn((_filter?: unknown) => query(0))
  };
  const auditLogs = {
    record: jest.fn().mockResolvedValue(undefined)
  };
  return {
    service: new CmsService(pages as never, auditLogs as never, revisions as never),
    pages,
    auditLogs,
    findChain, revisions, transaction
  };
}

function adminUser(): AuthenticatedUser {
  return {
    sub: 'admin-1',
    email: 'admin@example.test',
    roles: ['ADMIN'],
    permissions: [],
    tokenId: 'token-1'
  };
}

function studentUser(): AuthenticatedUser {
  return {
    sub: 'student-1',
    email: 'student@example.test',
    roles: ['STUDENT'],
    permissions: [],
    tokenId: 'token-1'
  };
}

function pageDoc(overrides: Record<string, unknown> = {}) {
  return {
    pageId: 'page-1',
    slug: 'home',
    title: 'Home',
    pageType: 'landing',
    status: 'draft',
    audience: 'public',
    locale: 'en',
    summary: 'Homepage copy',
    bodyMarkdown: 'Welcome',
    sections: [],
    seo: {},
    tags: [],
    createdByUserId: 'admin-1',
    updatedByUserId: 'admin-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function query<T>(value: T) {
  return {
    session: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value)
  };
}

function queryChain<T>(value: T) {
  const chain = {
    session: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value)
  };
  return chain;
}
