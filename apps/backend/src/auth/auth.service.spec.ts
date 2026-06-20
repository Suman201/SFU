import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('verifies access tokens with issuer and audience', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id' }) } as unknown as JwtService;
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-id' }) };
    const config = {
      getOrThrow: jest.fn((key: string) => ({
        'jwt.accessSecret': 'access-secret',
        'jwt.issuer': 'native-sfu-auth',
        'jwt.audience': 'native-sfu-clients'
      })[key])
    } as unknown as ConfigService;
    const service = new AuthService(users as never, {} as never, {} as never, jwt, config, {} as never);

    await service.verifyAccessToken('token');

    expect(jwt.verifyAsync).toHaveBeenCalledWith('token', {
      secret: 'access-secret',
      issuer: 'native-sfu-auth',
      audience: 'native-sfu-clients'
    });
    expect(users.findOne).toHaveBeenCalledWith({ _id: 'user-id', deletedAt: { $exists: false }, disabled: false, status: 'active' });
  });
});
