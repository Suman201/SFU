import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import {
  AccessPermissionDocument,
  AccessPermissionMongoDocument,
  RoleDocument,
  RoleMongoDocument,
  RolePermissionDocument,
  RolePermissionMongoDocument,
  UserDocument,
  UserMongoDocument,
  UserRoleDocument,
  UserRoleMongoDocument
} from '../database/schemas';
import { DEFAULT_PERMISSIONS, humanizeSlug, permissionModule, ROLE_PERMISSION_MAP, SYSTEM_ROLES } from './rbac.constants';

@Injectable()
export class RbacSeederService implements OnModuleInit {
  private readonly logger = new Logger(RbacSeederService.name);

  constructor(
    @InjectModel(RoleDocument.name) private readonly roles: Model<RoleMongoDocument>,
    @InjectModel(AccessPermissionDocument.name) private readonly permissions: Model<AccessPermissionMongoDocument>,
    @InjectModel(RolePermissionDocument.name) private readonly rolePermissions: Model<RolePermissionMongoDocument>,
    @InjectModel(UserRoleDocument.name) private readonly userRoles: Model<UserRoleMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly config: ConfigService
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('app.nodeEnv') === 'test') {
      return;
    }
    await this.seed();
  }

  async seed(): Promise<void> {
    const roleBySlug = new Map<string, RoleMongoDocument>();
    for (const slug of SYSTEM_ROLES) {
      const role = await this.roles.findOneAndUpdate(
        { slug },
        { $set: { name: humanizeSlug(slug.toLowerCase().replace('_', ':')), slug, isSystem: true, status: 'active' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      roleBySlug.set(slug, role);
    }

    const permissionBySlug = new Map<string, AccessPermissionMongoDocument>();
    for (const slug of DEFAULT_PERMISSIONS) {
      const permission = await this.permissions.findOneAndUpdate(
        { slug },
        { $set: { name: humanizeSlug(slug), slug, module: permissionModule(slug), description: `${humanizeSlug(slug)} permission` } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      permissionBySlug.set(slug, permission);
    }

    for (const [roleSlug, permissionSlugs] of Object.entries(ROLE_PERMISSION_MAP)) {
      const role = roleBySlug.get(roleSlug);
      if (!role) continue;
      for (const permissionSlug of permissionSlugs) {
        const permission = permissionBySlug.get(permissionSlug);
        if (!permission) continue;
        await this.rolePermissions.updateOne(
          { roleId: role.id, permissionId: permission.id },
          { $set: { roleId: role.id, permissionId: permission.id, permissionSlug } },
          { upsert: true }
        );
      }
    }

    await this.seedSuperAdmin(roleBySlug.get('SUPER_ADMIN')?.id, [...DEFAULT_PERMISSIONS]);
    this.logger.log('RBAC seed completed');
  }

  private async seedSuperAdmin(roleId: string | undefined, permissions: string[]): Promise<void> {
    const email = this.config.get<string>('seed.superAdminEmail');
    const password = this.config.get<string>('seed.superAdminPassword');
    if (!email || !password || !roleId) {
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.users.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $setOnInsert: { email: email.toLowerCase(), displayName: 'Super Admin', name: 'Super Admin', passwordHash },
        $set: { roles: ['SUPER_ADMIN'], permissions, status: 'active', disabled: false }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await this.userRoles.updateOne({ userId: user.id, roleId }, { $set: { userId: user.id, roleId, roleSlug: 'SUPER_ADMIN' } }, { upsert: true });
  }
}
