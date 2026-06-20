import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  PasswordResetTokenDocument,
  PasswordResetTokenMongoDocument,
  SessionDocument,
  SessionMongoDocument,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { ROLE_PERMISSION_MAP } from '../rbac/rbac.constants';
import { ChangePasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: AuthResponseUser;
}

export interface AuthResponseUser {
  id: string;
  name: string;
  email: string;
  role: 'teacher' | 'student';
  roles: string[];
  permissions: string[];
}

export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  permissions: string[];
  tokenId: string;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly sessions: Model<SessionMongoDocument>,
    @InjectModel(PasswordResetTokenDocument.name) private readonly resetTokens: Model<PasswordResetTokenMongoDocument>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auditLogs: AuditLogsService
  ) {}

  async register(request: RegisterDto, context: RequestContext = {}): Promise<TokenPair> {
    const email = request.email.toLowerCase();
    const existing = await this.users.exists({ email });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }
    const passwordHash = await bcrypt.hash(request.password, 12);
    const roles = ['STUDENT'];
    const permissions = this.permissionsForRoles(roles);
    const user = await this.users.create({
      displayName: request.displayName,
      name: request.displayName,
      email,
      phone: request.phone,
      passwordHash,
      roles,
      permissions,
      status: 'active',
      disabled: false
    });
    await this.auditLogs.record({ actorId: user.id, action: 'auth.register', targetType: 'user', targetId: user.id, ...context });
    return this.issueTokens(user, context);
  }

  async login(request: LoginDto, context: RequestContext = {}): Promise<TokenPair> {
    const user = await this.users.findOne({ email: request.email.toLowerCase(), deletedAt: { $exists: false } }).select('+passwordHash');
    if (!user || user.disabled || user.status !== 'active' || !(await bcrypt.compare(request.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    user.lastLoginAt = new Date();
    await user.save();
    await this.auditLogs.record({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ...context });
    return this.issueTokens(user, context);
  }

  async refresh(refreshToken: string, context: RequestContext = {}): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, this.refreshVerifyOptions());
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.sessions
      .findOne({ refreshTokenJti: payload.tokenId, userId: payload.sub, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } })
      .select('+refreshTokenHash');
    const validToken = session ? await bcrypt.compare(refreshToken, session.refreshTokenHash) : false;
    if (!session || !validToken) {
      await this.sessions.updateMany({ userId: payload.sub, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
      await this.auditLogs.record({ actorId: payload.sub, action: 'auth.refresh_reuse_detected', targetType: 'session', targetId: payload.tokenId, ...context });
      throw new UnauthorizedException('Refresh token revoked');
    }

    await this.sessions.updateOne({ _id: session.id }, { $set: { revokedAt: new Date() } });
    const user = await this.findActiveUser(payload.sub);
    return this.issueTokens(user, context);
  }

  async logout(userId: string, tokenId: string, context: RequestContext = {}): Promise<void> {
    await this.sessions.updateOne({ userId, refreshTokenJti: tokenId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: userId, action: 'auth.logout', targetType: 'session', targetId: tokenId, ...context });
  }

  async logoutAll(userId: string, context: RequestContext = {}): Promise<void> {
    await this.sessions.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: userId, action: 'auth.logout_all', targetType: 'user', targetId: userId, ...context });
  }

  async forgotPassword(email: string, context: RequestContext = {}): Promise<{ resetToken?: string }> {
    const user = await this.users.findOne({ email: email.toLowerCase(), deletedAt: { $exists: false }, status: 'active', disabled: false });
    if (!user) {
      return {};
    }
    const resetToken = randomBytes(32).toString('hex');
    await this.resetTokens.create({
      userId: user.id,
      tokenHash: this.hashOpaqueToken(resetToken),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    await this.auditLogs.record({ actorId: user.id, action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id, ...context });
    return this.config.get<string>('app.nodeEnv') === 'production' ? {} : { resetToken };
  }

  async resetPassword(request: ResetPasswordDto, context: RequestContext = {}): Promise<void> {
    const tokenHash = this.hashOpaqueToken(request.token);
    const resetToken = await this.resetTokens.findOne({ tokenHash, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
    if (!resetToken) {
      throw new BadRequestException('Invalid or expired password reset token');
    }
    const passwordHash = await bcrypt.hash(request.password, 12);
    await this.users.updateOne({ _id: resetToken.userId }, { $set: { passwordHash } });
    await this.resetTokens.updateOne({ _id: resetToken.id }, { $set: { usedAt: new Date() } });
    await this.sessions.updateMany({ userId: resetToken.userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: resetToken.userId, action: 'auth.password_reset_completed', targetType: 'user', targetId: resetToken.userId, ...context });
  }

  async changePassword(userId: string, request: ChangePasswordDto, currentTokenId: string, context: RequestContext = {}): Promise<void> {
    const user = await this.users.findById(userId).select('+passwordHash');
    if (!user || user.disabled || user.status !== 'active' || !(await bcrypt.compare(request.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Invalid current password');
    }
    user.passwordHash = await bcrypt.hash(request.newPassword, 12);
    await user.save();
    await this.sessions.updateMany({ userId, refreshTokenJti: { $ne: currentTokenId }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId, ...context });
  }

  async me(userId: string): Promise<Record<string, unknown>> {
    const user = await this.findActiveUser(userId);
    const roles = user.roles?.length ? user.roles : ['STUDENT'];
    const permissions = user.permissions?.length ? user.permissions : this.permissionsForRoles(roles);
    return {
      ...this.sanitizeUser(user),
      ...this.authResponseUser(user, roles, permissions)
    };
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
      secret: this.config.getOrThrow<string>('jwt.accessSecret'),
      issuer: this.config.getOrThrow<string>('jwt.issuer'),
      audience: this.config.getOrThrow<string>('jwt.audience')
    });
    await this.findActiveUser(payload.sub);
    const activeSession = await this.sessions.exists({
      userId: payload.sub,
      refreshTokenJti: payload.tokenId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() }
    });
    if (!activeSession) {
      throw new UnauthorizedException('Session is no longer active');
    }
    return payload;
  }

  private async issueTokens(user: UserMongoDocument, context: RequestContext): Promise<TokenPair> {
    const sessionTokenId = randomUUID();
    const accessTtl = this.config.get<string>('jwt.accessTtl', '15m') as never;
    const refreshTtl = this.config.get<string>('jwt.refreshTtl', '7d') as never;
    const roles = user.roles?.length ? user.roles : ['STUDENT'];
    const permissions = user.permissions?.length ? user.permissions : this.permissionsForRoles(roles);
    const payload = { sub: user.id, email: user.email, roles, permissions };
    const refreshToken = await this.jwt.signAsync({ ...payload, tokenId: sessionTokenId }, { ...this.refreshVerifyOptions(), expiresIn: refreshTtl });
    await this.sessions.create({
      userId: user.id,
      refreshTokenHash: await bcrypt.hash(refreshToken, 12),
      refreshTokenJti: sessionTokenId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      expiresAt: this.refreshExpiryDate()
    });
    return {
      accessToken: await this.jwt.signAsync(
        { ...payload, tokenId: sessionTokenId },
        {
          secret: this.config.getOrThrow<string>('jwt.accessSecret'),
          expiresIn: accessTtl,
          audience: this.config.getOrThrow<string>('jwt.audience'),
          issuer: this.config.getOrThrow<string>('jwt.issuer')
        }
      ),
      refreshToken,
      expiresIn: this.config.get<string>('jwt.accessTtl', '15m'),
      user: this.authResponseUser(user, roles, permissions)
    };
  }

  private async findActiveUser(userId: string): Promise<UserMongoDocument> {
    const user = await this.users.findOne({ _id: userId, deletedAt: { $exists: false }, disabled: false, status: 'active' });
    if (!user) {
      throw new UnauthorizedException('User account is not active');
    }
    return user;
  }

  private sanitizeUser(user: UserMongoDocument): Record<string, unknown> {
    return {
      id: user.id,
      name: user.name ?? user.displayName,
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      roles: user.roles,
      permissions: user.permissions,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }

  private authResponseUser(user: UserMongoDocument, roles: string[], permissions: string[]): AuthResponseUser {
    const normalizedRoles = roles.map((role) => role.toLowerCase());
    return {
      id: user.id,
      name: user.name ?? user.displayName,
      email: user.email,
      role: normalizedRoles.some((role) => role === 'teacher' || role === 'admin' || role === 'super_admin') ? 'teacher' : 'student',
      roles: normalizedRoles,
      permissions
    };
  }

  private permissionsForRoles(roles: string[]): string[] {
    return [...new Set(roles.flatMap((role) => ROLE_PERMISSION_MAP[role as keyof typeof ROLE_PERMISSION_MAP] ?? []))];
  }

  private hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private refreshVerifyOptions(): { secret: string; issuer: string; audience: string } {
    return {
      secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
      issuer: this.config.getOrThrow<string>('jwt.issuer'),
      audience: this.config.getOrThrow<string>('jwt.audience')
    };
  }

  private refreshExpiryDate(): Date {
    const ttl = this.config.get<string>('jwt.refreshTtl', '7d');
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
    const amount = Number(match[1]);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
    return new Date(Date.now() + amount * unitMs);
  }
}
