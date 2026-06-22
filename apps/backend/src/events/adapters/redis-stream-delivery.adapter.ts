import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  EventDeliveryAdapter,
  EventDeliveryExecutionRequest,
  EventDeliveryExecutionResult,
  RedisStreamDeliveryExecutionRequest
} from './event-delivery-adapter';

@Injectable()
export class RedisStreamDeliveryAdapter implements EventDeliveryAdapter {
  readonly kind = 'redis-stream' as const;

  constructor(private readonly redis: RedisService) {}

  async execute(request: EventDeliveryExecutionRequest): Promise<EventDeliveryExecutionResult> {
    const redisRequest = expectRedisStreamRequest(request);
    if (!redisRequest.streamKey.trim()) {
      return {
        outcome: 'failed',
        errorMessage: 'Redis stream delivery requires a non-empty streamKey',
        failureCategory: 'configuration',
        retryable: false
      };
    }
    if (redisRequest.maxLen !== undefined && redisRequest.maxLen <= 0) {
      return {
        outcome: 'failed',
        errorMessage: 'Redis stream delivery requires maxLen to be greater than 0 when provided',
        failureCategory: 'configuration',
        retryable: false
      };
    }

    let payload: unknown;
    try {
      payload = normalizePayload(redisRequest.payload);
    } catch (error) {
      return {
        outcome: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        failureCategory: 'configuration',
        retryable: false
      };
    }

    try {
      const deliveryReference = await withTimeout(
        this.redis.publishDurable(redisRequest.streamKey, payload, {
          maxLen: redisRequest.maxLen
        }),
        redisRequest.timeoutMs
      );
      if (!deliveryReference) {
        return {
          outcome: 'failed',
          errorMessage: 'Redis durable publish did not return a stream entry id',
          failureCategory: 'storage',
          retryable: true
        };
      }
      return {
        outcome: 'succeeded',
        deliveryReference
      };
    } catch (error) {
      if (error instanceof DeliveryTimeoutError) {
        return {
          outcome: 'timeout',
          errorMessage: error.message,
          failureCategory: 'timeout',
          retryable: true
        };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failure = classifyRedisFailure(errorMessage);
      return {
        outcome: 'failed',
        errorMessage,
        failureCategory: failure.failureCategory,
        retryable: failure.retryable
      };
    }
  }
}

class DeliveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis stream publish timed out after ${timeoutMs}ms`);
    this.name = 'DeliveryTimeoutError';
  }
}

function expectRedisStreamRequest(request: EventDeliveryExecutionRequest): RedisStreamDeliveryExecutionRequest {
  if (request.adapterKind !== 'redis-stream' || !request.streamKey || request.payload === undefined) {
    throw new Error(`RedisStreamDeliveryAdapter cannot execute ${request.adapterKind} requests`);
  }
  return request as RedisStreamDeliveryExecutionRequest;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new DeliveryTimeoutError(timeoutMs));
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new DeliveryTimeoutError(timeoutMs)), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch((error: unknown) => reject(error))
      .finally(() => clearTimeout(timeout));
  });
}

function normalizePayload(payload: unknown): unknown {
  const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
  return sortValue(parsedPayload);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) {
          accumulator[key] = sortValue(entry);
        }
        return accumulator;
      }, {});
  }
  return value;
}

function classifyRedisFailure(errorMessage: string): { failureCategory: EventDeliveryExecutionResult['failureCategory']; retryable: boolean } {
  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes('noauth') ||
    normalized.includes('wrongpass') ||
    normalized.includes('noperm') ||
    normalized.includes('auth failed') ||
    normalized.includes('authentication')
  ) {
    return {
      failureCategory: 'auth',
      retryable: false
    };
  }
  if (
    normalized.includes('wrongtype') ||
    normalized.includes('invalid stream') ||
    normalized.includes('stream key') ||
    normalized.includes('maxlen')
  ) {
    return {
      failureCategory: 'configuration',
      retryable: false
    };
  }
  if (
    normalized.includes('econn') ||
    normalized.includes('ehost') ||
    normalized.includes('eai_') ||
    normalized.includes('enotfound') ||
    normalized.includes('network') ||
    normalized.includes('socket') ||
    normalized.includes('connection') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('closed')
  ) {
    return {
      failureCategory: 'network',
      retryable: true
    };
  }
  return {
    failureCategory: 'storage',
    retryable: true
  };
}
