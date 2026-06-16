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

  it('requires PIPE_ADVERTISE_IP when pipe transport is enabled outside test mode', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        NODE_ENV: 'development',
        ENABLE_PIPE_TRANSPORT: 'true',
        PIPE_CLUSTER_SECRET: '0123456789abcdef01234567',
        PIPE_ADVERTISE_IP: ''
      })
    ).toThrow(/PIPE_ADVERTISE_IP" is required/);
  });

  it('allows pipe transport in worker mode when the cluster secret and advertise IP are configured', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        ENABLE_PIPE_TRANSPORT: 'true',
        MEDIA_WORKER_MODE: 'worker',
        PIPE_CLUSTER_SECRET: '0123456789abcdef01234567',
        PIPE_ADVERTISE_IP: '203.0.113.10'
      })
    ).not.toThrow();
  });
});
