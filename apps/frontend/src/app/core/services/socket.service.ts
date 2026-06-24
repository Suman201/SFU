import { Injectable } from '@angular/core';
import type { AckResponse, ClientToServerEvents, ServerToClientEvents } from '@native-sfu/contracts';
import { io, Socket } from 'socket.io-client';
import { AuthService } from './auth.service';
import { SOCKET_URL } from './app-environment';

const SOCKET_ACK_TIMEOUT_MS = 15_000;

export class SocketAckError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'SocketAckError';
  }
}

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket?: Socket<ServerToClientEvents, ClientToServerEvents>;

  constructor(private readonly auth: AuthService) {}

  connect(): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (this.socket && (this.socket.connected || this.socket.active)) {
      return this.socket;
    }
    this.socket = io(SOCKET_URL, {
      transports: ['websocket'],
      auth: {
        token: this.auth.accessToken()
      }
    });
    return this.socket;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = undefined;
  }

  emitAck<K extends keyof ClientToServerEvents>(
    event: K,
    payload: Parameters<ClientToServerEvents[K]>[0]
  ): Promise<ExtractAckData<Parameters<ClientToServerEvents[K]>[1]>> {
    const socket = this.connect();
    return new Promise((resolve, reject) => {
      const timeoutSocket = socket.timeout(SOCKET_ACK_TIMEOUT_MS) as unknown as {
        emit(
          name: K,
          body: unknown,
          ack: (error: Error | null, response?: AckResponse<unknown>) => void
        ): void;
      };
      timeoutSocket.emit(event, payload, (error, response) => {
        if (error) {
          reject(new SocketAckError('ACK_TIMEOUT', 'The server did not acknowledge this action. Please try again.'));
          return;
        }
        if (response?.ok) {
          resolve(response.data as ExtractAckData<Parameters<ClientToServerEvents[K]>[1]>);
        } else {
          reject(new SocketAckError(response?.error.code ?? 'ACK_ERROR', response?.error.message ?? 'The server rejected this action.', response?.error.details));
        }
      });
    });
  }

  on<K extends keyof ServerToClientEvents>(event: K, handler: (...args: Parameters<ServerToClientEvents[K]>) => void): void {
    this.connect().on(event, handler as never);
  }

  off<K extends keyof ServerToClientEvents>(event: K, handler: (...args: Parameters<ServerToClientEvents[K]>) => void): void {
    this.socket?.off(event, handler as never);
  }
}

type ExtractAckData<T> = T extends (response: AckResponse<infer R>) => void ? R : never;
