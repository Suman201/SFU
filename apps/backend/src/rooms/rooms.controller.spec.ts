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

  it('delegates room quality summary requests to the rooms service', async () => {
    const summary = { roomId: 'room-1', health: 'stable' } as any;
    const rooms = {
      getRoomDiagnosticsForUser: jest.fn(),
      getRoomAdaptiveDiagnosticsForUser: jest.fn(),
      getTransportQualityStateForUser: jest.fn(),
      getRoomQualitySummaryStateForUser: jest.fn(async () => summary)
    };
    const controller = new RoomsController(rooms as never);

    const result = await controller.getRoomQualitySummary('room-1', { sub: 'user-1' } as never);

    expect(result).toBe(summary);
    expect((rooms.getRoomQualitySummaryStateForUser as jest.Mock).mock.calls[0]).toEqual(['room-1', 'user-1']);
  });

  it('delegates room incident workflow requests to the rooms service', async () => {
    const incident = { roomId: 'room-1', status: 'critical' } as any;
    const timeline = { roomId: 'room-1', events: [] } as any;
    const history = { roomId: 'room-1', bundles: [] } as any;
    const recovery = { roomId: 'room-1', action: 'protect_room', executed: true } as any;
    const rooms = {
      getRoomDiagnosticsForUser: jest.fn(),
      getRoomAdaptiveDiagnosticsForUser: jest.fn(),
      getTransportQualityStateForUser: jest.fn(),
      getRoomIncidentStateForUser: jest.fn(async () => incident),
      getRoomIncidentTimelineForUser: jest.fn(async () => timeline),
      getRoomSnapshotHistoryForUser: jest.fn(async () => history),
      getRoomAuditLogForUser: jest.fn(async () => ({ events: [] })),
      runRoomRecoveryActionForUser: jest.fn(async () => recovery)
    };
    const controller = new RoomsController(rooms as never);

    expect(await controller.getRoomIncidentState('room-1', { sub: 'user-1' } as never)).toBe(incident);
    expect(await controller.getRoomIncidentTimeline('room-1', { sub: 'user-1' } as never)).toBe(timeline);
    expect(await controller.getRoomSnapshotHistory('room-1', { sub: 'user-1' } as never)).toBe(history);
    expect(await controller.getRoomAuditLog('room-1', { limit: 12 }, { sub: 'user-1' } as never)).toEqual({ events: [] });
    expect(
      await controller.runRoomRecoveryAction('room-1', { action: 'protect_room', reason: 'Protect room' }, { sub: 'user-1' } as never)
    ).toBe(recovery);
  });

  it('delegates room media profile updates through the user-scoped service path', async () => {
    const updatedRoom = { id: 'room-1', mediaProfile: { id: 'webinar' } } as any;
    const rooms = {
      getRoomDiagnosticsForUser: jest.fn(),
      getRoomAdaptiveDiagnosticsForUser: jest.fn(),
      getTransportQualityStateForUser: jest.fn(),
      updateRoomMediaProfileForUser: jest.fn(async () => updatedRoom)
    };
    const controller = new RoomsController(rooms as never);

    const result = await controller.updateRoomMediaProfile('room-1', { profileId: 'webinar' }, { sub: 'user-1' } as never);

    expect(result).toBe(updatedRoom);
    expect((rooms.updateRoomMediaProfileForUser as jest.Mock).mock.calls[0]).toEqual(['room-1', 'user-1', 'webinar']);
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
