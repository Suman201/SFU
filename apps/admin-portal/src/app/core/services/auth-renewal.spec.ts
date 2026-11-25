import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { authInterceptor } from './auth.interceptor';
import { API_BASE_URL } from './app-environment';
const access = 'native-sfu.admin.auth.accessToken',
  refresh = 'native-sfu.admin.auth.refreshToken';
const token = (exp = Math.floor(Date.now() / 1000) + 900) =>
  'x.' +
  btoa(
    JSON.stringify({
      sub: 'staff',
      email: 'staff@example.test',
      roles: ['ADMIN'],
      permissions: ['admin:dashboard:read'],
      exp,
    }),
  ) +
  '.x';
const result = (accessToken = token()) => ({
  accessToken,
  refreshToken: 'rotated-refresh',
  user: {
    id: 'staff',
    name: 'Staff',
    email: 'staff@example.test',
    roles: ['ADMIN'],
    permissions: ['admin:dashboard:read'],
  },
});
describe('admin session renewal', () => {
  let auth: AuthService, http: HttpClient, mock: HttpTestingController;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpClient);
    mock = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    mock.verify();
    localStorage.clear();
    sessionStorage.clear();
  });
  it('shares one rotating refresh across simultaneous expired-token requests', () => {
    sessionStorage.setItem(access, token(1));
    sessionStorage.setItem(refresh, 'original-refresh');
    let completed = 0;
    http
      .get(API_BASE_URL + '/admin/dashboard/summary')
      .subscribe(() => completed++);
    http.get(API_BASE_URL + '/admin/users').subscribe(() => completed++);
    const renewal = mock.expectOne(API_BASE_URL + '/auth/refresh');
    expect(renewal.request.body).toEqual({ refreshToken: 'original-refresh' });
    expect(renewal.request.headers.has('Authorization')).toBeFalse();
    const next = token();
    renewal.flush(result(next));
    const requests = mock.match((request) =>
      request.url.startsWith(API_BASE_URL + '/admin/'),
    );
    expect(requests.length).toBe(2);
    for (const request of requests) {
      expect(request.request.headers.get('Authorization')).toBe(
        'Bearer ' + next,
      );
      request.flush({});
    }
    expect(completed).toBe(2);
    expect(sessionStorage.getItem(refresh)).toBe('rotated-refresh');
  });
  it('retries an unauthorized request once with a renewed token', () => {
    const old = token();
    sessionStorage.setItem(access, old);
    sessionStorage.setItem(refresh, 'original-refresh');
    let completed = false;
    http.get(API_BASE_URL + '/admin/users').subscribe(() => (completed = true));
    mock
      .expectOne(API_BASE_URL + '/admin/users')
      .flush({}, { status: 401, statusText: 'Unauthorized' });
    const next = token(Math.floor(Date.now() / 1000) + 1800);
    mock.expectOne(API_BASE_URL + '/auth/refresh').flush(result(next));
    const retry = mock.expectOne(API_BASE_URL + '/admin/users');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer ' + next);
    retry.flush({});
    expect(completed).toBeTrue();
  });
  it('keeps refresh credentials after a temporary provider/network failure', () => {
    sessionStorage.setItem(access, token(1));
    sessionStorage.setItem(refresh, 'original-refresh');
    let failed = false;
    auth.ensureAccessToken().subscribe({ error: () => (failed = true) });
    mock
      .expectOne(API_BASE_URL + '/auth/refresh')
      .flush({}, { status: 503, statusText: 'Unavailable' });
    expect(failed).toBeTrue();
    expect(sessionStorage.getItem(refresh)).toBe('original-refresh');
  });
  it('clears rejected refresh credentials', () => {
    sessionStorage.setItem(access, token(1));
    sessionStorage.setItem(refresh, 'invalid-refresh');
    auth.ensureAccessToken().subscribe({ error: () => undefined });
    mock
      .expectOne(API_BASE_URL + '/auth/refresh')
      .flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(sessionStorage.getItem(refresh)).toBeNull();
    expect(auth.authenticated()).toBeFalse();
  });
  it('does not revive a session when logout wins a refresh race', () => {
    sessionStorage.setItem(access, token(1));
    sessionStorage.setItem(refresh, 'original-refresh');
    auth.ensureAccessToken().subscribe({ error: () => undefined });
    const renewal = mock.expectOne(API_BASE_URL + '/auth/refresh');
    auth.logout();
    renewal.flush(result());
    expect(auth.accessToken()).toBeNull();
    expect(auth.authenticated()).toBeFalse();
  });
  it('preserves remembered storage during rotation', () => {
    localStorage.setItem(access, token(1));
    localStorage.setItem(refresh, 'original-refresh');
    auth.ensureAccessToken().subscribe();
    mock.expectOne(API_BASE_URL + '/auth/refresh').flush(result());
    expect(localStorage.getItem(refresh)).toBe('rotated-refresh');
    expect(sessionStorage.getItem(refresh)).toBeNull();
  });
  it('does not attach admin credentials or trigger refresh on foreign URLs', () => {
    sessionStorage.setItem(access, token(1));
    sessionStorage.setItem(refresh, 'original-refresh');
    http.get('https://outside.example.test/material').subscribe();
    const request = mock.expectOne('https://outside.example.test/material');
    expect(request.request.headers.has('Authorization')).toBeFalse();
    request.flush({});
    mock.expectNone(API_BASE_URL + '/auth/refresh');
  });
  it('renews an expired session before restoring its server-owned profile', () => {
    sessionStorage.setItem(access, token(1));
    sessionStorage.setItem(refresh, 'original-refresh');
    let restored = '';
    auth.checkSession().subscribe((user) => (restored = user?.id ?? ''));
    mock.expectOne(API_BASE_URL + '/auth/refresh').flush(result());
    mock.expectOne(API_BASE_URL + '/auth/me').flush(result().user);
    expect(restored).toBe('staff');
  });
});
