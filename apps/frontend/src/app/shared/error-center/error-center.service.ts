import {
  HttpBackend,
  HttpClient,
  HttpContextToken,
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  ErrorHandler,
  inject,
  Injectable,
  InjectionToken,
  Injector,
  provideBrowserGlobalErrorListeners,
  makeEnvironmentProviders,
  signal,
} from '@angular/core';
import { catchError, throwError, timeout } from 'rxjs';
import {
  ERROR_CATALOG,
  errorGuideUrl,
  errorCodeForStatus,
  errorFrames,
  errorPath,
  errorReference,
  errorReason,
  publicErrorCode,
  type PublicErrorCode,
  type AppErrorCode,
  type ErrorField,
  type ErrorSource,
} from '@native-sfu/contracts';

export interface ErrorModuleConfig {
  apiBaseUrl: string;
  documentationBaseUrl?: string;
  openDocumentation?: (url: string) => Promise<void>;
  source: () => Exclude<ErrorSource, 'server'>;
  accessToken: () => string | null;
}
export const ERROR_MODULE_CONFIG = new InjectionToken<ErrorModuleConfig>(
  'Sapiovian error module',
);
/** Quiet background work still enters recent errors, without interrupting the user. */
export const QUIET_ERROR = new HttpContextToken<boolean>(() => false);
/** A feature may explicitly handle a status as a normal fallback (for example optional CMS content). */
export const EXPECTED_ERROR_STATUSES = new HttpContextToken<readonly number[]>(
  () => [],
);
export interface UserError {
  reference: string;
  requestId?: string;
  code: PublicErrorCode;
  reason: AppErrorCode;
  title: string;
  message: string;
  nextStep: string;
  source: Exclude<ErrorSource, 'server'>;
  statusCode?: number;
  method?: string;
  operation?: string;
  path: string;
  occurredAt: string;
  fields: ErrorField[];
  frames: string[];
  count: number;
  reportState: 'idle' | 'sending' | 'sent' | 'failed';
}
function newReference(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

@Injectable({ providedIn: 'root' })
export class ErrorCenter {
  private readonly config = inject(ERROR_MODULE_CONFIG);
  private readonly http = new HttpClient(inject(HttpBackend)); // Reports never recurse through interceptors.
  private readonly destroy = inject(DestroyRef);
  private readonly seen = new WeakMap<object, string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly recent = signal<UserError[]>([]);
  readonly activeReference = signal<string | null>(null);
  readonly active = computed(
    () =>
      this.recent().find(
        (error) => error.reference === this.activeReference(),
      ) ?? null,
  );
  readonly online = signal(globalThis.navigator?.onLine !== false);
  readonly latest = computed(() => this.recent()[0] ?? null);

  constructor() {
    const online = () => this.online.set(true);
    const offline = () => this.online.set(false);
    globalThis.addEventListener?.('online', online);
    globalThis.addEventListener?.('offline', offline);
    this.destroy.onDestroy(() => {
      globalThis.removeEventListener?.('online', online);
      globalThis.removeEventListener?.('offline', offline);
      for (const timer of this.timers) clearTimeout(timer);
    });
  }

  capture(
    error: unknown,
    context: {
      path?: string;
      method?: string;
      quiet?: boolean;
      operation?: string;
      code?: AppErrorCode | PublicErrorCode;
      requestId?: string;
    } = {},
  ): UserError {
    if (error && typeof error === 'object') {
      const found = this.recent().find(
        (item) => item.reference === this.seen.get(error),
      );
      if (found) return found;
    }
    const http = error instanceof HttpErrorResponse ? error : undefined;
    const body =
      http?.error &&
      typeof http.error === 'object' &&
      !(http.error instanceof Blob)
        ? (http.error as Record<string, unknown>)
        : {};
    const status = http?.status;
    const reason =
      errorReason(context.code) ??
      errorReason(body['code']) ??
      errorReason(http?.headers.get('x-error-code')) ??
      errorReason(body['reason']) ??
      (http
        ? http.status >= 200 && http.status < 300
          ? 'INVALID_RESPONSE'
          : errorCodeForStatus(http.status)
        : 'CLIENT_ERROR');
    const code = publicErrorCode(reason);
    const info = ERROR_CATALOG[reason];
    const requestId =
      errorReference(context.requestId) ??
      errorReference(body['requestId']) ??
      errorReference(http?.headers.get('x-request-id'));
    const fields: ErrorField[] = Array.isArray(body['errors'])
      ? body['errors'].slice(0, 30).flatMap((entry: any) =>
          entry &&
          typeof entry.field === 'string' &&
          typeof entry.message === 'string'
            ? [
                {
                  field: entry.field.slice(0, 100),
                  message: entry.message.slice(0, 300),
                },
              ]
            : [],
        )
      : [];
    const message =
      status !== undefined &&
      status > 0 &&
      status < 500 &&
      typeof body['message'] === 'string' &&
      body['message'] !== 'Validation failed'
        ? body['message'].slice(0, 600)
        : info.message;
    const path = errorPath(
      context.path ?? http?.url ?? globalThis.location?.pathname,
    );
    let reference = requestId ?? newReference();
    const item: UserError = {
      reference,
      ...(requestId ? { requestId } : {}),
      code,
      reason,
      title: info.title,
      message,
      nextStep: info.nextStep,
      source: this.config.source(),
      ...(status !== undefined ? { statusCode: status } : {}),
      ...(context.method ? { method: context.method } : {}),
      ...(context.operation && /^[a-zA-Z0-9:_-]{1,80}$/.test(context.operation)
        ? { operation: context.operation }
        : {}),
      path,
      occurredAt: new Date().toISOString(),
      fields,
      frames: http
        ? []
        : errorFrames(error instanceof Error ? error.stack : undefined),
      count: 1,
      reportState: 'idle',
    };
    // Consecutive background failures are grouped and do not repeatedly steal attention.
    const previous = this.latest();
    const duplicate =
      previous &&
      previous.code === code &&
      previous.path === path &&
      previous.method === item.method &&
      previous.operation === item.operation &&
      (reason !== 'CLIENT_ERROR' ||
        previous.frames.join() === item.frames.join()) &&
      Date.now() - Date.parse(previous.occurredAt) < 60_000;
    if (duplicate) {
      if (!requestId) {
        reference = previous.reference;
        item.reference = reference;
        item.reportState = previous.reportState;
        item.occurredAt = previous.occurredAt;
      }
      this.recent.update((items) => [
        { ...item, count: previous.count + 1 },
        ...items.slice(1),
      ]);
      if (
        this.activeReference() === previous.reference ||
        (!context.quiet && reason !== 'CLIENT_ERROR')
      )
        this.activeReference.set(reference);
    } else {
      this.recent.update((items) => [item, ...items].slice(0, 10));
      if (!context.quiet) this.activeReference.set(reference);
    }
    if (error && typeof error === 'object') this.seen.set(error, reference);
    if (reason === 'CLIENT_ERROR' && !duplicate) {
      console.error('[Sapiovian error]', {
        reference,
        code,
        reason,
        path,
        frames: item.frames,
      });
      // Defer until Angular finishes the current error/render turn.
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.report(reference);
      }, 0);
      this.timers.add(timer);
    }
    return item;
  }

  documentationUrl(code: AppErrorCode | PublicErrorCode): string | null {
    return errorGuideUrl(this.config.documentationBaseUrl, code);
  }
  async openDocumentation(
    event: MouseEvent,
    code: AppErrorCode | PublicErrorCode,
  ): Promise<boolean> {
    const url = this.documentationUrl(code);
    if (!url || !this.config.openDocumentation) return true;
    event.preventDefault();
    try {
      await this.config.openDocumentation(url);
      return true;
    } catch {
      return false;
    }
  }

  dismiss(): void {
    this.activeReference.set(null);
  }
  openLatest(): void {
    if (this.latest()) this.activeReference.set(this.latest()!.reference);
  }
  clear(): void {
    this.recent.set([]);
    this.activeReference.set(null);
  }
  canReport(): boolean {
    return Boolean(this.config.accessToken());
  }
  diagnostic(item: UserError): string {
    // Intentionally excludes exception messages, field contents, query strings and account details.
    return JSON.stringify(
      {
        product: 'Sapiovian',
        reference: item.reference,
        requestId: item.requestId,
        code: item.code,
        reason: item.reason,
        source: item.source,
        statusCode: item.statusCode,
        method: item.method,
        operation: item.operation,
        path: item.path,
        occurredAt: item.occurredAt,
        frames: item.frames,
      },
      null,
      2,
    );
  }
  report(reference: string): void {
    const item = this.recent().find((error) => error.reference === reference);
    const token = this.config.accessToken();
    if (
      !item ||
      !token ||
      item.reportState === 'sending' ||
      item.reportState === 'sent'
    )
      return;
    this.setReportState(reference, 'sending');
    this.http
      .post(
        `${this.config.apiBaseUrl}/errors/reports`,
        {
          reference: item.reference,
          requestId: item.requestId,
          code: item.code,
          reason: item.reason,
          source: item.source,
          path: item.path,
          statusCode: item.statusCode,
          method: item.method,
          operation: item.operation,
          frames: item.frames,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .pipe(timeout(10_000))
      .subscribe({
        next: () => this.setReportState(reference, 'sent'),
        error: () => this.setReportState(reference, 'failed'),
      });
  }
  private setReportState(
    reference: string,
    reportState: UserError['reportState'],
  ): void {
    this.recent.update((items) =>
      items.map((item) =>
        item.reference === reference ? { ...item, reportState } : item,
      ),
    );
  }
}

export const errorInterceptor: HttpInterceptorFn = (request, next) => {
  const config = inject(ERROR_MODULE_CONFIG);
  const center = inject(ErrorCenter);
  const base = new URL(config.apiBaseUrl, globalThis.location?.origin);
  const url = new URL(request.url, globalThis.location?.origin);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname}/`)
  )
    return next(request);
  return next(request).pipe(
    catchError((error: unknown) => {
      // Session probing and refresh are owned by auth; only the final failed operation should surface.
      const authBackground = /\/auth\/(refresh|me|logout)$/.test(url.pathname);
      const expected =
        error instanceof HttpErrorResponse &&
        request.context.get(EXPECTED_ERROR_STATUSES).includes(error.status);
      if (!authBackground && !expected)
        center.capture(error, {
          path: url.pathname,
          method: request.method,
          quiet: request.context.get(QUIET_ERROR),
        });
      return throwError(() => error); // Preserve HttpErrorResponse and feature-specific recovery logic.
    }),
  );
};

@Injectable()
export class ApplicationErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);
  handleError(error: unknown): void {
    try {
      this.injector.get(ErrorCenter).capture(error);
    } catch {
      console.error('[Sapiovian] Error reporting is unavailable.');
    }
  }
}
export function provideErrorModule(config: () => ErrorModuleConfig) {
  return makeEnvironmentProviders([
    { provide: ERROR_MODULE_CONFIG, useFactory: config },
    { provide: ErrorHandler, useClass: ApplicationErrorHandler },
    provideBrowserGlobalErrorListeners(),
  ]);
}
