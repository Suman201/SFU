export interface DesktopReminder { id: string; title: string; startsAt: string; joinPath: string; }
export interface DesktopUpdateState { status: 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'deferred'; message: string; version?: string; }
export interface ClassroomDesktopBridge {
  getInfo(): Promise<{ version: string; platform: string; websiteUrl: string; serverUrl: string; packaged: boolean }>;
  getPreferences(): Promise<{ remindersEnabled: boolean }>;
  setPreferences(preferences: { remindersEnabled: boolean }): Promise<{ remindersEnabled: boolean }>;
  setClassActive(active: boolean): Promise<void>;
  setReminders(reminders: DesktopReminder[]): Promise<void>;
  onOpenClass(callback: (path: string) => void): () => void;
  getPendingClass(): Promise<string | null>;
  openWebsite(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<DesktopUpdateState>;
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdateState(callback: (state: DesktopUpdateState) => void): () => void;
  saveDiagnostics(options: { description: string; includeDiagnostics: boolean }): Promise<{ saved: boolean; path?: string }>;
}

declare global { interface Window { classroomDesktop?: ClassroomDesktopBridge; } }

export function isDesktopSession(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.classroomDesktop || window.location.pathname.startsWith('/desktop')) return true;
  try { return sessionStorage.getItem('native-sfu.desktop') === '1'; } catch { return false; }
}

/** Accept a classroom destination only, never a URL, administration route or bearer token. */
export function normalizeDesktopDestination(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, 'https://classroom.invalid');
    if (url.origin !== 'https://classroom.invalid') return null;
    if (url.pathname === '/desktop/batches' || url.pathname === '/desktop/calendar' || url.pathname === '/desktop/upcoming' || url.pathname === '/desktop/recordings') return url.pathname;
    if (!['/desktop/join', '/class-session/teacher', '/class-session/student'].includes(url.pathname)) return null;
    const sessionId = url.searchParams.get('sessionId');
    const batchId = url.searchParams.get('batchId');
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || (batchId && !/^[a-zA-Z0-9_-]{1,128}$/.test(batchId))) return null;
    const query = new URLSearchParams({ sessionId });
    if (batchId) query.set('batchId', batchId);
    return `/desktop/join?${query}`;
  } catch { return null; }
}
