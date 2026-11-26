import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('verifies access tokens with issuer and audience', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id', tokenId: 'session-id' }) } as unknown as JwtService;
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-id' }) };
    const sessions = { exists: jest.fn().mockResolvedValue({ _id: 'session-id' }) };
    const config = {
      getOrThrow: jest.fn((key: string) => ({
        'jwt.accessSecret': 'access-secret',
        'jwt.issuer': 'native-sfu-auth',
        'jwt.audience': 'native-sfu-clients'
      })[key])
    } as unknown as ConfigService;
    const service = new AuthService(users as never, sessions as never, jwt, config, {} as never, {} as never);

    await service.verifyAccessToken('token');

    expect(jwt.verifyAsync).toHaveBeenCalledWith('token', {
      secret: 'access-secret',
      issuer: 'native-sfu-auth',
      audience: 'native-sfu-clients'
    });
    expect(users.findOne).toHaveBeenCalledWith({ _id: 'user-id', deletedAt: { $exists: false }, disabled: false, status: 'active' });
    const sessionQuery = sessions.exists.mock.calls[0][0];
    expect(sessionQuery.userId).toBe('user-id');
    expect(sessionQuery.refreshTokenJti).toBe('session-id');
    expect(sessionQuery.revokedAt).toEqual({ $exists: false });
    expect(sessionQuery.expiresAt.$gt).toBeInstanceOf(Date);
  });

  it('rejects access tokens when the backing session is not active', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id', tokenId: 'session-id' }) } as unknown as JwtService;
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-id' }) };
    const sessions = { exists: jest.fn().mockResolvedValue(null) };
    const config = {
      getOrThrow: jest.fn((key: string) => ({
        'jwt.accessSecret': 'access-secret',
        'jwt.issuer': 'native-sfu-auth',
        'jwt.audience': 'native-sfu-clients'
      })[key])
    } as unknown as ConfigService;
    const service = new AuthService(users as never, sessions as never, jwt, config, {} as never, {} as never);

    let thrown: unknown;
    try {
      await service.verifyAccessToken('token');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Session is no longer active');
  });
});

describe('Authentication epoch after recovery', () => {
  it('rejects stale access tokens even if a session row survives cleanup', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id', tokenId: 'session-id', authVersion: 0 }) } as unknown as JwtService;
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-id', authVersion: 1 }) };
    const sessions = { exists: jest.fn().mockResolvedValue(true) };
    const config = { getOrThrow: jest.fn(() => 'test-value') } as unknown as ConfigService;
    const service = new AuthService(users as never, sessions as never, jwt, config, {} as never, {} as never);
    await expect(service.verifyAccessToken('old-token')).rejects.toThrow('revoked by account recovery');
  });
});

describe('Connected account recovery', () => {
  it('disconnects only stale or inactive account sockets in a batched read', async () => {
    const users = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'student', authVersion: 2, status: 'active', disabled: false }, { _id: 'teacher', authVersion: 0, status: 'active', disabled: false }]) }) }) };
    const service = new AuthService(users as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    expect(await service.revokedSocketSessions([{ socketId: 'old', userId: 'student', authVersion: 1 }, { socketId: 'new', userId: 'student', authVersion: 2 }, { socketId: 'teacher-current', userId: 'teacher', authVersion: 0 }, { socketId: 'deleted', userId: 'missing', authVersion: 0 }])).toEqual(['old', 'deleted']);
    expect(users.find).toHaveBeenCalledTimes(1);
  });
});

describe('Old refresh tokens after recovery', () => {
  it('rejects an older epoch before reuse detection can revoke newly recovered sessions', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id', tokenId: 'old-session', authVersion: 0 }) } as unknown as JwtService;
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-id', authVersion: 1 }) };
    const sessions = { findOne: jest.fn(), updateMany: jest.fn() };
    const config = { getOrThrow: jest.fn(() => 'test-value') } as unknown as ConfigService;
    const service = new AuthService(users as never, sessions as never, jwt, config, {} as never, {} as never);
    await expect(service.refresh('stolen-old-refresh')).rejects.toThrow('revoked by account recovery');
    expect(sessions.findOne).not.toHaveBeenCalled(); expect(sessions.updateMany).not.toHaveBeenCalled();
  });
});
