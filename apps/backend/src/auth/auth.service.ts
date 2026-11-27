import { PasswordRecoveryService } from './password-recovery.service';
import { BadRequestException, ConflictException, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  SessionDocument,
  SessionMongoDocument,
  RoleDocument, RoleMongoDocument,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { ADMIN_PORTAL_PERMISSIONS } from '@native-sfu/contracts';
import { ROLE_PERMISSION_MAP } from '../rbac/rbac.constants';
import type { SocialIdentity } from './social-auth.schema';
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
  adminRoleId?: string;
  authVersion?: number;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(SessionDocument.name) private readonly sessions: Model<SessionMongoDocument>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auditLogs: AuditLogsService,
    private readonly recovery: PasswordRecoveryService,
    @Optional() @InjectModel(RoleDocument.name) private readonly staffRoles?: Model<RoleMongoDocument>,
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
    if (!user || user.disabled || user.status !== 'active' || !user.passwordHash || !(await bcrypt.compare(request.password, user.passwordHash))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }
    user.lastLoginAt = new Date();
    await user.save();
    await this.auditLogs.record({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ...context });
    return this.issueTokens(user, context);
  }

  async socialLogin(identity: SocialIdentity, expectedRole: 'student' | 'teacher', credentials: { email: string; password: string } | undefined, context: RequestContext = {}): Promise<TokenPair> {
    const subjectField = identity.provider === 'google' ? 'googleSubject' : 'appleSubject';
    let user: UserMongoDocument | null = await this.users.findOne({ [subjectField]: identity.subject }).select('+googleSubject +appleSubject');
    let action = 'auth.social.login';
    if (!user && credentials) {
      user = await this.users.findOne({ email: credentials.email.toLowerCase() }).select('+passwordHash +googleSubject +appleSubject');
      if (!user?.passwordHash || !(await bcrypt.compare(credentials.password, user.passwordHash))) {
        throw new UnauthorizedException('The existing account email or password is incorrect.');
      }
      this.assertSocialAccount(user, expectedRole);
      if (user[subjectField] && user[subjectField] !== identity.subject) throw new ConflictException('This account is already linked to another identity from this provider.');
      try {
        const linked = await this.users.findOneAndUpdate({ _id: user.id, $or: [{ [subjectField]: { $exists: false } }, { [subjectField]: identity.subject }] }, { $set: { [subjectField]: identity.subject } }, { new: true });
        if (!linked) throw new ConflictException('Account linking changed. Please start again.');
        user = linked;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new ConflictException('This identity is already linked. Please start again.');
        throw error;
      }
      action = 'auth.social.link';
    }
    if (!user) {
      const existing = await this.users.exists({ email: identity.email });
      if (existing || expectedRole === 'teacher') throw new ConflictException({ code: 'SOCIAL_LINK_REQUIRED', message: 'Link your existing account by confirming its email and password. Teacher accounts must first be created by our team.' });
      try {
        user = await this.users.create({ displayName: identity.name || 'New learner', name: identity.name || 'New learner', email: identity.email, emailVerifiedAt: new Date(), [subjectField]: identity.subject, roles: ['STUDENT'], permissions: this.permissionsForRoles(['STUDENT']), status: 'active', disabled: false });
      } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new ConflictException('This account was registered or linked in another sign-in. Please start again.');
        throw error;
      }
      action = 'auth.social.register';
    }
    this.assertSocialAccount(user, expectedRole);
    user.lastLoginAt = new Date();
    await user.save();
    await this.auditLogs.record({ actorId: user.id, action, targetType: 'user', targetId: user.id, metadata: { provider: identity.provider }, ...context });
    return this.issueTokens(user, context);
  }

  async linkSocialIdentity(userId: string, identity: SocialIdentity, version: number, role: 'student' | 'teacher', context: RequestContext): Promise<void> {
    const account = await this.findActiveUser(userId);
    this.assertSocialAccount(account, role);
    if ((account.authVersion ?? 0) !== version) throw new UnauthorizedException('This account changed. Start connecting the provider again.');
    const field = identity.provider === 'google' ? 'googleSubject' : 'appleSubject';
    try {
      const linked = await this.users.updateOne({ _id: userId, status: 'active', disabled: false, deletedAt: { $exists: false }, $expr: { $eq: [{ $ifNull: ['$authVersion', 0] }, version] }, $or: [{ [field]: { $exists: false } }, { [field]: identity.subject }] }, { $set: { [field]: identity.subject } });
      if (!linked.matchedCount) throw new ConflictException('This account already has another identity from this provider, or it changed.');
    } catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('This provider identity is already connected to another account.'); throw error; }
    await this.auditLogs.record({ actorId: userId, action: 'account.provider_linked', targetType: 'user', targetId: userId, metadata: { provider: identity.provider }, ...context });
  }

  private assertSocialAccount(user: UserMongoDocument, role: 'student' | 'teacher'): void {
    if (user.disabled || user.status !== 'active' || user.deletedAt || user.roles.some(value => ['ADMIN', 'SUPER_ADMIN'].includes(value))) throw new UnauthorizedException('This account cannot use student or teacher social sign-in.');
    const actualRole = user.roles.includes('TEACHER') ? 'teacher' : 'student';
    if (actualRole !== role) throw new UnauthorizedException(`Use the ${actualRole} login for this account.`);
  }

  async refresh(refreshToken: string, context: RequestContext = {}): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, this.refreshVerifyOptions());
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.findActiveUser(payload.sub);
    if ((payload.authVersion ?? 0) !== (user.authVersion ?? 0)) throw new UnauthorizedException('Session was revoked by account recovery');

    const session = await this.sessions
      .findOne({ refreshTokenJti: payload.tokenId, userId: payload.sub, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } })
      .select('+refreshTokenHash');
    const digest = this.refreshDigest(refreshToken);
    const validToken = session ? session.refreshTokenHashVersion === 1
      ? session.refreshTokenHash.length === digest.length && timingSafeEqual(Buffer.from(session.refreshTokenHash), Buffer.from(digest))
      : await bcrypt.compare(refreshToken, session.refreshTokenHash) : false;
    if (!session || !validToken) {
      if (session) await this.sessions.updateOne({ _id: session.id, userId: payload.sub }, { $set: { revokedAt: new Date() } });
      await this.auditLogs.record({ actorId: payload.sub, action: 'auth.refresh_reuse_detected', targetType: 'session', targetId: payload.tokenId, ...context });
      throw new UnauthorizedException('Refresh token revoked');
    }

    const tokens = await this.tokensForSession(user, payload.tokenId);
    // A stable session row represents the device. Hash rotation must not resurrect a revoked row.
    const rotated = await this.sessions.updateOne({ _id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }, { $set: { refreshTokenHash: this.refreshDigest(tokens.refreshToken), refreshTokenHashVersion: 1, expiresAt: this.refreshExpiryDate(), ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}), ...(context.userAgent ? { userAgent: context.userAgent } : {}) } });
    if (!rotated.modifiedCount) { await this.sessions.updateOne({ _id: session.id, userId: user.id }, { $set: { revokedAt: new Date() } }); throw new UnauthorizedException('Session was revoked or refreshed in another request.'); }
    return tokens;
  }

  async logout(userId: string, tokenId: string, context: RequestContext = {}): Promise<void> {
    await this.sessions.updateOne({ userId, refreshTokenJti: tokenId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: userId, action: 'auth.logout', targetType: 'session', targetId: tokenId, ...context });
  }

  async logoutAll(userId: string, context: RequestContext = {}): Promise<void> {
    const account = await this.users.findOneAndUpdate({ _id: userId, status: 'active', disabled: false, deletedAt: { $exists: false } }, { $inc: { authVersion: 1 } }, { new: true });
    if (!account) throw new UnauthorizedException('User account is not active');
    await this.revokeOlderSessions(userId, account.authVersion ?? 0);
    await this.auditLogs.record({ actorId: userId, action: 'auth.logout_all', targetType: 'user', targetId: userId, ...context });
  }

  async forgotPassword(email: string): Promise<void> {
    await this.recovery.request(email);
  }

  async resetPassword(request: ResetPasswordDto, context: RequestContext = {}): Promise<void> {
    await this.recovery.reset(request.token, request.password, context);
  }

  async changePassword(userId: string, request: ChangePasswordDto, currentTokenId: string, context: RequestContext = {}, revokeCurrent = false): Promise<void> {
    if (Buffer.byteLength(request.newPassword, 'utf8') > 72 || request.newPassword.length < 10) throw new BadRequestException('Use at least 10 characters and at most 72 UTF-8 bytes for your new password.');
    const user = await this.users.findById(userId).select('+passwordHash');
    if (!user || user.disabled || user.status !== 'active' || !user.passwordHash || !(await bcrypt.compare(request.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Invalid current password');
    }
    const passwordHash = await bcrypt.hash(request.newPassword, 12);
    const updated = await this.users.updateOne({ _id: userId, passwordHash: user.passwordHash, disabled: false, status: 'active', deletedAt: { $exists: false } }, {
      $set: { passwordHash, passwordResetCompletedAt: new Date() },
      ...(revokeCurrent ? { $inc: { authVersion: 1 } } : {}),
      $unset: { passwordResetHash: 1, passwordResetExpiresAt: 1, passwordResetIssuedAt: 1 },
    });
    if (!updated.modifiedCount) throw new UnauthorizedException('The password changed during this request. Please sign in again.');
    if (revokeCurrent) await this.revokeOlderSessions(userId, (user.authVersion ?? 0) + 1);
    else await this.sessions.updateMany({ userId, refreshTokenJti: { $ne: currentTokenId }, revokedAt: { $exists: false }, $or: [{ authVersion: { $lte: user.authVersion ?? 0 } }, { authVersion: { $exists: false } }] }, { $set: { revokedAt: new Date() } });
    await this.auditLogs.record({ actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId, ...context });
  }

  async me(userId: string): Promise<Record<string, unknown>> {
    const user = await this.findActiveUser(userId);
    const roles = user.roles?.length ? user.roles : ['STUDENT'];
    const permissions = await this.effectivePermissions(user);
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
    const user = await this.findActiveUser(payload.sub);
    if ((payload.authVersion ?? 0) !== (user.authVersion ?? 0)) throw new UnauthorizedException('Session was revoked by account recovery');
    const activeSession = await this.sessions.exists({
      userId: payload.sub,
      refreshTokenJti: payload.tokenId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() }
    });
    if (!activeSession) {
      throw new UnauthorizedException('Session is no longer active');
    }
    return { ...payload, email: user.email, roles: user.roles?.length ? user.roles : ['STUDENT'], permissions: await this.effectivePermissions(user), ...(user.adminRoleId ? { adminRoleId: user.adminRoleId } : {}) };
  }

  /** One account lookup per node sweep, rather than a database read for every media signal. */
  async revokedSocketSessions(sessions: Array<{ socketId: string; userId: string; authVersion: number; tokenId?: string }>): Promise<string[]> {
    if (!sessions.length) return [];
    const users = await this.users.find({ _id: { $in: [...new Set(sessions.map(session => session.userId))] } }).select('_id authVersion status disabled deletedAt').lean();
    const accounts = new Map(users.map(user => [String(user._id), user]));
    const tokenIds = [...new Set(sessions.map(session => session.tokenId).filter((id): id is string => Boolean(id)))];
    const active = tokenIds.length ? await this.sessions.find({ refreshTokenJti: { $in: tokenIds }, userId: { $in: [...accounts.keys()] }, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).select('userId refreshTokenJti').lean() : [];
    const activeKeys = new Set(active.map(session => `${session.userId}:${session.refreshTokenJti}`));
    return sessions.filter(session => {
      const account = accounts.get(session.userId);
      return !account || account.disabled || account.status !== 'active' || account.deletedAt || (account.authVersion ?? 0) !== session.authVersion || Boolean(session.tokenId && !activeKeys.has(`${session.userId}:${session.tokenId}`));
    }).map(session => session.socketId);
  }

  private async effectivePermissions(user: UserMongoDocument): Promise<string[]> {
    const roles = user.roles?.length ? user.roles : ['STUDENT'];
    if (roles.includes('SUPER_ADMIN')) return [...new Set([...this.permissionsForRoles(roles), ...ADMIN_PORTAL_PERMISSIONS])];
    if (roles.includes('ADMIN')) {
      if (user.adminRoleId) {
        const profile = await this.staffRoles?.findOne({ _id: user.adminRoleId, isSystem: false, status: 'active', adminPermissionSlugs: { $exists: true } }).lean();
        return profile?.adminPermissionSlugs?.filter(permission => ADMIN_PORTAL_PERMISSIONS.includes(permission as typeof ADMIN_PORTAL_PERMISSIONS[number])) ?? [];
      }
      return [...new Set([...(user.permissions?.length ? user.permissions : this.permissionsForRoles(roles)), ...ADMIN_PORTAL_PERMISSIONS])];
    }
    return user.permissions?.length ? user.permissions : this.permissionsForRoles(roles);
  }

  private refreshDigest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

  private async revokeOlderSessions(userId: string, version: number): Promise<void> {
    try { await this.sessions.updateMany({ userId, revokedAt: { $exists: false }, $or: [{ authVersion: { $lt: version } }, { authVersion: { $exists: false } }] }, { $set: { revokedAt: new Date() } }); }
    catch { this.logger.warn('Session cleanup failed; the account epoch still rejects previous credentials.'); }
  }

  private async issueTokens(user: UserMongoDocument, context: RequestContext): Promise<TokenPair> {
    const sessionTokenId = randomUUID();
    const tokens = await this.tokensForSession(user, sessionTokenId);
    await this.sessions.create({ userId: user.id, authVersion: user.authVersion ?? 0, refreshTokenHash: this.refreshDigest(tokens.refreshToken), refreshTokenHashVersion: 1, refreshTokenJti: sessionTokenId, ipAddress: context.ipAddress, userAgent: context.userAgent, expiresAt: this.refreshExpiryDate() });
    return tokens;
  }

  private async tokensForSession(user: UserMongoDocument, sessionTokenId: string): Promise<TokenPair> {
    const roles = user.roles?.length ? user.roles : ['STUDENT'];
    const permissions = await this.effectivePermissions(user);
    const payload = { sub: user.id, email: user.email, roles, permissions, authVersion: user.authVersion ?? 0, tokenId: sessionTokenId };
    return {
      // Random jti makes same-second rotations distinct. The full JWT is hashed, never bcrypt-truncated.
      refreshToken: await this.jwt.signAsync({ ...payload, jti: randomUUID() }, { ...this.refreshVerifyOptions(), expiresIn: this.config.get<string>('jwt.refreshTtl', '7d') as never }),
      accessToken: await this.jwt.signAsync(payload, { secret: this.config.getOrThrow<string>('jwt.accessSecret'), expiresIn: this.config.get<string>('jwt.accessTtl', '15m') as never, audience: this.config.getOrThrow<string>('jwt.audience'), issuer: this.config.getOrThrow<string>('jwt.issuer') }),
      expiresIn: this.config.get<string>('jwt.accessTtl', '15m'), user: this.authResponseUser(user, roles, permissions),
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
