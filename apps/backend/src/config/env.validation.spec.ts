import { validateConfig } from './env.validation';

describe('validateConfig', () => {
  const baseConfig = {
    NODE_ENV: 'development',
    MONGODB_URI: 'mongodb://localhost:27017/native-sfu-test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'replace-with-strong-access-secret',
    JWT_REFRESH_SECRET: 'replace-with-strong-refresh-secret',
    TURN_SECRET: 'replace-with-turn-rest-secret'
  };

  it('requires PIPE_ADVERTISE_IP when pipe transport is enabled outside test mode', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        ENABLE_PIPE_TRANSPORT: 'true',
        PIPE_CLUSTER_SECRET: '0123456789abcdef01234567',
        PIPE_ADVERTISE_IP: ''
      })
    ).toThrow('PIPE_ADVERTISE_IP is required when ENABLE_PIPE_TRANSPORT=true outside test mode');
  });

  it('allows internal pipe simulation in test mode without PIPE_ADVERTISE_IP', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        NODE_ENV: 'test',
        ENABLE_PIPE_TRANSPORT: 'true',
        PIPE_CLUSTER_SECRET: '0123456789abcdef01234567',
        PIPE_ADVERTISE_IP: ''
      })
    ).not.toThrow();
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
