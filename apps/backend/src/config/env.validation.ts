import Joi from 'joi';

const forbiddenSecretValues = ['changeme', 'change-me', 'secret', 'admin', 'password', 'replace-with-strong-access-secret', 'replace-with-strong-refresh-secret', 'replace-with-turn-rest-secret'];

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
  TURN_REALM: Joi.string().default('native-sfu.local'),
  TURN_SECRET: secretSchema.required(),
  TURN_URIS: Joi.string().allow('').default(''),
  RECORDING_STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  RECORDING_LOCAL_PATH: Joi.string().default('/app/recordings'),
  S3_ENDPOINT: Joi.string().allow('').optional(),
  S3_BUCKET: Joi.string().allow('').optional(),
  S3_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  S3_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  RATE_LIMIT_TTL: Joi.number().integer().min(1).default(60),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).default(120),
  SWAGGER_TITLE: Joi.string().default('EduConnect Live Backend API'),
  SWAGGER_VERSION: Joi.string().default('0.1.0'),
  SWAGGER_PATH: Joi.string().default('api/docs'),
  METRICS_PATH: Joi.string().default('metrics'),
  SUPER_ADMIN_EMAIL: Joi.string().email().optional(),
  SUPER_ADMIN_PASSWORD: Joi.string().min(12).optional(),
  MEDIA_WORKER_MODE: Joi.string().valid('in-process', 'worker').default('in-process'),
  MEDIA_WORKER_COUNT: Joi.number().integer().min(1).default(1),
  HOST_CANDIDATE_PORT_RANGE: Joi.string().pattern(/^\d{2,5}-\d{2,5}$/).default('40000-40100'),
  ENABLE_PIPE_TRANSPORT: Joi.boolean().truthy('true').falsy('false').default(false),
  PIPE_CLUSTER_SECRET: Joi.string().min(24).allow('').when('ENABLE_PIPE_TRANSPORT', { is: true, then: Joi.required().invalid('') }),
  PIPE_ADVERTISE_IP: Joi.string().allow('').when('ENABLE_PIPE_TRANSPORT', { is: true, then: Joi.required().invalid('') }),
  PIPE_PORT_RANGE: Joi.string().pattern(/^\d{2,5}-\d{2,5}$/).default('41000-41100')
}).unknown(true);

export function validateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { error, value } = schema.validate(config, { abortEarly: false, convert: true });
  if (error) {
    throw new Error(`Invalid environment configuration: ${error.details.map((detail) => detail.message).join('; ')}`);
  }
  return value as Record<string, unknown>;
}
