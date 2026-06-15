export interface PacketPacingQueueOptions {
  id: string;
  targetBitrateBps: number;
  maxQueueBytes?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, timeoutMs: number) => unknown;
  onQueueDepth?: (snapshot: PacketPacingQueueSnapshot) => void;
}

export interface PacketPacingQueueSnapshot {
  id: string;
  queuedPackets: number;
  queuedBytes: number;
  maxQueueBytes: number;
  targetBitrateBps: number;
  sentPackets: number;
  sentBytes: number;
  droppedPackets: number;
  queueDelayMs: number;
}

interface QueuedPacket {
  size: number;
  queuedAt: number;
  send: () => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PacketPacingQueue {
  private readonly queue: QueuedPacket[] = [];
  private queuedBytes = 0;
  private nextSendAt = 0;
  private draining = false;
  private sentPackets = 0;
  private sentBytes = 0;
  private droppedPackets = 0;
  private targetBitrateBps: number;

  constructor(private readonly options: PacketPacingQueueOptions) {
    this.targetBitrateBps = Math.max(1, options.targetBitrateBps);
  }

  enqueue(size: number, send: () => Promise<void>): Promise<void> {
    const normalizedSize = Math.max(0, size);
    const maxQueueBytes = this.options.maxQueueBytes ?? 2_000_000;
    if (this.queuedBytes + normalizedSize > maxQueueBytes) {
      this.droppedPackets += 1;
      const error = new Error(`Pacing queue ${this.options.id} exceeded ${maxQueueBytes} bytes`);
      this.emitDepth();
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        size: normalizedSize,
        queuedAt: this.now(),
        send,
        resolve,
        reject
      });
      this.queuedBytes += normalizedSize;
      this.emitDepth();
      if (!this.draining) {
        void this.drain();
      }
    });
  }

  updateTargetBitrate(targetBitrateBps: number): void {
    this.targetBitrateBps = Math.max(1, Math.floor(targetBitrateBps));
    this.emitDepth();
  }

  snapshot(): PacketPacingQueueSnapshot {
    const head = this.queue[0];
    return {
      id: this.options.id,
      queuedPackets: this.queue.length,
      queuedBytes: this.queuedBytes,
      maxQueueBytes: this.options.maxQueueBytes ?? 2_000_000,
      targetBitrateBps: this.targetBitrateBps,
      sentPackets: this.sentPackets,
      sentBytes: this.sentBytes,
      droppedPackets: this.droppedPackets,
      queueDelayMs: head ? Math.max(0, this.now() - head.queuedAt) : 0
    };
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.queuedBytes -= item.size;
        const now = this.now();
        const waitMs = Math.max(0, this.nextSendAt - now);
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
        try {
          await item.send();
          this.sentPackets += 1;
          this.sentBytes += item.size;
          const sendDurationMs = (item.size * 8 * 1000) / this.targetBitrateBps;
          this.nextSendAt = Math.max(this.now(), this.nextSendAt) + sendDurationMs;
          item.resolve();
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.emitDepth();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private emitDepth(): void {
    this.options.onQueueDepth?.(this.snapshot());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const schedule = this.options.setTimeout ?? setTimeout;
      schedule(() => resolve(), timeoutMs);
    });
  }
}
