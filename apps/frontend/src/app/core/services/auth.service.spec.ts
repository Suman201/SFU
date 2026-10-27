import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from './app-environment';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    clearAuthCookies();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
    localStorage.clear();
    clearAuthCookies();
  });

  it('stores a teacher login and exposes the teacher role', () => {
    let role = '';

    service.login('teacher@example.com', 'Password@12345', 'teacher').subscribe((result) => {
      role = result.user.role;
    });

    const request = http.expectOne(`${API_BASE_URL}/auth/login`);
    expect(request.request.method).toBe('POST');
    request.flush({
      success: true,
      message: 'OK',
      data: {
        accessToken: jwt({ sub: 'teacher-1', email: 'teacher@example.com', roles: ['TEACHER'], permissions: [], exp: futureExp() }),
        user: { id: 'teacher-1', name: 'Teacher One', email: 'teacher@example.com', role: 'teacher' }
      }
    });

    expect(role).toBe('teacher');
    expect(service.authenticated()).toBe(true);
    expect(service.role()).toBe('teacher');
    expect(service.accessToken()).toBeTruthy();
  });

  it('stores a remembered login in cookies when remember me is enabled', () => {
    let role = '';

    service.login('student@example.com', 'Password@12345', 'student', true).subscribe((result) => {
      role = result.user.role;
    });

    const request = http.expectOne(`${API_BASE_URL}/auth/login`);
    expect(request.request.method).toBe('POST');
    request.flush({
      success: true,
      message: 'OK',
      data: {
        accessToken: jwt({ sub: 'student-1', email: 'student@example.com', roles: ['STUDENT'], permissions: [], exp: futureExp() }),
        refreshToken: 'refresh-token',
        user: { id: 'student-1', name: 'Student One', email: 'student@example.com', role: 'student' }
      }
    });

    expect(role).toBe('student');
    expect(service.authenticated()).toBe(true);
    expect(readCookie('native-sfu.auth.accessToken')).toBeTruthy();
    expect(readCookie('native-sfu.auth.refreshToken')).toBe('refresh-token');
    expect(localStorage.getItem('native-sfu.auth.accessToken')).toBeNull();
    expect(sessionStorage.getItem('native-sfu.auth.accessToken')).toBeNull();
  });

  it('rejects a teacher account on the student login flow', () => {
    let message = '';

    service.login('teacher@example.com', 'Password@12345', 'student').subscribe({
      error: (error: Error) => {
        message = error.message;
      }
    });

    http.expectOne(`${API_BASE_URL}/auth/login`).flush({
      success: true,
      message: 'OK',
      data: {
        accessToken: jwt({ sub: 'teacher-1', email: 'teacher@example.com', roles: ['TEACHER'], permissions: [], exp: futureExp() }),
        user: { id: 'teacher-1', name: 'Teacher One', email: 'teacher@example.com', role: 'teacher' }
      }
    });

    expect(message).toBe('This account is registered as teacher. Use the teacher login.');
    expect(service.authenticated()).toBe(false);
    expect(service.accessToken()).toBeNull();
  });

  it('restores a valid stored token through /auth/me', () => {
    sessionStorage.setItem(
      'native-sfu.auth.accessToken',
      jwt({ sub: 'student-1', email: 'student@example.com', roles: ['STUDENT'], permissions: [], exp: futureExp() })
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);

    let role = '';
    service.checkSession().subscribe((user) => {
      role = user?.role ?? '';
    });

    http.expectOne(`${API_BASE_URL}/auth/me`).flush({
      success: true,
      message: 'OK',
      data: {
        id: 'student-1',
        name: 'Student One',
        email: 'student@example.com',
        role: 'student',
        roles: ['STUDENT'],
        permissions: []
      }
    });

    expect(role).toBe('student');
    expect(service.authenticated()).toBe(true);
  });

  it('restores an expired remembered session by rotating refresh tokens', () => {
    document.cookie = `native-sfu.auth.accessToken=${jwt({ sub: 'student-1', roles: ['STUDENT'], exp: 1 })}; Path=/`;
    document.cookie = 'native-sfu.auth.refreshToken=remembered-refresh; Path=/';
    let restored = '';
    service.checkSession().subscribe((user) => restored = user?.id ?? '');
    const refresh = http.expectOne(`${API_BASE_URL}/auth/refresh`);
    expect(refresh.request.body).toEqual({ refreshToken: 'remembered-refresh' });
    const token = jwt({ sub: 'student-1', roles: ['STUDENT'], exp: futureExp() });
    refresh.flush({ accessToken: token, refreshToken: 'rotated-refresh', user: { id: 'student-1', roles: ['STUDENT'] } });
    http.expectOne(`${API_BASE_URL}/auth/me`).flush({ id: 'student-1', roles: ['STUDENT'] });
    expect(restored).toBe('student-1');
    expect(readCookie('native-sfu.auth.refreshToken')).toBe('rotated-refresh');
    expect(sessionStorage.getItem('native-sfu.auth.accessToken')).toBeNull();
  });

  it('shares one refresh rotation across simultaneous requests', () => {
    sessionStorage.setItem('native-sfu.auth.accessToken', jwt({ sub: 'student-1', exp: 1 }));
    sessionStorage.setItem('native-sfu.auth.refreshToken', 'old-refresh');
    const tokens: Array<string | null> = [];
    service.ensureAccessToken().subscribe((token) => tokens.push(token));
    service.ensureAccessToken().subscribe((token) => tokens.push(token));
    const token = jwt({ sub: 'student-1', roles: ['STUDENT'], exp: futureExp() });
    http.expectOne(`${API_BASE_URL}/auth/refresh`).flush({ accessToken: token, refreshToken: 'new-refresh' });
    expect(tokens).toEqual([token, token]);
    expect(sessionStorage.getItem('native-sfu.auth.refreshToken')).toBe('new-refresh');
  });

  it('keeps a remembered refresh token during a temporary server outage', () => {
    document.cookie = 'native-sfu.auth.refreshToken=retry-me; Path=/';
    service.checkSession().subscribe();
    http.expectOne(`${API_BASE_URL}/auth/refresh`).flush({}, { status: 503, statusText: 'Unavailable' });
    expect(readCookie('native-sfu.auth.refreshToken')).toBe('retry-me');
    expect(service.authenticated()).toBe(false);
    expect(service.sessionNotice()).toContain('Reconnect');
  });

  it('does not restore a user after sign-out during token refresh', () => {
    sessionStorage.setItem('native-sfu.auth.refreshToken', 'old-refresh');
    let rejected = false;
    service.ensureAccessToken().subscribe({ error: () => rejected = true });
    const request = http.expectOne(`${API_BASE_URL}/auth/refresh`);
    service.logout();
    request.flush({ accessToken: jwt({ sub: 'student-1', exp: futureExp() }), refreshToken: 'new-refresh' });
    expect(rejected).toBe(true);
    expect(service.authenticated()).toBe(false);
    expect(service.accessToken()).toBeNull();
  });

  for (const status of [401, 403, 503]) {
    it(`preserves a newer login when an older refresh fails with ${status}`, () => {
      sessionStorage.setItem('native-sfu.auth.refreshToken', 'old-refresh');
      service.checkSession().subscribe();
      const previous = http.expectOne(`${API_BASE_URL}/auth/refresh`);
      service.logout();
      service.login('new@example.com', 'password').subscribe();
      const token = jwt({ sub: 'new-user', roles: ['STUDENT'], exp: futureExp() });
      http.expectOne(`${API_BASE_URL}/auth/login`).flush({ accessToken: token, refreshToken: 'new-refresh' });
      previous.flush({}, { status, statusText: 'Old session failed' });
      expect(service.user()?.id).toBe('new-user');
      expect(service.authenticated()).toBeTrue();
      expect(service.accessToken()).toBe(token);
      expect(sessionStorage.getItem('native-sfu.auth.refreshToken')).toBe('new-refresh');
      expect(service.sessionNotice()).toBe('');
    });
  }

  it('ignores an old successful refresh after a different account signs in', () => {
    sessionStorage.setItem('native-sfu.auth.refreshToken', 'old-refresh');
    service.checkSession().subscribe();
    const previous = http.expectOne(`${API_BASE_URL}/auth/refresh`);
    service.logout();
    service.login('new@example.com', 'password').subscribe();
    const token = jwt({ sub: 'new-user', roles: ['STUDENT'], exp: futureExp() });
    http.expectOne(`${API_BASE_URL}/auth/login`).flush({ accessToken: token, refreshToken: 'new-refresh' });
    previous.flush({ accessToken: jwt({ sub: 'old-user', exp: futureExp() }), refreshToken: 'old-rotated' });
    http.expectNone(`${API_BASE_URL}/auth/me`);
    expect(service.user()?.id).toBe('new-user');
    expect(service.accessToken()).toBe(token);
    expect(service.authenticated()).toBeTrue();
  });

  it('ignores a profile outage from a session restored before a newer login', () => {
    sessionStorage.setItem('native-sfu.auth.accessToken', jwt({ sub: 'old-user', exp: futureExp() }));
    service.checkSession().subscribe();
    const previous = http.expectOne(`${API_BASE_URL}/auth/me`);
    service.login('new@example.com', 'password').subscribe();
    http.expectOne(`${API_BASE_URL}/auth/login`).flush({ accessToken: jwt({ sub: 'new-user', exp: futureExp() }) });
    previous.flush({}, { status: 503, statusText: 'Unavailable' });
    expect(service.user()?.id).toBe('new-user');
    expect(service.authenticated()).toBeTrue();
    expect(service.sessionNotice()).toBe('');
  });

  for (const outcome of ['success', 'failure']) {
    it(`ignores an older login ${outcome} after a newer login completes`, () => {
      let rejected = false;
      service.login('old@example.com', 'password').subscribe({ error: () => rejected = true });
      const previous = http.expectOne(`${API_BASE_URL}/auth/login`);
      service.login('new@example.com', 'password').subscribe();
      http.expectOne(`${API_BASE_URL}/auth/login`).flush({ accessToken: jwt({ sub: 'new-user', exp: futureExp() }) });
      if (outcome === 'success') previous.flush({ accessToken: jwt({ sub: 'old-user', exp: futureExp() }) });
      else previous.flush({}, { status: 401, statusText: 'Unauthorized' });
      expect(rejected).toBeTrue();
      expect(service.user()?.id).toBe('new-user');
      expect(service.authenticated()).toBeTrue();
    });
  }

  it('supports both teacher and student roles on a shared account', () => {
    service.login('both@example.com', 'Password@12345').subscribe();
    http.expectOne(`${API_BASE_URL}/auth/login`).flush({ accessToken: jwt({ sub: 'both', roles: ['TEACHER', 'STUDENT'], exp: futureExp() }) });
    expect(service.hasRole('teacher')).toBe(true);
    expect(service.hasRole('student')).toBe(true);
  });

  it('maps common backend auth failures to friendly messages', () => {
    expect(
      service.authErrorMessage(new HttpErrorResponse({ status: 401, error: { message: 'Invalid email or password' } }))
    ).toBe('The email or password is incorrect.');
    expect(service.authErrorMessage(new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }))).toBe(
      'We could not reach the server. Check your connection and try again.'
    );
    expect(service.authErrorMessage(new HttpErrorResponse({ status: 500, error: { message: 'boom' } }))).toBe(
      'The server had trouble signing you in. Please try again shortly.'
    );
  });
});

function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function readCookie(key: string): string | null {
  const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(`${encodeURIComponent(key)}=`));
  return cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : null;
}

function clearAuthCookies(): void {
  for (const key of ['native-sfu.auth.accessToken', 'native-sfu.auth.refreshToken']) {
    document.cookie = `${encodeURIComponent(key)}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

function jwt(payload: Record<string, unknown>): string {
  return ['header', encode(JSON.stringify(payload)), 'signature'].join('.');
}

function encode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
