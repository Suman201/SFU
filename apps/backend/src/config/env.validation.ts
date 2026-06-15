const requiredKeys = ['MONGODB_URI', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TURN_SECRET'] as const;

export function validateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const missing = requiredKeys.filter((key) => typeof config[key] !== 'string' || String(config[key]).length < 12);
  if (missing.length > 0) {
    throw new Error(`Missing or weak environment values: ${missing.join(', ')}`);
  }
  return config;
}
