import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

describe('UsersService admin management', () => {
  it('lists users with filters, pagination, summary, and no secrets', async () => {
    const row = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      permissions: ['rooms:create']
    });
    const { service, users, findChain } = createService([row]);
    users.countDocuments.mockReturnValue(queryResult(7));

    const result = await service.listAdminUsers(
      { role: 'teacher', status: 'active', search: 'grace', page: 2, limit: 10, sort: 'name_asc' },
      authUser('admin-1', ['ADMIN'])
    );

    const filter = users.find.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(filter['deletedAt']).toEqual({ $exists: false });
    expect(filter['roles']).toBe('TEACHER');
    expect(filter['status']).toBe('active');
    expect(Array.isArray(filter['$or'])).toBe(true);
    expect(findChain.skip.mock.calls[0]?.[0]).toBe(10);
    expect(findChain.limit.mock.calls[0]?.[0]).toBe(10);
    expect(result.total).toBe(7);
    expect(result.summary.totalUsers).toBe(7);
    expect(result.items[0]?.id).toBe('teacher-1');
    expect(result.items[0]?.roles).toEqual(['teacher']);
    expect(result.items[0]?.primaryRole).toBe('teacher');
    expect('passwordHash' in ((result.items[0] ?? {}) as Record<string, unknown>)).toBe(false);
    expect('refreshTokenIds' in ((result.items[0] ?? {}) as Record<string, unknown>)).toBe(false);
  });

  it('rejects admin user listing for non-admin users', async () => {
    const { service, users } = createService();

    let thrown: unknown;
    try {
      await service.listAdminUsers({}, authUser('student-1', ['STUDENT']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(users.find).not.toHaveBeenCalled();
  });

  it('rejects admin self-promotion to super admin', async () => {
    const { service, users } = createService();
    users.findOne.mockReturnValueOnce(queryResult(userDoc({ id: 'admin-1', roles: ['ADMIN'] })));

    let thrown: unknown;
    try {
      await service.updateAdminUser('admin-1', { roles: ['super_admin'] }, authUser('admin-1', ['ADMIN']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('prevents admins from managing admin accounts', async () => {
    const { service, users } = createService();
    users.findOne.mockReturnValueOnce(queryResult(userDoc({ id: 'admin-2', roles: ['ADMIN'] })));

    let thrown: unknown;
    try {
      await service.updateAdminUser('admin-2', { phone: '+15550001111' }, authUser('admin-1', ['ADMIN']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('prevents deactivating the last active super admin', async () => {
    const { service, users } = createService();
    users.findOne.mockReturnValueOnce(queryResult(userDoc({ id: 'super-1', roles: ['SUPER_ADMIN'] })));
    users.countDocuments.mockReturnValueOnce(queryResult(1));

    let thrown: unknown;
    try {
      await service.deactivateAdminUser('super-1', authUser('super-2', ['SUPER_ADMIN']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('activates and deactivates users through admin actions', async () => {
    const inactiveUser = userDoc({ id: 'student-1', status: 'inactive', disabled: true });
    const activeUser = userDoc({ id: 'student-1', status: 'active', disabled: false });
    const { service, users, sessions } = createService();
    users.findOne.mockReturnValueOnce(queryResult(inactiveUser));
    users.findOneAndUpdate.mockReturnValueOnce(queryResult(activeUser));

    const activated = await service.activateAdminUser('student-1', authUser('admin-1', ['ADMIN']));

    expect(activated.action).toBe('activated');
    expect(activated.user.status).toBe('active');
    const activationUpdate = users.findOneAndUpdate.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(activationUpdate).toEqual({ $set: { status: 'active', disabled: false } });

    users.findOne.mockReturnValueOnce(queryResult(activeUser));
    users.findOneAndUpdate.mockReturnValueOnce(queryResult(inactiveUser));
    const deactivated = await service.deactivateAdminUser('student-1', authUser('admin-1', ['ADMIN']));

    expect(deactivated.action).toBe('deactivated');
    expect(deactivated.user.disabled).toBe(true);
    const revokeCall = sessions.updateMany.mock.calls[0];
    expect(revokeCall?.[0]).toEqual({ userId: 'student-1', revokedAt: { $exists: false } });
    expect(((revokeCall?.[1] as Record<string, Record<string, unknown>>)['$set']?.['revokedAt'] as Date) instanceof Date).toBe(true);
  });
});

function createService(rows: Record<string, unknown>[] = []) {
  const findChain = queryChain(rows);
  const users = {
    exists: jest.fn(),
    create: jest.fn(),
    find: jest.fn((_filter?: unknown) => findChain),
    findOne: jest.fn((_filter?: unknown) => queryResult(userDoc())),
    findOneAndUpdate: jest.fn((_filter?: unknown, _update?: unknown, _options?: unknown) => queryResult(userDoc())),
    countDocuments: jest.fn((_filter?: unknown) => queryResult(0))
  };
  const sessions = {
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 })
  };
  const auditLogs = {
    record: jest.fn().mockResolvedValue(undefined)
  };
  return {
    service: new UsersService(users as never, sessions as never, auditLogs as never),
    users,
    sessions,
    auditLogs,
    findChain
  };
}

function queryResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value)
  };
}

function queryChain<T>(value: T) {
  const chain = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    exec: jest.fn().mockResolvedValue(value)
  };
  chain.sort.mockImplementation((_sort?: unknown) => chain);
  chain.skip.mockImplementation((_skip?: number) => chain);
  chain.limit.mockImplementation((_limit?: number) => chain);
  return chain;
}

function authUser(sub: string, roles: string[]): AuthenticatedUser {
  return {
    sub,
    email: `${sub}@example.test`,
    roles,
    permissions: [],
    tokenId: `${sub}-token`
  };
}

function userDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    _id: 'user-1',
    name: 'Grace Hopper',
    displayName: 'Grace Hopper',
    email: 'grace@example.test',
    phone: '+15550000000',
    roles: ['STUDENT'],
    permissions: ['rooms:read'],
    status: 'active',
    disabled: false,
    passwordHash: 'secret',
    refreshTokenIds: ['refresh-token'],
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides
  };
}
