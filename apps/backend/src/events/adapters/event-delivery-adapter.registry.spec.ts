import type { RedisService } from '../../redis/redis.service';
import { EventDeliveryAdapterRegistry } from './event-delivery-adapter.registry';
import { RedisStreamDeliveryAdapter } from './redis-stream-delivery.adapter';
import { WebhookDeliveryAdapter } from './webhook-delivery.adapter';

describe('EventDeliveryAdapterRegistry', () => {
  it('registers both webhook and redis-stream adapters', () => {
    const registry = createRegistry();

    expect(registry.registeredKinds()).toEqual(['webhook', 'redis-stream']);
    expect(registry.get('webhook')).toBeInstanceOf(WebhookDeliveryAdapter);
    expect(registry.get('redis-stream')).toBeInstanceOf(RedisStreamDeliveryAdapter);
  });

  it('throws when an unknown adapter kind is requested', () => {
    const registry = createRegistry();

    expect(() => registry.get('unknown' as never)).toThrow('Unknown event delivery adapter: unknown');
  });
});

function createRegistry() {
  const redis = {
    publishDurable: jest.fn()
  } as unknown as RedisService;

  return new EventDeliveryAdapterRegistry(new WebhookDeliveryAdapter(), new RedisStreamDeliveryAdapter(redis));
}
