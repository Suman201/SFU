import { buildIceTurnServers, resolveAnnouncedAddress, splitConfigList } from './media.config';
import { envOrSecretFile } from './secret-file';

export const appConfig = () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? ((process.env.NODE_ENV ?? 'development') === 'production' ? 1 : 0)),
    gracefulShutdownTimeoutMs: Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS ?? 30_000)
  },
  database: {
    uri: envOrSecretFile('MONGODB_URI')
  },
  redis: {
    url: envOrSecretFile('REDIS_URL'),
    required: process.env.REDIS_REQUIRED !== 'false'
  },
  jwt: {
    accessSecret: envOrSecretFile('JWT_ACCESS_SECRET'),
    refreshSecret: envOrSecretFile('JWT_REFRESH_SECRET'),
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
    enabled: parseBoolean(process.env.SWAGGER_ENABLED, (process.env.NODE_ENV ?? 'development') !== 'production'),
    title: process.env.SWAGGER_TITLE ?? 'EduConnect Live Backend API',
    version: process.env.SWAGGER_VERSION ?? '0.1.0',
    path: process.env.SWAGGER_PATH ?? 'api/docs'
  },
  metrics: {
    enabled: parseBoolean(process.env.METRICS_ENABLED, true),
    path: process.env.METRICS_PATH ?? 'metrics'
  },
  seed: {
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL,
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD
  },
  security: {
    rateLimitTtlSeconds: Number(process.env.RATE_LIMIT_TTL ?? 60),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120),
    socketConnectionRateLimitMax: Number(process.env.SOCKET_CONNECTION_RATE_LIMIT_MAX ?? 60),
    socketEventRateLimitMax: Number(process.env.SOCKET_EVENT_RATE_LIMIT_MAX ?? 300),
    socketJoinRateLimitMax: Number(process.env.SOCKET_JOIN_RATE_LIMIT_MAX ?? 30),
    socketMediaRateLimitMax: Number(process.env.SOCKET_MEDIA_RATE_LIMIT_MAX ?? 240),
    socketRealtimeRateLimitMax: Number(process.env.SOCKET_REALTIME_RATE_LIMIT_MAX ?? 1200),
    socketMaxPayloadBytes: Number(process.env.SOCKET_MAX_PAYLOAD_BYTES ?? 1_048_576),
    operationsToken: envOrSecretFile('OPERATIONS_TOKEN')
  },
  logging: {
    level: process.env.LOG_LEVEL ?? ((process.env.NODE_ENV ?? 'development') === 'production' ? 'info' : 'debug')
  },
  turn: {
    realm: process.env.TURN_REALM ?? 'native-sfu.local',
    secret: envOrSecretFile('TURN_SECRET'),
    uris: splitConfigList(process.env.TURN_URIS)
  },
  mediaWorker: {
    mode: process.env.MEDIA_WORKER_MODE ?? 'in-process',
    count: Number(process.env.MEDIA_WORKER_COUNT ?? 1),
    hostCandidatePortRange: parsePortRange(process.env.HOST_CANDIDATE_PORT_RANGE ?? '40000-40999'),
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
    softRtcpPacketRate: Number(process.env.MEDIA_WORKER_SOFT_RTCP_PACKET_RATE ?? 5000),
    maxInboundPacketQueuePackets: Number(process.env.MEDIA_MAX_INBOUND_PACKET_QUEUE_PACKETS ?? 2048),
    maxInboundPacketQueueBytes: Number(process.env.MEDIA_MAX_INBOUND_PACKET_QUEUE_BYTES ?? 8 * 1024 * 1024)
  },
  media: {
    ice: {
      stunServers: splitConfigList(process.env.ICE_STUN_SERVERS),
      turnServers: buildIceTurnServers(splitConfigList(process.env.ICE_TURN_SERVERS), {
        turnSecret: envOrSecretFile('TURN_SECRET'),
        turnRealm: process.env.TURN_REALM,
        usernameSubject: process.env.NODE_ID ?? 'media-node'
      }),
      announcedAddress: resolveAnnouncedAddress(process.env.ICE_ANNOUNCED_ADDRESS, process.env.ICE_PUBLIC_CANDIDATE_ADDRESS)
    }
  },
  roomLimits: {
    maxParticipants: Number(process.env.ROOM_MAX_PARTICIPANTS ?? 100),
    maxProducers: Number(process.env.ROOM_MAX_PRODUCERS ?? 300),
    maxProducersPerParticipant: Number(process.env.ROOM_MAX_PRODUCERS_PER_PARTICIPANT ?? 3),
    maxConsumers: Number(process.env.ROOM_MAX_CONSUMERS ?? 20_000),
    maxConsumersPerParticipant: Number(process.env.ROOM_MAX_CONSUMERS_PER_PARTICIPANT ?? 300),
    maxScreenProducers: Number(process.env.ROOM_MAX_SCREEN_PRODUCERS ?? 4),
    maxAudioBitrateBps: Number(process.env.ROOM_MAX_AUDIO_BITRATE_BPS ?? 128_000),
    maxVideoBitrateBps: Number(process.env.ROOM_MAX_VIDEO_BITRATE_BPS ?? 2_500_000),
    maxScreenBitrateBps: Number(process.env.ROOM_MAX_SCREEN_BITRATE_BPS ?? 5_000_000)
  },
  ingest: {
    enabled: parseBoolean(process.env.INGEST_ENABLED, (process.env.NODE_ENV ?? 'development') !== 'production'),
    allowedSourceHosts: splitConfigList(process.env.INGEST_ALLOWED_SOURCE_HOSTS),
    secretEnvPrefix: process.env.INGEST_SECRET_ENV_PREFIX?.trim() || 'INGEST_SECRET_',
    allowPrivateHandoff: parseBoolean(process.env.INGEST_ALLOW_PRIVATE_HANDOFF, false),
    runtimeMetricsPersistIntervalMs: Number(process.env.INGEST_RUNTIME_METRICS_PERSIST_INTERVAL_MS ?? 5000),
    coordinationTimeoutMs: Number(process.env.INGEST_COORDINATION_TIMEOUT_MS ?? 5000),
    ffmpegPath: process.env.INGEST_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH,
    ffprobePath: process.env.INGEST_FFPROBE_PATH?.trim() || process.env.FFPROBE_PATH,
    userAgent: process.env.INGEST_USER_AGENT ?? 'NativeSFU-Ingest/0.1'
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
    clusterSecret: envOrSecretFile('PIPE_CLUSTER_SECRET'),
    previousClusterSecret: envOrSecretFile('PIPE_CLUSTER_SECRET_PREVIOUS'),
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
    retentionDays: Number(process.env.RECORDING_RETENTION_DAYS ?? 90),
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Bucket: process.env.S3_BUCKET,
    s3AccessKeyId: envOrSecretFile('S3_ACCESS_KEY_ID'),
    s3SecretAccessKey: envOrSecretFile('S3_SECRET_ACCESS_KEY')
  },
  chatAttachments: {
    storageProvider: 'local',
    localPath: process.env.CHAT_ATTACHMENT_LOCAL_PATH ?? './chat-attachments',
    maxFileSizeBytes: Number(process.env.CHAT_ATTACHMENT_MAX_FILE_SIZE_BYTES ?? 2 * 1024 * 1024)
  },
  classMaterials: {
    storageProvider: 'local',
    localPath: process.env.CLASS_MATERIAL_LOCAL_PATH ?? './class-materials',
    maxFileSizeBytes: Number(process.env.CLASS_MATERIAL_MAX_FILE_SIZE_BYTES ?? 10 * 1024 * 1024)
  },
  profileMedia: {
    storageProvider: 'local',
    localPath: process.env.PROFILE_MEDIA_LOCAL_PATH ?? './profile-media',
    maxFileSizeBytes: Number(process.env.PROFILE_MEDIA_MAX_FILE_SIZE_BYTES ?? 2 * 1024 * 1024)
  },
  notifications: {
    email: {
      enabled: parseBoolean(process.env.SMTP_ENABLED, false),
      host: process.env.SMTP_HOST?.trim() || undefined,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: parseBoolean(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER?.trim() || undefined,
      password: envOrSecretFile('SMTP_PASSWORD'),
      fromEmail: process.env.SMTP_FROM_EMAIL?.trim() || undefined,
      fromName: process.env.SMTP_FROM_NAME?.trim() || undefined,
      replyTo: process.env.SMTP_REPLY_TO?.trim() || undefined
    },
    push: {
      enabled: parseBoolean(process.env.PUSH_ENABLED, false),
      vapidPublicKey: process.env.PUSH_VAPID_PUBLIC_KEY?.trim() || undefined,
      vapidPrivateKey: envOrSecretFile('PUSH_VAPID_PRIVATE_KEY'),
      vapidSubject: process.env.PUSH_VAPID_SUBJECT?.trim() || undefined
    }
  },
  events: {
    webhooks: {
      enabled: parseBoolean(process.env.WEBHOOK_DELIVERY_ENABLED, true),
      secretEncryptionKey: envOrSecretFile('WEBHOOK_SECRET_ENCRYPTION_KEY') ?? envOrSecretFile('JWT_ACCESS_SECRET'),
      defaultTimeoutMs: Number(process.env.WEBHOOK_DEFAULT_TIMEOUT_MS ?? 5000),
      defaultMaxAttempts: Number(process.env.WEBHOOK_DEFAULT_MAX_ATTEMPTS ?? 5),
      defaultInitialBackoffMs: Number(process.env.WEBHOOK_DEFAULT_INITIAL_BACKOFF_MS ?? 2000),
      pollIntervalMs: Number(process.env.WEBHOOK_DELIVERY_POLL_INTERVAL_MS ?? 1000),
      leaseMs: Number(process.env.WEBHOOK_DELIVERY_LEASE_MS ?? 30000),
      concurrency: Number(process.env.WEBHOOK_DELIVERY_CONCURRENCY ?? 4),
      maxBatchPerPump: Number(process.env.WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP ?? 16),
      maxConcurrentPerEndpoint: Number(process.env.WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT ?? 2)
    },
    retention: {
      eventRetentionDays: Number(process.env.EVENT_LOG_RETENTION_DAYS ?? 30),
      deliveryRetentionDays: Number(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS ?? 14),
      exhaustedDeliveryRetentionDays: Number(process.env.WEBHOOK_EXHAUSTED_DELIVERY_RETENTION_DAYS ?? 30),
      cleanupIntervalMs: Number(process.env.EVENT_RETENTION_CLEANUP_INTERVAL_MS ?? 3_600_000)
    }
  },
  // Backward-compatible aliases for existing code that still reads raw keys.
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 3000),
  MONGODB_URI: envOrSecretFile('MONGODB_URI'),
  REDIS_URL: envOrSecretFile('REDIS_URL'),
  JWT_ACCESS_SECRET: envOrSecretFile('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: envOrSecretFile('JWT_REFRESH_SECRET'),
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? '15m',
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL ?? '7d',
  TURN_SECRET: envOrSecretFile('TURN_SECRET')
});

function parsePortRange(value: string): { min: number; max: number } {
  const parts = value.split('-').map((part) => Number(part.trim()));
  const min = parts[0];
  const max = parts[1];
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error(`Invalid port range: ${value}`);
  }
  return { min: Number(min), max: Number(max) };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.trim().toLowerCase() === 'true';
}
