import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateUserDto, UpdateUserDto, UpdateUserStatusDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @Permissions('users:create')
  @ApiOperation({ summary: 'Create a user' })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.users.create(dto, actor);
  }

  @Get()
  @Permissions('users:read')
  @ApiOperation({ summary: 'List users' })
  findAll(): Promise<Record<string, unknown>[]> {
    return this.users.findAll();
  }

  @Get(':id')
  @Permissions('users:read')
  @ApiOperation({ summary: 'Get a user by id' })
  findOne(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.users.findOne(id);
  }

  @Patch(':id')
  @Permissions('users:update')
  @ApiOperation({ summary: 'Update a user' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.users.update(id, dto, actor);
  }

  @Patch(':id/status')
  @Permissions('users:update')
  @ApiOperation({ summary: 'Update user status' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto, @CurrentUser() actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.users.updateStatus(id, dto, actor);
  }

  @Delete(':id')
  @Permissions('users:delete')
  @ApiOperation({ summary: 'Soft delete a user' })
  remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    return this.users.remove(id, actor);
  }
}
