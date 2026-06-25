import { validateConfig } from './env.validation';

const baseConfig = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://localhost:27017/native_sfu_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-valid-length-32chars',
  JWT_REFRESH_SECRET: 'test-refresh-secret-valid-length-32chars',
  TURN_SECRET: 'test-turn-secret-valid-length-32chars'
};

const productionConfig = {
  ...baseConfig,
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://sfu.example.com',
  NODE_PUBLIC_URL: 'https://node-a.sfu.example.com',
  FRONTEND_URL: 'https://app.example.com',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  TURN_URIS: 'turn:sfu.example.com:3478?transport=udp',
  OPERATIONS_TOKEN: 'operations-token-valid-length-32',
  WEBHOOK_SECRET_ENCRYPTION_KEY: 'webhook-secret-encryption-key-32+'
};

describe('validateConfig', () => {
  it('rejects placeholder secrets', () => {
    expect(() => validateConfig({ ...baseConfig, JWT_ACCESS_SECRET: 'secret' })).toThrow(/Invalid environment configuration/);
  });

  it('returns validated config values', () => {
    const validated = validateConfig(baseConfig) as Record<string, unknown>;
    expect(validated.NODE_ENV).toBe('test');
    expect(validated.PORT).toBe(3000);
    expect(validated.HOST_CANDIDATE_PORT_RANGE).toBe('40000-40100');
    expect(validated.ICE_STUN_SERVERS).toBe('');
    expect(validated.ICE_TURN_SERVERS).toBe('');
  });

  it('accepts an explicit host candidate port range for multi-node local validation', () => {
    const validated = validateConfig({ ...baseConfig, HOST_CANDIDATE_PORT_RANGE: '40100-40149' }) as Record<string, unknown>;
    expect(validated.HOST_CANDIDATE_PORT_RANGE).toBe('40100-40149');
  });

  it('rejects semantic port ranges with a descending range', () => {
    expect(() => validateConfig({ ...baseConfig, HOST_CANDIDATE_PORT_RANGE: '40149-40100' })).toThrow(/HOST_CANDIDATE_PORT_RANGE/);
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
    ).toThrow(/PIPE_ADVERTISE_IP/);
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

  it('requires an operations token for production deployments', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        OPERATIONS_TOKEN: ''
      })
    ).toThrow(/OPERATIONS_TOKEN/);
  });

  it('rejects placeholder operations tokens in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        OPERATIONS_TOKEN: 'replace-with-strong-operations-token'
      })
    ).toThrow(/Invalid environment configuration/);
  });

  it('rejects localhost public urls in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        PUBLIC_URL: 'http://localhost:3000',
      })
    ).toThrow(/PUBLIC_URL/);
  });

  it('accepts hardened production values', () => {
    expect(() => validateConfig(productionConfig)).not.toThrow();
  });

  it('requires a dedicated webhook secret encryption key in production when delivery is enabled', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        WEBHOOK_SECRET_ENCRYPTION_KEY: undefined
      })
    ).toThrow(/WEBHOOK_SECRET_ENCRYPTION_KEY/);
  });

  it('does not require SMTP or push config when providers are disabled in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        SMTP_ENABLED: 'false',
        PUSH_ENABLED: 'false'
      })
    ).not.toThrow();
  });

  it('requires SMTP provider fields when SMTP is enabled in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        SMTP_ENABLED: 'true',
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASSWORD: '',
        SMTP_FROM_EMAIL: '',
        SMTP_FROM_NAME: ''
      })
    ).toThrow(/SMTP_HOST/);
  });

  it('accepts SMTP provider fields when SMTP is enabled in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        SMTP_ENABLED: 'true',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        SMTP_USER: 'mailer@example.com',
        SMTP_PASSWORD: 'smtp-password',
        SMTP_FROM_EMAIL: 'classes@example.com',
        SMTP_FROM_NAME: 'Native SFU'
      })
    ).not.toThrow();
  });

  it('requires VAPID config when push is enabled in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        PUSH_ENABLED: 'true',
        PUSH_VAPID_PUBLIC_KEY: '',
        PUSH_VAPID_PRIVATE_KEY: '',
        PUSH_VAPID_SUBJECT: ''
      })
    ).toThrow(/PUSH_VAPID_PUBLIC_KEY/);
  });

  it('accepts VAPID config when push is enabled in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        PUSH_ENABLED: 'true',
        PUSH_VAPID_PUBLIC_KEY: 'public-vapid-key',
        PUSH_VAPID_PRIVATE_KEY: 'private-vapid-key',
        PUSH_VAPID_SUBJECT: 'mailto:admin@example.com'
      })
    ).not.toThrow();
  });

  it('rejects localhost CORS origins in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        CORS_ALLOWED_ORIGINS: 'http://localhost:4200'
      })
    ).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it('rejects wildcard CORS origins in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        CORS_ALLOWED_ORIGINS: '*'
      })
    ).toThrow(/wildcard origins/);
  });

  it('rejects reused production secret values', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        JWT_REFRESH_SECRET: productionConfig.JWT_ACCESS_SECRET
      })
    ).toThrow(/must not reuse the same secret value/);
  });

  it('rejects event retention shorter than delivery retention', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        EVENT_LOG_RETENTION_DAYS: '7',
        WEBHOOK_DELIVERY_RETENTION_DAYS: '14'
      })
    ).toThrow(/EVENT_LOG_RETENTION_DAYS/);
  });

  it('rejects webhook batch sizes smaller than the configured delivery concurrency', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        WEBHOOK_DELIVERY_CONCURRENCY: '8',
        WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP: '4'
      })
    ).toThrow(/WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP/);
  });

  it('rejects per-endpoint dispatch caps that exceed total delivery concurrency', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        WEBHOOK_DELIVERY_CONCURRENCY: '4',
        WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT: '5'
      })
    ).toThrow(/WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT/);
  });

  it('rejects localhost TURN URIs in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        TURN_URIS: 'turn:127.0.0.1:3478?transport=udp',
      })
    ).toThrow(/must not advertise localhost or wildcard hosts in production/);
  });

  it('rejects localhost pipe advertise IPs in production when pipe transport is enabled', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        ENABLE_PIPE_TRANSPORT: 'true',
        PIPE_CLUSTER_SECRET: '0123456789abcdef01234567',
        PIPE_ADVERTISE_IP: '127.0.0.1'
      })
    ).toThrow(/PIPE_ADVERTISE_IP must not use localhost or wildcard hosts in production/);
  });

  it('rejects unsupported TCP TURN URIs', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        TURN_URIS: 'turn:sfu.example.com:3478?transport=tcp'
      })
    ).toThrow(/unsupported TCP\/TLS TURN transport/);
  });

  it('rejects TURN URIs without an explicit UDP transport', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        TURN_URIS: 'turn:sfu.example.com:3478'
      })
    ).toThrow(/transport=udp/);
  });

  it('accepts explicit server-side ICE STUN, TURN, and announced candidate config', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        ICE_STUN_SERVERS: 'stun:stun.example.com:3478',
        ICE_TURN_SERVERS: 'turn:turn.example.com:3478?transport=udp',
        ICE_ANNOUNCED_ADDRESS: '203.0.113.10'
      })
    ).not.toThrow();
  });

  it('rejects unsupported TCP/TLS STUN server entries', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        ICE_STUN_SERVERS: 'stuns:stun.example.com:5349'
      })
    ).toThrow(/unsupported TCP\/TLS STUN transport/);
  });

  it('rejects server-side TURN URIs without an explicit UDP transport', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        ICE_TURN_SERVERS: 'turn:turn.example.com:3478'
      })
    ).toThrow(/ICE_TURN_SERVERS entry "turn:turn.example.com:3478" must explicitly request transport=udp/);
  });

  it('rejects mismatched announced and public candidate aliases', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        ICE_ANNOUNCED_ADDRESS: '203.0.113.10',
        ICE_PUBLIC_CANDIDATE_ADDRESS: '203.0.113.20'
      })
    ).toThrow(/ICE_ANNOUNCED_ADDRESS and ICE_PUBLIC_CANDIDATE_ADDRESS must match/);
  });

  it('rejects localhost announced candidate addresses in production', () => {
    expect(() =>
      validateConfig({
        ...productionConfig,
        ICE_ANNOUNCED_ADDRESS: '127.0.0.1'
      })
    ).toThrow(/ICE_ANNOUNCED_ADDRESS must not use localhost or wildcard hosts in production/);
  });
});
