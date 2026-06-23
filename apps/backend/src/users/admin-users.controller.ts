import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AdminUserActionResponse,
  AdminUserDetail,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserSort,
  AdminUserStatus,
  AdminUserUpdateRequest
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UsersService } from './users.service';

interface AdminUserQueryParams {
  role?: AdminUserListQuery['role'];
  status?: AdminUserStatus | 'all';
  search?: string;
  page?: string;
  limit?: string;
  sort?: AdminUserSort;
}

@ApiTags('admin users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List users for administrators' })
  listUsers(@Query() query: AdminUserQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminUserListResponse> {
    return this.users.listAdminUsers(this.toListQuery(query), user);
  }

  @Get(':userId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get a user for administrators' })
  getUser(@Param('userId') userId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminUserDetail> {
    return this.users.getAdminUser(userId, user);
  }

  @Patch(':userId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update a user as an administrator' })
  updateUser(
    @Param('userId') userId: string,
    @Body() body: AdminUserUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminUserDetail> {
    return this.users.updateAdminUser(userId, body, user);
  }

  @Post(':userId/activate')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Activate a user account as an administrator' })
  activateUser(@Param('userId') userId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminUserActionResponse> {
    return this.users.activateAdminUser(userId, user);
  }

  @Post(':userId/deactivate')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Deactivate a user account as an administrator' })
  deactivateUser(@Param('userId') userId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminUserActionResponse> {
    return this.users.deactivateAdminUser(userId, user);
  }

  private toListQuery(query: AdminUserQueryParams): AdminUserListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
