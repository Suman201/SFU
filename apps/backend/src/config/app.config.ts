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
  seed: {
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL,
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD
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
  mediaWorker: {
    mode: process.env.MEDIA_WORKER_MODE ?? 'in-process',
    count: Number(process.env.MEDIA_WORKER_COUNT ?? 1),
    hostCandidatePortRange: parsePortRange(process.env.HOST_CANDIDATE_PORT_RANGE ?? '40000-40100'),
    requestTimeoutMs: Number(process.env.MEDIA_WORKER_REQUEST_TIMEOUT_MS ?? 5000),
    startupTimeoutMs: Number(process.env.MEDIA_WORKER_STARTUP_TIMEOUT_MS ?? 10000),
    heartbeatIntervalMs: Number(process.env.MEDIA_WORKER_HEARTBEAT_INTERVAL_MS ?? 2000),
    heartbeatTimeoutMs: Number(process.env.MEDIA_WORKER_HEARTBEAT_TIMEOUT_MS ?? 6000),
    restartBackoffMs: Number(process.env.MEDIA_WORKER_RESTART_BACKOFF_MS ?? 1000),
    drainTimeoutMs: Number(process.env.MEDIA_WORKER_DRAIN_TIMEOUT_MS ?? 30000),
    maxRoomsPerWorker: Number(process.env.MEDIA_WORKER_MAX_ROOMS_PER_WORKER ?? 100),
    maxTransportsPerWorker: Number(process.env.MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER ?? 500),
    maxInFlightRequestsPerWorker: Number(process.env.MEDIA_WORKER_MAX_INFLIGHT_REQUESTS_PER_WORKER ?? 1000),
    softIpcLatencyMs: Number(process.env.MEDIA_WORKER_SOFT_IPC_LATENCY_MS ?? 100),
    hardIpcLatencyMs: Number(process.env.MEDIA_WORKER_HARD_IPC_LATENCY_MS ?? 1000),
    softMemoryLimitBytes: process.env.MEDIA_WORKER_SOFT_MEMORY_LIMIT_BYTES ? Number(process.env.MEDIA_WORKER_SOFT_MEMORY_LIMIT_BYTES) : undefined,
    hardMemoryLimitBytes: process.env.MEDIA_WORKER_HARD_MEMORY_LIMIT_BYTES ? Number(process.env.MEDIA_WORKER_HARD_MEMORY_LIMIT_BYTES) : undefined,
    softRtpPacketRate: Number(process.env.MEDIA_WORKER_SOFT_RTP_PACKET_RATE ?? 50000),
    softRtcpPacketRate: Number(process.env.MEDIA_WORKER_SOFT_RTCP_PACKET_RATE ?? 5000)
  },
  cluster: {
    nodeId: process.env.NODE_ID,
    region: process.env.NODE_REGION,
    zone: process.env.NODE_ZONE,
    publicUrl: process.env.NODE_PUBLIC_URL ?? process.env.PUBLIC_URL ?? 'http://localhost:3000',
    heartbeatIntervalMs: Number(process.env.NODE_HEARTBEAT_INTERVAL_MS ?? 5000),
    ttlMs: Number(process.env.NODE_TTL_MS ?? 15000),
    draining: String(process.env.NODE_DRAINING ?? 'false').toLowerCase() === 'true',
    preferLocalNode: String(process.env.NODE_PREFER_LOCAL ?? 'true').toLowerCase() !== 'false',
    maxRooms: Number(process.env.NODE_MAX_ROOMS ?? process.env.MEDIA_WORKER_MAX_ROOMS_PER_WORKER ?? 1000),
    maxTransports: Number(process.env.NODE_MAX_TRANSPORTS ?? process.env.MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER ?? 5000)
  },
  pipe: {
    enabled: String(process.env.ENABLE_PIPE_TRANSPORT ?? 'false').toLowerCase() === 'true',
    clusterSecret: process.env.PIPE_CLUSTER_SECRET,
    advertiseIp: process.env.PIPE_ADVERTISE_IP,
    allowedNodeIds: (process.env.PIPE_ALLOWED_NODE_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    portRange: parsePortRange(process.env.PIPE_PORT_RANGE ?? '41000-41100'),
    coordinationTimeoutMs: Number(process.env.PIPE_COORDINATION_TIMEOUT_MS ?? 5000),
    coordinationMaxAttempts: Number(process.env.PIPE_COORDINATION_MAX_ATTEMPTS ?? 3),
    maxSetupRequestsPerMinute: Number(process.env.PIPE_MAX_SETUP_REQUESTS_PER_MINUTE ?? 120)
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

function parsePortRange(value: string): { min: number; max: number } {
  const parts = value.split('-').map((part) => Number(part.trim()));
  const min = parts[0];
  const max = parts[1];
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    return { min: 41000, max: 41100 };
  }
  return { min: Number(min), max: Number(max) };
}
