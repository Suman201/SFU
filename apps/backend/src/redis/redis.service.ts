import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface DurableStreamMessageMeta {
  stream: string;
  id: string;
  replayed: boolean;
  consumerKey: string;
}

interface DurableConsumerHandle {
  active: boolean;
  client: Redis;
  loop?: Promise<void>;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  private pub!: Redis;
  private sub!: Redis;
  private readonly durableConsumers = new Map<string, DurableConsumerHandle>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.getOrThrow<string>('redis.url');
    this.client = this.createClient(url, 'client');
    this.pub = this.createClient(url, 'pub');
    this.sub = this.createClient(url, 'sub');
    try {
      await Promise.all([this.client.connect(), this.pub.connect(), this.sub.connect()]);
      this.logger.log('Redis clients connected');
    } catch (error: unknown) {
      this.logger.error('Redis connection failed', error instanceof Error ? error.stack : String(error));
      if (this.config.get<boolean>('redis.required', true)) {
        throw error;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const consumer of this.durableConsumers.values()) {
      consumer.active = false;
    }
    await Promise.allSettled([
      this.client?.quit(),
      this.pub?.quit(),
      this.sub?.quit(),
      ...[...this.durableConsumers.values()].map((consumer) => consumer.client.quit())
    ]);
    this.durableConsumers.clear();
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

  async publishDurable<T>(stream: string, payload: T, options: { maxLen?: number } = {}): Promise<string> {
    if (options.maxLen && options.maxLen > 0) {
      return (await this.client.xadd(stream, 'MAXLEN', '~', options.maxLen, '*', 'json', JSON.stringify(payload))) ?? '';
    }
    return (await this.client.xadd(stream, '*', 'json', JSON.stringify(payload))) ?? '';
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

  async consumeDurable<T>(
    stream: string,
    consumerKey: string,
    handler: (payload: T, meta: DurableStreamMessageMeta) => Promise<void> | void,
    options: {
      batchSize?: number;
      blockMs?: number;
      onError?: (error: unknown, phase: 'read' | 'handler') => void;
    } = {}
  ): Promise<void> {
    const handleKey = `${stream}:${consumerKey}`;
    if (this.durableConsumers.has(handleKey)) {
      return;
    }
    const url = this.config.getOrThrow<string>('REDIS_URL');
    const consumer: DurableConsumerHandle = {
      active: true,
      client: new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 })
    };
    this.durableConsumers.set(handleKey, consumer);
    await consumer.client.connect();

    const offsetKey = durableOffsetKey(stream, consumerKey);
    const storedOffset = await this.client.get(offsetKey);
    let lastId = storedOffset ?? (await this.latestStreamId(stream)) ?? '0-0';
    let replayUntilId = storedOffset ? (await this.latestStreamId(stream)) ?? storedOffset : undefined;
    const batchSize = Math.max(1, options.batchSize ?? 16);
    const blockMs = Math.max(250, options.blockMs ?? 5000);

    consumer.loop = (async () => {
      while (consumer.active) {
        let response: Array<[string, Array<[string, string[]]>]> | null = null;
        try {
          response = await consumer.client.xread('COUNT', batchSize, 'BLOCK', blockMs, 'STREAMS', stream, lastId);
        } catch (error) {
          if (!consumer.active) {
            break;
          }
          options.onError?.(error, 'read');
          this.logger.warn(`Durable Redis stream read failed for ${stream}:${consumerKey}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!response) {
          continue;
        }

        let shouldRetryCurrentMessage = false;
        for (const [, entries] of response) {
          for (const [id, fields] of entries) {
            const payloadJson = fieldValue(fields, 'json');
            if (!payloadJson) {
              lastId = id;
              await this.client.set(offsetKey, id);
              continue;
            }
            try {
              await handler(JSON.parse(payloadJson) as T, {
                stream,
                id,
                replayed: replayUntilId ? compareStreamIds(id, replayUntilId) <= 0 : false,
                consumerKey
              });
            } catch (error) {
              options.onError?.(error, 'handler');
              shouldRetryCurrentMessage = true;
              break;
            }
            lastId = id;
            if (replayUntilId && compareStreamIds(id, replayUntilId) >= 0) {
              replayUntilId = undefined;
            }
            await this.client.set(offsetKey, id);
          }
          if (shouldRetryCurrentMessage) {
            break;
          }
        }
      }
    })().finally(() => {
      this.durableConsumers.delete(handleKey);
    });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async markPresence(roomId: string, participantId: string, socketId: string): Promise<void> {
    await this.client.hset(`presence:${roomId}`, participantId, socketId);
  }

  async removePresence(roomId: string, participantId: string): Promise<void> {
    await this.client.hdel(`presence:${roomId}`, participantId);
  }

  async ping(): Promise<'PONG'> {
    return (await this.client.ping()) as 'PONG';
  }

  private async latestStreamId(stream: string): Promise<string | undefined> {
    const entries = await this.client.xrevrange(stream, '+', '-', 'COUNT', 1);
    return entries[0]?.[0];
  }

  private createClient(url: string, name: string): Redis {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectionName: `educonnect-${name}`
    });
    client.on('error', (error) => this.logger.error(`Redis ${name} error`, error.stack));
    client.on('reconnecting', () => this.logger.warn(`Redis ${name} reconnecting`));
    client.on('ready', () => this.logger.log(`Redis ${name} ready`));
    return client;
  }
}

function durableOffsetKey(stream: string, consumerKey: string): string {
  return `sfu:stream-offset:${stream}:${consumerKey}`;
}

function fieldValue(fields: string[], key: string): string | undefined {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === key) {
      return fields[index + 1];
    }
  }
  return undefined;
}

function compareStreamIds(left: string, right: string): number {
  const [leftMs = 0, leftSeq = 0] = left.split('-').map((value) => Number(value));
  const [rightMs = 0, rightSeq = 0] = right.split('-').map((value) => Number(value));
  if (leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  return leftSeq - rightSeq;
}
