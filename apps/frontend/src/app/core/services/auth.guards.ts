import { safeAuthReturnPath } from './auth-return-path';
import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, switchMap } from 'rxjs';
import { API_BASE_URL } from './app-environment';
import { AuthRole, AuthService } from './auth.service';
import { isDesktopSession } from './desktop-bridge';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.checkSession().pipe(
    map((user) => {
      if (user) {
        return true;
      }
      return router.createUrlTree([isDesktopSession() ? '/desktop/login' : state.url.startsWith('/class-session/teacher') ? '/teacher/login' : '/student/login'], { queryParams: { returnUrl: state.url } });
    })
  );
};

export const roleGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const http = inject(HttpClient);
  const expectedRole = route.data['role'] as AuthRole | undefined;
  return auth.checkSession().pipe(switchMap((user) => {
    if (!user) return of(router.createUrlTree([isDesktopSession() ? '/desktop/login' : `/${expectedRole ?? 'student'}/login`], { queryParams: { returnUrl: state.url } }));
    const sessionId = route.queryParamMap.get('sessionId');
    if (isDesktopSession() && state.url.startsWith('/class-session/') && sessionId) {
      // A teacher can attend another teacher's class. Membership, not the account's preferred role, decides.
      return http.get<{ role: string } | { data: { role: string } }>(`${API_BASE_URL}/desktop/classes/${encodeURIComponent(sessionId)}`).pipe(
        map((response) => {
          const item = 'data' in response ? response.data : response;
          return item.role === expectedRole ? true : router.createUrlTree(['/desktop/join'], { queryParams: { sessionId } });
        }),
        catchError(() => of(router.createUrlTree(['/desktop/join'], { queryParams: { sessionId } })))
      );
    }
    return of(!expectedRole || user.roles.includes(expectedRole) ? true : router.createUrlTree([auth.redirectPathFor(user.role)]));
  }));
};

export const guestGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.checkSession().pipe(
    map((user) => {
      if (!user) {
        return true;
      }
      const destination=safeAuthReturnPath(route.queryParamMap.get('returnUrl'),user.role);
      return destination?router.parseUrl(destination):router.createUrlTree([auth.redirectPathFor(user.role)]);
    })
  );
};
