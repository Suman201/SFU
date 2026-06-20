import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  AccessPermissionDocument,
  AccessPermissionMongoDocument,
  RoleDocument,
  RoleMongoDocument,
  RolePermissionDocument,
  RolePermissionMongoDocument
} from '../database/schemas';
import { AssignRolePermissionsDto, CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(
    @InjectModel(RoleDocument.name) private readonly roles: Model<RoleMongoDocument>,
    @InjectModel(AccessPermissionDocument.name) private readonly permissions: Model<AccessPermissionMongoDocument>,
    @InjectModel(RolePermissionDocument.name) private readonly rolePermissions: Model<RolePermissionMongoDocument>,
    private readonly auditLogs: AuditLogsService
  ) {}

  async create(dto: CreateRoleDto, actorId?: string): Promise<Record<string, unknown>> {
    if (await this.roles.exists({ slug: dto.slug })) throw new ConflictException('Role slug already exists');
    const role = await this.roles.create({ ...dto, status: 'active', isSystem: false });
    await this.auditLogs.record({ actorId, action: 'roles.create', targetType: 'role', targetId: role.id });
    return this.sanitize(role);
  }

  async findAll(): Promise<Record<string, unknown>[]> {
    return (await this.roles.find().sort({ slug: 1 })).map((role) => this.sanitize(role));
  }

  async findOne(id: string): Promise<Record<string, unknown>> {
    return this.sanitize(await this.findRole(id));
  }

  async update(id: string, dto: UpdateRoleDto, actorId?: string): Promise<Record<string, unknown>> {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem && dto.status === 'inactive') throw new BadRequestException('System roles cannot be deactivated');
    Object.assign(role, dto);
    await role.save();
    await this.auditLogs.record({ actorId, action: 'roles.update', targetType: 'role', targetId: role.id });
    return this.sanitize(role);
  }

  async remove(id: string, actorId?: string): Promise<void> {
    const role = await this.findRole(id);
    if (role.isSystem) throw new BadRequestException('System roles cannot be deleted');
    await this.rolePermissions.deleteMany({ roleId: role.id });
    await role.deleteOne();
    await this.auditLogs.record({ actorId, action: 'roles.delete', targetType: 'role', targetId: role.id });
  }

  async assignPermissions(id: string, dto: AssignRolePermissionsDto, actorId?: string): Promise<Record<string, unknown>[]> {
    const role = await this.findRole(id);
    const permissions = await this.permissions.find({ slug: { $in: dto.permissionSlugs } });
    if (permissions.length !== new Set(dto.permissionSlugs).size) throw new BadRequestException('One or more permissions do not exist');
    await this.rolePermissions.deleteMany({ roleId: role.id });
    await this.rolePermissions.insertMany(permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id, permissionSlug: permission.slug })));
    await this.auditLogs.record({ actorId, action: 'roles.permissions_assign', targetType: 'role', targetId: role.id, metadata: { permissions: dto.permissionSlugs } });
    return this.getPermissions(id);
  }

  async getPermissions(id: string): Promise<Record<string, unknown>[]> {
    const role = await this.findRole(id);
    const mappings = await this.rolePermissions.find({ roleId: role.id });
    const permissions = await this.permissions.find({ _id: { $in: mappings.map((mapping) => mapping.permissionId) } });
    return permissions.map((permission) => ({
      id: permission.id,
      name: permission.name,
      slug: permission.slug,
      module: permission.module,
      description: permission.description
    }));
  }

  private async findRole(id: string): Promise<RoleMongoDocument> {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private sanitize(role: RoleMongoDocument): Record<string, unknown> {
    return {
      id: role.id,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: role.isSystem,
      status: role.status,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt
    };
  }
}
