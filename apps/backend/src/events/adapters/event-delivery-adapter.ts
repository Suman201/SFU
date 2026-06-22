import type { EventDeliveryAdapterKind, EventDeliveryFailureCategory } from '@native-sfu/contracts';

export interface EventDeliveryExecutionRequest {
  adapterKind: EventDeliveryAdapterKind;
  timeoutMs: number;
  url?: string;
  method?: 'POST';
  headers?: Record<string, string>;
  body?: string;
  streamKey?: string;
  maxLen?: number;
  payload?: unknown;
}

export interface WebhookDeliveryExecutionRequest extends EventDeliveryExecutionRequest {
  adapterKind: 'webhook';
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface RedisStreamDeliveryExecutionRequest extends EventDeliveryExecutionRequest {
  adapterKind: 'redis-stream';
  streamKey: string;
  maxLen?: number;
  payload: unknown;
}

export interface EventDeliveryExecutionResult {
  outcome: 'succeeded' | 'failed' | 'timeout';
  responseStatusCode?: number;
  errorMessage?: string;
  failureCategory?: EventDeliveryFailureCategory;
  deliveryReference?: string;
  retryable?: boolean;
}

export interface EventDeliveryAdapter {
  readonly kind: EventDeliveryAdapterKind;
  execute(request: EventDeliveryExecutionRequest): Promise<EventDeliveryExecutionResult>;
}
