type RuntimeEnvironment = {
  apiBaseUrl?: string;
  socketUrl?: string;
};

type RuntimeOverrideKey = keyof RuntimeEnvironment;

export type RoomOwnerRedirectJoinContext = {
  displayName?: string;
  asViewer?: boolean;
};

declare global {
  interface Window {
    __SFU_ENV__?: RuntimeEnvironment;
  }
}

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
const isLocalBrowserOrigin = Boolean(browserOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(browserOrigin));
const runtimeEnvironment = typeof window !== 'undefined' ? resolveRuntimeEnvironment(window, isLocalBrowserOrigin) : undefined;
const defaultOrigin = browserOrigin ?? 'http://localhost:3000';
const defaultApiBaseUrl = `${defaultOrigin}/api/v1`;
const defaultSocketUrl = `${defaultOrigin}/sfu`;

export const API_BASE_URL = normalizeUrl(runtimeEnvironment?.apiBaseUrl ?? defaultApiBaseUrl);
export const SOCKET_URL = normalizeUrl(runtimeEnvironment?.socketUrl ?? defaultSocketUrl);

export function buildRoomOwnerRedirectUrl(ownerUrl: string, roomId: string, joinContext?: RoomOwnerRedirectJoinContext): string {
  const ownerOrigin = new URL(normalizeUrl(ownerUrl)).origin;

  if (typeof window === 'undefined') {
    return `${ownerOrigin}/rooms/${encodeURIComponent(roomId)}`;
  }

  const currentOrigin = window.location.origin;
  const currentApiOrigin = new URL(API_BASE_URL).origin;
  const currentSocketOrigin = new URL(SOCKET_URL).origin;
  const usingSplitFrontendRuntime = currentOrigin !== currentApiOrigin || currentOrigin !== currentSocketOrigin;
  const targetOrigin = usingSplitFrontendRuntime && currentOrigin !== ownerOrigin ? currentOrigin : ownerOrigin;
  const target = new URL(`/rooms/${encodeURIComponent(roomId)}`, `${targetOrigin}/`);

  if (usingSplitFrontendRuntime && targetOrigin === currentOrigin) {
    target.searchParams.set('apiBaseUrl', `${ownerOrigin}/api/v1`);
    target.searchParams.set('socketUrl', `${ownerOrigin}/sfu`);
  }

  const displayName = joinContext?.displayName?.trim();
  if (displayName) {
    target.searchParams.set('joinDisplayName', displayName);
  }
  if (joinContext?.asViewer) {
    target.searchParams.set('joinAsViewer', '1');
  }

  return target.toString();
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveRuntimeEnvironment(currentWindow: Window, allowLocalOverrides: boolean): RuntimeEnvironment | undefined {
  const configured = currentWindow.__SFU_ENV__ ?? {};
  if (!allowLocalOverrides) {
    return configured;
  }

  const stored = readStoredOverrides(currentWindow);
  const query = readQueryOverrides(currentWindow);
  const merged = {
    ...configured,
    ...stored,
    ...query
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function readStoredOverrides(currentWindow: Window): RuntimeEnvironment {
  const apiBaseUrl = readStoredOverride(currentWindow, 'apiBaseUrl');
  const socketUrl = readStoredOverride(currentWindow, 'socketUrl');
  return {
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(socketUrl ? { socketUrl } : {})
  };
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
  const socketUrl = readQueryOverride(currentWindow, params, 'socketUrl');
  return {
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(socketUrl ? { socketUrl } : {})
  };
}

function readQueryOverride(
  currentWindow: Window,
  params: URLSearchParams,
  key: RuntimeOverrideKey
): string | undefined {
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
    // Best effort only; local overrides still work for the current page load.
  }
  return value ? normalizeUrl(value) : undefined;
}

function storageKey(key: RuntimeOverrideKey): string {
  return `native-sfu:${key}`;
}
