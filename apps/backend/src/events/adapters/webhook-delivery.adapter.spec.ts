import { WebhookDeliveryAdapter } from './webhook-delivery.adapter';

describe('WebhookDeliveryAdapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('reports successful deliveries for 2xx webhook responses', async () => {
    const adapter = new WebhookDeliveryAdapter();
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => ({
      ok: true,
      status: 204
    })) as unknown as typeof fetch;

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'succeeded',
      responseStatusCode: 204
    });
  });

  it('classifies non-2xx responses as http failures', async () => {
    const adapter = new WebhookDeliveryAdapter();
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503
    })) as unknown as typeof fetch;

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'failed',
      responseStatusCode: 503,
      errorMessage: 'Received HTTP 503',
      failureCategory: 'http',
      retryable: true
    });
  });

  it('classifies 403 responses as non-retryable auth failures', async () => {
    const adapter = new WebhookDeliveryAdapter();
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => ({
      ok: false,
      status: 403
    })) as unknown as typeof fetch;

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'failed',
      responseStatusCode: 403,
      errorMessage: 'Received HTTP 403',
      failureCategory: 'auth',
      retryable: false
    });
  });

  it('classifies aborts as timeouts', async () => {
    const adapter = new WebhookDeliveryAdapter();
    const abortError = new Error('timed out');
    abortError.name = 'AbortError';
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => {
      throw abortError;
    }) as unknown as typeof fetch;

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'timeout',
      errorMessage: 'timed out',
      failureCategory: 'timeout',
      retryable: true
    });
  });

  it('classifies unexpected fetch failures as network errors', async () => {
    const adapter = new WebhookDeliveryAdapter();
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const result = await adapter.execute(baseRequest());

    expect(result).toEqual({
      outcome: 'failed',
      errorMessage: 'socket hang up',
      failureCategory: 'network',
      retryable: true
    });
  });
});

function baseRequest() {
  return {
    adapterKind: 'webhook' as const,
    url: 'https://hooks.example.test/events',
    method: 'POST' as const,
    timeoutMs: 1000,
    headers: {
      'content-type': 'application/json'
    },
    body: '{"ok":true}'
  };
}
