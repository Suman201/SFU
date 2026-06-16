import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('verifies access tokens with issuer and audience', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id' }) } as unknown as JwtService;
    const config = {
      getOrThrow: jest.fn((key: string) => ({
        'jwt.accessSecret': 'access-secret',
        'jwt.issuer': 'native-sfu-auth',
        'jwt.audience': 'native-sfu-clients'
      })[key])
    } as unknown as ConfigService;
    const service = new AuthService({} as never, jwt, config);

    await service.verifyAccessToken('token');

    expect(jwt.verifyAsync).toHaveBeenCalledWith('token', {
      secret: 'access-secret',
      issuer: 'native-sfu-auth',
      audience: 'native-sfu-clients'
    });
  });
});
