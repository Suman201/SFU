import { Injectable } from '@nestjs/common';
import {
  EventDeliveryAdapter,
  EventDeliveryExecutionRequest,
  EventDeliveryExecutionResult,
  WebhookDeliveryExecutionRequest
} from './event-delivery-adapter';

@Injectable()
export class WebhookDeliveryAdapter implements EventDeliveryAdapter {
  readonly kind = 'webhook' as const;

  async execute(request: EventDeliveryExecutionRequest): Promise<EventDeliveryExecutionResult> {
    const webhookRequest = expectWebhookRequest(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhookRequest.timeoutMs);
    try {
      const response = await fetch(webhookRequest.url, {
        method: webhookRequest.method,
        headers: webhookRequest.headers,
        body: webhookRequest.body,
        signal: controller.signal
      });
      if (!response.ok) {
        const classification = classifyWebhookFailure(response.status);
        return {
          outcome: 'failed',
          responseStatusCode: response.status,
          errorMessage: `Received HTTP ${response.status}`,
          failureCategory: classification.failureCategory,
          retryable: classification.retryable
        };
      }
      return {
        outcome: 'succeeded',
        responseStatusCode: response.status
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          outcome: 'timeout',
          errorMessage: error.message,
          failureCategory: 'timeout',
          retryable: true
        };
      }
      return {
        outcome: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        failureCategory: 'network',
        retryable: true
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function expectWebhookRequest(request: EventDeliveryExecutionRequest): WebhookDeliveryExecutionRequest {
  if (
    request.adapterKind !== 'webhook' ||
    !request.url ||
    !request.method ||
    !request.headers ||
    request.body === undefined
  ) {
    throw new Error(`WebhookDeliveryAdapter cannot execute ${request.adapterKind} requests`);
  }
  return request as WebhookDeliveryExecutionRequest;
}

function classifyWebhookFailure(status: number): { failureCategory: EventDeliveryExecutionResult['failureCategory']; retryable: boolean } {
  if (status === 401 || status === 403) {
    return {
      failureCategory: 'auth',
      retryable: false
    };
  }
  if (status === 429) {
    return {
      failureCategory: 'throttled',
      retryable: true
    };
  }
  return {
    failureCategory: 'http',
    retryable: status === 408 || status === 425 || status >= 500
  };
}
