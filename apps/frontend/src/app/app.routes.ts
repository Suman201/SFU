import { Routes } from '@angular/router';
import { authGuard, guestGuard, roleGuard } from './core/services/auth.guards';
import { RoomComponent } from './features/room/room.component';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/landing/landing').then((route) => route.Landing) },
  { path: 'login', redirectTo: 'student/login', pathMatch: 'full' },
  {
    path: 'teacher/login',
    canActivate: [guestGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/auth/login/login').then((route) => route.Login)
  },
  {
    path: 'student/login',
    canActivate: [guestGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/auth/login/login').then((route) => route.Login)
  },
  { path: 'register', loadComponent: () => import('./features/auth/register/register').then((route) => route.Register) },
  { path: 'teacher-dashboard', redirectTo: 'teacher/dashboard', pathMatch: 'full' },
  { path: 'teacher-dashboard/batches/:batchId', redirectTo: 'teacher/dashboard/batches/:batchId', pathMatch: 'full' },
  {
    path: 'teacher/dashboard',
    canActivate: [roleGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/teacher-dashboard/teacher-dashboard').then((route) => route.TeacherDashboard)
  },
  {
    path: 'teacher/dashboard/batches/:batchId',
    canActivate: [roleGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/teacher-dashboard/batch-details/batch-details').then((route) => route.BatchDetails)
  },
  {
    path: 'teacher/profile',
    canActivate: [roleGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/profile/teacher-profile/teacher-profile').then((route) => route.TeacherProfile)
  },
  {
    path: 'teacher/live-settings',
    canActivate: [roleGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/profile/teacher-profile/teacher-profile').then((route) => route.TeacherProfile)
  },
  {
    path: 'teachers/:teacherId',
    loadComponent: () =>
      import('./features/profile/public-teacher-profile/public-teacher-profile').then((route) => route.PublicTeacherProfile)
  },
  {
    path: 'profile',
    redirectTo: 'student/profile',
    pathMatch: 'full'
  },
  {
    path: 'student/explore',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/student/explore/explore').then((route) => route.StudentExplore)
  },
  {
    path: 'student/dashboard',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/student/dashboard/dashboard').then((route) => route.StudentDashboard)
  },
  {
    path: 'student/profile',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/profile/student-profile/student-profile').then((route) => route.StudentProfile)
  },
  {
    path: 'sfu-forms',
    canActivate: [authGuard],
    loadChildren: () => import('./features/sfu-forms/sfu-forms.routes').then((routes) => routes.SFU_FORMS_ROUTES)
  },
  {
    path: 'class-session',
    canActivate: [authGuard],
    loadChildren: () => import('./features/class-session/class-session.routes').then((routes) => routes.CLASS_SESSION_ROUTES)
  },
  { path: 'rooms/:roomId', canActivate: [authGuard], component: RoomComponent },
  { path: '**', redirectTo: '' }
];
