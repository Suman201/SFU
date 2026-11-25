import type { AdminPortalPermission } from '@native-sfu/contracts';
/** Classify administrative resources centrally; a managed profile has no implicit access. */
export function adminPermissionForRequest(
  method: string,
  originalUrl: string,
): AdminPortalPermission | 'super-admin' | null {
  const path = originalUrl.split('?')[0]!.replace(/^\/api(?:\/v\d+)?/, '');
  const read = method === 'GET' || method === 'HEAD';
  if (/^\/(?:admin\/staff|roles|permissions)(?:\/|$)/.test(path))
    return 'super-admin';
  if (/^\/admin\/whiteboards(?:\/|$)/.test(path))
    return read ? 'admin:whiteboards:read' : 'admin:whiteboards:restore';
  if (/^\/class-sessions\/[^/]+\/whiteboard(?:\/|$)/.test(path))
    return read ? 'admin:whiteboards:read' : 'admin:whiteboards:restore';
  if (path.startsWith('/admin/dashboard/finance')) return 'admin:finance:read';
  if (path.startsWith('/admin/dashboard')) return 'admin:dashboard:read';
  if (path.startsWith('/admin/bookings/finance')) return 'admin:finance:read';
  if (path.startsWith('/admin/bookings')) {
    if (read) return 'admin:bookings:read';
    return path.includes('/refund')
      ? 'admin:bookings:refund'
      : 'admin:bookings:reconcile';
  }
  if (path.startsWith('/bookings/orders/')) {
    if (/\/(invoice|credits)(?:\/|$)/.test(path)) return 'admin:finance:read';
    return read
      ? 'admin:bookings:read'
      : path.endsWith('/cancel')
        ? 'admin:bookings:refund'
        : 'admin:bookings:reconcile';
  }
  if (
    /^\/(?:student-enrollments|assignments|teacher\/assignments)(?:\/|$)/.test(
      path,
    )
  )
    return read ? 'admin:teaching:read' : 'admin:teaching:write';
  if (/^\/class-library(?:\/|$)/.test(path)) return 'admin:library:read';
  if (path.startsWith('/teacher/analytics')) return 'admin:attendance:read';
  if (path.startsWith('/class-sessions/'))
    return read ? 'admin:teaching:read' : 'admin:teaching:write';
  if (path.startsWith('/recordings/'))
    return read ? 'admin:recordings:read' : 'admin:recordings:write';
  if (path.startsWith('/admin/finance')) {
    if ((path === '/admin/finance/settings' && !read) || path === '/admin/finance/reconciliation/repair') return 'super-admin';
    return read ? 'admin:finance:read' : 'admin:finance:write';
  }
  if (path.startsWith('/admin/invoices'))
    return read ? 'admin:finance:read' : 'admin:finance:write';
  if (path.startsWith('/admin/users'))
    return read ? 'admin:users:read' : 'admin:users:write';
  if (/^\/admin\/(?:courses|batches|enrollments)(?:\/|$)/.test(path))
    return read ? 'admin:teaching:read' : 'admin:teaching:write';
  if (path.startsWith('/admin/tutor-'))
    return read ? 'admin:teaching:read' : 'admin:teaching:write';
  if (path.startsWith('/admin/teacher-analytics'))
    return 'admin:attendance:read';
  if (path.startsWith('/admin/support-requests'))
    return read ? 'admin:support:read' : 'admin:support:write';
  if (path.startsWith('/admin/class-sessions')) return 'admin:teaching:read';
  if (path.startsWith('/admin/attendance')) return 'admin:attendance:read';
  if (path.startsWith('/admin/recordings'))
    return read ? 'admin:recordings:read' : 'admin:recordings:write';
  if (path.startsWith('/admin/class-library')) return 'admin:library:read';
  if (path.startsWith('/admin/audit-logs')) return 'admin:audit:read';
  if (path.startsWith('/admin/errors'))
    return read ? 'admin:errors:read' : 'admin:errors:write';
  if (
    /^\/(?:admin\/)?(?:cms|teaching-catalog|teacher-promotions)(?:\/|$)/.test(
      path,
    )
  )
    return read ? 'admin:content:read' : 'admin:content:write';
  if (/^\/(?:admin\/)?(?:support|contact)(?:\/|$)/.test(path))
    return read ? 'admin:support:read' : 'admin:support:write';
  if (path.startsWith('/admin/')) return 'admin:system:access';
  return null;
}
