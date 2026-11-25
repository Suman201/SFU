import { describe, it, expect } from '@jest/globals';
import { adminPermissionForRequest } from './admin-access';
describe('admin resource permission classification', () => {
  it('separates viewing, refunding, reconciliation and financial reporting', () => {
    expect(
      adminPermissionForRequest('GET', '/api/v1/admin/bookings?page=2'),
    ).toBe('admin:bookings:read');
    expect(
      adminPermissionForRequest('POST', '/api/v1/admin/bookings/abc/refunds'),
    ).toBe('admin:bookings:refund');
    expect(
      adminPermissionForRequest('POST', '/api/v1/admin/bookings/abc/reconcile'),
    ).toBe('admin:bookings:reconcile');
    expect(
      adminPermissionForRequest('GET', '/api/v1/admin/bookings/finance'),
    ).toBe('admin:finance:read');
    expect(
      adminPermissionForRequest('POST', '/api/v1/bookings/orders/abc/cancel'),
    ).toBe('admin:bookings:refund');
  });
  it('protects staff policy and financial document routes', () => {
    expect(adminPermissionForRequest('GET', '/api/v1/admin/staff/roles')).toBe(
      'super-admin',
    );
    expect(adminPermissionForRequest('PATCH', '/api/v1/roles/abc')).toBe(
      'super-admin',
    );
    expect(
      adminPermissionForRequest('GET', '/api/v1/bookings/orders/abc/invoice'),
    ).toBe('admin:finance:read');
    expect(adminPermissionForRequest('POST', '/api/v1/admin/invoices')).toBe(
      'admin:finance:write',
    );
  });
  it('classifies shared classroom resources and defaults unknown admin modules to explicit access', () => {
    expect(
      adminPermissionForRequest('GET', '/api/v1/class-sessions/abc/whiteboard'),
    ).toBe('admin:whiteboards:read');
    expect(
      adminPermissionForRequest(
        'POST',
        '/api/v1/admin/whiteboards/abc/versions/xyz/restore',
      ),
    ).toBe('admin:whiteboards:restore');
    expect(adminPermissionForRequest('GET', '/api/v1/admin/new-module')).toBe(
      'admin:system:access',
    );
    expect(adminPermissionForRequest('GET', '/api/v1/auth/me')).toBeNull();
  });
});
