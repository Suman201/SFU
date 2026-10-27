import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, map } from 'rxjs';
import { ClassSessionService } from '../class-session/class-session.service';
import type { WhiteboardMemorySnapshot } from '@native-sfu/contracts';
import { API_BASE_URL } from '../../core/services/app-environment';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { LessonRecordingService } from '../../core/services/lesson-recording.service';
import { DesktopUpdateState, normalizeDesktopDestination } from '../../core/services/desktop-bridge';

export interface DesktopClass {
  sessionId: string; batchId: string; title: string; batchName: string; courseId?: string; courseName?: string;
  teacherName: string; scheduledAt: string; durationMinutes: number; status: 'scheduled' | 'live' | 'cancelled' | 'completed'; rescheduledAt?: string; originalScheduledAt?: string;
  role: 'teacher' | 'student'; canJoin: boolean; updatedAt: string;
}
export interface DesktopRecording {
  recordingId: string; sessionId: string; batchId: string; title: string; sessionTitle: string; batchName: string;
  courseId?: string; courseName?: string; teacherName: string; startedAt: string; durationSeconds: number;
  status: 'processing' | 'available' | 'failed' | 'unavailable' | 'expired'; role: 'teacher' | 'student'; published: boolean; lastPositionSeconds: number;
}
export interface DesktopPlayback {
  recordingId: string; playbackUrl: string; mimeType: string; durationSeconds: number; lastPositionSeconds: number; expiresAt: string; notesUrl?: string;
  materials: Array<{ materialId: string; title: string; kind: string; url?: string; downloadUrl?: string }>;
}
export function resolveDesktopMediaUrl(value: string, apiBaseUrl = API_BASE_URL, pageOrigin = globalThis.location?.origin ?? 'http://localhost'): string {
  const api = new URL(apiBaseUrl, pageOrigin);
  const media = new URL(value, api);
  const prefix = `${api.pathname.replace(/\/$/, '')}/desktop/recordings/`;
  if (!['http:', 'https:'].includes(media.protocol) || media.origin !== api.origin || media.username || media.password || !media.pathname.startsWith(prefix) || !/^[^/]+\/content$/.test(media.pathname.slice(prefix.length))) throw new Error('Recording playback address is invalid.');
  return media.toString();
}
function unwrap<T>(response: T | { data: T }): T { return response && typeof response === 'object' && 'data' in response ? response.data : response as T; }

@Injectable({ providedIn: 'root' })
export class DesktopService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly sessions = inject(ClassSessionService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  readonly lessonRecording = inject(LessonRecordingService);
  readonly bridge = typeof window !== 'undefined' ? window.classroomDesktop : undefined;
  readonly reminderEnabled = signal(false);
  readonly updateState = signal<DesktopUpdateState>({ status: 'unavailable', message: 'Updates are managed by your browser.' });
  readonly version = signal('Web');
  readonly notice = signal('');
  readonly classItems = signal<DesktopClass[]>([]);
  readonly classesLoading = signal(false);
  readonly classesError = signal('');
  private classRefreshTimer?: ReturnType<typeof setInterval>;
  private classRequest?: Subscription;
  private scheduleUserId = '';
  private lastScheduleRefresh = 0;
  private initialized = false;
  private lastClasses: DesktopClass[] = [];

  constructor() {
    effect(() => {
      const userId = this.auth.user()?.id ?? '';
      if (userId === this.scheduleUserId) return;
      this.scheduleUserId = userId;
      clearInterval(this.classRefreshTimer); this.classRequest?.unsubscribe();
      this.classesLoading.set(false); this.classItems.set([]); this.lastClasses = []; this.lastScheduleRefresh = 0;
      void this.bridge?.setReminders([]).catch(() => undefined);
      if (userId) {
        this.refreshClasses();
        this.classRefreshTimer = setInterval(() => {
          if (Date.now() - this.lastScheduleRefresh > 90_000) void this.bridge?.setReminders([]).catch(() => undefined);
          this.refreshClasses(true);
        }, 30_000);
      }
    });
  }

  refreshClasses(background = false): void {
    const userId = this.auth.user()?.id;
    if (!userId || this.classesLoading()) return;
    this.classesLoading.set(true); if (!background) this.classesError.set('');
    this.classRequest = this.classes().subscribe({
      next: (response) => {
        if (this.auth.user()?.id !== userId) return;
        this.lastScheduleRefresh = Date.now(); this.classItems.set(response.items); this.classesLoading.set(false); this.classesError.set('');
        void this.schedule(response.items);
      },
      error: (error) => {
        this.classesLoading.set(false); this.classesError.set(this.sessions.errorMessage(error));
        if (Date.now() - this.lastScheduleRefresh > 90_000) void this.bridge?.setReminders([]).catch(() => undefined);
      }
    });
  }

  async initialize(): Promise<void> {
    try { sessionStorage.setItem('native-sfu.desktop', '1'); } catch { /* Session storage may be restricted. */ }
    if (this.initialized) return;
    this.initialized = true;
    if (!this.bridge) return;
    this.bridge.onOpenClass((path) => { void this.openDestination(path); });
    this.bridge.onUpdateState((state) => this.updateState.set(state));
    try {
      const [info, preferences, state, pending] = await Promise.all([this.bridge.getInfo(), this.bridge.getPreferences(), this.bridge.getUpdateState(), this.bridge.getPendingClass()]);
      this.version.set(`${info.version} · ${info.platform}`);
      this.reminderEnabled.set(preferences.remindersEnabled);
      await this.schedule(this.lastClasses);
      this.updateState.set(state);
      if (pending) await this.openDestination(pending);
    } catch { this.notice.set('Some desktop features could not be loaded. Your classes are still available.'); }
  }

  classes() { return this.http.get<{ items: DesktopClass[]; total: number }>(`${API_BASE_URL}/desktop/classes`).pipe(map(unwrap)); }
  classroom(id: string) { return this.http.get<DesktopClass>(`${API_BASE_URL}/desktop/classes/${encodeURIComponent(id)}`).pipe(map(unwrap)); }
  notes(id: string) { return this.http.get<{ snapshot: WhiteboardMemorySnapshot }>(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(id)}/notes`).pipe(map(unwrap)); }
  recordings(q = '', courseId = '') {
    return this.http.get<{ items: DesktopRecording[]; total: number }>(`${API_BASE_URL}/desktop/recordings`, { params: { q, courseId } }).pipe(map(unwrap));
  }
  playback(id: string) { return this.http.get<DesktopPlayback>(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(id)}/playback`).pipe(map((response) => { const media = unwrap(response); return { ...media, playbackUrl: resolveDesktopMediaUrl(media.playbackUrl) }; })); }
  progress(id: string, positionSeconds: number, durationSeconds: number, event: string) {
    return this.http.post(`${API_BASE_URL}/desktop/recordings/${encodeURIComponent(id)}/progress`, { positionSeconds, ...(Number.isFinite(durationSeconds) ? { durationSeconds } : {}), event });
  }
  async schedule(classes: DesktopClass[]): Promise<void> {
    this.lastClasses = classes;
    if (!this.bridge) return;
    try {
      await this.bridge.setReminders(this.reminderEnabled() && Date.now() - this.lastScheduleRefresh <= 90_000 ? classes.filter((item) => item.status === 'scheduled').map((item) => ({
        id: item.sessionId, title: item.title, startsAt: item.scheduledAt,
        joinPath: `/desktop/join?${new URLSearchParams({ sessionId: item.sessionId, batchId: item.batchId })}`
      })) : []);
    } catch { this.notice.set('Class reminders could not be scheduled.'); }
  }
  async setReminders(enabled: boolean): Promise<void> {
    if (!this.bridge) return;
    try { await this.bridge.setPreferences({ remindersEnabled: enabled }); this.reminderEnabled.set(enabled); await this.schedule(this.lastClasses); }
    catch { this.notice.set('Your reminder preference could not be saved. Please try again.'); }
  }
  async openDestination(value: string): Promise<void> {
    const destination = normalizeDesktopDestination(value);
    if (!destination) { this.notice.set('This class invitation is not valid.'); return; }
    if (this.router.url.startsWith('/class-session/')) {
      const current = this.router.parseUrl(this.router.url).queryParams['sessionId'];
      const incoming = this.router.parseUrl(destination).queryParams['sessionId'];
      if (current && current === incoming) return;
      const leave = await this.confirmDialog.confirm({ title: 'Open another class?', message: 'You are currently in a classroom. Leave it to open this invitation?', confirmLabel: 'Leave and open class', cancelLabel: 'Stay in class', variant: 'warning' });
      if (!leave) return;
    }
    if (this.auth.authenticated()) await this.router.navigateByUrl(destination);
    else await this.router.navigate(['/desktop/login'], { queryParams: { returnUrl: destination } });
  }
  async website(): Promise<void> {
    const path = this.auth.user()?.roles.includes('teacher') ? '/teacher/dashboard' : '/student/dashboard';
    if (this.bridge) { try { await this.bridge.openWebsite(path); } catch { this.notice.set('The website could not be opened.'); } }
    else window.open(path, '_blank', 'noopener,noreferrer');
  }
  async logout(): Promise<void> {
    clearInterval(this.classRefreshTimer); this.classRequest?.unsubscribe(); this.classItems.set([]); this.lastClasses = [];
    try { await this.bridge?.setReminders([]); } catch { /* Login state is still cleared. */ }
    this.auth.logout();
    await this.router.navigateByUrl('/desktop/login');
  }
}
