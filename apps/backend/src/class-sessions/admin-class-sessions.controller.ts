import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminClassSessionReportQuery, AdminClassSessionReportResponse, AdminClassSessionReportRow } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassSessionsService } from './class-sessions.service';

interface AdminClassSessionReportQueryParams {
  status?: AdminClassSessionReportQuery['status'];
  teacherId?: string;
  batchId?: string;
  courseId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
  limit?: string;
}

@ApiTags('admin class sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/class-sessions')
export class AdminClassSessionsController {
  constructor(private readonly classSessions: ClassSessionsService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List class session reports for administrators' })
  listReports(
    @Query() query: AdminClassSessionReportQueryParams,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminClassSessionReportResponse> {
    return this.classSessions.listAdminClassSessionReports(this.toReportQuery(query), user);
  }

  @Get(':sessionId/attendance.csv')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="class-session-attendance.csv"')
  @ApiOperation({ summary: 'Download class session attendance CSV as an administrator' })
  downloadAttendance(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser): Promise<string> {
    return this.classSessions.exportAttendanceCsv(sessionId, undefined, user);
  }

  @Get(':sessionId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get one class session report for administrators' })
  getReport(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminClassSessionReportRow> {
    return this.classSessions.getAdminClassSessionReport(sessionId, user);
  }

  private toReportQuery(query: AdminClassSessionReportQueryParams): AdminClassSessionReportQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
