import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  it('returns an atomic cross-node throttle record from Redis', async () => {
    const evaluate = jest.fn(async (..._args: unknown[]) => [6, 59_100, 1, 30_100]);
    const storage = new RedisThrottlerStorage({ raw: { eval: evaluate } } as never);

    const result = await storage.increment('request-key', 60_000, 5, 30_000, 'default');

    const call = evaluate.mock.calls[0] ?? [];
    expect(String(call[0])).toContain("redis.call('INCR', countKey)");
    expect(call.slice(1)).toEqual([
      2,
      'sfu:throttle:default:request-key:count',
      'sfu:throttle:default:request-key:blocked',
      60_000,
      5,
      30_000
    ]);
    expect(result).toEqual({
      totalHits: 6,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 31
    });
  });
});
