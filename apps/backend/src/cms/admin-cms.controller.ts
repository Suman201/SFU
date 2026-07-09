import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CmsPage, CmsPageListQuery, CmsPageListResponse, CmsPageStatus, CmsPageWriteRequest } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CmsService } from './cms.service';

interface CmsPageQueryParams {
  status?: CmsPageStatus | 'all';
  pageType?: string;
  audience?: string;
  locale?: string;
  search?: string;
  page?: string;
  limit?: string;
}

@ApiTags('admin cms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/cms/pages')
export class AdminCmsController {
  constructor(private readonly cms: CmsService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List CMS pages for administrators' })
  listPages(@Query() query: CmsPageQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<CmsPageListResponse> {
    return this.cms.listAdminPages(this.toListQuery(query), user);
  }

  @Post()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Create a CMS page draft' })
  createPage(@Body() body: CmsPageWriteRequest, @CurrentUser() user: AuthenticatedUser): Promise<CmsPage> {
    return this.cms.createAdminPage(body, user);
  }

  @Get(':pageId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get one CMS page for administrators' })
  getPage(@Param('pageId') pageId: string, @CurrentUser() user: AuthenticatedUser): Promise<CmsPage> {
    return this.cms.getAdminPage(pageId, user);
  }

  @Patch(':pageId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update a CMS page' })
  updatePage(@Param('pageId') pageId: string, @Body() body: CmsPageWriteRequest, @CurrentUser() user: AuthenticatedUser): Promise<CmsPage> {
    return this.cms.updateAdminPage(pageId, body, user);
  }

  @Post(':pageId/publish')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Publish a CMS page' })
  publishPage(@Param('pageId') pageId: string, @CurrentUser() user: AuthenticatedUser): Promise<CmsPage> {
    return this.cms.publishAdminPage(pageId, user);
  }

  @Post(':pageId/unpublish')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Unpublish a CMS page back to draft' })
  unpublishPage(@Param('pageId') pageId: string, @CurrentUser() user: AuthenticatedUser): Promise<CmsPage> {
    return this.cms.unpublishAdminPage(pageId, user);
  }

  @Post(':pageId/archive')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Archive a CMS page' })
  archivePage(@Param('pageId') pageId: string, @CurrentUser() user: AuthenticatedUser): Promise<CmsPage> {
    return this.cms.archiveAdminPage(pageId, user);
  }

  private toListQuery(query: CmsPageQueryParams): CmsPageListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.pageType ? { pageType: query.pageType as CmsPageListQuery['pageType'] } : {}),
      ...(query.audience ? { audience: query.audience as CmsPageListQuery['audience'] } : {}),
      ...(query.locale ? { locale: query.locale } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
