import { readFileSync } from 'node:fs';

const MAX_SECRET_FILE_BYTES = 64 * 1024;

export function hydrateSecretFiles(config: Record<string, unknown>): Record<string, unknown> {
  const hydrated = { ...config };
  for (const [key, value] of Object.entries(config)) {
    if (!key.endsWith('_FILE') || typeof value !== 'string' || !value.trim()) {
      continue;
    }
    const targetKey = key.slice(0, -'_FILE'.length);
    if (String(hydrated[targetKey] ?? '').trim()) {
      continue;
    }
    hydrated[targetKey] = readSecretFile(value, targetKey);
  }
  return hydrated;
}

export function envOrSecretFile(key: string): string | undefined {
  const direct = process.env[key]?.trim();
  if (direct) {
    return direct;
  }
  const file = process.env[`${key}_FILE`]?.trim();
  return file ? readSecretFile(file, key) : undefined;
}

function readSecretFile(file: string, key: string): string {
  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch (error) {
    throw new Error(`Unable to read secret file for ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (content.length === 0 || content.length > MAX_SECRET_FILE_BYTES) {
    throw new Error(`Secret file for ${key} must contain between 1 and ${MAX_SECRET_FILE_BYTES} bytes`);
  }
  const value = content.toString('utf8').trim();
  if (!value) {
    throw new Error(`Secret file for ${key} is empty`);
  }
  return value;
}
