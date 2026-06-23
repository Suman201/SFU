import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';
import { Observable, catchError, finalize, map, of, shareReplay, throwError } from 'rxjs';
import { API_BASE_URL } from './app-environment';

export type AuthStatus = 'checking' | 'authenticated' | 'guest';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  permissions: string[];
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: string;
  user: AuthUser;
}

interface BackendLoginResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: string;
  user?: BackendUser;
}

interface BackendUser {
  id?: string | number;
  sub?: string;
  name?: string;
  displayName?: string;
  email?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
}

interface JwtPayload {
  exp?: number;
  sub?: string;
  email?: string;
  roles?: string[];
  permissions?: string[];
}

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

const ACCESS_TOKEN_KEY = 'native-sfu.admin.auth.accessToken';
const REFRESH_TOKEN_KEY = 'native-sfu.admin.auth.refreshToken';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly statusSignal = signal<AuthStatus>(this.hasUsableToken() ? 'checking' : 'guest');
  private readonly userSignal = signal<AuthUser | null>(null);
  private readonly sessionNoticeSignal = signal('');
  private restoreRequest?: Observable<AuthUser | null>;

  readonly status = this.statusSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly authenticated = computed(() => this.statusSignal() === 'authenticated' && this.userSignal() !== null);
  readonly checking = computed(() => this.statusSignal() === 'checking');
  readonly sessionNotice = this.sessionNoticeSignal.asReadonly();

  constructor(private readonly http: HttpClient) {}

  login(email: string, password: string, rememberMe = false): Observable<LoginResult> {
    this.statusSignal.set('checking');
    this.sessionNoticeSignal.set('');
    return this.http.post<BackendLoginResponse | ApiEnvelope<BackendLoginResponse>>(`${API_BASE_URL}/auth/login`, { email, password }).pipe(
      map((response) => this.storeLoginResponse(this.unwrapResponse(response), rememberMe)),
      catchError((error) => {
        this.clearSession();
        return throwError(() => this.toAuthError(error));
      })
    );
  }

  checkSession(): Observable<AuthUser | null> {
    const token = this.accessToken();
    if (!token) {
      this.clearSession();
      return of(null);
    }
    if (this.isTokenExpired(token)) {
      this.clearSession('Your admin session expired. Please sign in again.');
      return of(null);
    }
    const currentUser = this.userSignal();
    if (currentUser) {
      this.statusSignal.set('authenticated');
      return of(currentUser);
    }
    if (this.restoreRequest) {
      return this.restoreRequest;
    }

    this.statusSignal.set('checking');
    this.restoreRequest = this.http.get<BackendUser | ApiEnvelope<BackendUser>>(`${API_BASE_URL}/auth/me`).pipe(
      map((profile) => {
        const user = this.normalizeUser(this.unwrapResponse(profile), this.decodeToken(token));
        if (!this.hasAdminAccess(user)) {
          this.clearSession('This portal is limited to administrators.');
          return null;
        }
        return this.applyUser(user);
      }),
      catchError(() => {
        this.clearSession('We could not verify your admin session. Please sign in again.');
        return of(null);
      }),
      finalize(() => {
        this.restoreRequest = undefined;
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );
    return this.restoreRequest;
  }

  logout(): void {
    const token = this.accessToken();
    if (token && !this.isTokenExpired(token)) {
      this.http.post(`${API_BASE_URL}/auth/logout`, {}, { headers: { Authorization: `Bearer ${token}` } }).subscribe({ error: () => undefined });
    }
    this.clearSession();
  }

  accessToken(): string | null {
    return this.readStorage(ACCESS_TOKEN_KEY);
  }

  redirectPath(): string {
    return '/class-sessions';
  }

  hasAdminAccess(user: AuthUser | null | undefined): boolean {
    const roles = (user?.roles ?? []).map((role) => role.toUpperCase());
    return roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
  }

  clearSession(notice = ''): void {
    this.removeStorage(ACCESS_TOKEN_KEY);
    this.removeStorage(REFRESH_TOKEN_KEY);
    this.userSignal.set(null);
    this.statusSignal.set('guest');
    this.sessionNoticeSignal.set(notice);
  }

  authErrorMessage(error: unknown): string {
    return this.toAuthError(error).message;
  }

  private storeLoginResponse(response: BackendLoginResponse, rememberMe: boolean): LoginResult {
    if (!response.accessToken) {
      throw new Error('Login response did not include an access token.');
    }
    const payload = this.decodeToken(response.accessToken);
    if (this.isTokenExpired(response.accessToken)) {
      throw new Error('Login session expired before it could be stored.');
    }
    const user = this.normalizeUser(response.user, payload);
    if (!this.hasAdminAccess(user)) {
      this.clearSession();
      throw new Error('This portal is only available to admin and super admin accounts.');
    }

    this.removeStorage(ACCESS_TOKEN_KEY);
    this.removeStorage(REFRESH_TOKEN_KEY);
    this.writeStorage(ACCESS_TOKEN_KEY, response.accessToken, rememberMe);
    if (response.refreshToken) {
      this.writeStorage(REFRESH_TOKEN_KEY, response.refreshToken, rememberMe);
    }
    this.applyUser(user);
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresIn: response.expiresIn,
      user
    };
  }

  private applyUser(user: AuthUser): AuthUser {
    this.userSignal.set(user);
    this.statusSignal.set('authenticated');
    this.sessionNoticeSignal.set('');
    return user;
  }

  private unwrapResponse<T>(response: T | ApiEnvelope<T>): T {
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as ApiEnvelope<T>).data;
      if (data !== undefined && data !== null) {
        return data;
      }
    }
    return response as T;
  }

  private normalizeUser(user: BackendUser | undefined, payload: JwtPayload | null): AuthUser {
    const roles = this.normalizeRoles(user?.roles ?? (user?.role ? [user.role] : payload?.roles));
    const name = user?.displayName ?? user?.name ?? user?.email ?? payload?.email ?? 'Administrator';
    return {
      id: String(user?.id ?? user?.sub ?? payload?.sub ?? ''),
      name,
      email: user?.email ?? payload?.email ?? '',
      roles,
      permissions: user?.permissions ?? payload?.permissions ?? []
    };
  }

  private normalizeRoles(values: string[] | undefined): string[] {
    const roles = (values ?? []).map((role) => role.toUpperCase());
    return roles.length ? [...new Set(roles)] : [];
  }

  private hasUsableToken(): boolean {
    const token = this.accessToken();
    return Boolean(token && !this.isTokenExpired(token));
  }

  private isTokenExpired(token: string): boolean {
    const exp = this.decodeToken(token)?.exp;
    return typeof exp === 'number' ? exp * 1000 <= Date.now() : false;
  }

  private decodeToken(token: string): JwtPayload | null {
    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      return JSON.parse(atob(padded)) as JwtPayload;
    } catch {
      return null;
    }
  }

  private toAuthError(error: unknown): Error {
    if (error instanceof Error && !(error instanceof HttpErrorResponse)) {
      return error;
    }
    if (error instanceof HttpErrorResponse) {
      const backendMessage = this.extractBackendMessage(error.error);
      if (error.status === 0) {
        return new Error('We could not reach the server. Check your connection and try again.');
      }
      if (error.status >= 500) {
        return new Error('The server had trouble signing you in. Please try again shortly.');
      }
      if (error.status === 401 || error.status === 403) {
        return new Error(backendMessage || 'This admin account could not be authorized.');
      }
      return new Error(backendMessage || 'Please check the form and try again.');
    }
    return new Error('Something went wrong. Please try again.');
  }

  private extractBackendMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return '';
    }
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string') {
      return value.message;
    }
    if (Array.isArray(value.message)) {
      return value.message.join(' ');
    }
    if (typeof value.error === 'string') {
      return value.error;
    }
    return '';
  }

  private readStorage(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? globalThis.sessionStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string, rememberMe: boolean): void {
    try {
      const target = rememberMe ? globalThis.localStorage : globalThis.sessionStorage;
      const other = rememberMe ? globalThis.sessionStorage : globalThis.localStorage;
      target?.setItem(key, value);
      other?.removeItem(key);
    } catch {
      // A blocked storage write leaves the session in-memory only.
    }
  }

  private removeStorage(key: string): void {
    try {
      globalThis.localStorage?.removeItem(key);
      globalThis.sessionStorage?.removeItem(key);
    } catch {
      // Ignore storage cleanup failures.
    }
  }
}
