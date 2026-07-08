import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TeacherAnalyticsQuery, TeacherAnalyticsResponse } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassSessionsService } from './class-sessions.service';

interface TeacherAnalyticsQueryParams {
  batchId?: string;
  courseId?: string;
  studentId?: string;
  dateFrom?: string;
  dateTo?: string;
}

@ApiTags('teacher analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('teacher/analytics')
export class TeacherAnalyticsController {
  constructor(private readonly classSessions: ClassSessionsService) {}

  @Get()
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get deterministic learning analytics for teacher-owned batches' })
  getAnalytics(@Query() query: TeacherAnalyticsQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<TeacherAnalyticsResponse> {
    return this.classSessions.getTeacherAnalytics(this.toQuery(query), user);
  }

  private toQuery(query: TeacherAnalyticsQueryParams): TeacherAnalyticsQuery {
    return {
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {})
    };
  }
}

@ApiTags('admin teacher analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/teacher-analytics')
export class AdminTeacherAnalyticsController {
  constructor(private readonly classSessions: ClassSessionsService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get deterministic teacher analytics across batches for admins' })
  getAnalytics(@Query() query: TeacherAnalyticsQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<TeacherAnalyticsResponse> {
    return this.classSessions.getTeacherAnalytics(
      {
        ...(query.batchId ? { batchId: query.batchId } : {}),
        ...(query.courseId ? { courseId: query.courseId } : {}),
        ...(query.studentId ? { studentId: query.studentId } : {}),
        ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
        ...(query.dateTo ? { dateTo: query.dateTo } : {})
      },
      user
    );
  }
}
