import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogsService } from './audit-logs.service';

describe('AuditLogsService', () => {
  it('records audit events with actor context and redacted sensitive fields', async () => {
    const { service, auditLogs } = createHarness();

    await service.record({
      actor: admin(),
      action: 'admin.users.update',
      resourceType: 'user',
      resourceId: 'user-1',
      metadata: {
        summary: 'Updated user',
        password: 'secret',
        nested: {
          accessToken: 'token',
          safe: 'kept'
        }
      },
      before: { roles: ['STUDENT'], passwordHash: 'hash' },
      after: { roles: ['TEACHER'] }
    });

    const payload = auditLogs.create.mock.calls[0]?.[0];
    expect(payload.actorId).toBe('admin-1');
    expect(payload.actorEmail).toBe('admin@example.test');
    expect(payload.actorRoles).toEqual(['ADMIN']);
    expect(payload.action).toBe('admin.users.update');
    expect(payload.status).toBe('success');
    expect(payload.resourceType).toBe('user');
    expect(payload.resourceId).toBe('user-1');
    expect(payload.metadata).toEqual({
      summary: 'Updated user',
      password: '[redacted]',
      nested: {
        accessToken: '[redacted]',
        safe: 'kept'
      }
    });
    expect(payload.before).toEqual({ roles: ['STUDENT'], passwordHash: '[redacted]' });
    expect(payload.after).toEqual({ roles: ['TEACHER'] });
  });

  it('does not fail the business action when audit persistence fails', async () => {
    const { service, auditLogs } = createHarness();
    auditLogs.create.mockRejectedValueOnce(new Error('database unavailable'));

    await service.record({ actor: admin(), action: 'admin.users.update' });
  });

  it('lists audit logs for admins newest first with filters', async () => {
    const { service, auditLogs } = createHarness();

    const result = await service.listAdminAuditLogs(
      {
        actorId: 'admin-1',
        action: 'admin.users.update',
        resourceType: 'user',
        resourceId: 'user-1',
        status: 'success',
        dateFrom: '2026-06-24T00:00:00.000Z',
        search: 'update',
        page: 2,
        limit: 10
      },
      admin()
    );

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.id).toBe('audit-1');
    expect(result.items[0]?.action).toBe('admin.users.update');
    expect(result.items[0]?.resourceType).toBe('user');
    expect(result.items[0]?.resourceId).toBe('user-1');
    expect(result.items[0]?.status).toBe('success');
    expect(result.items[0]?.summary).toBe('Updated user');
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.total).toBe(1);
    const filter = auditLogs.find.mock.calls[0]?.[0];
    expect(filter.actorId).toBe('admin-1');
    expect(filter.action).toBe('admin.users.update');
    expect(filter.resourceType).toBe('user');
    expect(filter.resourceId).toBe('user-1');
    expect(filter.status).toBe('success');
  });

  it('rejects non-admin access to audit logs', async () => {
    const { service, auditLogs } = createHarness();

    let thrown: unknown;
    try {
      await service.listAdminAuditLogs({}, student());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(auditLogs.find).not.toHaveBeenCalled();
  });

  it('loads one audit log detail for admins', async () => {
    const { service, auditLogs } = createHarness();

    const detail = await service.getAdminAuditLog('audit-1', admin());

    expect(auditLogs.findById).toHaveBeenCalledWith('audit-1');
    expect(detail.metadata).toEqual({ summary: 'Updated user' });
    expect(detail.before).toEqual({ roles: ['STUDENT'] });
    expect(detail.after).toEqual({ roles: ['TEACHER'] });
  });

  function createHarness(): {
    service: AuditLogsService;
    auditLogs: {
      create: jest.Mock;
      find: jest.Mock;
      countDocuments: jest.Mock;
      findById: jest.Mock;
    };
  } {
    const doc = {
      id: 'audit-1',
      createdAt: new Date('2026-06-24T08:30:00.000Z'),
      actorId: 'admin-1',
      actorEmail: 'admin@example.test',
      actorRoles: ['ADMIN'],
      action: 'admin.users.update',
      status: 'success',
      resourceType: 'user',
      resourceId: 'user-1',
      resourceLabel: 'Ada Admin',
      metadata: { summary: 'Updated user' },
      before: { roles: ['STUDENT'] },
      after: { roles: ['TEACHER'] }
    };
    const findExec = jest.fn(async () => [doc]);
    const auditLogs = {
      create: jest.fn(async () => undefined),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({
          skip: jest.fn(() => ({
            limit: jest.fn(() => ({
              exec: findExec
            }))
          }))
        }))
      })),
      countDocuments: jest.fn(() => ({ exec: jest.fn(async () => 1) })),
      findById: jest.fn(() => ({ exec: jest.fn(async () => doc) }))
    };
    return {
      service: new AuditLogsService(auditLogs as never),
      auditLogs
    };
  }

  function admin(): AuthenticatedUser {
    return {
      sub: 'admin-1',
      email: 'admin@example.test',
      roles: ['ADMIN'],
      permissions: [],
      tokenId: 'token-1'
    };
  }

  function student(): AuthenticatedUser {
    return {
      sub: 'student-1',
      email: 'student@example.test',
      roles: ['STUDENT'],
      permissions: [],
      tokenId: 'token-2'
    };
  }
});
