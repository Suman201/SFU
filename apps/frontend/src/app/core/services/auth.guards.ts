import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthRole, AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.checkSession().pipe(
    map((user) => {
      if (user) {
        return true;
      }
      return router.createUrlTree(['/student/login'], { queryParams: { returnUrl: state.url } });
    })
  );
};

export const roleGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const expectedRole = route.data['role'] as AuthRole | undefined;

  return auth.checkSession().pipe(
    map((user) => {
      if (!user) {
        return router.createUrlTree([`/${expectedRole ?? 'student'}/login`], { queryParams: { returnUrl: state.url } });
      }
      if (!expectedRole || user.role === expectedRole) {
        return true;
      }
      return router.createUrlTree([auth.redirectPathFor(user.role)]);
    })
  );
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.checkSession().pipe(
    map((user) => {
      if (!user) {
        return true;
      }
      return router.createUrlTree([auth.redirectPathFor(user.role)]);
    })
  );
};
