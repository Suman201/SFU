const requiredKeys = ['MONGODB_URI', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TURN_SECRET'] as const;

export function validateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = String(config.NODE_ENV ?? 'development').toLowerCase();
  const missing = requiredKeys.filter((key) => typeof config[key] !== 'string' || String(config[key]).length < 12);
  if (missing.length > 0) {
    throw new Error(`Missing or weak environment values: ${missing.join(', ')}`);
  }
  const mediaWorkerMode = String(config.MEDIA_WORKER_MODE ?? 'in-process');
  if (!['in-process', 'worker'].includes(mediaWorkerMode)) {
    throw new Error('MEDIA_WORKER_MODE must be one of: in-process, worker');
  }
  const mediaWorkerCount = Number(config.MEDIA_WORKER_COUNT ?? 1);
  if (!Number.isInteger(mediaWorkerCount) || mediaWorkerCount < 1) {
    throw new Error('MEDIA_WORKER_COUNT must be a positive integer');
  }
  for (const key of [
    'MEDIA_WORKER_MAX_ROOMS_PER_WORKER',
    'MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER',
    'MEDIA_WORKER_MAX_INFLIGHT_REQUESTS_PER_WORKER',
    'MEDIA_WORKER_DRAIN_TIMEOUT_MS',
    'MEDIA_WORKER_SOFT_IPC_LATENCY_MS',
    'MEDIA_WORKER_HARD_IPC_LATENCY_MS',
    'MEDIA_WORKER_SOFT_MEMORY_LIMIT_BYTES',
    'MEDIA_WORKER_HARD_MEMORY_LIMIT_BYTES',
    'MEDIA_WORKER_SOFT_RTP_PACKET_RATE',
    'MEDIA_WORKER_SOFT_RTCP_PACKET_RATE',
    'NODE_HEARTBEAT_INTERVAL_MS',
    'NODE_TTL_MS',
    'NODE_MAX_ROOMS',
    'NODE_MAX_TRANSPORTS',
    'PIPE_COORDINATION_TIMEOUT_MS',
    'PIPE_COORDINATION_MAX_ATTEMPTS',
    'PIPE_MAX_SETUP_REQUESTS_PER_MINUTE'
  ]) {
    if (config[key] !== undefined && String(config[key]).length > 0 && (!Number.isFinite(Number(config[key])) || Number(config[key]) < 1)) {
      throw new Error(`${key} must be a positive number`);
    }
  }
  if (String(config.ENABLE_PIPE_TRANSPORT ?? 'false').toLowerCase() === 'true') {
    if (typeof config.PIPE_CLUSTER_SECRET !== 'string' || String(config.PIPE_CLUSTER_SECRET).length < 24) {
      throw new Error('PIPE_CLUSTER_SECRET must be at least 24 characters when ENABLE_PIPE_TRANSPORT=true');
    }
    if (nodeEnv !== 'test' && String(config.PIPE_ADVERTISE_IP ?? '').trim().length === 0) {
      throw new Error('PIPE_ADVERTISE_IP is required when ENABLE_PIPE_TRANSPORT=true outside test mode');
    }
  }
  if (config.PIPE_PORT_RANGE !== undefined && !/^\d{2,5}-\d{2,5}$/.test(String(config.PIPE_PORT_RANGE))) {
    throw new Error('PIPE_PORT_RANGE must use min-max format, for example 41000-41100');
  }
  if (config.PIPE_ALLOWED_NODE_IDS !== undefined) {
    const invalid = String(config.PIPE_ALLOWED_NODE_IDS)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .some((value) => !/^[a-zA-Z0-9._:-]+$/.test(value));
    if (invalid) {
      throw new Error('PIPE_ALLOWED_NODE_IDS must be a comma-separated list of node IDs');
    }
  }
  return config;
}
