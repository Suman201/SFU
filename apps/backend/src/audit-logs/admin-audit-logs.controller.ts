import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminAuditLogDetail, AdminAuditLogListResponse, AdminAuditLogQuery, AdminAuditLogStatus } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuditLogsService } from './audit-logs.service';

interface AdminAuditLogQueryParams {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  status?: AdminAuditLogStatus | 'all';
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page?: string;
  limit?: string;
}

@ApiTags('admin audit logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List platform audit logs for administrators' })
  listAuditLogs(@Query() query: AdminAuditLogQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminAuditLogListResponse> {
    return this.auditLogs.listAdminAuditLogs(this.toListQuery(query), user);
  }

  @Get(':auditLogId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get one platform audit log for administrators' })
  getAuditLog(@Param('auditLogId') auditLogId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminAuditLogDetail> {
    return this.auditLogs.getAdminAuditLog(auditLogId, user);
  }

  private toListQuery(query: AdminAuditLogQueryParams): AdminAuditLogQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
