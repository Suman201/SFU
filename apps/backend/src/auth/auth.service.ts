import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { Role } from '@native-sfu/contracts';
import { UserDocument, UserMongoDocument } from '../database/schemas';

export interface RegisterRequest {
  displayName: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

interface JwtPayload {
  sub: string;
  email: string;
  roles: Role[];
  tokenId: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService
  ) {}

  async register(request: RegisterRequest): Promise<TokenPair> {
    const existing = await this.users.exists({ email: request.email.toLowerCase() });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }
    const passwordHash = await bcrypt.hash(request.password, 12);
    const user = await this.users.create({
      displayName: request.displayName,
      email: request.email.toLowerCase(),
      passwordHash,
      roles: [Role.PARTICIPANT],
      refreshTokenIds: []
    });
    return this.issueTokens(user);
  }

  async login(request: LoginRequest): Promise<TokenPair> {
    const user = await this.users.findOne({ email: request.email.toLowerCase(), disabled: false }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(request.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET')
      });
      const user = await this.users.findById(payload.sub);
      if (!user || !user.refreshTokenIds.includes(payload.tokenId)) {
        throw new UnauthorizedException('Refresh token revoked');
      }
      await this.users.updateOne({ _id: user.id }, { $pull: { refreshTokenIds: payload.tokenId } });
      return this.issueTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string, tokenId: string): Promise<void> {
    await this.users.updateOne({ _id: userId }, { $pull: { refreshTokenIds: tokenId } });
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET')
    });
  }

  private async issueTokens(user: UserMongoDocument): Promise<TokenPair> {
    const refreshTokenId = randomUUID();
    const accessTokenId = randomUUID();
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m') as never;
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d') as never;
    const payload = {
      sub: user.id,
      email: user.email,
      roles: user.roles
    };
    await this.users.updateOne({ _id: user.id }, { $addToSet: { refreshTokenIds: refreshTokenId } });
    return {
      accessToken: await this.jwt.signAsync(
        { ...payload, tokenId: accessTokenId },
        {
          secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
          expiresIn: accessTtl,
          audience: 'native-sfu-clients',
          issuer: 'native-sfu-auth'
        }
      ),
      refreshToken: await this.jwt.signAsync(
        { ...payload, tokenId: refreshTokenId },
        {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: refreshTtl,
          audience: 'native-sfu-clients',
          issuer: 'native-sfu-auth'
        }
      ),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '15m')
    };
  }
}
