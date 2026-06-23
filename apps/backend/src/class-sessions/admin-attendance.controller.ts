import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AdminAttendanceQuery,
  AdminAttendanceSessionsResponse,
  AdminAttendanceStudentsResponse,
  AdminAttendanceSummary,
  AdminAttendanceTrendsResponse
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassSessionsService } from './class-sessions.service';

interface AdminAttendanceQueryParams {
  courseId?: string;
  batchId?: string;
  teacherId?: string;
  status?: AdminAttendanceQuery['status'];
  dateFrom?: string;
  dateTo?: string;
  page?: string;
  limit?: string;
}

@ApiTags('admin attendance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/attendance')
export class AdminAttendanceController {
  constructor(private readonly classSessions: ClassSessionsService) {}

  @Get('summary')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get aggregate class-session attendance analytics' })
  getSummary(@Query() query: AdminAttendanceQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminAttendanceSummary> {
    return this.classSessions.getAdminAttendanceSummary(this.toAttendanceQuery(query), user);
  }

  @Get('sessions')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List class-session attendance analytics by session' })
  listSessions(@Query() query: AdminAttendanceQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminAttendanceSessionsResponse> {
    return this.classSessions.listAdminAttendanceSessions(this.toAttendanceQuery(query), user);
  }

  @Get('students')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List class-session attendance analytics by student' })
  listStudents(@Query() query: AdminAttendanceQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminAttendanceStudentsResponse> {
    return this.classSessions.listAdminAttendanceStudents(this.toAttendanceQuery(query), user);
  }

  @Get('trends')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get daily class-session attendance trends' })
  getTrends(@Query() query: AdminAttendanceQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminAttendanceTrendsResponse> {
    return this.classSessions.getAdminAttendanceTrends(this.toAttendanceQuery(query), user);
  }

  @Get('export.csv')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="attendance-analytics.csv"')
  @ApiOperation({ summary: 'Download filtered class-session attendance analytics as CSV' })
  exportCsv(@Query() query: AdminAttendanceQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<string> {
    return this.classSessions.exportAdminAttendanceCsv(this.toAttendanceQuery(query), user);
  }

  private toAttendanceQuery(query: AdminAttendanceQueryParams): AdminAttendanceQuery {
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
