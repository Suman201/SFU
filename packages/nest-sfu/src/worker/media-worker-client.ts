import { EventEmitter } from 'events';
import { fork, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import type { NestSfuOptions } from '../nest-sfu.options';
import {
  isMediaWorkerMessage,
  serializeError,
  type MediaWorkerCommandResult,
  type MediaWorkerErrorShape,
  type MediaWorkerEventPayload,
  type MediaWorkerHealth,
  type MediaWorkerRequest,
  type MediaWorkerRequestCommand
} from './ipc';

interface PendingRequest {
  commandType: MediaWorkerRequestCommand['type'];
  createdAt: number;
  timeout: NodeJS.Timeout;
  resolve: (value: MediaWorkerCommandResult) => void;
  reject: (reason: Error) => void;
}

export interface MediaWorkerClientOptions {
  workerId: string;
  options: NestSfuOptions;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  heartbeatTimeoutMs: number;
  execArgv?: string[];
}

export interface MediaWorkerIpcMetrics {
  requests: number;
  timeouts: number;
  failures: number;
  averageLatencyMs: number;
}

export interface MediaWorkerClientEvents {
  event: [MediaWorkerEventPayload];
  ready: [MediaWorkerHealth];
  health: [MediaWorkerHealth];
  crash: [{ workerId: string; code: number | null; signal: NodeJS.Signals | null; error?: MediaWorkerErrorShape }];
  ipc: [{ workerId: string; operation: string; status: 'ok' | 'error' | 'timeout'; durationMs: number }];
}

export class MediaWorkerClient extends EventEmitter {
  readonly workerId: string;
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private starting?: Promise<void>;
  private healthState: MediaWorkerHealth;
  private latencySamples = 0;
  private latencyTotalMs = 0;
  private requests = 0;
  private failures = 0;
  private timeouts = 0;
  private stopping = false;
  private draining = false;
  private restartCount = 0;

  constructor(private readonly config: MediaWorkerClientOptions) {
    super();
    this.workerId = config.workerId;
    this.healthState = {
      workerId: this.workerId,
      healthy: false,
      ready: false,
      status: 'starting',
      startedAt: new Date().toISOString(),
      restarts: 0,
      crashes: 0,
      activeRooms: 0,
      activeTransports: 0,
      activeProducers: 0,
      activeConsumers: 0,
      rtpPackets: 0,
      rtcpPackets: 0,
      inflightRequests: 0,
      queueDepth: 0,
      averageIpcLatencyMs: 0,
      ipcTimeouts: 0
    };
  }

  override on<K extends keyof MediaWorkerClientEvents>(eventName: K, listener: (...args: MediaWorkerClientEvents[K]) => void): this {
    return super.on(eventName, listener);
  }

  override emit<K extends keyof MediaWorkerClientEvents>(eventName: K, ...args: MediaWorkerClientEvents[K]): boolean {
    return super.emit(eventName, ...args);
  }

  async start(): Promise<void> {
    if (this.ready && this.child?.connected) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = new Promise<void>((resolve, reject) => {
      const entry = resolveWorkerEntry();
      const execArgv = this.config.execArgv ?? (entry.endsWith('.ts') ? ['-r', 'ts-node/register'] : []);
      const startupTimeout = setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill('SIGTERM');
        }
        reject(new Error(`Media worker ${this.workerId} did not become ready within ${this.config.startupTimeoutMs}ms`));
      }, this.config.startupTimeoutMs);
      const child = fork(entry, [], {
        env: {
          ...process.env,
          MEDIA_WORKER_ID: this.workerId,
          MEDIA_WORKER_OPTIONS: JSON.stringify(sanitizeOptions(this.config.options))
        },
        execArgv,
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      this.child = child;
      this.stopping = false;
      this.ready = false;
      this.healthState = {
        ...this.healthState,
        pid: child.pid,
        healthy: false,
        ready: false,
        status: 'starting',
        startedAt: new Date().toISOString(),
        inflightRequests: 0,
        queueDepth: 0
      };
      child.on('message', (message) => {
        if (!isMediaWorkerMessage(message)) {
          return;
        }
        if (message.kind === 'response') {
          this.handleResponse(message.id, message.ok, message.data, message.error, message.durationMs);
          return;
        }
        if (message.kind === 'event') {
          if (message.event.type === 'ready') {
            clearTimeout(startupTimeout);
            this.ready = true;
            this.healthState = {
              ...message.event.health,
              restarts: this.restartCount,
              draining: this.draining,
              status: this.draining ? 'draining' : 'ready'
            };
            this.emit('ready', this.snapshot());
            resolve();
          } else if (message.event.type === 'health') {
            this.healthState = {
              ...message.event.health,
              restarts: this.restartCount,
              draining: this.draining,
              status: this.draining ? 'draining' : message.event.health.status ?? 'ready'
            };
            this.emit('health', this.snapshot());
          } else if (message.event.type === 'error') {
            this.healthState = { ...this.healthState, lastError: message.event.error.message, healthy: false };
          }
          this.emit('event', message.event);
        }
      });
      child.on('error', (error) => {
        clearTimeout(startupTimeout);
        this.healthState = { ...this.healthState, healthy: false, lastError: error.message };
        reject(error);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        this.ready = false;
        this.child = undefined;
        if (this.stopping) {
          this.healthState = {
            ...this.healthState,
            healthy: false,
            ready: false
          };
          this.failPending(new Error(`Media worker ${this.workerId} stopped`));
          return;
        }
        this.healthState = {
          ...this.healthState,
          healthy: false,
          ready: false,
          status: 'exited',
          crashes: this.healthState.crashes + 1,
          lastError: `worker exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`
        };
        this.failPending(new Error(this.healthState.lastError));
        this.emit('crash', { workerId: this.workerId, code, signal });
      });
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async request(command: MediaWorkerRequestCommand, timeoutMs = this.config.requestTimeoutMs): Promise<MediaWorkerCommandResult> {
    await this.start();
    const child = this.child;
    if (!child?.connected || !this.ready) {
      throw new Error(`Media worker ${this.workerId} is not ready`);
    }
    if (this.staleHeartbeat()) {
      throw new Error(`Media worker ${this.workerId} heartbeat is stale`);
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const message: MediaWorkerRequest = { kind: 'request', id, command, createdAt };
    this.requests += 1;
    return new Promise<MediaWorkerCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        this.timeouts += 1;
        this.healthState = { ...this.healthState, ipcTimeouts: this.timeouts };
        const durationMs = Date.now() - createdAt;
        this.emit('ipc', { workerId: this.workerId, operation: command.type, status: 'timeout', durationMs });
        reject(new Error(`Media worker ${this.workerId} request ${command.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        commandType: command.type,
        createdAt,
        timeout,
        resolve,
        reject
      });
      this.healthState = this.withInflight();
      child.send(message, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        this.failures += 1;
        this.healthState = this.withInflight(error.message);
        this.emit('ipc', { workerId: this.workerId, operation: command.type, status: 'error', durationMs: Date.now() - createdAt });
        reject(error);
      });
    });
  }

  async stop(reason = 'shutdown'): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.stopping = true;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    if (child.connected && this.ready) {
      try {
        await this.request({ type: 'shutdown' }, Math.min(this.config.requestTimeoutMs, 1000));
      } catch {
        // Worker shutdown is best-effort; the process is killed below if it remains alive.
      }
    }
    this.ready = false;
    this.draining = false;
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    this.failPending(new Error(`Media worker ${this.workerId} stopped: ${reason}`));
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
  }

  snapshot(): MediaWorkerHealth {
    const baseHealthy = this.ready && !this.staleHeartbeat();
    const overloaded = this.healthState.overloaded ?? false;
    return {
      ...this.healthState,
      healthy: baseHealthy,
      ready: this.ready,
      status: !baseHealthy ? 'unhealthy' : this.draining ? 'draining' : overloaded ? 'overloaded' : 'ready',
      draining: this.draining,
      overloaded,
      restarts: this.restartCount,
      inflightRequests: this.pending.size,
      queueDepth: this.pending.size,
      averageIpcLatencyMs: this.latencySamples === 0 ? 0 : this.latencyTotalMs / this.latencySamples,
      ipcTimeouts: this.timeouts
    };
  }

  metrics(): MediaWorkerIpcMetrics {
    return {
      requests: this.requests,
      failures: this.failures,
      timeouts: this.timeouts,
      averageLatencyMs: this.latencySamples === 0 ? 0 : this.latencyTotalMs / this.latencySamples
    };
  }

  markDraining(draining = true): void {
    this.draining = draining;
    this.healthState = {
      ...this.healthState,
      draining,
      status: draining ? 'draining' : this.healthState.ready ? 'ready' : this.healthState.status
    };
  }

  markRestarted(): void {
    this.restartCount += 1;
    this.healthState = {
      ...this.healthState,
      restarts: this.restartCount
    };
  }

  private handleResponse(
    id: string,
    ok: boolean,
    data: MediaWorkerCommandResult | undefined,
    error: MediaWorkerErrorShape | undefined,
    durationMs: number
  ): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    this.latencySamples += 1;
    this.latencyTotalMs += durationMs;
    this.healthState = this.withInflight(error?.message);
    this.emit('ipc', { workerId: this.workerId, operation: pending.commandType, status: ok ? 'ok' : 'error', durationMs });
    if (ok) {
      pending.resolve(data);
      return;
    }
    this.failures += 1;
    pending.reject(errorFromShape(error));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.healthState = this.withInflight(error.message);
  }

  private withInflight(lastError?: string): MediaWorkerHealth {
    return {
      ...this.healthState,
      inflightRequests: this.pending.size,
      queueDepth: this.pending.size,
      averageIpcLatencyMs: this.latencySamples === 0 ? 0 : this.latencyTotalMs / this.latencySamples,
      ipcTimeouts: this.timeouts,
      lastError: lastError ?? this.healthState.lastError
    };
  }

  private staleHeartbeat(): boolean {
    if (!this.healthState.lastHeartbeatAt) {
      return false;
    }
    return Date.now() - Date.parse(this.healthState.lastHeartbeatAt) > this.config.heartbeatTimeoutMs;
  }
}

function resolveWorkerEntry(): string {
  const jsEntry = join(__dirname, 'media-worker.entry.js');
  if (existsSync(jsEntry)) {
    return jsEntry;
  }
  return join(dirname(__filename), 'media-worker.entry.ts');
}

function sanitizeOptions(options: NestSfuOptions): NestSfuOptions {
  const { metrics: _metrics, ...rest } = options;
  return rest;
}

function errorFromShape(error: MediaWorkerErrorShape | undefined): Error {
  if (!error) {
    return new Error('Unknown media worker error');
  }
  const normalized = new Error(error.message);
  normalized.name = error.name;
  normalized.stack = error.stack;
  Object.assign(normalized, { status: error.status, code: error.code });
  return normalized;
}
