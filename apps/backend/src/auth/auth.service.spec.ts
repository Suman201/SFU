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
    const service = new AuthService(users as never, sessions as never, {} as never, jwt, config, {} as never);

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
    const service = new AuthService(users as never, sessions as never, {} as never, jwt, config, {} as never);

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
