import { SocketService } from './socket.service';

describe('SocketService', () => {
  it('preserves the Socket.IO context when emitting acknowledged events', async () => {
    const service = new SocketService({ accessToken: () => 'token' } as never);
    const timeoutSocket = {
      marker: 'timeout-socket',
      emit(
        this: { marker: string },
        event: string,
        payload: unknown,
        ack: (error: Error | null, response?: unknown) => void
      ): void {
        expect(this.marker).toBe('timeout-socket');
        expect(event).toBe('room:leave');
        expect(payload).toEqual({ roomId: 'room-1' });
        ack(null, { ok: true, data: undefined });
      }
    };
    const socket = {
      timeout: jasmine.createSpy('timeout').and.returnValue(timeoutSocket)
    };
    spyOn(service, 'connect').and.returnValue(socket as never);

    await expectAsync(service.emitAck('room:leave', { roomId: 'room-1' })).toBeResolved();
    expect(socket.timeout).toHaveBeenCalledWith(15_000);
  });
});
