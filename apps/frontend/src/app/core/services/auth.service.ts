import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';
import { Observable, catchError, finalize, map, of, shareReplay, throwError } from 'rxjs';
import { API_BASE_URL } from './app-environment';

export type AuthRole = 'teacher' | 'student';
export type AuthStatus = 'checking' | 'authenticated' | 'guest';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: AuthRole;
  roles: AuthRole[];
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

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
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

const ACCESS_TOKEN_KEY = 'native-sfu.auth.accessToken';
const REFRESH_TOKEN_KEY = 'native-sfu.auth.refreshToken';

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
  readonly role = computed(() => this.userSignal()?.role ?? null);
  readonly sessionNotice = this.sessionNoticeSignal.asReadonly();

  constructor(private readonly http: HttpClient) {}

  login(email: string, password: string, expectedRole?: AuthRole): Observable<LoginResult> {
    this.statusSignal.set('checking');
    this.sessionNoticeSignal.set('');
    return this.http.post<BackendLoginResponse | ApiEnvelope<BackendLoginResponse>>(`${API_BASE_URL}/auth/login`, { email, password }).pipe(
      map((response) => this.storeLoginResponse(this.unwrapResponse(response), expectedRole)),
      catchError((error) => {
        this.clearSession();
        return throwError(() => this.toAuthError(error));
      })
    );
  }

  register(displayName: string, email: string, password: string): Observable<LoginResult> {
    this.statusSignal.set('checking');
    this.sessionNoticeSignal.set('');
    return this.http.post<BackendLoginResponse | ApiEnvelope<BackendLoginResponse>>(`${API_BASE_URL}/auth/register`, { displayName, email, password }).pipe(
      map((response) => this.storeLoginResponse(this.unwrapResponse(response))),
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
      this.clearSession('Your session expired. Please sign in again.');
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
      map((profile) => this.applyUser(this.normalizeUser(this.unwrapResponse(profile), this.decodeToken(token)))),
      catchError(() => {
        this.clearSession('We could not verify your session. Please sign in again.');
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
      this.http
        .post(`${API_BASE_URL}/auth/logout`, {}, { headers: { Authorization: `Bearer ${token}` } })
        .subscribe({ error: () => undefined });
    }
    this.clearSession();
  }

  accessToken(): string | null {
    return this.readStorage(ACCESS_TOKEN_KEY);
  }

  hasRole(role: AuthRole): boolean {
    return this.userSignal()?.role === role;
  }

  redirectPathFor(role = this.role()): string {
    return role === 'teacher' ? '/teacher/dashboard' : '/student/dashboard';
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

  private storeLoginResponse(response: BackendLoginResponse, expectedRole?: AuthRole): LoginResult {
    if (!response.accessToken) {
      throw new Error('Login response did not include an access token.');
    }
    this.writeStorage(ACCESS_TOKEN_KEY, response.accessToken);
    if (response.refreshToken) {
      this.writeStorage(REFRESH_TOKEN_KEY, response.refreshToken);
    } else {
      this.removeStorage(REFRESH_TOKEN_KEY);
    }

    const payload = this.decodeToken(response.accessToken);
    if (this.isTokenExpired(response.accessToken)) {
      throw new Error('Login session expired before it could be stored');
    }

    const user = this.applyUser(this.normalizeUser(response.user, payload));
    if (expectedRole && user.role !== expectedRole) {
      this.clearSession();
      throw new Error(`This account is registered as ${user.role}. Use the ${user.role} login.`);
    }
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
    const role = roles.includes('teacher') ? 'teacher' : 'student';
    const fallbackName = user?.displayName ?? user?.name ?? user?.email ?? payload?.email ?? 'User';
    return {
      id: String(user?.id ?? user?.sub ?? payload?.sub ?? ''),
      name: fallbackName,
      email: user?.email ?? payload?.email ?? '',
      role,
      roles,
      permissions: user?.permissions ?? payload?.permissions ?? []
    };
  }

  private normalizeRoles(values: string[] | undefined): AuthRole[] {
    const roles = (values ?? [])
      .map((role) => role.toLowerCase())
      .map((role) => (role === 'admin' || role === 'super_admin' ? 'teacher' : role))
      .filter((role): role is AuthRole => role === 'teacher' || role === 'student');
    return roles.length ? [...new Set(roles)] : ['student'];
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
      const lowerMessage = backendMessage.toLowerCase();
      if (error.status === 401 && (lowerMessage.includes('invalid email') || lowerMessage.includes('invalid credentials'))) {
        return new Error('The email or password is incorrect.');
      }
      if (lowerMessage.includes('not active') || lowerMessage.includes('inactive') || lowerMessage.includes('disabled')) {
        return new Error('This account is not active. Please contact support or your administrator.');
      }
      if (lowerMessage.includes('expired') || lowerMessage.includes('revoked') || lowerMessage.includes('session is no longer active')) {
        return new Error('Your session expired. Please sign in again.');
      }
      return new Error(backendMessage || error.message || 'Authentication failed. Please check your details and try again.');
    }
    return new Error('Authentication failed');
  }

  private extractBackendMessage(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (!value || typeof value !== 'object') {
      return '';
    }
    const body = value as { message?: unknown; error?: unknown };
    if (Array.isArray(body.message)) {
      return body.message.join('\n');
    }
    if (typeof body.message === 'string') {
      return body.message;
    }
    return typeof body.error === 'string' ? body.error : '';
  }

  private readStorage(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Session persistence is best-effort; auth state still lives in memory.
    }
  }

  private removeStorage(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Nothing to do when storage is unavailable.
    }
  }
}
