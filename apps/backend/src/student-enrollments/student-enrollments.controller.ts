import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  BatchRosterQueryDto,
  BulkCreateStudentEnrollmentDto,
  CreateStudentEnrollmentDto,
  StudentEnrollmentBatchQueryDto,
  UpdateStudentEnrollmentStatusDto
} from './dto/student-enrollment.dto';
import { StudentEnrolledBatch, StudentEnrollmentsService, StudentEnrollmentRosterItem } from './student-enrollments.service';

@ApiTags('student enrollments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('student-enrollments')
export class StudentEnrollmentsController {
  constructor(private readonly enrollments: StudentEnrollmentsService) {}

  @Get('me/batches')
  @Roles('STUDENT')
  @ApiOperation({ summary: "List the logged-in student's enrolled batches" })
  listMyBatches(@CurrentUser() user: AuthenticatedUser, @Query() query: StudentEnrollmentBatchQueryDto): Promise<StudentEnrolledBatch[]> {
    return this.enrollments.listStudentBatches(user.sub, { status: query.status });
  }

  @Get('batches')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'List active batches available to the logged-in student' })
  listAvailableBatches(@CurrentUser() user: AuthenticatedUser): Promise<StudentEnrolledBatch[]> {
    return this.enrollments.listAvailableBatches(user.sub);
  }

  @Post('me/batches/:batchId')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'Enroll the logged-in student into an active batch' })
  enrollMe(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<StudentEnrolledBatch> {
    return this.enrollments.selfEnrollStudent(user, batchId);
  }

  @Delete('me/batches/:batchId')
  @Roles('STUDENT')
  @ApiOperation({ summary: "Cancel the logged-in student's active enrollment in a batch" })
  leaveBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.selfCancelStudentEnrollment(user, batchId);
  }

  @Get('batches/:batchId/roster')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List enrolled students for a batch' })
  async listBatchRoster(
    @Param('batchId') batchId: string,
    @Query() query: BatchRosterQueryDto,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<StudentEnrollmentRosterItem[]> {
    await this.enrollments.assertCanViewRoster(batchId, user);
    const includeInactive = query.includeInactive === true || String(query.includeInactive).toLowerCase() === 'true';
    return this.enrollments.listBatchRoster(batchId, { includeInactive });
  }

  @Post()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Enroll a student into a batch' })
  create(@Body() body: CreateStudentEnrollmentDto, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.enrollStudent({
      studentId: body.studentId,
      batchId: body.batchId,
      status: body.status,
      actorUserId: user.sub
    });
  }

  @Post('bulk')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Enroll multiple students into a batch' })
  bulkCreate(@Body() body: BulkCreateStudentEnrollmentDto, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>[]> {
    return this.enrollments.bulkEnrollStudents({
      batchId: body.batchId,
      studentIds: body.studentIds,
      status: body.status,
      actorUserId: user.sub
    });
  }

  @Patch(':id/status')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update a student enrollment status' })
  updateStatus(@Param('id') id: string, @Body() body: UpdateStudentEnrollmentStatusDto, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.updateEnrollmentStatus(id, body.status, user.sub);
  }

  @Patch(':id/cancel')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Cancel a student enrollment' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.cancelEnrollment(id, user.sub);
  }

  @Patch(':id/suspend')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Suspend a student enrollment' })
  suspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.suspendEnrollment(id, user.sub);
  }

  @Patch(':id/reactivate')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Reactivate a student enrollment' })
  reactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.reactivateEnrollment(id, user.sub);
  }

  @Patch(':id/complete')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Complete a student enrollment' })
  complete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.enrollments.completeEnrollment(id, user.sub);
  }
}
