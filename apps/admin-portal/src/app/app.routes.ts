import { Routes } from '@angular/router';
import { adminGuard, guestGuard } from './core/services/auth.guards';

export const routes: Routes = [
  { path: 'error-encyclopedia', loadComponent: () => import('./features/error-encyclopedia/error-encyclopedia').then(m => m.ErrorEncyclopedia) },
  { path: 'error-encyclopedia/:code', loadComponent: () => import('./features/error-encyclopedia/error-encyclopedia').then(m => m.ErrorEncyclopedia) },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login/login').then((route) => route.AdminLogin)
  },
  {
    path: 'forbidden',
    loadComponent: () => import('./features/forbidden/forbidden').then((route) => route.AdminForbidden)
  },
  {
    path: '',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/shell/admin-shell').then((route) => route.AdminShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'errors', loadComponent: () => import('./features/errors/errors').then(m => m.ErrorsAdmin) },
      { path: 'invoices', loadComponent: () => import('./features/invoices/invoices').then(m => m.InvoicesAdmin) },
      { path: 'invoices/:id', loadComponent: () => import('./features/invoices/invoices').then(m => m.InvoicesAdmin) },
      { path: 'teaching-catalog', loadComponent: () => import('./features/teaching-catalog/teaching-catalog').then(m => m.TeachingCatalogAdmin) },
      { path: 'tutor-applications', loadComponent: () => import('./features/teaching-catalog/tutor-applications').then(m => m.TutorApplicationsAdmin) },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard').then((route) => route.AdminDashboard)
      },
      {
        path: 'audit-logs',
        loadComponent: () => import('./features/audit-logs/list/audit-logs-list').then((route) => route.AuditLogsList)
      },
      {
        path: 'audit-logs/:auditLogId',
        loadComponent: () => import('./features/audit-logs/detail/audit-log-detail').then((route) => route.AuditLogDetail)
      },
      {
        path: 'class-sessions',
        loadComponent: () => import('./features/class-sessions/list/class-sessions-list').then((route) => route.ClassSessionsList)
      },
      {
        path: 'class-sessions/:sessionId',
        loadComponent: () => import('./features/class-sessions/detail/class-session-detail').then((route) => route.ClassSessionDetail)
      },
      {
        path: 'class-library',
        loadComponent: () => import('./features/class-library/class-library').then((route) => route.AdminClassLibrary)
      },
      {
        path: 'cms/pages',
        loadComponent: () => import('./features/cms/pages/cms-pages').then((route) => route.CmsPages)
      },
      {
        path: 'cms/contact',
        loadComponent: () => import('./features/contact-inbox/contact-inbox').then((route) => route.ContactInbox)
      },
      {
        path: 'support',
        loadComponent: () => import('./features/support/support-requests').then((route) => route.SupportRequests)
      },
      {
        path: 'teacher-promotions',
        loadComponent: () => import('./features/teacher-promotions/teacher-promotions').then((route) => route.TeacherPromotions)
      },
      {
        path: 'attendance',
        loadComponent: () => import('./features/attendance/list/attendance-list').then((route) => route.AttendanceList)
      },
      {
        path: 'recordings',
        loadComponent: () => import('./features/recordings/list/recordings-list').then((route) => route.RecordingsList)
      },
      {
        path: 'recordings/:recordingId',
        loadComponent: () => import('./features/recordings/detail/recording-detail').then((route) => route.RecordingDetail)
      },
      {
        path: 'enrollments',
        loadComponent: () => import('./features/enrollments/list/enrollments-list').then((route) => route.EnrollmentsList)
      },
      {
        path: 'enrollments/:enrollmentId',
        loadComponent: () => import('./features/enrollments/detail/enrollment-detail').then((route) => route.EnrollmentDetail)
      },
      {
        path: 'users',
        loadComponent: () => import('./features/users/list/users-list').then((route) => route.UsersList)
      },
      {
        path: 'users/:userId',
        loadComponent: () => import('./features/users/detail/user-detail').then((route) => route.UserDetail)
      },
      {
        path: 'courses',
        loadComponent: () => import('./features/courses/list/courses-list').then((route) => route.CoursesList)
      },
      {
        path: 'courses/:courseId',
        loadComponent: () => import('./features/courses/detail/course-detail').then((route) => route.CourseDetail)
      },
      {
        path: 'batches',
        loadComponent: () => import('./features/batches/list/batches-list').then((route) => route.BatchesList)
      },
      {
        path: 'batches/:batchId',
        loadComponent: () => import('./features/batches/detail/batch-detail').then((route) => route.BatchDetail)
      }
    ]
  },
  { path: '**', redirectTo: '' }
];
