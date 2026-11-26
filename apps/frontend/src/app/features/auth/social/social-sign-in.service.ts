import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';
import { API_BASE_URL } from '../../../core/services/app-environment';
import { AuthRole } from '../../../core/services/auth.service';
import { safeAuthReturnPath } from '../../../core/services/auth-return-path';

type Provider = 'google' | 'apple';
export interface PendingSocialLogin { verifier: string; role: AuthRole; rememberMe: boolean; returnUrl: string | null; expiresAt: number; provider: Provider; }
const PENDING_KEY = 'native-sfu.auth.social.pending';

@Injectable({ providedIn: 'root' })
export class SocialSignInService {
  private readonly http = inject(HttpClient);
  providers() {
    return this.http.get<{ data: Record<Provider, boolean> }>(`${API_BASE_URL}/auth/social/providers`).pipe(map(response => response.data));
  }
  async start(provider: Provider, role: AuthRole, rememberMe: boolean, returnUrl: string | null): Promise<void> {
    const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    const response = await firstValueFrom(this.http.post<{ data: { authorizationUrl: string } }>(`${API_BASE_URL}/auth/social/${provider}/start`, { role, challenge }));
    const url = new URL(response.data.authorizationUrl);
    if (url.protocol !== 'https:' || url.origin !== (provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com')) throw new Error('The sign-in provider is not available.');
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, role, provider, rememberMe, returnUrl: safeAuthReturnPath(returnUrl, role), expiresAt: Date.now() + 10 * 60000 } satisfies PendingSocialLogin));
    window.location.assign(url.href);
  }
  pending(): PendingSocialLogin | null {
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as PendingSocialLogin | null;
      return value && value.expiresAt > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(value.verifier) && ['student', 'teacher'].includes(value.role) && ['google', 'apple'].includes(value.provider) ? value : null;
    } catch { return null; }
  }
  clear(): void { sessionStorage.removeItem(PENDING_KEY); }
}
