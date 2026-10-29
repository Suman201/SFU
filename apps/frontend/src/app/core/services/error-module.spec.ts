import {
  HttpClient,
  HttpContext,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ErrorCenter,
  errorInterceptor,
  provideErrorModule,
  QUIET_ERROR,
  EXPECTED_ERROR_STATUSES,
} from '@sapiovian/error-ui';

describe('Shared error module', () => {
  let center: ErrorCenter, http: HttpClient, backend: HttpTestingController;
  let token: string | null;
  beforeEach(() => {
    token = null;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideErrorModule(() => ({
          apiBaseUrl: '/api/v1',
          source: () => 'web',
          accessToken: () => token,
        })),
      ],
    });
    center = TestBed.inject(ErrorCenter);
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    spyOn(console, 'error');
  });
  afterEach(() => backend.verify());
  it('retains the real HTTP error for existing features and makes safe diagnostics available', () => {
    let caught: unknown;
    http
      .post('/api/v1/calendar?token=private', { password: 'secret' })
      .subscribe({ error: (error) => (caught = error) });
    backend.expectOne('/api/v1/calendar?token=private').flush(
      {
        message: 'database connection secret',
        requestId: 'server-reference-123',
      },
      { status: 500, statusText: 'Error' },
    );
    expect(caught instanceof HttpErrorResponse).toBeTrue();
    expect(center.active()?.reference).toBe('server-reference-123');
    expect(center.active()?.code).toBe('INTERNAL_ERROR');
    expect(center.diagnostic(center.active()!)).not.toMatch(
      /private|secret|password|database/,
    );
  });
  it('distinguishes an unreadable successful response from a form mistake', () => {
    const item = center.capture(
      new HttpErrorResponse({
        status: 200,
        error: new SyntaxError('private body'),
      }),
    );
    expect(item.code).toBe('INVALID_RESPONSE');
    expect(item.nextStep).toContain('whether your change saved');
  });
  it('records quiet background errors without opening an interrupting notice', () => {
    http
      .get('/api/v1/calendar/notices', {
        context: new HttpContext().set(QUIET_ERROR, true),
      })
      .subscribe({ error: () => undefined });
    backend
      .expectOne('/api/v1/calendar/notices')
      .error(new ProgressEvent('network'));
    expect(center.active()).toBeNull();
    expect(center.latest()?.code).toBe('NETWORK_ERROR');
    center.openLatest();
    expect(center.active()?.code).toBe('NETWORK_ERROR');
  });
  it('does not surface an intermediate auth refresh failure or intercept unrelated origins', () => {
    for (const url of [
      '/api/v1/auth/refresh',
      'https://external.example/file',
    ]) {
      http.get(url).subscribe({ error: () => undefined });
      backend
        .expectOne(url)
        .flush({}, { status: 401, statusText: 'Unauthorized' });
    }
    expect(center.recent()).toEqual([]);
  });
  it('preserves an explicitly handled missing-content fallback without showing an error', () => {
    let caught: unknown;
    http
      .get('/api/v1/cms/pages/home', {
        context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [404]),
      })
      .subscribe({ error: (error) => (caught = error) });
    backend
      .expectOne('/api/v1/cms/pages/home')
      .flush({}, { status: 404, statusText: 'Not found' });
    expect(caught instanceof HttpErrorResponse).toBeTrue();
    expect(center.recent()).toEqual([]);
  });
  it('handles blob download errors using safe fallback text and the header reference', () => {
    http
      .get('/api/v1/invoices/pdf', { responseType: 'blob' })
      .subscribe({ error: () => undefined });
    backend
      .expectOne('/api/v1/invoices/pdf')
      .flush(new Blob(['private error']), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-request-id': 'binary-reference-123' },
      });
    expect(center.active()?.code).toBe('ACCESS_DENIED');
    expect(center.active()?.reference).toBe('binary-reference-123');
    expect(center.active()?.message).not.toContain('private');
  });
  it('groups repeated failures and never retries a failed mutation', () => {
    for (let index = 0; index < 3; index++) {
      center.dismiss();
      http.post('/api/v1/calendar', {}).subscribe({ error: () => undefined });
      backend
        .expectOne('/api/v1/calendar')
        .flush({}, { status: 503, statusText: 'Unavailable' });
    }
    expect(center.recent().length).toBe(1);
    expect(center.latest()?.count).toBe(3);
    expect(center.active()?.code).toBe('SERVICE_UNAVAILABLE');
    backend.expectNone('/api/v1/calendar');
  });
  it('sends only permitted metadata and keeps report failures out of the error handler', () => {
    token = 'test-token';
    const item = center.capture(
      new DOMException('private permission message', 'NotAllowedError'),
      { code: 'DEVICE_PERMISSION_DENIED', path: '/devices?token=private' },
    );
    center.report(item.reference);
    const report = backend.expectOne('/api/v1/errors/reports');
    expect(report.request.headers.get('Authorization')).toBe(
      'Bearer test-token',
    );
    expect(JSON.stringify(report.request.body)).not.toMatch(
      /private|permission message|password/,
    );
    report.flush({}, { status: 500, statusText: 'Error' });
    expect(center.latest()?.reportState).toBe('failed');
    expect(center.recent().length).toBe(1);
  });
  it('keeps a dismissible error available until explicitly cleared', () => {
    const item = center.capture({}, { code: 'NETWORK_ERROR' });
    center.dismiss();
    expect(center.active()).toBeNull();
    center.openLatest();
    expect(center.active()?.reference).toBe(item.reference);
    center.clear();
    expect(center.recent()).toEqual([]);
  });
});
