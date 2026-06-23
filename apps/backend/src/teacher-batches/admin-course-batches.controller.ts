import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AdminBatchCreateRequest,
  AdminBatchDetail,
  AdminBatchListQuery,
  AdminBatchListResponse,
  AdminBatchRosterResponse,
  AdminBatchSessionListResponse,
  AdminBatchSort,
  AdminBatchStatus,
  AdminBatchUpdateRequest,
  AdminCourseDetail,
  AdminCourseListQuery,
  AdminCourseListResponse,
  AdminCourseSort,
  AdminCourseStatus,
  AdminCourseUpdateRequest
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { TeacherBatchesService } from './teacher-batches.service';

interface AdminCourseQueryParams {
  status?: AdminCourseStatus | 'all';
  search?: string;
  sort?: AdminCourseSort;
  page?: string;
  limit?: string;
}

interface AdminBatchQueryParams {
  courseId?: string;
  teacherId?: string;
  status?: AdminBatchStatus | 'all';
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: AdminBatchSort;
  page?: string;
  limit?: string;
}

@ApiTags('admin courses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/courses')
export class AdminCoursesController {
  constructor(private readonly batches: TeacherBatchesService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List course aggregates for administrators' })
  listCourses(@Query() query: AdminCourseQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminCourseListResponse> {
    return this.batches.listAdminCourses(this.toCourseQuery(query), user);
  }

  @Get(':courseId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get a course aggregate and its batches' })
  getCourse(@Param('courseId') courseId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminCourseDetail> {
    return this.batches.getAdminCourse(courseId, user);
  }

  @Patch(':courseId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Rename a course aggregate across its batches' })
  updateCourse(
    @Param('courseId') courseId: string,
    @Body() body: AdminCourseUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminCourseDetail> {
    return this.batches.updateAdminCourse(courseId, body, user);
  }

  @Post(':courseId/batches')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Create a batch under a course aggregate' })
  createBatch(
    @Param('courseId') courseId: string,
    @Body() body: AdminBatchCreateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminBatchDetail> {
    return this.batches.createAdminBatch(courseId, body, user);
  }

  private toCourseQuery(query: AdminCourseQueryParams): AdminCourseListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}

@ApiTags('admin batches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/batches')
export class AdminBatchesController {
  constructor(private readonly batches: TeacherBatchesService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List batches for administrators' })
  listBatches(@Query() query: AdminBatchQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchListResponse> {
    return this.batches.listAdminBatches(this.toBatchQuery(query), user);
  }

  @Get(':batchId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get a batch for administrators' })
  getBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchDetail> {
    return this.batches.getAdminBatch(batchId, user);
  }

  @Patch(':batchId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update a batch as an administrator' })
  updateBatch(
    @Param('batchId') batchId: string,
    @Body() body: AdminBatchUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminBatchDetail> {
    return this.batches.updateAdminBatch(batchId, body, user);
  }

  @Post(':batchId/activate')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Activate a batch' })
  activateBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchDetail> {
    return this.batches.updateAdminBatchStatus(batchId, 'ACTIVE', user);
  }

  @Post(':batchId/pause')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Pause a batch' })
  pauseBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchDetail> {
    return this.batches.updateAdminBatchStatus(batchId, 'INACTIVE', user);
  }

  @Post(':batchId/complete')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Complete a batch' })
  completeBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchDetail> {
    return this.batches.updateAdminBatchStatus(batchId, 'COMPLETED', user);
  }

  @Post(':batchId/cancel')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Cancel a batch' })
  cancelBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchDetail> {
    return this.batches.updateAdminBatchStatus(batchId, 'CANCELLED', user);
  }

  @Get(':batchId/roster')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List a batch roster as an administrator' })
  getBatchRoster(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchRosterResponse> {
    return this.batches.getAdminBatchRoster(batchId, user);
  }

  @Get(':batchId/sessions')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List planned and persisted class sessions for a batch' })
  getBatchSessions(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminBatchSessionListResponse> {
    return this.batches.getAdminBatchSessions(batchId, user);
  }

  private toBatchQuery(query: AdminBatchQueryParams): AdminBatchListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
