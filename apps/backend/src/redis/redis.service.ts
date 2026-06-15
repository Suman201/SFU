import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  private pub!: Redis;
  private sub!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    void Promise.all([this.client.connect(), this.pub.connect(), this.sub.connect()]).catch((error: unknown) => {
      this.logger.error('Redis connection failed', error instanceof Error ? error.stack : String(error));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client?.quit(), this.pub?.quit(), this.sub?.quit()]);
  }

  get raw(): Redis {
    return this.client;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, payload);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async publish<T>(channel: string, payload: T): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(payload));
  }

  async subscribe<T>(channel: string, handler: (payload: T) => Promise<void> | void): Promise<void> {
    await this.sub.subscribe(channel);
    this.sub.on('message', (receivedChannel, message) => {
      if (receivedChannel !== channel) {
        return;
      }
      void handler(JSON.parse(message) as T);
    });
  }

  async markPresence(roomId: string, participantId: string, socketId: string): Promise<void> {
    await this.client.hset(`presence:${roomId}`, participantId, socketId);
  }

  async removePresence(roomId: string, participantId: string): Promise<void> {
    await this.client.hdel(`presence:${roomId}`, participantId);
  }
}
