import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator, MongooseHealthIndicator } from '@nestjs/terminus';
import { RedisService } from '../redis/redis.service';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly redis: RedisService
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024)
    ]);
  }

  @Get('db')
  @HealthCheck()
  db() {
    return this.health.check([() => this.mongoose.pingCheck('mongodb')]);
  }

  @Get('redis')
  @HealthCheck()
  redisHealth() {
    return this.health.check([
      async () => {
        await this.redis.ping();
        return { redis: { status: 'up' } };
      }
    ]);
  }
}
