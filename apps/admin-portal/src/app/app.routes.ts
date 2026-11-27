import { Routes } from '@angular/router';
import { adminGuard, adminFeatureGuard, guestGuard } from './core/services/auth.guards';

export const routes: Routes = [
  { path: 'forgot-password', data: { mode: 'request' }, loadComponent: () => import('./features/auth/recovery/password-recovery').then(module => module.AdminPasswordRecovery) },
  { path: 'reset-password', data: { mode: 'reset' }, loadComponent: () => import('./features/auth/recovery/password-recovery').then(module => module.AdminPasswordRecovery) },
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
    canActivateChild: [adminFeatureGuard],
    loadComponent: () => import('./features/shell/admin-shell').then((route) => route.AdminShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'promotion-commerce', loadComponent: () => import('./features/promotions/promotion-commerce').then(m => m.AdminPromotionCommerce) },
      { path: 'errors', loadComponent: () => import('./features/errors/errors').then(m => m.ErrorsAdmin) },
      { path: 'whiteboards', loadComponent: () => import('./features/whiteboards/whiteboards').then(route => route.AdminWhiteboards) },
      { path: 'whiteboards/:sessionId', loadComponent: () => import('./features/whiteboards/whiteboards').then(route => route.AdminWhiteboards) },
      { path: 'staff', loadComponent: () => import('./features/staff/staff').then(route => route.AdminStaff) },
      { path: 'finance', loadComponent: () => import('./features/finance/finance').then(route => route.AdminFinance) },
      { path: 'bookings', loadComponent: () => import('./features/bookings/bookings').then(route => route.AdminBookings) },
      { path: 'invoices', loadComponent: () => import('./features/invoices/invoices').then(m => m.InvoicesAdmin) },
      { path: 'finance/overview', loadComponent: () => import('./features/finance/overview/finance-overview').then(m => m.FinanceOverviewPage) },
      { path: 'finance/payments', loadComponent: () => import('./features/finance/payments/finance-payments').then(m => m.FinancePaymentsPage) },
      { path: 'finance/payments/:id', loadComponent: () => import('./features/finance/payments/finance-payment-detail').then(m => m.FinancePaymentDetailPage) },
      { path: 'finance/payouts', loadComponent: () => import('./features/finance/payouts/finance-payouts').then(m => m.FinancePayoutsPage) },
      { path: 'finance/refunds', loadComponent: () => import('./features/finance/refunds/finance-refunds').then(m => m.FinanceRefundsPage) },
      { path: 'finance/teachers', loadComponent: () => import('./features/finance/teachers/finance-teachers').then(m => m.FinanceTeachersPage) },
      { path: 'finance/ledger', loadComponent: () => import('./features/finance/ledger/finance-ledger').then(m => m.FinanceLedgerPage) },
      { path: 'finance/settings', loadComponent: () => import('./features/finance/settings/finance-settings').then(m => m.FinanceSettingsPage) },
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
