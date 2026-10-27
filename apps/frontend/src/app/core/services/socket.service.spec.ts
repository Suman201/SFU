import { of, throwError } from 'rxjs';
import { createSocketAuth, SocketService } from './socket.service';

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

describe('Socket reconnect authentication', () => {
  it('obtains the latest valid token for every handshake', () => {
    const auth = { ensureAccessToken: jasmine.createSpy().and.returnValues(of('first'), of('rotated')) };
    const authenticate = createSocketAuth(auth);
    const callback = jasmine.createSpy();
    authenticate(callback); authenticate(callback);
    expect(callback.calls.allArgs()).toEqual([[{ token: 'first' }], [{ token: 'rotated' }]]);
  });
  it('does not send a stale token when renewal fails', () => {
    const authenticate = createSocketAuth({ ensureAccessToken: () => throwError(() => new Error('offline')) });
    const callback = jasmine.createSpy(); authenticate(callback);
    expect(callback).toHaveBeenCalledOnceWith({ token: null });
  });
});
