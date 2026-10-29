import { errorGuideUrl } from '@native-sfu/contracts';
import {
  HttpClient,
  HttpContext,
  HttpErrorResponse,
  HttpHeaders,
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
  ERROR_MODULE_CONFIG,
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
          documentationBaseUrl: 'https://admin.sapiovian.example',
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
  it('links a code to its public admin-domain explanation without including the occurrence reference', () => {
    const item = center.capture(
      new HttpErrorResponse({
        status: 500,
        error: { requestId: 'private-reference-123' },
      }),
    );
    expect(center.documentationUrl(item.code)).toBe(
      'https://admin.sapiovian.example/error-encyclopedia/SAP4001',
    );
    expect(center.documentationUrl(item.code)).not.toContain(item.reference);
  });
  it('rejects unsafe or non-origin documentation addresses', () => {
    for (const base of [
      'javascript:alert(1)',
      'http://admin.example.com',
      'https://user:password@admin.example.com',
      'https://admin.example.com/private?token=secret',
    ])
      expect(errorGuideUrl(base, 'NETWORK_ERROR')).toBeNull();
    expect(errorGuideUrl('http://localhost:4300', 'NETWORK_ERROR')).toBe(
      'http://localhost:4300/error-encyclopedia/SAP3001',
    );
    expect(
      errorGuideUrl('https://admin.example.com', '../private' as never),
    ).toBeNull();
  });
  it('uses the desktop external-browser action without navigating the classroom', async () => {
    const open = jasmine.createSpy('openDocumentation').and.resolveTo();
    TestBed.inject(ERROR_MODULE_CONFIG).openDocumentation = open;
    const event = new MouseEvent('click', { cancelable: true });
    expect(await center.openDocumentation(event, 'NETWORK_ERROR')).toBeTrue();
    expect(event.defaultPrevented).toBeTrue();
    expect(open).toHaveBeenCalledOnceWith(
      'https://admin.sapiovian.example/error-encyclopedia/SAP3001',
    );
  });
  it('handles a failed desktop documentation launch without creating another incident', async () => {
    TestBed.inject(ERROR_MODULE_CONFIG).openDocumentation = () =>
      Promise.reject(new Error('Could not open browser'));
    expect(
      await center.openDocumentation(
        new MouseEvent('click', { cancelable: true }),
        'NETWORK_ERROR',
      ),
    ).toBeFalse();
    expect(center.recent()).toEqual([]);
  });
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
    expect(center.active()?.code).toBe('SAP4001');
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
    expect(item.code).toBe('SAP4002');
    expect(item.nextStep).toContain('whether your change saved');
  });
  it('preserves the backend classification independently of the HTTP status fallback', () => {
    const item = center.capture(
      new HttpErrorResponse({
        status: 400,
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
          requestId: 'upload-reference-123',
        },
      }),
    );
    expect(item.code).toBe('SAP1004');
    expect(item.requestId).toBe('upload-reference-123');
    expect(
      center.capture(
        new HttpErrorResponse({
          status: 400,
          error: { code: 'UNREGISTERED_PRIVATE_CODE' },
        }),
      ).code,
    ).toBe('SAP1001');
  });
  it('keeps a valid signaling occurrence reference and rejects malformed references', () => {
    const item = center.capture(new Error('private socket payload'), {
      code: 'ACCESS_DENIED',
      requestId: 'socket-reference-123',
      quiet: true,
      operation: 'session:watch',
    });
    expect(item.requestId).toBe('socket-reference-123');
    expect(item.reference).toBe(item.requestId!);
    expect(center.diagnostic(item)).not.toContain('private socket payload');
    expect(
      center.capture(
        {},
        { code: 'CLASSROOM_ERROR', requestId: 'unsafe value\n' },
      ).requestId,
    ).toBeUndefined();
  });
  it('uses the exact numbered API code and derives its semantic reason from the registry', () => {
    const item = center.capture(
      new HttpErrorResponse({
        status: 400,
        error: {
          code: 'SAP1004',
          reason: 'UNSUPPORTED_FILE_TYPE',
          requestId: 'numbered-api-reference',
        },
      }),
    );
    expect(item.code).toBe('SAP1004');
    expect(item.reason).toBe('UNSUPPORTED_FILE_TYPE');
    expect(JSON.parse(center.diagnostic(item))).toEqual(
      jasmine.objectContaining({
        code: 'SAP1004',
        reason: 'UNSUPPORTED_FILE_TYPE',
      }),
    );
    // A conflicting label cannot redefine a published numbered code.
    expect(
      center.capture(
        new HttpErrorResponse({
          status: 500,
          error: { code: 'SAP3001', reason: 'INTERNAL_ERROR' },
        }),
      ).reason,
    ).toBe('NETWORK_ERROR');
  });
  it('reads the API code header when a download error body is a Blob', () => {
    const item = center.capture(
      new HttpErrorResponse({
        status: 400,
        error: new Blob(['private response']),
        headers: new HttpHeaders({
          'x-error-code': 'SAP1004',
          'x-request-id': 'download-reference-123',
        }),
      }),
    );
    expect(item.code).toBe('SAP1004');
    expect(item.reason).toBe('UNSUPPORTED_FILE_TYPE');
    expect(item.requestId).toBe('download-reference-123');
    expect(item.message).not.toContain('private response');
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
    expect(center.latest()?.code).toBe('SAP3001');
    center.openLatest();
    expect(center.active()?.code).toBe('SAP3001');
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
    expect(center.active()?.code).toBe('SAP2003');
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
    expect(center.active()?.code).toBe('SAP3003');
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
    expect(report.request.body.code).toBe('SAP5001');
    expect(report.request.body.reason).toBe('DEVICE_PERMISSION_DENIED');
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
