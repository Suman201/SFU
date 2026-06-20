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
