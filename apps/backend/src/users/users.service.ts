import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SessionDocument, SessionMongoDocument, UserDocument, UserMongoDocument } from '../database/schemas';
import { ROLE_PERMISSION_MAP } from '../rbac/rbac.constants';
import { CreateUserDto, UpdateUserDto, UpdateUserStatusDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly sessions: Model<SessionMongoDocument>,
    private readonly auditLogs: AuditLogsService
  ) {}

  async create(dto: CreateUserDto, actorId?: string): Promise<Record<string, unknown>> {
    const email = dto.email.toLowerCase();
    if (await this.users.exists({ email })) {
      throw new ConflictException('Email is already registered');
    }
    const roles = dto.roles?.length ? dto.roles : ['STUDENT'];
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
    await this.auditLogs.record({ actorId, action: 'users.create', targetType: 'user', targetId: user.id });
    return this.sanitize(user);
  }

  async findAll(): Promise<Record<string, unknown>[]> {
    const users = await this.users.find({ deletedAt: { $exists: false } }).sort({ createdAt: -1 });
    return users.map((user) => this.sanitize(user));
  }

  async findOne(id: string): Promise<Record<string, unknown>> {
    return this.sanitize(await this.findActiveOrInactive(id));
  }

  async update(id: string, dto: UpdateUserDto, actorId?: string): Promise<Record<string, unknown>> {
    const update: Record<string, unknown> = {};
    if (dto.name) {
      update.name = dto.name;
      update.displayName = dto.name;
    }
    if (dto.phone !== undefined) update.phone = dto.phone;
    if (dto.roles?.length) {
      update.roles = dto.roles;
      update.permissions = this.permissionsForRoles(dto.roles);
    }
    const user = await this.users.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: update }, { new: true });
    if (!user) throw new NotFoundException('User not found');
    await this.auditLogs.record({ actorId, action: 'users.update', targetType: 'user', targetId: user.id });
    return this.sanitize(user);
  }

  async updateStatus(id: string, dto: UpdateUserStatusDto, actorId?: string): Promise<Record<string, unknown>> {
    const user = await this.users.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { status: dto.status, disabled: dto.status !== 'active' } },
      { new: true }
    );
    if (!user) throw new NotFoundException('User not found');
    if (dto.status !== 'active') {
      await this.sessions.updateMany({ userId: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    }
    await this.auditLogs.record({ actorId, action: 'users.status_update', targetType: 'user', targetId: user.id, metadata: { status: dto.status } });
    return this.sanitize(user);
  }

  async remove(id: string, actorId?: string): Promise<void> {
    const user = await this.users.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), disabled: true, status: 'inactive' } },
      { new: true }
    );
    if (!user) throw new NotFoundException('User not found');
    await this.sessions.updateMany({ userId: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId, action: 'users.delete', targetType: 'user', targetId: user.id });
  }

  private async findActiveOrInactive(id: string): Promise<UserMongoDocument> {
    const user = await this.users.findOne({ _id: id, deletedAt: { $exists: false } });
    if (!user) throw new NotFoundException('User not found');
    return user;
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
