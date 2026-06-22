import { Injectable } from '@nestjs/common';
import type { EventDeliveryAdapterKind } from '@native-sfu/contracts';
import { EventDeliveryAdapter } from './event-delivery-adapter';
import { RedisStreamDeliveryAdapter } from './redis-stream-delivery.adapter';
import { WebhookDeliveryAdapter } from './webhook-delivery.adapter';

@Injectable()
export class EventDeliveryAdapterRegistry {
  private readonly adapters = new Map<EventDeliveryAdapterKind, EventDeliveryAdapter>();

  constructor(webhookAdapter: WebhookDeliveryAdapter, redisStreamAdapter: RedisStreamDeliveryAdapter) {
    for (const adapter of [webhookAdapter, redisStreamAdapter]) {
      this.adapters.set(adapter.kind, adapter);
    }
  }

  get(kind: EventDeliveryAdapterKind): EventDeliveryAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`Unknown event delivery adapter: ${kind}`);
    }
    return adapter;
  }

  registeredKinds(): EventDeliveryAdapterKind[] {
    return [...this.adapters.keys()];
  }
}
