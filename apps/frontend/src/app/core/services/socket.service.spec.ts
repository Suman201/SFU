import { of, throwError } from 'rxjs';
import {
  createSocketAuth,
  SocketAckError,
  SocketService,
} from './socket.service';

describe('SocketService', () => {
  it('preserves the Socket.IO context when emitting acknowledged events', async () => {
    const service = new SocketService({ accessToken: () => 'token' } as never);
    const timeoutSocket = {
      marker: 'timeout-socket',
      emit(
        this: { marker: string },
        event: string,
        payload: unknown,
        ack: (error: Error | null, response?: unknown) => void,
      ): void {
        expect(this.marker).toBe('timeout-socket');
        expect(event).toBe('room:leave');
        expect(payload).toEqual({ roomId: 'room-1' });
        ack(null, { ok: true, data: undefined });
      },
    };
    const socket = {
      timeout: jasmine.createSpy('timeout').and.returnValue(timeoutSocket),
    };
    spyOn(service, 'connect').and.returnValue(socket as never);

    await expectAsync(
      service.emitAck('room:leave', { roomId: 'room-1' }),
    ).toBeResolved();
    expect(socket.timeout).toHaveBeenCalledWith(15_000);
  });
});

describe('Socket reconnect authentication', () => {
  it('obtains the latest valid token for every handshake', () => {
    const auth = {
      ensureAccessToken: jasmine
        .createSpy()
        .and.returnValues(of('first'), of('rotated')),
    };
    const authenticate = createSocketAuth(auth);
    const callback = jasmine.createSpy();
    authenticate(callback);
    authenticate(callback);
    expect(callback.calls.allArgs()).toEqual([
      [{ token: 'first' }],
      [{ token: 'rotated' }],
    ]);
  });
  it('does not send a stale token when renewal fails', () => {
    const authenticate = createSocketAuth({
      ensureAccessToken: () => throwError(() => new Error('offline')),
    });
    const callback = jasmine.createSpy();
    authenticate(callback);
    expect(callback).toHaveBeenCalledOnceWith({ token: null });
  });
});

describe('Socket error-code propagation', () => {
  function harness(response?: unknown, timeout?: Error) {
    const capture = jasmine.createSpy('capture');
    const service = new SocketService({} as never, { capture } as never);
    spyOn(service, 'connect').and.returnValue({
      timeout: () => ({
        emit: (_event: unknown, _payload: unknown, ack: Function) =>
          ack(timeout ?? null, response),
      }),
    } as never);
    return { service, capture };
  }
  it('carries the public code and server reference while retaining the original recovery discriminator', async () => {
    const { service, capture } = harness({
      ok: false,
      error: {
        code: 'ForbiddenException',
        publicCode: 'ACCESS_DENIED',
        requestId: 'socket-reference-123',
        message: 'Permission denied',
      },
    });
    try {
      await service.emitAck('room:leave', { roomId: 'room-1' });
      fail('Expected rejection');
    } catch (error) {
      expect(error instanceof SocketAckError).toBeTrue();
      expect((error as SocketAckError).code).toBe('ForbiddenException');
      expect((error as SocketAckError).publicCode).toBe('ACCESS_DENIED');
    }
    expect(capture).toHaveBeenCalledWith(jasmine.any(SocketAckError), {
      code: 'ACCESS_DENIED',
      requestId: 'socket-reference-123',
      quiet: true,
      operation: 'room:leave',
    });
  });
  it('supports older servers with no public classification and rejects unknown codes', async () => {
    for (const publicCode of [undefined, 'UNREGISTERED_CODE']) {
      const { service, capture } = harness({
        ok: false,
        error: { code: 'Error', message: 'Rejected', publicCode },
      });
      await expectAsync(
        service.emitAck('room:leave', { roomId: 'room-1' }),
      ).toBeRejected();
      expect(capture.calls.mostRecent().args[1].code).toBe('CLASSROOM_ERROR');
    }
  });
  it('preserves automatic redirects without creating a spurious user error', async () => {
    const details = { ownerNodeId: 'node-b' };
    const { service, capture } = harness({
      ok: false,
      error: { code: 'ROOM_REDIRECT', details, message: 'Switch node' },
    });
    try {
      await service.emitAck('room:leave', { roomId: 'room-1' });
      fail('Expected redirect');
    } catch (error) {
      expect((error as SocketAckError).details).toBe(details);
    }
    expect(capture).not.toHaveBeenCalled();
  });
  it('classifies missing acknowledgments as timeouts without retrying the action', async () => {
    const { service, capture } = harness(undefined, new Error('timeout'));
    await expectAsync(
      service.emitAck('room:leave', { roomId: 'room-1' }),
    ).toBeRejected();
    expect(capture.calls.mostRecent().args[1].code).toBe('REQUEST_TIMEOUT');
    expect(service.connect).toHaveBeenCalledTimes(1);
  });
});
