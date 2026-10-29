import { ErrorCenter } from '@sapiovian/error-ui';
import { Injectable, Optional } from '@angular/core';
import {
  isAppErrorCode,
  type AppErrorCode,
  type AckResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@native-sfu/contracts';
import { io, Socket } from 'socket.io-client';
import { AuthService } from './auth.service';
import { SOCKET_URL } from './app-environment';

const SOCKET_ACK_TIMEOUT_MS = 15_000;

export class SocketAckError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly publicCode?: AppErrorCode,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'SocketAckError';
  }
}

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket?: Socket<ServerToClientEvents, ClientToServerEvents>;

  constructor(
    private readonly auth: AuthService,
    @Optional() private readonly errors?: ErrorCenter,
  ) {}

  connect(): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (this.socket && (this.socket.connected || this.socket.active)) {
      return this.socket;
    }
    this.socket = io(SOCKET_URL, {
      transports: ['websocket'],
      auth: createSocketAuth(this.auth),
    });
    return this.socket;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = undefined;
  }

  emitAck<K extends keyof ClientToServerEvents>(
    event: K,
    payload: Parameters<ClientToServerEvents[K]>[0],
  ): Promise<ExtractAckData<Parameters<ClientToServerEvents[K]>[1]>> {
    const socket = this.connect();
    return new Promise((resolve, reject) => {
      const timeoutSocket = socket.timeout(
        SOCKET_ACK_TIMEOUT_MS,
      ) as unknown as {
        emit(
          name: K,
          body: unknown,
          ack: (error: Error | null, response?: AckResponse<unknown>) => void,
        ): void;
      };
      timeoutSocket.emit(event, payload, (error, response) => {
        if (error) {
          const failure = new SocketAckError(
            'ACK_TIMEOUT',
            'The server did not acknowledge this action. Check whether it completed before trying again.',
            undefined,
            'REQUEST_TIMEOUT',
          );
          this.errors?.capture(failure, {
            code: 'REQUEST_TIMEOUT',
            quiet: true,
            operation: event,
          });
          reject(failure);
          return;
        }
        if (response?.ok) {
          resolve(
            response.data as ExtractAckData<
              Parameters<ClientToServerEvents[K]>[1]
            >,
          );
        } else {
          const publicCode = isAppErrorCode(response?.error.publicCode)
            ? response.error.publicCode
            : 'CLASSROOM_ERROR';
          const failure = new SocketAckError(
            response?.error.code ?? 'ACK_ERROR',
            response?.error.message ?? 'The server rejected this action.',
            response?.error.details,
            publicCode,
            response?.error.requestId,
          );
          if (failure.code !== 'ROOM_REDIRECT')
            this.errors?.capture(failure, {
              code: publicCode,
              requestId: failure.requestId,
              quiet: true,
              operation: event,
            });
          reject(failure);
        }
      });
    });
  }

  on<K extends keyof ServerToClientEvents>(
    event: K,
    handler: (...args: Parameters<ServerToClientEvents[K]>) => void,
  ): void {
    this.connect().on(event, handler as never);
  }

  off<K extends keyof ServerToClientEvents>(
    event: K,
    handler: (...args: Parameters<ServerToClientEvents[K]>) => void,
  ): void {
    this.socket?.off(event, handler as never);
  }
}

type ExtractAckData<T> = T extends (response: AckResponse<infer R>) => void
  ? R
  : never;

/** Resolve the current token on every Socket.IO handshake, including reconnects. */
export function createSocketAuth(
  auth: Pick<AuthService, 'ensureAccessToken'>,
): (callback: (credentials: { token: string | null }) => void) => void {
  return (callback) =>
    auth.ensureAccessToken().subscribe({
      next: (token) => callback({ token }),
      error: () => callback({ token: null }),
    });
}
