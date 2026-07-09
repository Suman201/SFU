export const CMS_PAGE_STATUSES = ['draft', 'published', 'archived'] as const;
export type CmsPageStatus = (typeof CMS_PAGE_STATUSES)[number];

export const CMS_PAGE_TYPES = ['page', 'legal', 'faq', 'landing', 'announcement', 'banner'] as const;
export type CmsPageType = (typeof CMS_PAGE_TYPES)[number];

export const CMS_AUDIENCES = ['public', 'student', 'teacher', 'admin', 'all'] as const;
export type CmsAudience = (typeof CMS_AUDIENCES)[number];

export const CMS_BLOCK_TYPES = [
  'hero',
  'rich_text',
  'faq_list',
  'feature_grid',
  'cta',
  'contact_info',
  'link_list',
  'announcement',
  'legal_text',
  'marketplace_intro'
] as const;
export type CmsBlockType = (typeof CMS_BLOCK_TYPES)[number];

export interface CmsLink {
  label: string;
  url: string;
  variant?: 'primary' | 'secondary' | 'link';
}

export interface CmsBlockItem {
  title?: string;
  body?: string;
  label?: string;
  url?: string;
  imageUrl?: string;
}

export interface CmsPageBlock {
  blockId?: string;
  type: CmsBlockType;
  title?: string;
  eyebrow?: string;
  body?: string;
  imageUrl?: string;
  links?: CmsLink[];
  items?: CmsBlockItem[];
}

export interface CmsSeoMetadata {
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
}

export interface CmsPage {
  pageId: string;
  slug: string;
  title: string;
  pageType: CmsPageType;
  status: CmsPageStatus;
  audience: CmsAudience;
  locale?: string;
  summary?: string;
  bodyMarkdown?: string;
  sections: CmsPageBlock[];
  seo?: CmsSeoMetadata;
  tags: string[];
  publishedAt?: string;
  publishedByUserId?: string;
  archivedAt?: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CmsPageListQuery {
  status?: CmsPageStatus | 'all';
  pageType?: CmsPageType | 'all';
  audience?: CmsAudience | 'all';
  locale?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CmsPageListResponse {
  items: CmsPage[];
  page: number;
  limit: number;
  total: number;
}

export interface CmsPageWriteRequest {
  slug?: string;
  title?: string;
  pageType?: CmsPageType;
  audience?: CmsAudience;
  locale?: string;
  summary?: string;
  bodyMarkdown?: string;
  sections?: CmsPageBlock[];
  seo?: CmsSeoMetadata;
  tags?: string[];
}

export interface CmsPublicPageQuery {
  audience?: CmsAudience | 'all';
  locale?: string;
  pageType?: CmsPageType | 'all';
}
