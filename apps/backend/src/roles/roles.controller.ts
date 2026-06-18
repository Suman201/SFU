import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AssignRolePermissionsDto, CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post()
  @Permissions('roles:create')
  @ApiOperation({ summary: 'Create a role' })
  create(@Body() dto: CreateRoleDto, @CurrentUser() actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.roles.create(dto, actor.sub);
  }

  @Get()
  @Permissions('roles:read')
  @ApiOperation({ summary: 'List roles' })
  findAll(): Promise<Record<string, unknown>[]> {
    return this.roles.findAll();
  }

  @Get(':id')
  @Permissions('roles:read')
  @ApiOperation({ summary: 'Get a role' })
  findOne(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.roles.findOne(id);
  }

  @Patch(':id')
  @Permissions('roles:update')
  @ApiOperation({ summary: 'Update a role' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.roles.update(id, dto, actor.sub);
  }

  @Delete(':id')
  @Permissions('roles:delete')
  @ApiOperation({ summary: 'Delete a role' })
  remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.roles.remove(id, actor.sub);
  }

  @Post(':id/permissions')
  @Permissions('permissions:assign')
  @ApiOperation({ summary: 'Replace role permissions' })
  assignPermissions(@Param('id') id: string, @Body() dto: AssignRolePermissionsDto, @CurrentUser() actor: AuthenticatedUser): Promise<Record<string, unknown>[]> {
    return this.roles.assignPermissions(id, dto, actor.sub);
  }

  @Get(':id/permissions')
  @Permissions('permissions:read')
  @ApiOperation({ summary: 'List permissions assigned to a role' })
  getPermissions(@Param('id') id: string): Promise<Record<string, unknown>[]> {
    return this.roles.getPermissions(id);
  }
}
