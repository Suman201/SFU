import Joi from 'joi';
import {
  isLocalOrWildcardHost,
  isSupportedStunUri,
  isSupportedTurnUri,
  parseIceServerUrl,
  parseTurnUriHost,
  resolveAnnouncedAddress,
  splitConfigList
} from './media.config';

const forbiddenSecretValues = [
  'changeme',
  'change-me',
  'secret',
  'admin',
  'password',
  'replace-with-strong-access-secret',
  'replace-with-strong-refresh-secret',
  'replace-with-turn-rest-secret',
  'replace-with-strong-operations-token',
  'replace-with-strong-pipe-cluster-secret'
];

const secretSchema = Joi.string()
  .min(24)
  .custom((value: string, helpers) => {
    if (forbiddenSecretValues.includes(value.toLowerCase())) {
      return helpers.error('any.invalid');
    }
    return value;
  });

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  PUBLIC_URL: Joi.string().uri().default('http://localhost:3000'),
  FRONTEND_URL: Joi.string().default('http://localhost:4200'),
  CORS_ALLOWED_ORIGINS: Joi.string().default(Joi.ref('FRONTEND_URL')),
  MONGODB_URI: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  REDIS_REQUIRED: Joi.boolean().truthy('true').falsy('false').default(true),
  JWT_ACCESS_SECRET: secretSchema.required(),
  JWT_REFRESH_SECRET: secretSchema.required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),
  JWT_ISSUER: Joi.string().default('native-sfu-auth'),
  JWT_AUDIENCE: Joi.string().default('native-sfu-clients'),
  OPERATIONS_TOKEN: secretSchema.allow('').default(''),
  TURN_REALM: Joi.string().default('native-sfu.local'),
  TURN_SECRET: secretSchema.required(),
  TURN_URIS: Joi.string().allow('').default(''),
  ICE_STUN_SERVERS: Joi.string().allow('').default(''),
  ICE_TURN_SERVERS: Joi.string().allow('').default(''),
  ICE_ANNOUNCED_ADDRESS: Joi.string().allow('').default(''),
  ICE_PUBLIC_CANDIDATE_ADDRESS: Joi.string().allow('').default(''),
  RECORDING_STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  RECORDING_LOCAL_PATH: Joi.string().default('/app/recordings'),
  WEBHOOK_SECRET_ENCRYPTION_KEY: secretSchema.optional(),
  WEBHOOK_DELIVERY_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  WEBHOOK_DEFAULT_TIMEOUT_MS: Joi.number().integer().min(500).max(30000).default(5000),
  WEBHOOK_DEFAULT_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  WEBHOOK_DEFAULT_INITIAL_BACKOFF_MS: Joi.number().integer().min(250).max(3_600_000).default(2000),
  WEBHOOK_DELIVERY_POLL_INTERVAL_MS: Joi.number().integer().min(250).max(60_000).default(1000),
  WEBHOOK_DELIVERY_LEASE_MS: Joi.number().integer().min(1000).max(300_000).default(30000),
  WEBHOOK_DELIVERY_CONCURRENCY: Joi.number().integer().min(1).max(64).default(4),
  WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP: Joi.number().integer().min(1).max(256).default(16),
  WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT: Joi.number().integer().min(1).max(32).default(2),
  EVENT_LOG_RETENTION_DAYS: Joi.number().integer().min(1).max(3650).default(30),
  WEBHOOK_DELIVERY_RETENTION_DAYS: Joi.number().integer().min(1).max(3650).default(14),
  WEBHOOK_EXHAUSTED_DELIVERY_RETENTION_DAYS: Joi.number().integer().min(1).max(3650).default(30),
  EVENT_RETENTION_CLEANUP_INTERVAL_MS: Joi.number().integer().min(60_000).max(86_400_000).default(3_600_000),
  S3_ENDPOINT: Joi.string().allow('').optional(),
  S3_BUCKET: Joi.string().allow('').optional(),
  S3_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  S3_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  RATE_LIMIT_TTL: Joi.number().integer().min(1).default(60),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).default(120),
  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(Joi.ref('NODE_ENV', { adjust: (value) => value !== 'production' })),
  SWAGGER_TITLE: Joi.string().default('EduConnect Live Backend API'),
  SWAGGER_VERSION: Joi.string().default('0.1.0'),
  SWAGGER_PATH: Joi.string().default('api/docs'),
  METRICS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  METRICS_PATH: Joi.string().default('metrics'),
  SUPER_ADMIN_EMAIL: Joi.string().email().optional(),
  SUPER_ADMIN_PASSWORD: Joi.string().min(12).optional(),
  MEDIA_WORKER_MODE: Joi.string().valid('in-process', 'worker').default('in-process'),
  MEDIA_WORKER_COUNT: Joi.number().integer().min(1).default(1),
  HOST_CANDIDATE_PORT_RANGE: Joi.string().pattern(/^\d{2,5}-\d{2,5}$/).default('40000-40100'),
  MEDIA_WORKER_HEARTBEAT_INTERVAL_MS: Joi.number().integer().min(250).default(2000),
  MEDIA_WORKER_HEARTBEAT_TIMEOUT_MS: Joi.number().integer().min(500).default(6000),
  ENABLE_PIPE_TRANSPORT: Joi.boolean().truthy('true').falsy('false').default(false),
  PIPE_CLUSTER_SECRET: Joi.string().min(24).allow('').when('ENABLE_PIPE_TRANSPORT', { is: true, then: Joi.required().invalid('') }),
  PIPE_ADVERTISE_IP: Joi.string().allow('').when('ENABLE_PIPE_TRANSPORT', { is: true, then: Joi.required().invalid('') }),
  PIPE_PORT_RANGE: Joi.string().pattern(/^\d{2,5}-\d{2,5}$/).default('41000-41100'),
  NODE_PUBLIC_URL: Joi.string().uri().default(Joi.ref('PUBLIC_URL')),
  NODE_HEARTBEAT_INTERVAL_MS: Joi.number().integer().min(500).default(5000),
  NODE_TTL_MS: Joi.number().integer().min(1000).default(15000)
}).unknown(true);

export function validateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { error, value } = schema.validate(config, { abortEarly: false, convert: true });
  if (error) {
    throw new Error(`Invalid environment configuration: ${error.details.map((detail) => detail.message).join('; ')}`);
  }
  const validated = value as Record<string, unknown>;
  const semanticErrors: string[] = [];

  validatePortRange(validated.HOST_CANDIDATE_PORT_RANGE, 'HOST_CANDIDATE_PORT_RANGE', semanticErrors);
  validatePortRange(validated.PIPE_PORT_RANGE, 'PIPE_PORT_RANGE', semanticErrors);

  const nodeHeartbeatIntervalMs = Number(validated.NODE_HEARTBEAT_INTERVAL_MS);
  const nodeTtlMs = Number(validated.NODE_TTL_MS);
  if (nodeTtlMs <= nodeHeartbeatIntervalMs) {
    semanticErrors.push('NODE_TTL_MS must be greater than NODE_HEARTBEAT_INTERVAL_MS');
  }

  const workerHeartbeatIntervalMs = Number(validated.MEDIA_WORKER_HEARTBEAT_INTERVAL_MS);
  const workerHeartbeatTimeoutMs = Number(validated.MEDIA_WORKER_HEARTBEAT_TIMEOUT_MS);
  if (workerHeartbeatTimeoutMs <= workerHeartbeatIntervalMs) {
    semanticErrors.push('MEDIA_WORKER_HEARTBEAT_TIMEOUT_MS must be greater than MEDIA_WORKER_HEARTBEAT_INTERVAL_MS');
  }

  const eventRetentionDays = Number(validated.EVENT_LOG_RETENTION_DAYS);
  const deliveryRetentionDays = Number(validated.WEBHOOK_DELIVERY_RETENTION_DAYS);
  const exhaustedDeliveryRetentionDays = Number(validated.WEBHOOK_EXHAUSTED_DELIVERY_RETENTION_DAYS);
  const webhookDeliveryConcurrency = Number(validated.WEBHOOK_DELIVERY_CONCURRENCY);
  const webhookDeliveryMaxBatchPerPump = Number(validated.WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP);
  const webhookMaxConcurrentPerEndpoint = Number(validated.WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT);
  if (eventRetentionDays < deliveryRetentionDays) {
    semanticErrors.push('EVENT_LOG_RETENTION_DAYS must be greater than or equal to WEBHOOK_DELIVERY_RETENTION_DAYS');
  }
  if (eventRetentionDays < exhaustedDeliveryRetentionDays) {
    semanticErrors.push('EVENT_LOG_RETENTION_DAYS must be greater than or equal to WEBHOOK_EXHAUSTED_DELIVERY_RETENTION_DAYS');
  }
  if (webhookDeliveryMaxBatchPerPump < webhookDeliveryConcurrency) {
    semanticErrors.push('WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP must be greater than or equal to WEBHOOK_DELIVERY_CONCURRENCY');
  }
  if (webhookMaxConcurrentPerEndpoint > webhookDeliveryConcurrency) {
    semanticErrors.push('WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT must be less than or equal to WEBHOOK_DELIVERY_CONCURRENCY');
  }

  const nodeEnv = String(validated.NODE_ENV ?? 'development');
  if (nodeEnv === 'production') {
    validatePublicUrl(validated.PUBLIC_URL, 'PUBLIC_URL', semanticErrors);
    validatePublicUrl(validated.NODE_PUBLIC_URL, 'NODE_PUBLIC_URL', semanticErrors);

    const turnUris = splitConfigList(validated.TURN_URIS);
    if (turnUris.length === 0) {
      semanticErrors.push('TURN_URIS must include at least one TURN URI in production');
    }

    if (!String(validated.OPERATIONS_TOKEN ?? '').trim()) {
      semanticErrors.push('OPERATIONS_TOKEN is required in production');
    }

    if (validated.WEBHOOK_DELIVERY_ENABLED === true && !String(validated.WEBHOOK_SECRET_ENCRYPTION_KEY ?? '').trim()) {
      semanticErrors.push('WEBHOOK_SECRET_ENCRYPTION_KEY is required in production when webhook delivery is enabled');
    }
  }

  validateTurnUris(validated.TURN_URIS, semanticErrors, { rejectLocalHosts: nodeEnv === 'production' });
  validateStunServerUris(validated.ICE_STUN_SERVERS, semanticErrors, { rejectLocalHosts: nodeEnv === 'production' });
  validateIceTurnServerUris(validated.ICE_TURN_SERVERS, semanticErrors, { rejectLocalHosts: nodeEnv === 'production' });
  validateAnnouncedAddress(
    validated.ICE_ANNOUNCED_ADDRESS,
    validated.ICE_PUBLIC_CANDIDATE_ADDRESS,
    semanticErrors,
    { rejectLocalHosts: nodeEnv === 'production' }
  );

  if (nodeEnv === 'production' && validated.ENABLE_PIPE_TRANSPORT === true) {
    validatePipeAdvertiseIp(validated.PIPE_ADVERTISE_IP, semanticErrors);
  }

  if (semanticErrors.length > 0) {
    throw new Error(`Invalid environment configuration: ${semanticErrors.join('; ')}`);
  }

  return validated;
}

function validatePortRange(value: unknown, key: string, errors: string[]): void {
  const parts = String(value ?? '')
    .split('-')
    .map((part) => Number(part.trim()));
  const parsedMin = parts[0];
  const parsedMax = parts[1];

  if (parsedMin === undefined || parsedMax === undefined || !Number.isInteger(parsedMin) || !Number.isInteger(parsedMax)) {
    errors.push(`${key} must use the form min-max`);
    return;
  }
  const min = parsedMin;
  const max = parsedMax;
  if (min < 1024 || max > 65535) {
    errors.push(`${key} must stay within UDP ports 1024-65535`);
  }
  if (min > max) {
    errors.push(`${key} must have min less than or equal to max`);
  }
}

function validatePublicUrl(value: unknown, key: string, errors: string[]): void {
  const url = new URL(String(value));
  if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
    errors.push(`${key} must not point to localhost or wildcard addresses in production`);
  }
}

function validateTurnUris(value: unknown, errors: string[], options: { rejectLocalHosts: boolean }): void {
  const uris = splitConfigList(value);

  for (const uri of uris) {
    if (!parseIceServerUrl(uri) || !uri.trim().toLowerCase().startsWith('turn:')) {
      errors.push(`TURN_URIS entry "${uri}" must use the turn: scheme`);
      continue;
    }
    if (!uri.trim().toLowerCase().includes('transport=udp')) {
      errors.push(`TURN_URIS entry "${uri}" must explicitly request transport=udp`);
    }
    if (!isSupportedTurnUri(uri)) {
      errors.push(`TURN_URIS entry "${uri}" uses an unsupported TCP/TLS TURN transport`);
    }
    if (options.rejectLocalHosts) {
      const host = parseTurnUriHost(uri);
      if (host && isLocalOrWildcardHost(host)) {
        errors.push(`TURN_URIS entry "${uri}" must not advertise localhost or wildcard hosts in production`);
      }
    }
  }
}

function validateStunServerUris(value: unknown, errors: string[], options: { rejectLocalHosts: boolean }): void {
  const uris = splitConfigList(value);

  for (const uri of uris) {
    const parsed = parseIceServerUrl(uri);
    if (!parsed || parsed.scheme !== 'stun') {
      errors.push(`ICE_STUN_SERVERS entry "${uri}" must use the stun: scheme`);
      continue;
    }
    if (!isSupportedStunUri(uri)) {
      errors.push(`ICE_STUN_SERVERS entry "${uri}" uses an unsupported TCP/TLS STUN transport`);
    }
    if (options.rejectLocalHosts && isLocalOrWildcardHost(parsed.host)) {
      errors.push(`ICE_STUN_SERVERS entry "${uri}" must not advertise localhost or wildcard hosts in production`);
    }
  }
}

function validateIceTurnServerUris(value: unknown, errors: string[], options: { rejectLocalHosts: boolean }): void {
  const uris = splitConfigList(value);

  for (const uri of uris) {
    const parsed = parseIceServerUrl(uri);
    if (!parsed || parsed.scheme !== 'turn') {
      errors.push(`ICE_TURN_SERVERS entry "${uri}" must use the turn: scheme`);
      continue;
    }
    if (!uri.trim().toLowerCase().includes('transport=udp')) {
      errors.push(`ICE_TURN_SERVERS entry "${uri}" must explicitly request transport=udp`);
    }
    if (!isSupportedTurnUri(uri)) {
      errors.push(`ICE_TURN_SERVERS entry "${uri}" uses an unsupported TCP/TLS TURN transport`);
    }
    if (options.rejectLocalHosts && isLocalOrWildcardHost(parsed.host)) {
      errors.push(`ICE_TURN_SERVERS entry "${uri}" must not advertise localhost or wildcard hosts in production`);
    }
  }
}

function validatePipeAdvertiseIp(value: unknown, errors: string[]): void {
  const host = String(value ?? '').trim().toLowerCase();
  if (host.length === 0) {
    return;
  }
  if (isLocalOrWildcardHost(host)) {
    errors.push('PIPE_ADVERTISE_IP must not use localhost or wildcard hosts in production');
  }
}

function validateAnnouncedAddress(
  primary: unknown,
  alias: unknown,
  errors: string[],
  options: { rejectLocalHosts: boolean }
): void {
  const primaryValue = String(primary ?? '').trim();
  const aliasValue = String(alias ?? '').trim();
  if (primaryValue && aliasValue && primaryValue !== aliasValue) {
    errors.push('ICE_ANNOUNCED_ADDRESS and ICE_PUBLIC_CANDIDATE_ADDRESS must match when both are set');
    return;
  }

  const announcedAddress = resolveAnnouncedAddress(primary, alias);
  if (!announcedAddress) {
    return;
  }
  if (options.rejectLocalHosts && isLocalOrWildcardHost(announcedAddress)) {
    errors.push('ICE_ANNOUNCED_ADDRESS must not use localhost or wildcard hosts in production');
  }
}
