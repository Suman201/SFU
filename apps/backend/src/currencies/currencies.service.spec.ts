import { ConfigService } from '@nestjs/config';
import { CurrenciesService } from './currencies.service';
import { RedisService } from '../redis/redis.service';

describe('server-managed reference rates', () => {
  const redis = { getJson: jest.fn(), setJson: jest.fn() };
  const fetchMock = jest.fn();
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = fetchMock;
    fetchMock.mockReset(); redis.getJson.mockReset().mockResolvedValue(null); redis.setJson.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { global.fetch = originalFetch; });
  function service() { return new CurrenciesService(new ConfigService({ DEFAULT_CURRENCY: 'INR' }), redis as unknown as RedisService); }
  function response() { return { ok: true, json: async () => [
    { base: 'EUR', quote: 'USD', date: new Date().toISOString().slice(0, 10), rate: 1.1 },
    { base: 'EUR', quote: 'INR', date: '2020-01-01', rate: 90 },
    { base: 'EUR', quote: 'JPY', date: new Date().toISOString().slice(0, 10), rate: -1 },
  ] }; }
  it('single-flights requests and caches only current, validated provider rates', async () => {
    fetchMock.mockResolvedValue(response());
    const api = service();
    const [a, b] = await Promise.all([api.catalogue(), api.catalogue()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.defaultCurrency).toBe('INR');
    expect(a.snapshot?.rates.USD?.rate).toBe('1.1');
    expect(a.snapshot?.rates.INR).toBeUndefined();
    expect(a.snapshot?.rates.JPY).toBeUndefined();
    await api.catalogue(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalled();
  });
  it('returns no invented conversion during a cold provider outage and backs off', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const api = service();
    expect((await api.catalogue()).snapshot).toBeNull();
    expect((await api.catalogue()).snapshot).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reuses the Redis snapshot across backend processes', async () => {
    fetchMock.mockResolvedValue(response());
    const snapshot = (await service().catalogue()).snapshot;
    redis.getJson.mockResolvedValue(snapshot);
    fetchMock.mockClear();
    expect((await service().catalogue()).snapshot).toEqual(snapshot);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
