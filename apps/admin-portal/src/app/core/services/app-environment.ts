type RuntimeEnvironment = {
  apiBaseUrl?: string;
};

type RuntimeOverrideKey = keyof RuntimeEnvironment;

declare global {
  interface Window {
    __SFU_ENV__?: RuntimeEnvironment;
  }
}

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
const isLocalBrowserOrigin = Boolean(browserOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(browserOrigin));
const runtimeEnvironment = typeof window !== 'undefined' ? resolveRuntimeEnvironment(window, isLocalBrowserOrigin) : undefined;
const defaultApiBaseUrl = browserOrigin ? `${browserOrigin}/api/v1` : '/api/v1';

export const API_BASE_URL = normalizeUrl(runtimeEnvironment?.apiBaseUrl ?? defaultApiBaseUrl);

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveRuntimeEnvironment(currentWindow: Window, allowLocalOverrides: boolean): RuntimeEnvironment | undefined {
  const configured = sanitizeRuntimeEnvironment(currentWindow.__SFU_ENV__ ?? {}, currentWindow, allowLocalOverrides);
  if (!allowLocalOverrides) {
    return configured;
  }
  const stored = readStoredOverrides(currentWindow);
  const query = readQueryOverrides(currentWindow);
  const merged = { ...configured, ...stored, ...query };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function sanitizeRuntimeEnvironment(
  configured: RuntimeEnvironment,
  currentWindow: Window,
  allowLocalOrigins: boolean
): RuntimeEnvironment {
  if (allowLocalOrigins) {
    return configured;
  }
  return configured.apiBaseUrl && !isLocalRuntimeUrl(configured.apiBaseUrl, currentWindow)
    ? { apiBaseUrl: configured.apiBaseUrl }
    : {};
}

function isLocalRuntimeUrl(value: string | undefined, currentWindow: Window): boolean {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value, currentWindow.location.origin);
    return /^https?:$/.test(parsed.protocol) && /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function readStoredOverrides(currentWindow: Window): RuntimeEnvironment {
  const apiBaseUrl = readStoredOverride(currentWindow, 'apiBaseUrl');
  return apiBaseUrl ? { apiBaseUrl } : {};
}

function readStoredOverride(currentWindow: Window, key: RuntimeOverrideKey): string | undefined {
  try {
    const value = currentWindow.localStorage.getItem(storageKey(key))?.trim();
    return value ? normalizeUrl(value) : undefined;
  } catch {
    return undefined;
  }
}

function readQueryOverrides(currentWindow: Window): RuntimeEnvironment {
  const params = new URLSearchParams(currentWindow.location.search);
  const apiBaseUrl = readQueryOverride(currentWindow, params, 'apiBaseUrl');
  return apiBaseUrl ? { apiBaseUrl } : {};
}

function readQueryOverride(currentWindow: Window, params: URLSearchParams, key: RuntimeOverrideKey): string | undefined {
  if (!params.has(key)) {
    return undefined;
  }
  const value = params.get(key)?.trim();
  try {
    if (value) {
      currentWindow.localStorage.setItem(storageKey(key), normalizeUrl(value));
    } else {
      currentWindow.localStorage.removeItem(storageKey(key));
    }
  } catch {
    // Local override persistence is best effort.
  }
  return value ? normalizeUrl(value) : undefined;
}

function storageKey(key: RuntimeOverrideKey): string {
  return `native-sfu.admin:${key}`;
}
