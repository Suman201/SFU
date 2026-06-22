import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ServerToClientEvents } from '@native-sfu/contracts';
import { MetricsService } from '../metrics/metrics.service';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { RedisService } from '../redis/redis.service';

const ROOM_SIGNAL_STREAM = 'sfu:room-signals';
const ROOM_SIGNAL_DEDUP_TTL_SECONDS = 300;

export interface RoomSignalEnvelope {
  eventId: string;
  sourceNodeId: string;
  roomId: string;
  event: keyof ServerToClientEvents;
  payload: unknown[];
  target?: RoomSignalTarget;
}

export interface RoomSignalTarget {
  socketIds?: string[];
  participantIds?: string[];
  userIds?: string[];
  nodeIds?: string[];
}

@Injectable()
export class RoomSignalService implements OnModuleInit {
  private readonly listeners = new Set<(envelope: RoomSignalEnvelope) => void>();

  constructor(
    private readonly redis: RedisService,
    private readonly registry: NodeRegistryService,
    private readonly metrics: MetricsService
  ) {}

  async onModuleInit(): Promise<void> {
    const consumerKey = `room-signals:${this.registry.localNodeId()}`;
    await this.redis.consumeDurable<RoomSignalEnvelope>(
      ROOM_SIGNAL_STREAM,
      consumerKey,
      async (envelope, meta) => {
        if (meta.replayed) {
          this.metrics.controlPlaneReplayMessages.labels('room_signals').inc();
        }
        if (envelope.sourceNodeId === this.registry.localNodeId()) {
          this.metrics.controlPlaneDuplicateSuppressions.labels('room_signals', 'local_echo').inc();
          return;
        }
        const accepted = await this.redis.setIfAbsent(
          roomSignalDedupKey(this.registry.localNodeId(), envelope.eventId),
          meta.id,
          ROOM_SIGNAL_DEDUP_TTL_SECONDS
        );
        if (!accepted) {
          this.metrics.controlPlaneDuplicateSuppressions.labels('room_signals', 'event_id').inc();
          return;
        }
        for (const listener of this.listeners) {
          listener(envelope);
        }
        this.metrics.controlPlaneMessagesDelivered.labels('room_signals').inc();
      },
      {
        onError: (_error, phase) => {
          this.metrics.controlPlaneConsumeFailures.labels('room_signals', phase).inc();
        }
      }
    );
  }

  onSignal(listener: (envelope: RoomSignalEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(roomId: string, event: keyof ServerToClientEvents, ...payload: unknown[]): Promise<void> {
    return this.publishEnvelope(roomId, event, undefined, ...payload);
  }

  async publishTargeted(roomId: string, target: RoomSignalTarget, event: keyof ServerToClientEvents, ...payload: unknown[]): Promise<void> {
    return this.publishEnvelope(roomId, event, target, ...payload);
  }

  private async publishEnvelope(roomId: string, event: keyof ServerToClientEvents, target: RoomSignalTarget | undefined, ...payload: unknown[]): Promise<void> {
    try {
      await this.redis.publishDurable(ROOM_SIGNAL_STREAM, {
        eventId: randomUUID(),
        sourceNodeId: this.registry.localNodeId(),
        roomId,
        event,
        payload,
        ...(target ? { target } : {})
      } satisfies RoomSignalEnvelope);
      this.metrics.controlPlaneMessagesPublished.labels('room_signals').inc();
    } catch (error) {
      this.metrics.controlPlanePublishFailures.labels('room_signals').inc();
      throw error;
    }
  }
}

function roomSignalDedupKey(nodeId: string, eventId: string): string {
  return `sfu:room-signal:dedup:${nodeId}:${eventId}`;
}
