export const appConfig = () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000'
  },
  database: {
    uri: process.env.MONGODB_URI
  },
  redis: {
    url: process.env.REDIS_URL,
    required: process.env.REDIS_REQUIRED !== 'false'
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
    issuer: process.env.JWT_ISSUER ?? 'native-sfu-auth',
    audience: process.env.JWT_AUDIENCE ?? 'native-sfu-clients'
  },
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? process.env.FRONTEND_URL ?? 'http://localhost:4200')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  },
  swagger: {
    title: process.env.SWAGGER_TITLE ?? 'EduConnect Live Backend API',
    version: process.env.SWAGGER_VERSION ?? '0.1.0',
    path: process.env.SWAGGER_PATH ?? 'api/docs'
  },
  metrics: {
    path: process.env.METRICS_PATH ?? 'metrics'
  },
  security: {
    rateLimitTtl: Number(process.env.RATE_LIMIT_TTL ?? 60),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120)
  },
  turn: {
    realm: process.env.TURN_REALM ?? 'native-sfu.local',
    secret: process.env.TURN_SECRET,
    uris: (process.env.TURN_URIS ?? '').split(',').filter(Boolean)
  },
  recording: {
    driver: process.env.RECORDING_STORAGE_DRIVER ?? 'local',
    localPath: process.env.RECORDING_LOCAL_PATH ?? './recordings',
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Bucket: process.env.S3_BUCKET,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  },
  // Backward-compatible aliases for existing code that still reads raw keys.
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 3000),
  MONGODB_URI: process.env.MONGODB_URI,
  REDIS_URL: process.env.REDIS_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? '15m',
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL ?? '7d',
  TURN_SECRET: process.env.TURN_SECRET
});
