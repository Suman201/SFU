import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from './app-environment';
import { authInterceptor } from './auth.interceptor';

describe('Shared authenticated API requests', () => {
  let client: HttpClient;
  let http: HttpTestingController;
  const accessKey = 'native-sfu.auth.accessToken';
  const refreshKey = 'native-sfu.auth.refreshToken';
  const token = (id: string) => `header.${btoa(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, roles: ['STUDENT'] }))}.signature`;
  beforeEach(() => {
    sessionStorage.clear();
    for (const key of [accessKey, refreshKey]) document.cookie = `${key}=; Max-Age=0; Path=/`;
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()] });
    client = TestBed.inject(HttpClient); http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); sessionStorage.clear(); });

  it('does not expose classroom credentials to a teacher-authored external URL', () => {
    sessionStorage.setItem(accessKey, token('student'));
    client.get('https://materials.example/lesson.pdf').subscribe();
    const request = http.expectOne('https://materials.example/lesson.pdf');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({});
  });

  it('rotates once for concurrent unauthorized responses and retries both with the new token', () => {
    const original = token('old'); const refreshed = token('new');
    sessionStorage.setItem(accessKey, original); sessionStorage.setItem(refreshKey, 'refresh');
    const completed: string[] = [];
    client.get(`${API_BASE_URL}/desktop/classes`).subscribe(() => completed.push('classes'));
    client.get(`${API_BASE_URL}/desktop/recordings`).subscribe(() => completed.push('recordings'));
    http.expectOne(`${API_BASE_URL}/desktop/classes`).flush({}, { status: 401, statusText: 'Unauthorized' });
    http.expectOne(`${API_BASE_URL}/desktop/recordings`).flush({}, { status: 401, statusText: 'Unauthorized' });
    const refresh = http.expectOne(`${API_BASE_URL}/auth/refresh`);
    expect(refresh.request.headers.has('Authorization')).toBe(false);
    refresh.flush({ accessToken: refreshed, refreshToken: 'rotated', user: { id: 'student', roles: ['STUDENT'] } });
    for (const path of ['classes', 'recordings']) {
      const retried = http.expectOne(`${API_BASE_URL}/desktop/${path}`);
      expect(retried.request.headers.get('Authorization')).toBe(`Bearer ${refreshed}`);
      retried.flush({ items: [] });
    }
    expect(completed).toEqual(['classes', 'recordings']);
  });

  it('returns an authentication failure after one unsuccessful retry', () => {
    sessionStorage.setItem(accessKey, token('old')); sessionStorage.setItem(refreshKey, 'refresh');
    let status = 0;
    client.get(`${API_BASE_URL}/desktop/classes`).subscribe({ error: (error) => status = error.status });
    http.expectOne(`${API_BASE_URL}/desktop/classes`).flush({}, { status: 401, statusText: 'Unauthorized' });
    http.expectOne(`${API_BASE_URL}/auth/refresh`).flush({ accessToken: token('new'), refreshToken: 'rotated' });
    http.expectOne(`${API_BASE_URL}/desktop/classes`).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(status).toBe(401);
    http.expectNone(`${API_BASE_URL}/auth/refresh`);
  });
});
