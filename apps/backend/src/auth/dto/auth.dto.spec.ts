import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto, RegisterDto } from './auth.dto';

describe('Auth DTO validation', () => {
  it('rejects invalid login payloads', async () => {
    const dto = plainToInstance(LoginDto, { email: 'not-email', password: 'short' });

    const errors = await validate(dto);
    const properties = errors.map((error) => error.property);

    expect(properties).toContain('email');
    expect(properties).toContain('password');
  });

  it('accepts valid register payloads', async () => {
    const dto = plainToInstance(RegisterDto, {
      displayName: 'Ada Lovelace',
      email: 'teacher@example.com',
      password: 'StrongPassword@123'
    });

    const errors = await validate(dto);

    expect(errors.length).toBe(0);
  });
});
