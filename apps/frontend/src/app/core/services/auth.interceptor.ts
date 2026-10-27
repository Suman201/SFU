import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { API_BASE_URL } from './app-environment';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const base = new URL(API_BASE_URL, globalThis.location?.origin);
  const url = new URL(request.url, globalThis.location?.origin);
  // Never attach classroom credentials to material links or an unrelated origin.
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) return next(request);
  const publicAuth = /\/auth\/(login|register|refresh|forgot-password|reset-password)$/.test(url.pathname);
  if (publicAuth) return next(request);
  if (url.pathname.endsWith('/auth/logout')) {
    const token = auth.accessToken();
    return next(token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request);
  }
  return auth.ensureAccessToken().pipe(switchMap((token) => {
    const authenticated = token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request;
    return next(authenticated).pipe(catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401 || !token) return throwError(() => error);
      const current = auth.accessToken();
      // Another request may already have rotated the token while this one was in flight.
      if (current && current !== token) return next(request.clone({ setHeaders: { Authorization: `Bearer ${current}` } }));
      return auth.ensureAccessToken(true).pipe(switchMap((refreshed) => refreshed
        ? next(request.clone({ setHeaders: { Authorization: `Bearer ${refreshed}` } }))
        : throwError(() => error)));
    }));
  }));
};
