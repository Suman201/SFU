import { RoomsGateway } from './rooms.gateway';

describe('RoomsGateway', () => {
  it('disconnects unauthorized sockets', async () => {
    const gateway = new RoomsGateway({} as never, {} as never);
    const socket: { data: { requestId?: string }; handshake: { auth: Record<string, unknown>; headers: Record<string, unknown>; address: string }; disconnect: jest.Mock } = {
      data: {},
      handshake: { auth: {}, headers: {}, address: '127.0.0.1' },
      disconnect: jest.fn()
    };

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data.requestId).toBeDefined();
  });
});
