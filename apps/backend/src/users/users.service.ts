import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type {
  AdminUserActionResponse,
  AdminUserDetail,
  AdminUserListItem,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserRole,
  AdminUserSort,
  AdminUserStatus,
  AdminUserSummary,
  AdminUserUpdateRequest
} from '@native-sfu/contracts';
import bcrypt from 'bcrypt';
import { type FilterQuery, Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SessionDocument, SessionMongoDocument, UserDocument, UserMongoDocument } from '../database/schemas';
import { ROLE_PERMISSION_MAP, SYSTEM_ROLES, SystemRole } from '../rbac/rbac.constants';
import { CreateUserDto, UpdateUserDto, UpdateUserStatusDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly sessions: Model<SessionMongoDocument>,
    private readonly auditLogs: AuditLogsService
  ) {}

  async create(dto: CreateUserDto, actor?: string | AuthenticatedUser): Promise<Record<string, unknown>> {
    const email = dto.email.toLowerCase();
    if (await this.users.exists({ email })) {
      throw new ConflictException('Email is already registered');
    }
    const roles = dto.roles?.length ? this.normalizeSystemRoles(dto.roles) : ['STUDENT'];
    if (this.isAuthenticatedUser(actor)) {
      this.assertCanAssignRoles(actor, roles);
    }
    const user = await this.users.create({
      name: dto.name,
      displayName: dto.name,
      email,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 12),
      roles,
      permissions: this.permissionsForRoles(roles),
      status: 'active',
      disabled: false
    });
    await this.auditLogs.record({ actorId: this.actorId(actor), action: 'users.create', targetType: 'user', targetId: user.id });
    return this.sanitize(user);
  }

  async findAll(): Promise<Record<string, unknown>[]> {
    const users = await this.users.find({ deletedAt: { $exists: false } }).sort({ createdAt: -1 });
    return users.map((user) => this.sanitize(user));
  }

  async findOne(id: string): Promise<Record<string, unknown>> {
    return this.sanitize(await this.findActiveOrInactive(id));
  }

  async update(id: string, dto: UpdateUserDto, actor?: string | AuthenticatedUser): Promise<Record<string, unknown>> {
    const target = this.isAuthenticatedUser(actor) || dto.roles?.length ? await this.findAnyUser(id) : undefined;
    const nextRoles = dto.roles?.length ? this.normalizeSystemRoles(dto.roles) : undefined;
    if (this.isAuthenticatedUser(actor) && target) {
      this.assertCanManageUser(actor, target, nextRoles);
      await this.assertKeepsAtLeastOneActiveSuperAdmin(target, {}, nextRoles);
    }
    const update: Record<string, unknown> = {};
    if (dto.name) {
      update.name = dto.name;
      update.displayName = dto.name;
    }
    if (dto.phone !== undefined) update.phone = dto.phone;
    if (nextRoles) {
      update.roles = nextRoles;
      update.permissions = this.permissionsForRoles(nextRoles);
    }
    const user = await this.users.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: update }, { new: true });
    if (!user) throw new NotFoundException('User not found');
    if (nextRoles) {
      await this.revokeUserSessions(user.id);
    }
    await this.auditLogs.record({ actorId: this.actorId(actor), action: 'users.update', targetType: 'user', targetId: user.id });
    return this.sanitize(user);
  }

  async updateStatus(id: string, dto: UpdateUserStatusDto, actor?: string | AuthenticatedUser): Promise<Record<string, unknown>> {
    if (this.isAuthenticatedUser(actor)) {
      if (actor.sub === id && dto.status !== 'active') {
        throw new BadRequestException('You cannot deactivate your own admin account');
      }
      const target = await this.findAnyUser(id);
      this.assertCanManageUser(actor, target);
      await this.assertKeepsAtLeastOneActiveSuperAdmin(target, { status: dto.status });
    }
    const user = await this.users.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { status: dto.status, disabled: dto.status !== 'active' } },
      { new: true }
    );
    if (!user) throw new NotFoundException('User not found');
    if (dto.status !== 'active') {
      await this.sessions.updateMany({ userId: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    }
    await this.auditLogs.record({ actorId: this.actorId(actor), action: 'users.status_update', targetType: 'user', targetId: user.id, metadata: { status: dto.status } });
    return this.sanitize(user);
  }

  async remove(id: string, actor?: string | AuthenticatedUser): Promise<void> {
    if (this.isAuthenticatedUser(actor)) {
      if (actor.sub === id) {
        throw new BadRequestException('You cannot delete your own admin account');
      }
      const target = await this.findAnyUser(id);
      this.assertCanManageUser(actor, target);
      await this.assertKeepsAtLeastOneActiveSuperAdmin(target, { status: 'inactive', disabled: true });
    }
    const user = await this.users.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), disabled: true, status: 'inactive' } },
      { new: true }
    );
    if (!user) throw new NotFoundException('User not found');
    await this.sessions.updateMany({ userId: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: this.actorId(actor), action: 'users.delete', targetType: 'user', targetId: user.id });
  }

  async listAdminUsers(query: AdminUserListQuery, actor: AuthenticatedUser): Promise<AdminUserListResponse> {
    this.assertAdminActor(actor);
    const page = this.clampNumber(query.page, 1, 10_000, 1);
    const limit = this.clampNumber(query.limit, 1, 100, 25);
    const filter = this.adminUserFilter(query);
    const sort = this.adminUserSort(query.sort);
    const [users, total, summary] = await Promise.all([
      this.users
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.users.countDocuments(filter).exec(),
      this.adminUserSummary()
    ]);
    return {
      items: users.map((user: UserMongoDocument) => this.toAdminListItem(user)),
      summary,
      page,
      limit,
      total
    };
  }

  async getAdminUser(userId: string, actor: AuthenticatedUser): Promise<AdminUserDetail> {
    this.assertAdminActor(actor);
    return this.toAdminDetail(await this.findAnyUser(userId));
  }

  async updateAdminUser(userId: string, request: AdminUserUpdateRequest, actor: AuthenticatedUser): Promise<AdminUserDetail> {
    this.assertAdminActor(actor);
    const user = await this.findAnyUser(userId);
    const nextRoles = request.roles ? this.normalizeSystemRoles(request.roles) : undefined;
    if (actor.sub === user.id && (request.disabled === true || (request.status !== undefined && request.status !== 'active'))) {
      throw new BadRequestException('You cannot deactivate your own admin account');
    }
    this.assertCanManageUser(actor, user, nextRoles);
    await this.assertKeepsAtLeastOneActiveSuperAdmin(user, request, nextRoles);

    const update: Record<string, unknown> = {};
    if (request.name !== undefined) {
      const name = request.name.trim();
      if (name.length < 2) {
        throw new BadRequestException('User name must be at least 2 characters');
      }
      update.name = name;
      update.displayName = request.displayName?.trim() || name;
    } else if (request.displayName !== undefined) {
      const displayName = request.displayName.trim();
      if (displayName.length < 2) {
        throw new BadRequestException('Display name must be at least 2 characters');
      }
      update.displayName = displayName;
    }
    if (request.phone !== undefined) {
      update.phone = request.phone.trim() || undefined;
    }
    if (nextRoles) {
      update.roles = nextRoles;
      update.permissions = this.permissionsForRoles(nextRoles);
    }
    if (request.status) {
      update.status = request.status;
      update.disabled = request.status !== 'active';
    }
    if (request.disabled !== undefined) {
      update.disabled = request.disabled;
      if (request.disabled) {
        update.status = request.status ?? 'inactive';
      } else if (!request.status) {
        update.status = 'active';
      }
    }

    if (Object.keys(update).length === 0) {
      return this.toAdminDetail(user);
    }
    const updated = await this.users.findOneAndUpdate({ _id: user.id, deletedAt: { $exists: false } }, { $set: update }, { new: true }).exec();
    if (!updated) throw new NotFoundException('User not found');
    if (nextRoles || updated.status !== 'active' || updated.disabled) {
      await this.revokeUserSessions(updated.id);
    }
    await this.auditLogs.record({
      actor,
      action: 'admin.users.update',
      resourceType: 'user',
      resourceId: updated.id,
      resourceLabel: updated.displayName ?? updated.name,
      targetUserId: updated.id,
      metadata: { summary: `Updated user ${updated.displayName ?? updated.email}` },
      before: { roles: user.roles, status: user.status, disabled: user.disabled },
      after: { roles: updated.roles, status: updated.status, disabled: updated.disabled }
    });
    return this.toAdminDetail(updated);
  }

  async activateAdminUser(userId: string, actor: AuthenticatedUser): Promise<AdminUserActionResponse> {
    this.assertAdminActor(actor);
    const user = await this.findAnyUser(userId);
    this.assertCanManageUser(actor, user);
    const updated = await this.users
      .findOneAndUpdate({ _id: user.id, deletedAt: { $exists: false } }, { $set: { status: 'active', disabled: false } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('User not found');
    await this.auditLogs.record({
      actor,
      action: 'admin.users.activate',
      resourceType: 'user',
      resourceId: updated.id,
      resourceLabel: updated.displayName ?? updated.name,
      targetUserId: updated.id,
      metadata: { summary: `Activated user ${updated.displayName ?? updated.email}` },
      after: { status: updated.status, disabled: updated.disabled }
    });
    return { action: 'activated', user: this.toAdminDetail(updated) };
  }

  async deactivateAdminUser(userId: string, actor: AuthenticatedUser): Promise<AdminUserActionResponse> {
    this.assertAdminActor(actor);
    if (actor.sub === userId) {
      throw new BadRequestException('You cannot deactivate your own admin account');
    }
    const user = await this.findAnyUser(userId);
    this.assertCanManageUser(actor, user);
    await this.assertKeepsAtLeastOneActiveSuperAdmin(user, { status: 'inactive', disabled: true });
    const updated = await this.users
      .findOneAndUpdate({ _id: user.id, deletedAt: { $exists: false } }, { $set: { status: 'inactive', disabled: true } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('User not found');
    await this.revokeUserSessions(updated.id);
    await this.auditLogs.record({
      actor,
      action: 'admin.users.deactivate',
      resourceType: 'user',
      resourceId: updated.id,
      resourceLabel: updated.displayName ?? updated.name,
      targetUserId: updated.id,
      metadata: { summary: `Deactivated user ${updated.displayName ?? updated.email}` },
      before: { status: user.status, disabled: user.disabled },
      after: { status: updated.status, disabled: updated.disabled }
    });
    return { action: 'deactivated', user: this.toAdminDetail(updated) };
  }

  private async findActiveOrInactive(id: string): Promise<UserMongoDocument> {
    const user = await this.users.findOne({ _id: id, deletedAt: { $exists: false } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async findAnyUser(id: string): Promise<UserMongoDocument> {
    const user = await this.users.findOne({ _id: id, deletedAt: { $exists: false } }).exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private assertAdminActor(actor: AuthenticatedUser): void {
    if (!this.hasAnyRole(actor.roles, ['ADMIN', 'SUPER_ADMIN'])) {
      throw new ForbiddenException('Only administrators can manage users');
    }
  }

  private assertCanManageUser(actor: AuthenticatedUser, target: UserMongoDocument, nextRoles = target.roles): void {
    if (actor.sub === target.id && nextRoles.includes('SUPER_ADMIN') && !target.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('You cannot promote yourself to super admin');
    }
    if (actor.sub === target.id && target.roles.includes('SUPER_ADMIN') && !nextRoles.includes('SUPER_ADMIN')) {
      throw new BadRequestException('You cannot remove your own super admin role');
    }
    if (actor.sub === target.id && this.hasAnyRole(target.roles, ['ADMIN', 'SUPER_ADMIN']) && !this.hasAnyRole(nextRoles, ['ADMIN', 'SUPER_ADMIN'])) {
      throw new BadRequestException('You cannot remove your own admin access');
    }
    if (this.hasAnyRole(actor.roles, ['SUPER_ADMIN'])) {
      return;
    }
    if (this.hasAnyRole(target.roles, ['ADMIN', 'SUPER_ADMIN']) || this.hasAnyRole(nextRoles, ['ADMIN', 'SUPER_ADMIN'])) {
      throw new ForbiddenException('Only super admins can manage admin accounts');
    }
  }

  private async assertKeepsAtLeastOneActiveSuperAdmin(
    user: UserMongoDocument,
    request: Partial<Pick<AdminUserUpdateRequest, 'status' | 'disabled'>>,
    nextRoles = user.roles
  ): Promise<void> {
    const removesSuperAdmin = user.roles.includes('SUPER_ADMIN') && !nextRoles.includes('SUPER_ADMIN');
    const deactivatesSuperAdmin = user.roles.includes('SUPER_ADMIN') && (request.disabled === true || (request.status !== undefined && request.status !== 'active'));
    if (!removesSuperAdmin && !deactivatesSuperAdmin) {
      return;
    }
    const activeSuperAdmins = await this.users
      .countDocuments({ roles: 'SUPER_ADMIN', status: 'active', disabled: false, deletedAt: { $exists: false } })
      .exec();
    if (activeSuperAdmins <= 1) {
      throw new BadRequestException('At least one active super admin must remain');
    }
  }

  private adminUserFilter(query: AdminUserListQuery): FilterQuery<UserDocument> {
    const filter: FilterQuery<UserDocument> = { deletedAt: { $exists: false } };
    const role = this.normalizeOptionalRole(query.role);
    if (role) {
      filter.roles = role;
    }
    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    const search = query.search?.trim();
    if (search) {
      const regex = new RegExp(this.escapeRegex(search), 'i');
      const searchConditions: FilterQuery<UserDocument>[] = [{ displayName: regex }, { name: regex }, { email: regex }, { phone: regex }];
      if (/^[a-f\d]{24}$/i.test(search)) {
        searchConditions.push({ _id: search } as FilterQuery<UserDocument>);
      }
      filter.$or = searchConditions;
    }
    return filter;
  }

  private adminUserSort(sort: AdminUserSort | undefined): Record<string, 1 | -1> {
    switch (sort) {
      case 'created_asc':
        return { createdAt: 1 };
      case 'name_asc':
        return { displayName: 1, createdAt: -1 };
      case 'email_asc':
        return { email: 1, createdAt: -1 };
      case 'last_login_desc':
        return { lastLoginAt: -1, createdAt: -1 };
      case 'created_desc':
      default:
        return { createdAt: -1 };
    }
  }

  private async adminUserSummary(): Promise<AdminUserSummary> {
    const base = { deletedAt: { $exists: false } };
    const [totalUsers, teachers, students, admins, disabledUsers] = await Promise.all([
      this.users.countDocuments(base).exec(),
      this.users.countDocuments({ ...base, roles: 'TEACHER' }).exec(),
      this.users.countDocuments({ ...base, roles: 'STUDENT' }).exec(),
      this.users.countDocuments({ ...base, roles: { $in: ['ADMIN', 'SUPER_ADMIN'] } }).exec(),
      this.users.countDocuments({ ...base, disabled: true }).exec()
    ]);
    return { totalUsers, teachers, students, admins, disabledUsers };
  }

  private normalizeSystemRoles(roles: AdminUserRole[] | string[]): SystemRole[] {
    const normalized = [...new Set(roles.map((role) => this.toSystemRole(role)))];
    if (!normalized.length) {
      throw new BadRequestException('At least one role is required');
    }
    return normalized;
  }

  private assertCanAssignRoles(actor: AuthenticatedUser, roles: string[]): void {
    if (this.hasAnyRole(actor.roles, ['SUPER_ADMIN'])) {
      return;
    }
    if (this.hasAnyRole(roles, ['ADMIN', 'SUPER_ADMIN'])) {
      throw new ForbiddenException('Only super admins can create admin accounts');
    }
  }

  private normalizeOptionalRole(role: AdminUserListQuery['role']): SystemRole | undefined {
    if (!role || role === 'all') {
      return undefined;
    }
    return this.toSystemRole(role);
  }

  private toSystemRole(role: string): SystemRole {
    const normalized = role.trim().toUpperCase();
    const mapped = normalized === 'SUPER_ADMIN' ? normalized : normalized.replace('-', '_');
    if (!SYSTEM_ROLES.includes(mapped as SystemRole)) {
      throw new BadRequestException(`Unsupported user role: ${role}`);
    }
    return mapped as SystemRole;
  }

  private toAdminRole(role: string | undefined): AdminUserRole {
    switch (role) {
      case 'SUPER_ADMIN':
        return 'super_admin';
      case 'ADMIN':
        return 'admin';
      case 'TEACHER':
        return 'teacher';
      case 'STUDENT':
      default:
        return 'student';
    }
  }

  private primaryAdminRole(roles: string[]): AdminUserRole {
    if (roles.includes('SUPER_ADMIN')) return 'super_admin';
    if (roles.includes('ADMIN')) return 'admin';
    if (roles.includes('TEACHER')) return 'teacher';
    return 'student';
  }

  private toAdminListItem(user: UserMongoDocument): AdminUserListItem {
    return {
      id: user.id,
      name: user.name ?? user.displayName,
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      roles: (user.roles?.length ? user.roles : ['STUDENT']).map((role) => this.toAdminRole(role)),
      primaryRole: this.primaryAdminRole(user.roles ?? []),
      status: user.status,
      disabled: user.disabled,
      emailVerifiedAt: this.dateString(user.emailVerifiedAt),
      lastLoginAt: this.dateString(user.lastLoginAt),
      createdAt: this.dateString(user.createdAt),
      updatedAt: this.dateString(user.updatedAt)
    };
  }

  private toAdminDetail(user: UserMongoDocument): AdminUserDetail {
    return {
      ...this.toAdminListItem(user),
      permissions: user.permissions ?? []
    };
  }

  private dateString(value?: Date | string): string | undefined {
    if (!value) {
      return undefined;
    }
    return value instanceof Date ? value.toISOString() : value;
  }

  private hasAnyRole(roles: string[] | undefined, expected: string[]): boolean {
    return expected.some((role) => roles?.includes(role));
  }

  private isAuthenticatedUser(actor: string | AuthenticatedUser | undefined): actor is AuthenticatedUser {
    return !!actor && typeof actor === 'object' && 'sub' in actor;
  }

  private actorId(actor: string | AuthenticatedUser | undefined): string | undefined {
    return this.isAuthenticatedUser(actor) ? actor.sub : actor;
  }

  private async revokeUserSessions(userId: string): Promise<void> {
    await this.sessions.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  }

  private clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value ?? NaN)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(value as number)));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private permissionsForRoles(roles: string[]): string[] {
    return [...new Set(roles.flatMap((role) => ROLE_PERMISSION_MAP[role as keyof typeof ROLE_PERMISSION_MAP] ?? []))];
  }

  private sanitize(user: UserMongoDocument): Record<string, unknown> {
    return {
      id: user.id,
      name: user.name ?? user.displayName,
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      roles: user.roles,
      permissions: user.permissions,
      status: user.status,
      disabled: user.disabled,
      emailVerifiedAt: user.emailVerifiedAt,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }
}
