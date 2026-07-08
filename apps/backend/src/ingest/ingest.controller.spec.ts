import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminIngestsController, AdminRoomIngestsController } from './ingest.controller';

describe('AdminIngestsController', () => {
  it('protects the admin ingest surface with JWT and admin-role guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminIngestsController)).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminIngestsController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminRoomIngestsController)).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminRoomIngestsController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('delegates ingest listing and lifecycle requests to the ingest service', async () => {
    const service = {
      createAdminIngest: jest.fn(async () => ({ id: 'ingest-1' })),
      listAdminIngests: jest.fn(async () => ({ items: [], page: 1, limit: 25, total: 0, summary: {} })),
      getAdminIngest: jest.fn(async () => ({ id: 'ingest-1' })),
      updateAdminIngest: jest.fn(async () => ({ id: 'ingest-1' })),
      startAdminIngest: jest.fn(async () => ({ id: 'ingest-1', status: 'starting' })),
      stopAdminIngest: jest.fn(async () => ({ id: 'ingest-1', status: 'stopped' })),
      attachAdminIngest: jest.fn(async () => ({ id: 'ingest-1', roomId: 'room-1' })),
      detachAdminIngest: jest.fn(async () => ({ id: 'ingest-1' }))
    };
    const controller = new AdminIngestsController(service as never);
    const roomController = new AdminRoomIngestsController(service as never);
    const user = { sub: 'admin-1' } as never;

    await controller.create({ sourceType: 'hls', sourceUrl: 'https://media.example.test/live/index.m3u8' } as never, user);
    await controller.list({ page: '2', limit: '10', attached: 'detached', search: 'promo' }, user);
    await controller.start('ingest-1', user);
    await controller.stop('ingest-1', user);
    await roomController.attach('room-1', 'ingest-1', { startIfStopped: true } as never, user);
    await roomController.detach('room-1', 'ingest-1', user);

    expect((service.createAdminIngest as jest.Mock).mock.calls[0][0]).toBe(user);
    expect((service.listAdminIngests as jest.Mock).mock.calls[0][1]).toEqual({
      page: 2,
      limit: 10,
      attached: 'detached',
      search: 'promo'
    });
    expect((service.startAdminIngest as jest.Mock).mock.calls[0]).toEqual([user, 'ingest-1']);
    expect((service.stopAdminIngest as jest.Mock).mock.calls[0]).toEqual([user, 'ingest-1']);
    expect((service.attachAdminIngest as jest.Mock).mock.calls[0]).toEqual([user, 'ingest-1', 'room-1', { startIfStopped: true }]);
    expect((service.detachAdminIngest as jest.Mock).mock.calls[0]).toEqual([user, 'ingest-1', 'room-1']);
  });
});
