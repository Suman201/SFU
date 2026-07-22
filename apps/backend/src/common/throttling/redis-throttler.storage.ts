import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../../redis/redis.service';

const INCREMENT_SCRIPT = `
local countKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local existingBlockTtl = redis.call('PTTL', blockKey)
if existingBlockTtl > 0 then
  local blockedCount = tonumber(redis.call('GET', countKey) or limit + 1)
  local countTtl = redis.call('PTTL', countKey)
  return {blockedCount, math.max(countTtl, 0), 1, existingBlockTtl}
end

local count = redis.call('INCR', countKey)
if count == 1 then
  redis.call('PEXPIRE', countKey, ttl)
end
local countTtl = redis.call('PTTL', countKey)

if count > limit then
  local effectiveBlockDuration = blockDuration > 0 and blockDuration or math.max(countTtl, ttl)
  redis.call('SET', blockKey, '1', 'PX', effectiveBlockDuration)
  return {count, math.max(countTtl, 0), 1, effectiveBlockDuration}
end

return {count, math.max(countTtl, 0), 0, 0}
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const prefix = `sfu:throttle:${throttlerName}:${key}`;
    const result = await this.redis.raw.eval(
      INCREMENT_SCRIPT,
      2,
      `${prefix}:count`,
      `${prefix}:blocked`,
      Math.max(1, Math.floor(ttl)),
      Math.max(1, Math.floor(limit)),
      Math.max(1, Math.floor(blockDuration))
    ) as [number, number, number, number];

    return {
      totalHits: Number(result[0] ?? 0),
      timeToExpire: millisecondsToSeconds(result[1]),
      isBlocked: Number(result[2] ?? 0) === 1,
      timeToBlockExpire: millisecondsToSeconds(result[3])
    };
  }
}

function millisecondsToSeconds(value: number | undefined): number {
  return Math.max(0, Math.ceil(Number(value ?? 0) / 1000));
}
