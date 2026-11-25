import { canVisitAdmin } from './admin-access';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from './auth.service';

export const adminGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.checkSession().pipe(
    map((user) => {
      if (auth.hasAdminAccess(user)) {
        return true;
      }
      return router.createUrlTree(['/login'], {
        queryParams: { returnUrl: state.url },
      });
    }),
    catchError(() =>
      of(
        router.createUrlTree(['/login'], {
          queryParams: { returnUrl: state.url },
        }),
      ),
    ),
  );
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.checkSession().pipe(
    map((user) =>
      auth.hasAdminAccess(user)
        ? router.createUrlTree([auth.redirectPath()])
        : true,
    ),
    catchError(() => of(true)),
  );
};

export const adminFeatureGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService),
    router = inject(Router);
  return auth.checkSession().pipe(
    map((user) => {
      if (!auth.hasAdminAccess(user))
        return router.createUrlTree(['/login'], {
          queryParams: { returnUrl: state.url },
        });
      if (canVisitAdmin(auth, state.url)) return true;
      if (
        state.url.split('?')[0] === '/dashboard' &&
        auth.redirectPath() !== '/dashboard'
      )
        return router.createUrlTree([auth.redirectPath()]);
      return router.createUrlTree(['/forbidden']);
    }),
  );
};
