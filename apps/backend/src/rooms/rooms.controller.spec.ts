import { RoomsController } from './rooms.controller';

describe('RoomsController', () => {
  it('delegates room diagnostics requests to the rooms service', async () => {
    const diagnostics: any = { room: { id: 'room-1' }, qualitySource: 'local-owner' };
    const rooms = {
      getRoomDiagnosticsForUser: jest.fn(async () => diagnostics),
      getRoomAdaptiveDiagnosticsForUser: jest.fn(async () => ({ roomId: 'room-1' })),
      getTransportQualityStateForUser: jest.fn(async () => ({ transportId: 'transport-1' }))
    };
    const controller = new RoomsController(rooms as never);

    const result = await controller.getRoomDiagnostics('room-1', { sub: 'user-1' } as never);

    expect(result).toEqual(diagnostics);
    expect((rooms.getRoomDiagnosticsForUser as jest.Mock).mock.calls[0]).toEqual(['room-1', 'user-1']);
  });

  it('delegates room adaptive diagnostics requests to the rooms service', async () => {
    const adaptiveDiagnostics = { roomId: 'room-1' } as any;
    const rooms = {
      getRoomDiagnosticsForUser: jest.fn(),
      getRoomAdaptiveDiagnosticsForUser: jest.fn(async () => adaptiveDiagnostics),
      getTransportQualityStateForUser: jest.fn()
    };
    const controller = new RoomsController(rooms as never);

    const result = await controller.getRoomAdaptiveDiagnostics('room-1', { sub: 'user-1' } as never);

    expect(result).toBe(adaptiveDiagnostics);
    expect((rooms.getRoomAdaptiveDiagnosticsForUser as jest.Mock).mock.calls[0]).toEqual(['room-1', 'user-1']);
  });

  it('delegates transport quality requests to the rooms service', async () => {
    const transportQuality = { transportId: 'transport-1' } as any;
    const rooms = {
      getRoomDiagnosticsForUser: jest.fn(),
      getRoomAdaptiveDiagnosticsForUser: jest.fn(),
      getTransportQualityStateForUser: jest.fn(async () => transportQuality)
    };
    const controller = new RoomsController(rooms as never);

    const result = await controller.getTransportQuality('transport-1', { sub: 'user-1' } as never);

    expect(result).toBe(transportQuality);
    expect((rooms.getTransportQualityStateForUser as jest.Mock).mock.calls[0]).toEqual(['transport-1', 'user-1']);
  });
});
