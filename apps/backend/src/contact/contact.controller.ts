import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ContactSubmission,
  ContactSubmissionAck,
  ContactSubmissionCategory,
  ContactSubmissionListQuery,
  ContactSubmissionListResponse,
  ContactSubmissionPriority,
  ContactSubmissionStatus,
  CreateContactSubmissionRequest,
  ReplyToContactSubmissionRequest,
  UpdateContactSubmissionRequest
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ContactInboxService } from './contact-inbox.service';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface ContactSubmissionQueryParams {
  page?: string;
  limit?: string;
  status?: ContactSubmissionStatus | 'all';
  category?: ContactSubmissionCategory | 'all';
  priority?: ContactSubmissionPriority | 'all';
  assignedToUserId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

@ApiTags('contact')
@Controller('contact/submissions')
export class ContactController {
  constructor(private readonly contactInbox: ContactInboxService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a public Contact Us request' })
  create(@Body() body: CreateContactSubmissionRequest, @Req() request: RequestLike): Promise<ContactSubmissionAck> {
    return this.contactInbox.createPublicSubmission(body, {
      userAgent: this.header(request, 'user-agent'),
      ipAddress: this.header(request, 'x-forwarded-for')?.split(',')[0]?.trim() || request.ip || request.socket?.remoteAddress
    });
  }

  private header(request: RequestLike, key: string): string | undefined {
    const value = request.headers[key];
    return Array.isArray(value) ? value[0] : value;
  }
}

@ApiTags('admin contact inbox')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/contact/submissions')
export class AdminContactController {
  constructor(private readonly contactInbox: ContactInboxService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List public contact submissions for administrators' })
  list(@Query() query: ContactSubmissionQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<ContactSubmissionListResponse> {
    return this.contactInbox.listAdminSubmissions(user, this.toQuery(query));
  }

  @Get(':submissionId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Read one contact submission for administrators' })
  get(@Param('submissionId') submissionId: string, @CurrentUser() user: AuthenticatedUser): Promise<ContactSubmission> {
    return this.contactInbox.getAdminSubmission(user, submissionId);
  }

  @Patch(':submissionId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update contact submission status, priority, assignee, or notes' })
  update(
    @Param('submissionId') submissionId: string,
    @Body() body: UpdateContactSubmissionRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ContactSubmission> {
    return this.contactInbox.updateAdminSubmission(user, submissionId, body);
  }

  @Post(':submissionId/reply')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Reply to a contact submission' })
  reply(
    @Param('submissionId') submissionId: string,
    @Body() body: ReplyToContactSubmissionRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ContactSubmission> {
    return this.contactInbox.replyToSubmission(user, submissionId, body);
  }

  @Post(':submissionId/archive')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Archive a contact submission' })
  archive(@Param('submissionId') submissionId: string, @CurrentUser() user: AuthenticatedUser): Promise<ContactSubmission> {
    return this.contactInbox.archiveSubmission(user, submissionId);
  }

  @Post(':submissionId/mark-spam')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Mark a contact submission as spam' })
  markSpam(@Param('submissionId') submissionId: string, @CurrentUser() user: AuthenticatedUser): Promise<ContactSubmission> {
    return this.contactInbox.markSpam(user, submissionId);
  }

  private toQuery(query: ContactSubmissionQueryParams): ContactSubmissionListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.assignedToUserId ? { assignedToUserId: query.assignedToUserId } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {})
    };
  }
}
