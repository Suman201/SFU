export const appConfig = () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:4200',
  mongodbUri: process.env.MONGODB_URI,
  redisUrl: process.env.REDIS_URL,
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d'
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
  }
});
