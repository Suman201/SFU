import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { normalizeDesktopDestination } from '../../core/services/desktop-bridge';

export const desktopAuthGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService); const router = inject(Router);
  return auth.checkSession().pipe(map((user) => user ? true : router.createUrlTree(['/desktop/login'], { queryParams: { returnUrl: normalizeDesktopDestination(state.url) ?? '/desktop/upcoming' } })));
};
export const desktopGuestGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService); const router = inject(Router);
  return auth.checkSession().pipe(map((user) => user ? router.parseUrl(normalizeDesktopDestination(route.queryParamMap.get('returnUrl')) ?? '/desktop/upcoming') : true));
};
export const DESKTOP_CHILD_ROUTES: Routes = [
  { path: 'login', canActivate: [desktopGuestGuard], loadComponent: () => import('./desktop-login').then((module) => module.DesktopLogin) },
  { path: '', canActivate: [desktopAuthGuard], loadComponent: () => import('./desktop-shell').then((module) => module.DesktopShell), children: [
    { path: 'batches', loadComponent:()=>import('../student/explore/explore').then(m=>m.StudentExplore) },
    { path: 'calendar', loadComponent:()=>import('../calendar/calendar').then(m=>m.ClassCalendar) },
    { path: 'upcoming', loadComponent: () => import('./desktop-upcoming').then((module) => module.DesktopUpcoming) },
    { path: 'recordings', loadComponent: () => import('./desktop-recordings').then((module) => module.DesktopRecordings) },
    { path: 'devices', loadComponent: () => import('./desktop-devices').then((module) => module.DesktopDevices) },
    { path: 'settings', loadComponent: () => import('./desktop-settings').then((module) => module.DesktopSettings) },
    { path: 'join', loadComponent: () => import('./desktop-join').then((module) => module.DesktopJoin) },
    { path: '', pathMatch: 'full', redirectTo: 'upcoming' },
    { path: '**', redirectTo: 'upcoming' }
  ] }
];
