import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CmsPage, CmsPageListQuery, CmsPageListResponse } from '@native-sfu/contracts';
import { CmsService } from './cms.service';

interface CmsPublicQueryParams {
  locale?: string;
  pageType?: string;
  page?: string;
  limit?: string;
}

@ApiTags('cms')
@Controller('cms/pages')
export class CmsPublicController {
  constructor(private readonly cms: CmsService) {}

  @Get()
  @ApiOperation({ summary: 'List published public CMS pages' })
  listPublishedPages(@Query() query: CmsPublicQueryParams): Promise<CmsPageListResponse> {
    return this.cms.listPublicPages(this.toListQuery(query));
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a published public CMS page by slug' })
  getPublishedPage(@Param('slug') slug: string, @Query('locale') locale?: string): Promise<CmsPage> {
    return this.cms.getPublicPage(slug, { locale });
  }

  private toListQuery(query: CmsPublicQueryParams): CmsPageListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.locale ? { locale: query.locale } : {}),
      ...(query.pageType ? { pageType: query.pageType as CmsPageListQuery['pageType'] } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
