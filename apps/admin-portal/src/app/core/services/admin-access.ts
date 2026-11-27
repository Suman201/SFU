import type { AuthService } from './auth.service';
const modules: Record<string, string> = {
  dashboard: 'admin:dashboard:read',
  whiteboards: 'admin:whiteboards:read',
  bookings: 'admin:bookings:read',
  finance: 'admin:finance:read',
  invoices: 'admin:finance:read',
  users: 'admin:users:read',
  courses: 'admin:teaching:read',
  batches: 'admin:teaching:read',
  enrollments: 'admin:teaching:read',
  'class-sessions': 'admin:teaching:read',
  attendance: 'admin:attendance:read',
  recordings: 'admin:recordings:read',
  'class-library': 'admin:library:read',
  'teaching-catalog': 'admin:content:read',
  'tutor-applications': 'admin:teaching:read',
  support: 'admin:support:read',
  'teacher-promotions': 'admin:content:read',
  'audit-logs': 'admin:audit:read',
  errors: 'admin:errors:read',
  'error-encyclopedia': 'admin:errors:read',
};
export function canVisitAdmin(auth: AuthService, url: string): boolean {
  if (/^\/?promotion-commerce(?:[/?]|$)/.test(url)) return auth.can('admin:content:read') || auth.can('admin:finance:read');
  const path = url.split('?')[0]!.replace(/^\//, '');
  if (path === 'staff' || path.startsWith('staff/')) return auth.isSuperAdmin();
  if (path.startsWith('cms/contact')) return auth.can('admin:support:read');
  if (path.startsWith('cms/')) return auth.can('admin:content:read');
  const permission = modules[path.split('/')[0] ?? ''];
  return permission ? auth.can(permission) : auth.isSuperAdmin();
}
export const ADMIN_LANDING_ROUTES = [
  '/dashboard',
  '/whiteboards',
  '/bookings',
  '/finance',
  '/class-sessions',
  '/users',
  '/attendance',
  '/recordings',
  '/class-library',
  '/support',
  '/cms/pages',
  '/audit-logs',
  '/errors',
];
