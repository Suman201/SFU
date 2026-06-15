import { Injectable, NgZone } from '@angular/core';
import type { AckResponse, ClientToServerEvents, ServerToClientEvents } from '@native-sfu/contracts';
import { io, Socket } from 'socket.io-client';
import { AuthService } from './auth.service';
import { SOCKET_URL } from './app-environment';

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket?: Socket<ServerToClientEvents, ClientToServerEvents>;

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {}

  connect(): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (this.socket?.connected) {
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
      (socket.emit as unknown as (name: K, body: unknown, ack: (response: AckResponse<unknown>) => void) => void)(event, payload, (response) => {
        this.zone.run(() => {
          if (response.ok) {
            resolve(response.data as ExtractAckData<Parameters<ClientToServerEvents[K]>[1]>);
          } else {
            reject(new Error(response.error.message));
          }
        });
      });
    });
  }

  on<K extends keyof ServerToClientEvents>(event: K, handler: (...args: Parameters<ServerToClientEvents[K]>) => void): void {
    this.connect().on(event, ((...args: Parameters<ServerToClientEvents[K]>) => this.zone.run(() => handler(...args))) as never);
  }
}

type ExtractAckData<T> = T extends (response: AckResponse<infer R>) => void ? R : never;
