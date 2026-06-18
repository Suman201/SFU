import { createHmac } from 'node:crypto';
import type { TurnServerOptions } from '@native-sfu/nest-sfu';

export interface ParsedIceServerUrl {
  scheme: 'stun' | 'turn';
  secure: boolean;
  host: string;
  port: number;
  transport: 'udp' | 'tcp';
  explicitTransport: boolean;
}

interface IceTurnServerConfigOptions {
  turnSecret?: string;
  turnRealm?: string;
  usernameSubject?: string;
  ttlSeconds?: number;
  now?: () => number;
}

export function splitConfigList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveAnnouncedAddress(primary: unknown, alias?: unknown): string | undefined {
  const primaryValue = normalizeOptionalString(primary);
  const aliasValue = normalizeOptionalString(alias);
  return primaryValue ?? aliasValue;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseIceServerUrl(url: string): ParsedIceServerUrl | undefined {
  const trimmed = url.trim();
  const match = trimmed.match(/^(stun|stuns|turn|turns):(.+)$/i);
  if (!match) {
    return undefined;
  }
  const schemeValue = match[1]!.toLowerCase();
  const secure = schemeValue.endsWith('s');
  const scheme = schemeValue.replace(/s$/, '') as 'stun' | 'turn';
  const rest = match[2]!.replace(/^\/\//, '');
  const [authority, query = ''] = rest.split('?');
  if (!authority) {
    return undefined;
  }

  const hostPort = authority.split('/')[0]?.trim() ?? '';
  const normalizedHost = normalizeHost(parseHostFromAuthority(hostPort));
  const normalizedPort = parsePortFromAuthority(hostPort);
  if (!normalizedHost || normalizedPort === undefined) {
    return undefined;
  }

  const transportValue = query
    .split('&')
    .map((part) => part.split('='))
    .find(([key]) => key?.toLowerCase() === 'transport')?.[1]?.toLowerCase();

  return {
    scheme,
    secure,
    host: normalizedHost,
    port: normalizedPort,
    transport: transportValue === 'tcp' ? 'tcp' : 'udp',
    explicitTransport: transportValue !== undefined
  };
}

export function parseUrlHost(value: string): string | undefined {
  try {
    return normalizeHost(new URL(value).hostname);
  } catch {
    return undefined;
  }
}

export function parseTurnUriHost(uri: string): string | undefined {
  return parseIceServerUrl(uri)?.host;
}

export function isSupportedTurnUri(uri: string): boolean {
  const parsed = parseIceServerUrl(uri);
  return parsed?.scheme === 'turn' && !parsed.secure && parsed.transport === 'udp' && parsed.explicitTransport === true;
}

export function isSupportedStunUri(uri: string): boolean {
  const parsed = parseIceServerUrl(uri);
  return parsed?.scheme === 'stun' && !parsed.secure && parsed.transport === 'udp';
}

export function isLocalOrWildcardHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host.toLowerCase());
}

export function buildIceTurnServers(
  urls: string[],
  options: IceTurnServerConfigOptions = {}
): TurnServerOptions[] {
  const turnSecret = normalizeOptionalString(options.turnSecret);
  if (!turnSecret) {
    return [];
  }
  const usernameSubject = normalizeOptionalString(options.usernameSubject) ?? 'media-node';
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const now = options.now ?? Date.now;
  const expires = Math.floor(now() / 1000) + ttlSeconds;
  const username = `${expires}:${usernameSubject}`;
  const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
  const realm = normalizeOptionalString(options.turnRealm);

  return urls
    .filter(isSupportedTurnUri)
    .map((url) => ({
      url,
      username,
      credential,
      realm
    }));
}

function parseHostFromAuthority(authority: string): string | undefined {
  const hostPort = authority.split('@').pop()?.trim() ?? authority;
  if (!hostPort) {
    return undefined;
  }
  if (hostPort.startsWith('[')) {
    const closingBracket = hostPort.indexOf(']');
    return closingBracket > 1 ? hostPort.slice(1, closingBracket) : undefined;
  }
  const segments = hostPort.split(':');
  if (segments.length <= 2) {
    return segments[0];
  }
  return hostPort;
}

function parsePortFromAuthority(authority: string): number | undefined {
  const hostPort = authority.split('@').pop()?.trim() ?? authority;
  if (!hostPort) {
    return undefined;
  }
  if (hostPort.startsWith('[')) {
    const closingBracket = hostPort.indexOf(']');
    const remainder = closingBracket >= 0 ? hostPort.slice(closingBracket + 1) : '';
    if (!remainder) {
      return 3478;
    }
    if (!remainder.startsWith(':')) {
      return undefined;
    }
    return normalizePort(remainder.slice(1));
  }
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon <= 0) {
    return 3478;
  }
  return normalizePort(hostPort.slice(lastColon + 1));
}

function normalizePort(value: string): number | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return port;
}

function normalizeHost(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}
