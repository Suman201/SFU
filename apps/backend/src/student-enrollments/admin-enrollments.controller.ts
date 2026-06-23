import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AdminCreateEnrollmentRequest,
  AdminEnrollmentDetail,
  AdminEnrollmentListQuery,
  AdminEnrollmentListResponse,
  AdminUpdateEnrollmentRequest
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { StudentEnrollmentStatus } from '../database/schemas';
import { StudentEnrollmentsService } from './student-enrollments.service';

interface AdminEnrollmentQueryParams {
  courseId?: string;
  batchId?: string;
  studentId?: string;
  status?: AdminEnrollmentListQuery['status'];
  search?: string;
  page?: string;
  limit?: string;
}

@ApiTags('admin enrollments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/enrollments')
export class AdminEnrollmentsController {
  constructor(private readonly enrollments: StudentEnrollmentsService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List student enrollments across batches for administrators' })
  listEnrollments(
    @Query() query: AdminEnrollmentQueryParams,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminEnrollmentListResponse> {
    return this.enrollments.listAdminEnrollments(this.toListQuery(query), user);
  }

  @Get(':enrollmentId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get a student enrollment for administrators' })
  getEnrollment(@Param('enrollmentId') enrollmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.enrollments.getAdminEnrollment(enrollmentId, user);
  }

  @Post()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Create a student enrollment as an administrator' })
  createEnrollment(@Body() body: AdminCreateEnrollmentRequest, @CurrentUser() user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.enrollments.createAdminEnrollment(body, user);
  }

  @Patch(':enrollmentId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update a student enrollment as an administrator' })
  updateEnrollment(
    @Param('enrollmentId') enrollmentId: string,
    @Body() body: AdminUpdateEnrollmentRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminEnrollmentDetail> {
    return this.enrollments.updateAdminEnrollment(enrollmentId, body, user);
  }

  @Patch(':enrollmentId/cancel')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Cancel a student enrollment as an administrator' })
  cancelEnrollment(@Param('enrollmentId') enrollmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.transition(enrollmentId, 'cancelled', user);
  }

  @Patch(':enrollmentId/suspend')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Suspend a student enrollment as an administrator' })
  suspendEnrollment(@Param('enrollmentId') enrollmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.transition(enrollmentId, 'suspended', user);
  }

  @Patch(':enrollmentId/reactivate')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Reactivate a student enrollment as an administrator' })
  reactivateEnrollment(@Param('enrollmentId') enrollmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.transition(enrollmentId, 'active', user);
  }

  @Patch(':enrollmentId/complete')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Complete a student enrollment as an administrator' })
  completeEnrollment(@Param('enrollmentId') enrollmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.transition(enrollmentId, 'completed', user);
  }

  private transition(enrollmentId: string, status: StudentEnrollmentStatus, user: AuthenticatedUser): Promise<AdminEnrollmentDetail> {
    return this.enrollments.transitionAdminEnrollment(enrollmentId, status, user);
  }

  private toListQuery(query: AdminEnrollmentQueryParams): AdminEnrollmentListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
