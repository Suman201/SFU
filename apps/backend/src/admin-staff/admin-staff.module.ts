import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ArrayMaxSize,
  ArrayUnique,
} from 'class-validator';
import { isValidObjectId, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  ADMIN_PORTAL_PERMISSIONS,
  type AdminStaffRole,
  type AdminStaffRoleInput,
} from '@native-sfu/contracts';
import { DatabaseModule } from '../database/database.module';
import {
  RoleDocument,
  RoleMongoDocument,
  UserDocument,
  UserMongoDocument,
} from '../database/schemas';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

class StaffRoleDto implements AdminStaffRoleInput {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsString() @MaxLength(500) description!: string;
  @IsIn(['active', 'inactive']) status!: 'active' | 'inactive';
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsIn(ADMIN_PORTAL_PERMISSIONS, { each: true })
  permissions!: AdminStaffRoleInput['permissions'];
  @IsOptional() @IsInt() @Min(0) version?: number;
}
class AssignmentDto {
  @IsOptional() @IsString() @MaxLength(24) roleId?: string | null;
  @IsOptional() @IsString() @MaxLength(24) expectedRoleId?: string | null;
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
@Injectable()
export class AdminStaffService {
  constructor(
    @InjectModel(RoleDocument.name)
    private readonly profiles: Model<RoleMongoDocument>,
    @InjectModel(UserDocument.name)
    private readonly users: Model<UserMongoDocument>,
    private readonly audit: AuditLogsService,
  ) {}
  private assertSuper(user: AuthenticatedUser) {
    if (!user.roles.includes('SUPER_ADMIN'))
      throw new ForbiddenException(
        'Only super admins can manage staff access.',
      );
  }
  private validate(body: StaffRoleDto) {
    if (body.name.trim().length < 2)
      throw new BadRequestException('Enter a role name.');
    if (!body.permissions.some((permission) => permission.endsWith(':read')))
      throw new BadRequestException('Select at least one view permission.');
    for (const permission of body.permissions) {
      const read = permission.replace(
        /:(?:write|restore|refund|reconcile)$/,
        ':read',
      );
      if (
        read !== permission &&
        !body.permissions.includes(read as (typeof body.permissions)[number])
      )
        throw new BadRequestException(
          'Each action also requires its module view permission.',
        );
    }
    if (body.permissions.includes('admin:system:access'))
      throw new BadRequestException(
        'System-wide access is reserved for unrestricted administrators.',
      );
  }
  async roles(user: AuthenticatedUser): Promise<AdminStaffRole[]> {
    this.assertSuper(user);
    const roles = await this.profiles
      .find({ isSystem: false, adminPermissionSlugs: { $exists: true } })
      .sort({ name: 1 });
    return Promise.all(
      roles.map(async (role) => ({
        id: role.id,
        name: role.name,
        slug: role.slug,
        description: role.description ?? '',
        status: role.status,
        version: role.adminVersion ?? 0,
        permissions: role.adminPermissionSlugs as AdminStaffRole['permissions'],
        assignedUsers: await this.users.countDocuments({
          adminRoleId: role.id,
          deletedAt: { $exists: false },
        }),
      })),
    );
  }
  async save(user: AuthenticatedUser, body: StaffRoleDto, id?: string) {
    this.assertSuper(user);
    this.validate(body);
    if (id && (!isValidObjectId(id) || !Number.isInteger(body.version)))
      throw new BadRequestException(
        'The role ID and current version are required.',
      );
    const value = {
      name: body.name.trim(),
      description: body.description.trim(),
      status: body.status,
      adminPermissionSlugs: body.permissions,
    };
    const role = id
      ? await this.profiles.findOneAndUpdate(
          {
            _id: id,
            isSystem: false,
            adminPermissionSlugs: { $exists: true },
            adminVersion: body.version,
          },
          { $set: value, $inc: { adminVersion: 1 } },
          { new: true },
        )
      : await this.profiles.create({
          ...value,
          slug: 'staff_' + randomUUID().replaceAll('-', ''),
          isSystem: false,
          adminVersion: 0,
        });
    if (!role)
      throw new ConflictException(
        'This access role changed. Reload before saving.',
      );
    await this.audit.record({
      actor: user,
      action: id ? 'admin.staff.role_updated' : 'admin.staff.role_created',
      targetType: 'role',
      targetId: role.id,
      metadata: { permissions: body.permissions, status: body.status },
    });
    return (await this.roles(user)).find((item) => item.id === role.id);
  }
  async remove(user: AuthenticatedUser, id: string) {
    this.assertSuper(user);
    if (!isValidObjectId(id))
      throw new BadRequestException('Invalid access role ID.');
    if (
      await this.users.exists({
        adminRoleId: id,
        deletedAt: { $exists: false },
      })
    )
      throw new ConflictException(
        'Reassign every staff member before deleting this role.',
      );
    const removed = await this.profiles.findOneAndDelete({
      _id: id,
      isSystem: false,
      adminPermissionSlugs: { $exists: true },
    });
    if (!removed) throw new NotFoundException('Managed access role not found.');
    await this.audit.record({
      actor: user,
      action: 'admin.staff.role_deleted',
      targetType: 'role',
      targetId: id,
    });
    return { deleted: true };
  }
  async members(user: AuthenticatedUser, search = '', pageText = '1') {
    this.assertSuper(user);
    const page = Number(pageText);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      search.length > 150
    )
      throw new BadRequestException('Invalid staff search.');
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = {
      roles: 'ADMIN',
      $and: [{ roles: { $ne: 'SUPER_ADMIN' } }],
      deletedAt: { $exists: false },
      ...(escaped
        ? {
            $or: [
              { email: { $regex: escaped, $options: 'i' } },
              { displayName: { $regex: escaped, $options: 'i' } },
            ],
          }
        : {}),
    };
    const [users, total, roles] = await Promise.all([
      this.users
        .find(filter)
        .sort({ email: 1, _id: 1 })
        .skip((page - 1) * 25)
        .limit(25),
      this.users.countDocuments(filter),
      this.roles(user),
    ]);
    return {
      items: users.map((member) => ({
        id: member.id,
        name: member.displayName ?? member.name ?? '',
        email: member.email,
        status: member.status,
        disabled: member.disabled,
        adminRoleId: member.adminRoleId,
        adminRoleName: roles.find((role) => role.id === member.adminRoleId)
          ?.name,
      })),
      total,
      page,
      limit: 25,
    };
  }
  async assign(user: AuthenticatedUser, id: string, body: AssignmentDto) {
    this.assertSuper(user);
    if (
      body.roleId === undefined ||
      body.expectedRoleId === undefined ||
      !isValidObjectId(id) ||
      (body.roleId !== null && !isValidObjectId(body.roleId)) ||
      (body.expectedRoleId !== null && !isValidObjectId(body.expectedRoleId)) ||
      body.reason.trim().length < 5
    )
      throw new BadRequestException(
        'The selected role, current role and reason are required.',
      );
    if (
      body.roleId &&
      !(await this.profiles.exists({
        _id: body.roleId,
        isSystem: false,
        status: 'active',
        adminPermissionSlugs: { $exists: true },
      }))
    )
      throw new BadRequestException('Select an active managed role.');
    const filter = {
      _id: id,
      roles: 'ADMIN',
      $and: [{ roles: { $ne: 'SUPER_ADMIN' } }],
      deletedAt: { $exists: false },
      adminRoleId: body.expectedRoleId ?? null,
    };
    const member = await this.users.findOneAndUpdate(
      filter,
      body.roleId
        ? { $set: { adminRoleId: body.roleId } }
        : { $unset: { adminRoleId: '' } },
      { new: true },
    );
    if (!member)
      throw new ConflictException(
        'Staff access changed, or the account is not an eligible administrator. Reload before assigning.',
      );
    await this.audit.record({
      actor: user,
      action: 'admin.staff.role_assigned',
      targetType: 'user',
      targetId: member.id,
      metadata: {
        roleId: body.roleId ?? 'default-admin',
        previousRoleId: body.expectedRoleId ?? 'default-admin',
        reason: body.reason.trim(),
      },
    });
    return { updated: true };
  }
}
@Controller({ path: 'admin/staff', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
class AdminStaffController {
  constructor(private readonly staff: AdminStaffService) {}
  @Get('permissions') permissions() {
    return ADMIN_PORTAL_PERMISSIONS.filter(
      (permission) => permission !== 'admin:system:access',
    );
  }
  @Get('roles') roles(@CurrentUser() user: AuthenticatedUser) {
    return this.staff.roles(user);
  }
  @Post('roles') create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: StaffRoleDto,
  ) {
    return this.staff.save(user, body);
  }
  @Patch('roles/:id') update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: StaffRoleDto,
  ) {
    return this.staff.save(user, body, id);
  }
  @Delete('roles/:id') remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.staff.remove(user, id);
  }
  @Get('members') members(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
    @Query('page') page?: string,
  ) {
    return this.staff.members(user, search, page);
  }
  @Post('members/:id/role') assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: AssignmentDto,
  ) {
    return this.staff.assign(user, id, body);
  }
}
@Module({
  imports: [AuthModule, DatabaseModule, AuditLogsModule],
  controllers: [AdminStaffController],
  providers: [AdminStaffService],
})
export class AdminStaffModule {}
