import { Routes } from '@angular/router';
import { authGuard, guestGuard, roleGuard } from './core/services/auth.guards';
import { RoomComponent } from './features/room/room.component';

export const routes: Routes = [
  { path: 'whiteboard', loadComponent: () => import('./shared/whiteboard/whiteboard').then((module) => module.Whiteboard) },
  { path: 'calendar', canActivate:[authGuard], loadComponent:()=>import('./features/calendar/calendar').then(m=>m.ClassCalendar)},
  { path: 'desktop', loadChildren: () => import('./features/desktop/desktop.routes').then((module) => module.DESKTOP_CHILD_ROUTES) },
  { path: '', loadComponent: () => import('./features/landing/landing').then((route) => route.Landing) },
  {
    path: 'about',
    data: { slug: 'about' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
  {
    path: 'contact-us',
    data: { slug: 'contact-us' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
  {
    path: 'faq',
    data: { slug: 'faq' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
  {
    path: 'help',
    data: { slug: 'help' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
  {
    path: 'terms',
    data: { slug: 'terms' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
  {
    path: 'privacy-policy',
    data: { slug: 'privacy-policy' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
  {
    path: 'refund-policy',
    data: { slug: 'refund-policy' },
    loadComponent: () => import('./features/cms/public-cms-page').then((route) => route.PublicCmsPage)
  },
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
  { path: 'teacher-dashboard/batches/:batchId/live-settings', redirectTo: 'teacher/batches/:batchId/live-settings', pathMatch: 'full' },
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
    path: 'teacher/analytics',
    canActivate: [roleGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/teacher-dashboard/analytics/teacher-analytics').then((route) => route.TeacherAnalytics)
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
    loadComponent: () => import('./features/teacher-dashboard/live-settings/teacher-live-settings').then((route) => route.TeacherLiveSettings)
  },
  {
    path: 'teacher/batches/:batchId/live-settings',
    canActivate: [roleGuard],
    data: { role: 'teacher' },
    loadComponent: () => import('./features/teacher-dashboard/live-settings/teacher-live-settings').then((route) => route.TeacherLiveSettings)
  },
  {
    path: 'teachers',
    loadComponent: () => import('./features/profile/teacher-marketplace/teacher-marketplace').then((route) => route.TeacherMarketplace)
  },
  {
    path: 'booking',
    loadComponent: () => import('./features/booking/booking-preview').then((route) => route.BookingPreview)
  },
  {
    path: 'teachers/:teacherId/book',
    loadComponent: () => import('./features/booking/booking-preview').then((route) => route.BookingPreview)
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
    path: 'student/support',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/student/support/student-support').then((route) => route.StudentSupport)
  },
  {
    path: 'student/progress',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/student/progress/student-progress').then((route) => route.StudentProgress)
  },
  {
    path: 'student/classes/completed',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () =>
      import('./features/student/completed-classes/completed-classes-list').then((route) => route.StudentCompletedClassesList)
  },
  {
    path: 'student/classes/completed/:sessionId',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () =>
      import('./features/student/completed-classes/completed-class-detail').then((route) => route.StudentCompletedClassDetail)
  },
  {
    path: 'class-library',
    canActivate: [authGuard],
    loadComponent: () => import('./features/class-library/class-library').then((route) => route.ClassLibrary)
  },
  {
    path: 'student/assignments/:assignmentId',
    canActivate: [roleGuard],
    data: { role: 'student' },
    loadComponent: () => import('./features/student/assignments/student-assignment-detail').then((route) => route.StudentAssignmentDetail)
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
