import { Routes } from '@angular/router';
import { RoomComponent } from './features/room/room.component';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/landing/landing').then((route) => route.Landing) },
  { path: 'login', loadComponent: () => import('./features/auth/login/login').then((route) => route.Login) },
  { path: 'register', loadComponent: () => import('./features/auth/register/register').then((route) => route.Register) },
  {
    path: 'teacher-dashboard',
    loadComponent: () => import('./features/teacher-dashboard/teacher-dashboard').then((route) => route.TeacherDashboard)
  },
  {
    path: 'teacher-dashboard/batches/:batchId',
    loadComponent: () => import('./features/teacher-dashboard/batch-details/batch-details').then((route) => route.BatchDetails)
  },
  {
    path: 'teacher/profile',
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
    loadComponent: () => import('./features/student/explore/explore').then((route) => route.StudentExplore)
  },
  {
    path: 'student/dashboard',
    loadComponent: () => import('./features/student/dashboard/dashboard').then((route) => route.StudentDashboard)
  },
  {
    path: 'student/profile',
    loadComponent: () => import('./features/profile/student-profile/student-profile').then((route) => route.StudentProfile)
  },
  {
    path: 'sfu-forms',
    loadChildren: () => import('./features/sfu-forms/sfu-forms.routes').then((routes) => routes.SFU_FORMS_ROUTES)
  },
  {
    path: 'class-session',
    loadChildren: () => import('./features/class-session/class-session.routes').then((routes) => routes.CLASS_SESSION_ROUTES)
  },
  { path: 'rooms/:roomId', component: RoomComponent },
  { path: '**', redirectTo: '' }
];
