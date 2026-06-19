import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@native-sfu/contracts';
import { type AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { AuthService } from '../src/auth/auth.service';
import { RoomSignalService } from '../src/rooms/room-signal.service';
import { RoomsGateway } from '../src/rooms/rooms.gateway';
import { RoomsService } from '../src/rooms/rooms.service';

describe('RoomsGateway Socket.IO ack integration (e2e)', () => {
  let app: INestApplication;
  let socket: Socket;

  const rooms = {
    onConsumerLayerEvent: jest.fn(() => jest.fn()),
    onProducerDynacastEvent: jest.fn(() => jest.fn()),
    onConsumerScoreUpdated: jest.fn(() => jest.fn()),
    onProducerScoreUpdated: jest.fn(() => jest.fn()),
    onTransportQualityUpdated: jest.fn(() => jest.fn()),
    onRoomQualityUpdated: jest.fn(() => jest.fn()),
    onRoomQualitySummaryUpdated: jest.fn(() => jest.fn()),
    onRoomIncidentStateUpdated: jest.fn(() => jest.fn()),
    onRoomIncidentTimelineEvent: jest.fn(() => jest.fn()),
    onRoomSnapshotGenerated: jest.fn(() => jest.fn()),
    onRoomFailed: jest.fn(() => jest.fn()),
    createRoom: jest.fn(async () => ({ id: 'room-1', hostId: 'host-1' })),
    getRoomQualitySummaryState: jest.fn(async () => ({ roomId: 'room-1', health: 'stable' })),
    getRoomIncidentState: jest.fn(async () => ({
      roomId: 'room-1',
      status: 'stable',
      health: 'stable',
      protected: false,
      admissionsState: 'default',
      publishingState: 'default',
      underRecovery: false,
      activeAlerts: [],
      snapshotCount: 0,
      updatedAt: '2026-06-19T00:00:00.000Z'
    })),
    updateRoomMediaProfile: jest.fn(async () => ({ id: 'room-1', mediaProfile: { id: 'webinar' } })),
    leaveRoomForSocket: jest.fn(async () => ({ closed: false, left: false }))
  };
  const auth = {
    verifyAccessToken: jest.fn(async () => ({
      sub: 'user-1',
      email: 'teacher.one@example.com',
      roles: [Role.HOST],
      tokenId: 'token-1'
    }))
  };
  const signals = {
    onSignal: jest.fn(() => jest.fn()),
    publish: jest.fn(async () => undefined)
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoomsGateway,
        { provide: RoomsService, useValue: rooms },
        { provide: AuthService, useValue: auth },
        { provide: RoomSignalService, useValue: signals }
      ]
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    socket = io(`http://127.0.0.1:${port}/sfu`, {
      transports: ['websocket'],
      auth: { token: 'test-access-token' },
      reconnection: false
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 5_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  });

  afterAll(async () => {
    socket?.disconnect();
    await app.close();
  });

  it('returns an acknowledgement payload for room:create', async () => {
    const response = await new Promise<{ ok: boolean; data?: { id: string; hostId: string }; error?: { message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Ack timeout for room:create')), 5_000);
      socket.emit(
        'room:create',
        {
          name: 'Release Gate Ack Validation',
          maxParticipants: 4,
          waitingRoomEnabled: false,
          joinApprovalRequired: false
        },
        (ackResponse: { ok: boolean; data?: { id: string; hostId: string }; error?: { message?: string } }) => {
          clearTimeout(timer);
          resolve(ackResponse);
        }
      );
    });

    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ id: 'room-1', hostId: 'host-1' });
    expect(rooms.createRoom).toHaveBeenCalledTimes(1);
    const [user, socketId, request] = rooms.createRoom.mock.calls[0] as unknown as [any, any, any];
    expect(user).toEqual({
      id: 'user-1',
      email: 'teacher.one@example.com',
      roles: [Role.HOST]
    });
    expect(typeof socketId).toBe('string');
    expect(request.name).toBe('Release Gate Ack Validation');
    expect(request.maxParticipants).toBe(4);
  });

  it('returns an acknowledgement payload for room:get-quality-summary', async () => {
    const response = await new Promise<{ ok: boolean; data?: { roomId: string; health: string }; error?: { message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Ack timeout for room:get-quality-summary')), 5_000);
      socket.emit('room:get-quality-summary', { roomId: 'room-1' }, (ackResponse: { ok: boolean; data?: { roomId: string; health: string }; error?: { message?: string } }) => {
        clearTimeout(timer);
        resolve(ackResponse);
      });
    });

    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ roomId: 'room-1', health: 'stable' });
    expect(rooms.getRoomQualitySummaryState as jest.Mock).toHaveBeenCalledWith('room-1', 'host-1');
  });

  it('returns an acknowledgement payload for room:update-media-profile', async () => {
    const response = await new Promise<{ ok: boolean; data?: { id: string; mediaProfile: { id: string } }; error?: { message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Ack timeout for room:update-media-profile')), 5_000);
      socket.emit(
        'room:update-media-profile',
        { roomId: 'room-1', profileId: 'webinar' },
        (ackResponse: { ok: boolean; data?: { id: string; mediaProfile: { id: string } }; error?: { message?: string } }) => {
          clearTimeout(timer);
          resolve(ackResponse);
        }
      );
    });

    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ id: 'room-1', mediaProfile: { id: 'webinar' } });
    expect(rooms.updateRoomMediaProfile as jest.Mock).toHaveBeenCalledWith({ roomId: 'room-1', profileId: 'webinar' }, 'host-1');
  });

  it('returns an acknowledgement payload for room:get-incident-state', async () => {
    const response = await new Promise<{ ok: boolean; data?: { roomId: string; status: string }; error?: { message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Ack timeout for room:get-incident-state')), 5_000);
      socket.emit('room:get-incident-state', { roomId: 'room-1' }, (ackResponse: { ok: boolean; data?: { roomId: string; status: string }; error?: { message?: string } }) => {
        clearTimeout(timer);
        resolve(ackResponse);
      });
    });

    expect(response.ok).toBe(true);
    expect(response.data?.roomId).toBe('room-1');
    expect(response.data?.status).toBe('stable');
    expect(rooms.getRoomIncidentState as jest.Mock).toHaveBeenCalledWith('room-1', 'host-1');
  });
});
