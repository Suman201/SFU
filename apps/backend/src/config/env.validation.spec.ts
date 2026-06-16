import { validateConfig } from './env.validation';

const baseConfig = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://localhost:27017/native_sfu_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-valid-length-32chars',
  JWT_REFRESH_SECRET: 'test-refresh-secret-valid-length-32chars',
  TURN_SECRET: 'test-turn-secret-valid-length-32chars'
};

describe('validateConfig', () => {
  it('rejects placeholder secrets', () => {
    expect(() => validateConfig({ ...baseConfig, JWT_ACCESS_SECRET: 'secret' })).toThrow(/Invalid environment configuration/);
  });

  it('returns validated config values', () => {
    expect(validateConfig(baseConfig)).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3000
    });
  });
});
