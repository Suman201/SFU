import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateSupportRequestRequest,
  SupportRequest,
  SupportRequestListQuery,
  SupportRequestListResponse,
  SupportRequestStatus,
  SupportIssueType,
  UpdateSupportRequestRequest
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupportService } from './support.service';

interface SupportRequestQueryParams {
  page?: string;
  limit?: string;
  status?: SupportRequestStatus | 'all';
  issueType?: SupportIssueType | 'all';
  batchId?: string;
  sessionId?: string;
  studentId?: string;
  search?: string;
}

@ApiTags('support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('support/requests')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @Roles('STUDENT')
  @ApiOperation({ summary: 'Create a student support request' })
  create(@Body() body: CreateSupportRequestRequest, @CurrentUser() user: AuthenticatedUser): Promise<SupportRequest> {
    return this.support.createStudentRequest(user, body);
  }

  @Get()
  @Roles('STUDENT')
  @ApiOperation({ summary: 'List support requests for the current student' })
  list(@Query() query: SupportRequestQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<SupportRequestListResponse> {
    return this.support.listStudentRequests(user, this.toQuery(query, false));
  }

  @Get(':requestId')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'Read one support request owned by the current student' })
  get(@Param('requestId') requestId: string, @CurrentUser() user: AuthenticatedUser): Promise<SupportRequest> {
    return this.support.getStudentRequest(user, requestId);
  }

  private toQuery(query: SupportRequestQueryParams, includeStudentId: boolean): SupportRequestListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.issueType ? { issueType: query.issueType } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(includeStudentId && query.studentId ? { studentId: query.studentId } : {}),
      ...(query.search ? { search: query.search } : {})
    };
  }
}

@ApiTags('admin support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/support-requests')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List student support requests for admin triage' })
  list(@Query() query: SupportRequestQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<SupportRequestListResponse> {
    return this.support.listAdminRequests(user, this.toQuery(query));
  }

  @Get(':requestId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Read a student support request for admin triage' })
  get(@Param('requestId') requestId: string, @CurrentUser() user: AuthenticatedUser): Promise<SupportRequest> {
    return this.support.getAdminRequest(user, requestId);
  }

  @Patch(':requestId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update status or respond to a student support request' })
  update(
    @Param('requestId') requestId: string,
    @Body() body: UpdateSupportRequestRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<SupportRequest> {
    return this.support.updateAdminRequest(user, requestId, body);
  }

  private toQuery(query: SupportRequestQueryParams): SupportRequestListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.issueType ? { issueType: query.issueType } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.search ? { search: query.search } : {})
    };
  }
}
