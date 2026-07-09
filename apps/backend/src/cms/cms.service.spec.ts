import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  const pages: any = {
    create: jest.fn(),
    find: jest.fn((_filter?: unknown) => findChain),
    findOne: jest.fn((_filter?: unknown) => query(pageDoc())),
    countDocuments: jest.fn((_filter?: unknown) => query(0))
  };
  const auditLogs = {
    record: jest.fn().mockResolvedValue(undefined)
  };
  return {
    service: new CmsService(pages as never, auditLogs as never),
    pages,
    auditLogs,
    findChain
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
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value)
  };
}

function queryChain<T>(value: T) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value)
  };
  return chain;
}
