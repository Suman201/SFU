import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto, RegisterDto } from './auth.dto';

describe('Auth DTO validation', () => {
  it('rejects invalid login payloads', async () => {
    const dto = plainToInstance(LoginDto, { email: 'not-email', password: 'short' });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('accepts valid register payloads', async () => {
    const dto = plainToInstance(RegisterDto, {
      displayName: 'Ada Lovelace',
      email: 'teacher@example.com',
      password: 'StrongPassword@123'
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
