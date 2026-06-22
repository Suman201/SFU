import type { RedisService } from '../../redis/redis.service';
import type { RedisStreamDeliveryExecutionRequest } from './event-delivery-adapter';
import { RedisStreamDeliveryAdapter } from './redis-stream-delivery.adapter';

describe('RedisStreamDeliveryAdapter', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('publishes a stable payload to the configured durable stream and returns the stream entry id', async () => {
    const redis = createRedisServiceMock(async () => '1719036300000-0');
    const adapter = createAdapter(redis);

    const result = await adapter.execute(
      baseRequest({
        payload: {
          timestamp: '2026-06-22T10:45:00.000Z',
          nested: {
            z: 3,
            a: {
              d: 4,
              b: 2
            }
          },
          deliveryId: 'delivery-1',
          attemptNumber: 2
        }
      })
    );

    expect(result).toEqual({
      outcome: 'succeeded',
      deliveryReference: '1719036300000-0'
    });
    expect(redis.publishDurable).toHaveBeenCalledWith(
      'sfu:events:deliveries',
      publishedPayload(redis),
      {
        maxLen: 1024
      }
    );
    expect(JSON.stringify(publishedPayload(redis))).toBe(
      '{"attemptNumber":2,"deliveryId":"delivery-1","nested":{"a":{"b":2,"d":4},"z":3},"timestamp":"2026-06-22T10:45:00.000Z"}'
    );
  });

  it('accepts JSON string payloads and normalizes them before publishing', async () => {
    const redis = createRedisServiceMock(async () => '1719036300001-0');
    const adapter = createAdapter(redis);

    await adapter.execute(
      baseRequest({
        payload: '{"z":1,"a":{"d":4,"b":2}}'
      })
    );

    expect(JSON.stringify(publishedPayload(redis))).toBe('{"a":{"b":2,"d":4},"z":1}');
  });

  it('treats empty stream keys as non-retryable configuration failures', async () => {
    const redis = createRedisServiceMock(async () => 'unused');
    const adapter = createAdapter(redis);

    const result = await adapter.execute(
      baseRequest({
        streamKey: '   '
      })
    );

    expect(result).toEqual({
      outcome: 'failed',
      errorMessage: 'Redis stream delivery requires a non-empty streamKey',
      failureCategory: 'configuration',
      retryable: false
    });
    expect(redis.publishDurable).not.toHaveBeenCalled();
  });

  it('classifies publish timeouts as retryable timeout failures', async () => {
    jest.useFakeTimers();
    const redis = createRedisServiceMock(async () => new Promise<string>(() => undefined));
    const adapter = createAdapter(redis);

    const resultPromise = adapter.execute(
      baseRequest({
        timeoutMs: 50
      })
    );

    await jest.advanceTimersByTimeAsync(50);

    expect(await resultPromise).toEqual({
      outcome: 'timeout',
      errorMessage: 'Redis stream publish timed out after 50ms',
      failureCategory: 'timeout',
      retryable: true
    });
  });

  it('classifies authentication failures as non-retryable auth errors', async () => {
    const redis = createRedisServiceMock(async () => {
      throw new Error('NOAUTH Authentication required.');
    });
    const adapter = createAdapter(redis);

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'failed',
      errorMessage: 'NOAUTH Authentication required.',
      failureCategory: 'auth',
      retryable: false
    });
  });

  it('classifies missing stream ids as retryable storage failures', async () => {
    const redis = createRedisServiceMock(async () => '');
    const adapter = createAdapter(redis);

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'failed',
      errorMessage: 'Redis durable publish did not return a stream entry id',
      failureCategory: 'storage',
      retryable: true
    });
  });
});

function baseRequest(overrides: Partial<RedisStreamDeliveryExecutionRequest> = {}): RedisStreamDeliveryExecutionRequest {
  return {
    ...defaultRequest(),
    ...overrides
  };
}

function defaultRequest(): RedisStreamDeliveryExecutionRequest {
  return {
    adapterKind: 'redis-stream' as const,
    streamKey: 'sfu:events:deliveries',
    maxLen: 1024,
    timeoutMs: 1000,
    payload: {
      deliveryId: 'delivery-1',
      attemptNumber: 1
    }
  };
}

function createRedisServiceMock(implementation: RedisService['publishDurable']) {
  return {
    publishDurable: jest.fn(implementation)
  } as {
    publishDurable: jest.MockedFunction<RedisService['publishDurable']>;
  };
}

function createAdapter(redis: { publishDurable: RedisService['publishDurable'] }): RedisStreamDeliveryAdapter {
  return new RedisStreamDeliveryAdapter(redis as unknown as RedisService);
}

function publishedPayload(redis: { publishDurable: { mock: { calls: unknown[][] } } }): unknown {
  return redis.publishDurable.mock.calls[0]?.[1];
}
