import { EventEmitter } from 'events';
import type { Consumer, Producer } from '@native-sfu/contracts';
import type { NestSfuOptions } from '../nest-sfu.options';
import { MediaWorkerClient } from './media-worker-client';
import type { MediaWorkerEventPayload, MediaWorkerHealth, MediaWorkerPoolSnapshot, MediaWorkerRoomFailureEvent } from './ipc';

export interface MediaWorkerPoolOptions {
  options: NestSfuOptions;
  workerCount: number;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  heartbeatTimeoutMs: number;
  restartBackoffMs: number;
  maxRoomsPerWorker: number;
  maxTransportsPerWorker: number;
  maxInFlightRequestsPerWorker: number;
  softMemoryLimitBytes?: number;
  hardMemoryLimitBytes?: number;
  softIpcLatencyMs: number;
  hardIpcLatencyMs: number;
  drainTimeoutMs: number;
  execArgv?: string[];
  workerFactory?: (workerId: string) => MediaWorkerClient;
}

export interface MediaWorkerCrashEvent {
  workerId: string;
  roomIds: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface MediaWorkerPoolEvents {
  event: [MediaWorkerEventPayload];
  crash: [MediaWorkerCrashEvent];
  roomFailure: [MediaWorkerRoomFailureEvent];
  restart: [{ workerId: string; reason: string }];
  drain: [{ workerId: string; state: 'started' | 'completed' | 'forced'; roomIds: string[] }];
  ipc: [{ workerId: string; operation: string; status: 'ok' | 'error' | 'timeout'; durationMs: number }];
}

interface WorkerBindings {
  rooms: Set<string>;
  transports: Set<string>;
  producers: Set<string>;
  consumers: Set<string>;
}

export class MediaWorkerPool extends EventEmitter {
  private readonly workers: MediaWorkerClient[];
  private readonly bindings = new Map<string, WorkerBindings>();
  private readonly roomToWorker = new Map<string, string>();
  private readonly transportToWorker = new Map<string, string>();
  private readonly producerToWorker = new Map<string, string>();
  private readonly consumerToWorker = new Map<string, string>();
  private readonly transportToRoom = new Map<string, string>();
  private readonly producerToRoom = new Map<string, string>();
  private readonly consumerToRoom = new Map<string, string>();
  private readonly failedRooms = new Set<string>();
  private readonly failures = new Map<string, MediaWorkerRoomFailureEvent>();
  private readonly drainingWorkers = new Set<string>();
  private readonly drainTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(private readonly config: MediaWorkerPoolOptions) {
    super();
    this.workers = Array.from({ length: Math.max(1, config.workerCount) }, (_value, index) => {
      const workerId = `media-worker-${index + 1}`;
      const worker =
        config.workerFactory?.(workerId) ??
        new MediaWorkerClient({
          workerId,
          options: config.options,
          requestTimeoutMs: config.requestTimeoutMs,
          startupTimeoutMs: config.startupTimeoutMs,
          heartbeatTimeoutMs: config.heartbeatTimeoutMs,
          execArgv: config.execArgv
        });
      this.bindings.set(workerId, { rooms: new Set(), transports: new Set(), producers: new Set(), consumers: new Set() });
      worker.on('event', (event) => this.emit('event', event));
      worker.on('ipc', (event) => this.emit('ipc', event));
      worker.on('crash', (event) => {
        const binding = this.bindings.get(event.workerId);
        const rooms = [...(binding?.rooms ?? [])];
        for (const roomId of rooms) {
          this.markRoomFailed(roomId, event.workerId, 'worker_crashed', `Media worker ${event.workerId} crashed`);
        }
        this.emit('crash', { workerId: event.workerId, roomIds: rooms, code: event.code, signal: event.signal });
        void this.restartWorker(event.workerId);
      });
      return worker;
    });
  }

  override on<K extends keyof MediaWorkerPoolEvents>(eventName: K, listener: (...args: MediaWorkerPoolEvents[K]) => void): this {
    return super.on(eventName, listener);
  }

  override emit<K extends keyof MediaWorkerPoolEvents>(eventName: K, ...args: MediaWorkerPoolEvents[K]): boolean {
    return super.emit(eventName, ...args);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await Promise.all(this.workers.map((worker) => worker.start()));
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer);
    }
    this.drainTimers.clear();
    await Promise.all(this.workers.map((worker) => worker.stop('pool shutdown')));
    this.started = false;
  }

  workerForRoom(roomId: string): MediaWorkerClient {
    const existing = this.roomToWorker.get(roomId);
    if (existing) {
      return this.requireWorker(existing);
    }
    const worker = this.pickWorker();
    this.roomToWorker.set(roomId, worker.workerId);
    this.bindings.get(worker.workerId)?.rooms.add(roomId);
    this.failedRooms.delete(roomId);
    this.failures.delete(roomId);
    return worker;
  }

  workerForTransport(transportId: string): MediaWorkerClient {
    return this.requireWorker(this.requireMapping(this.transportToWorker, transportId, 'transport'));
  }

  workerForProducer(producerId: string): MediaWorkerClient {
    return this.requireWorker(this.requireMapping(this.producerToWorker, producerId, 'producer'));
  }

  workerForConsumer(consumerId: string): MediaWorkerClient {
    return this.requireWorker(this.requireMapping(this.consumerToWorker, consumerId, 'consumer'));
  }

  bindTransport(roomId: string, transportId: string, workerId: string): void {
    this.roomToWorker.set(roomId, workerId);
    this.transportToWorker.set(transportId, workerId);
    this.transportToRoom.set(transportId, roomId);
    const binding = this.bindings.get(workerId);
    binding?.rooms.add(roomId);
    binding?.transports.add(transportId);
    this.failedRooms.delete(roomId);
    this.failures.delete(roomId);
  }

  bindProducer(producer: Producer, workerId: string): void {
    this.producerToWorker.set(producer.id, workerId);
    this.producerToRoom.set(producer.id, producer.roomId);
    this.bindings.get(workerId)?.producers.add(producer.id);
  }

  bindConsumer(consumer: Consumer, workerId: string): void {
    this.consumerToWorker.set(consumer.id, workerId);
    this.consumerToRoom.set(consumer.id, consumer.roomId);
    this.bindings.get(workerId)?.consumers.add(consumer.id);
  }

  releaseProducer(producerId: string): void {
    const workerId = this.producerToWorker.get(producerId);
    if (workerId) {
      this.bindings.get(workerId)?.producers.delete(producerId);
    }
    this.producerToWorker.delete(producerId);
    this.producerToRoom.delete(producerId);
  }

  releaseTransport(transportId: string): void {
    const workerId = this.transportToWorker.get(transportId);
    if (workerId) {
      this.bindings.get(workerId)?.transports.delete(transportId);
    }
    this.transportToWorker.delete(transportId);
    this.transportToRoom.delete(transportId);
  }

  releaseConsumer(consumerId: string): void {
    const workerId = this.consumerToWorker.get(consumerId);
    if (workerId) {
      this.bindings.get(workerId)?.consumers.delete(consumerId);
    }
    this.consumerToWorker.delete(consumerId);
    this.consumerToRoom.delete(consumerId);
  }

  releaseRoom(roomId: string, options: { preserveFailure?: boolean } = {}): void {
    const workerId = this.roomToWorker.get(roomId);
    if (workerId) {
      const binding = this.bindings.get(workerId);
      binding?.rooms.delete(roomId);
      for (const transportId of [...(binding?.transports ?? [])]) {
        if (this.transportToWorker.get(transportId) === workerId && this.transportToRoom.get(transportId) === roomId) {
          this.transportToWorker.delete(transportId);
          this.transportToRoom.delete(transportId);
          binding?.transports.delete(transportId);
        }
      }
      for (const producerId of [...(binding?.producers ?? [])]) {
        if (this.producerToWorker.get(producerId) === workerId && this.producerToRoom.get(producerId) === roomId) {
          this.producerToWorker.delete(producerId);
          this.producerToRoom.delete(producerId);
          binding?.producers.delete(producerId);
        }
      }
      for (const consumerId of [...(binding?.consumers ?? [])]) {
        if (this.consumerToWorker.get(consumerId) === workerId && this.consumerToRoom.get(consumerId) === roomId) {
          this.consumerToWorker.delete(consumerId);
          this.consumerToRoom.delete(consumerId);
          binding?.consumers.delete(consumerId);
        }
      }
    }
    this.roomToWorker.delete(roomId);
    if (!options.preserveFailure) {
      this.failedRooms.delete(roomId);
      this.failures.delete(roomId);
    }
    if (workerId && this.drainingWorkers.has(workerId) && (this.bindings.get(workerId)?.rooms.size ?? 0) === 0) {
      void this.completeDrain(workerId);
    }
  }

  clearRoomFailure(roomId: string): void {
    this.failedRooms.delete(roomId);
    this.failures.delete(roomId);
  }

  async drainWorker(workerId: string, forceAfterMs = this.config.drainTimeoutMs): Promise<void> {
    const worker = this.requireWorker(workerId);
    const binding = this.bindings.get(workerId);
    this.drainingWorkers.add(workerId);
    worker.markDraining(true);
    const rooms = [...(binding?.rooms ?? [])];
    this.emit('drain', { workerId, state: 'started', roomIds: rooms });
    if (rooms.length === 0) {
      await this.completeDrain(workerId);
      return;
    }
    const existingTimer = this.drainTimers.get(workerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      void this.forceDrain(workerId);
    }, Math.max(1, forceAfterMs));
    this.drainTimers.set(workerId, timer);
  }

  workerIds(): string[] {
    return this.workers.map((worker) => worker.workerId);
  }

  snapshot(): MediaWorkerPoolSnapshot {
    const workers = this.workers.map((worker) => this.decorateHealth(worker));
    return {
      mode: 'worker',
      workerCount: workers.length,
      healthyWorkers: workers.filter((worker) => worker.healthy).length,
      readyWorkers: workers.filter((worker) => worker.ready).length,
      drainingWorkers: workers.filter((worker) => worker.draining).length,
      overloadedWorkers: workers.filter((worker) => worker.overloaded).length,
      activeRooms: this.roomToWorker.size,
      failedRooms: [...this.failedRooms],
      failures: [...this.failures.values()],
      workers
    };
  }

  private pickWorker(): MediaWorkerClient {
    const candidates = this.workers
      .map((worker) => ({ worker, health: this.decorateHealth(worker) }))
      .filter(({ health }) => health.healthy && !health.draining && !this.hardSaturated(health))
      .sort((left, right) => (left.health.capacityScore ?? 1) - (right.health.capacityScore ?? 1));
    const selected = candidates[0];
    if (!selected) {
      throw new Error('No media worker has capacity for a new room');
    }
    if (selected.health.overloaded) {
      throw new Error('All media workers are overloaded');
    }
    return selected.worker;
  }

  private workerLoad(workerId: string): number {
    return this.bindings.get(workerId)?.rooms.size ?? Number.MAX_SAFE_INTEGER;
  }

  private requireWorker(workerId: string): MediaWorkerClient {
    const worker = this.workers.find((candidate) => candidate.workerId === workerId);
    if (!worker) {
      throw new Error(`Media worker ${workerId} not found`);
    }
    return worker;
  }

  private requireMapping(map: Map<string, string>, id: string, kind: string): string {
    const workerId = map.get(id);
    if (!workerId) {
      throw new Error(`Media ${kind} ${id} is not assigned to a worker`);
    }
    return workerId;
  }

  private async restartWorker(workerId: string): Promise<void> {
    const worker = this.requireWorker(workerId);
    await new Promise((resolve) => setTimeout(resolve, this.config.restartBackoffMs));
    try {
      worker.markDraining(false);
      worker.markRestarted();
      await worker.start();
      this.emit('restart', { workerId, reason: 'crash' });
    } catch {
      // Health remains failed; a later request or process restart can surface the fault.
    }
  }

  private async completeDrain(workerId: string): Promise<void> {
    const timer = this.drainTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.drainTimers.delete(workerId);
    }
    const worker = this.requireWorker(workerId);
    worker.markDraining(false);
    this.drainingWorkers.delete(workerId);
    await worker.stop('drain complete');
    worker.markRestarted();
    await worker.start();
    this.emit('drain', { workerId, state: 'completed', roomIds: [] });
    this.emit('restart', { workerId, reason: 'drain_complete' });
  }

  private async forceDrain(workerId: string): Promise<void> {
    const binding = this.bindings.get(workerId);
    const rooms = [...(binding?.rooms ?? [])];
    for (const roomId of rooms) {
      this.markRoomFailed(roomId, workerId, 'worker_drained_forced', `Media worker ${workerId} drain timed out and was force-closed`);
      this.roomToWorker.delete(roomId);
    }
    for (const transportId of [...(binding?.transports ?? [])]) {
      this.transportToWorker.delete(transportId);
      this.transportToRoom.delete(transportId);
    }
    for (const producerId of [...(binding?.producers ?? [])]) {
      this.producerToWorker.delete(producerId);
      this.producerToRoom.delete(producerId);
    }
    for (const consumerId of [...(binding?.consumers ?? [])]) {
      this.consumerToWorker.delete(consumerId);
      this.consumerToRoom.delete(consumerId);
    }
    binding?.rooms.clear();
    binding?.transports.clear();
    binding?.producers.clear();
    binding?.consumers.clear();
    this.emit('drain', { workerId, state: 'forced', roomIds: rooms });
    await this.completeDrain(workerId);
  }

  private markRoomFailed(
    roomId: string,
    workerId: string,
    reason: MediaWorkerRoomFailureEvent['reason'],
    message: string
  ): void {
    const binding = this.bindings.get(workerId);
    const failure: MediaWorkerRoomFailureEvent = {
      roomId,
      workerId,
      reason,
      message,
      failedAt: new Date().toISOString(),
      affectedTransports: [...(binding?.transports ?? [])].filter(
        (transportId) => this.transportToWorker.get(transportId) === workerId && this.transportToRoom.get(transportId) === roomId
      ),
      affectedProducers: [...(binding?.producers ?? [])].filter(
        (producerId) => this.producerToWorker.get(producerId) === workerId && this.producerToRoom.get(producerId) === roomId
      ),
      affectedConsumers: [...(binding?.consumers ?? [])].filter(
        (consumerId) => this.consumerToWorker.get(consumerId) === workerId && this.consumerToRoom.get(consumerId) === roomId
      ),
      recoverable: false
    };
    this.failedRooms.add(roomId);
    this.failures.set(roomId, failure);
    this.emit('roomFailure', failure);
  }

  private decorateHealth(worker: MediaWorkerClient): MediaWorkerHealth {
    const raw = worker.snapshot();
    const binding = this.bindings.get(worker.workerId);
    const boundHealth: MediaWorkerHealth = {
      ...raw,
      activeRooms: Math.max(raw.activeRooms, binding?.rooms.size ?? 0),
      activeTransports: Math.max(raw.activeTransports, binding?.transports.size ?? 0),
      activeProducers: Math.max(raw.activeProducers, binding?.producers.size ?? 0),
      activeConsumers: Math.max(raw.activeConsumers, binding?.consumers.size ?? 0)
    };
    const capacityScore = this.capacityScore(boundHealth);
    const overloaded = this.hardSaturated(boundHealth) || capacityScore >= 1;
    const draining = this.drainingWorkers.has(worker.workerId) || raw.draining;
    return {
      ...boundHealth,
      status: draining ? 'draining' : !raw.healthy ? 'unhealthy' : overloaded ? 'overloaded' : 'ready',
      draining,
      overloaded,
      capacityScore,
      roomLimit: this.config.maxRoomsPerWorker,
      transportLimit: this.config.maxTransportsPerWorker,
      inflightLimit: this.config.maxInFlightRequestsPerWorker
    };
  }

  private hardSaturated(health: MediaWorkerHealth): boolean {
    const memoryBytes = health.memory?.rss ?? health.memory?.heapUsed ?? 0;
    return (
      health.activeRooms >= this.config.maxRoomsPerWorker ||
      health.activeTransports >= this.config.maxTransportsPerWorker ||
      health.inflightRequests >= this.config.maxInFlightRequestsPerWorker ||
      (this.config.hardMemoryLimitBytes !== undefined && memoryBytes >= this.config.hardMemoryLimitBytes) ||
      health.averageIpcLatencyMs >= this.config.hardIpcLatencyMs
    );
  }

  private capacityScore(health: MediaWorkerHealth): number {
    const memoryBytes = health.memory?.rss ?? health.memory?.heapUsed ?? 0;
    return Math.max(
      safeRatio(health.activeRooms, this.config.maxRoomsPerWorker),
      safeRatio(health.activeTransports, this.config.maxTransportsPerWorker),
      safeRatio(health.inflightRequests, this.config.maxInFlightRequestsPerWorker),
      this.config.softMemoryLimitBytes ? safeRatio(memoryBytes, this.config.softMemoryLimitBytes) : 0,
      safeRatio(health.averageIpcLatencyMs, this.config.softIpcLatencyMs),
      safeRatio(health.rtpPacketRate ?? 0, this.config.options.mediaWorkerSoftRtpPacketRate ?? Number.POSITIVE_INFINITY),
      safeRatio(health.rtcpPacketRate ?? 0, this.config.options.mediaWorkerSoftRtcpPacketRate ?? Number.POSITIVE_INFINITY)
    );
  }
}

function safeRatio(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return Math.max(0, value / max);
}
