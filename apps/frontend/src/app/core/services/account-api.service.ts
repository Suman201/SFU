import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EXPECTED_ERROR_STATUSES } from '@sapiovian/error-ui';
import { firstValueFrom, map } from 'rxjs';
import type { AccountOverview, AccountSessionPage, UpdateMyProfileRequest, UpdateMySettingsRequest } from '@native-sfu/contracts';
import { isDesktopSession } from './desktop-bridge';
import { API_BASE_URL } from './app-environment';
interface Envelope<T> { data: T }
const LINK_KEY = 'native-sfu.account.provider.pending';
@Injectable({ providedIn: 'root' })
export class AccountApi {
  private readonly http = inject(HttpClient);
  private readonly root = API_BASE_URL + '/account';
  private options() { return { context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [400, 401, 403, 404, 409, 429, 503]) }; }
  overview() { return this.http.get<Envelope<AccountOverview>>(this.root, this.options()).pipe(map(r => r.data)); }
  profile(input: UpdateMyProfileRequest) { return this.http.patch(this.root + '/profile', input, this.options()); }
  preferences(input: UpdateMySettingsRequest) { return this.http.patch(this.root + '/preferences', input, this.options()); }
  sessions(page = 1) { return this.http.get<Envelope<AccountSessionPage>>(this.root + '/sessions', { ...this.options(), params: { page } }).pipe(map(r => r.data)); }
  revoke(id: string) { return this.http.post<Envelope<{ current: boolean }>>(this.root + '/sessions/' + encodeURIComponent(id) + '/revoke', {}, this.options()).pipe(map(r => r.data)); }
  revokeOthers() { return this.http.post(this.root + '/sessions/others/revoke', {}, this.options()); }
  password(currentPassword: string, newPassword: string) { return this.http.post(this.root + '/password', { currentPassword, newPassword }, this.options()); }
  requestEmail(email: string, currentPassword: string) { return this.http.post(this.root + '/email/request', { email, currentPassword }, this.options()); }
  cancelEmail() { return this.http.post(this.root + '/email/cancel', {}, this.options()); }
  confirmEmail(token: string) { return this.http.post<Envelope<{ changed: boolean; accountId: string; role: 'teacher' | 'student' }>>(this.root + '/email/confirm', { token }, this.options()).pipe(map(r => r.data)); }
  unlink(provider: string, currentPassword: string) { return this.http.post(this.root + '/providers/' + encodeURIComponent(provider) + '/unlink', { currentPassword }, this.options()); }
  async startLink(provider: 'google' | 'apple', currentPassword: string): Promise<void> {
    if (isDesktopSession()) throw new Error('Connect sign-in providers from your account on the website.');
    const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    const response = await firstValueFrom(this.http.post<Envelope<{ authorizationUrl: string }>>(this.root + '/providers/' + provider + '/start', { currentPassword, challenge }, this.options()));
    const url = new URL(response.data.authorizationUrl);
    if (url.protocol !== 'https:' || url.origin !== (provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com')) throw new Error('The sign-in provider is not available.');
    sessionStorage.setItem(LINK_KEY, JSON.stringify({ verifier, provider, expiresAt: Date.now() + 10 * 60000 }));
    window.location.assign(url.href);
  }
  pendingLink(): { verifier: string; provider: string } | null {
    try { const value = JSON.parse(sessionStorage.getItem(LINK_KEY) ?? 'null'); return value && value.expiresAt > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(value.verifier) && ['google', 'apple'].includes(value.provider) ? value : null; } catch { return null; }
  }
  clearLink() { sessionStorage.removeItem(LINK_KEY); }
  completeLink(ticket: string, verifier: string) { return this.http.post(this.root + '/providers/complete', { ticket, verifier }, this.options()); }
}
export function accountDate(value: string, locale = 'en-GB', timezone?: string): string {
  try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value)); } catch { return new Date(value).toLocaleString(); }
}
