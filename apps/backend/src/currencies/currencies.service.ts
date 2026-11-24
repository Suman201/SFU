import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_CURRENCY, SUPPORTED_CURRENCIES, isCurrencyCode, quoteDisplayMoney, type CurrencyCatalogue, type CurrencyCode, type ExchangeRateSnapshot } from '@native-sfu/contracts';
import { RedisService } from '../redis/redis.service';

const CACHE_KEY = 'money:reference-rates:v1';
const CACHE_SECONDS = 3600;
const SNAPSHOT_SECONDS = 12 * 3600;

@Injectable()
export class CurrenciesService {
  private readonly logger = new Logger(CurrenciesService.name);
  private snapshot: ExchangeRateSnapshot | null = null;
  private refresh?: Promise<ExchangeRateSnapshot | null>;
  private nextRefreshAt = 0;
  constructor(private readonly config: ConfigService, private readonly redis: RedisService) {}

  get defaultCurrency(): CurrencyCode {
    const value = this.config.get<string>('DEFAULT_CURRENCY', DEFAULT_CURRENCY);
    return isCurrencyCode(value) ? value : DEFAULT_CURRENCY;
  }
  async catalogue(): Promise<CurrencyCatalogue> {
    return { currencies: [...SUPPORTED_CURRENCIES], defaultCurrency: this.defaultCurrency, snapshot: await this.rates() };
  }
  async rates(): Promise<ExchangeRateSnapshot | null> {
    if (this.refresh) return this.refresh;
    if (Date.now() < this.nextRefreshAt) return this.usable(this.snapshot) ? this.snapshot : null;
    this.refresh ??= this.load().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
  private usable(value: ExchangeRateSnapshot | null): value is ExchangeRateSnapshot {
    if (!value || value.provider !== 'Frankfurter' || !value.rates || value.rates.EUR?.rate !== '1') return false;
    try { quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, 'EUR', value); return true; } catch { return false; }
  }
  private async load(): Promise<ExchangeRateSnapshot | null> {
    // Back off failures; concurrent page requests share one provider request per process.
    this.nextRefreshAt = Date.now() + 60000;
    try {
      const shared = await this.redis.getJson<ExchangeRateSnapshot>(CACHE_KEY);
      if (this.usable(shared)) {
        this.snapshot = shared;
        this.nextRefreshAt = Math.min(Date.now() + CACHE_SECONDS * 1000, Date.parse(shared.expiresAt));
        return shared;
      }
    } catch { /* Reference display remains available when Redis is temporarily unavailable. */ }
    try {
      const response = await fetch('https://api.frankfurter.dev/v2/rates?base=EUR&quotes=' + SUPPORTED_CURRENCIES.filter(code => code !== 'EUR').join(','), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Exchange provider unavailable.');
      const body: unknown = await response.json();
      if (!Array.isArray(body) || body.length > 100) throw new Error('Invalid exchange response.');
      const now = Date.now();
      const rates: ExchangeRateSnapshot['rates'] = { EUR: { rate: '1', date: new Date(now).toISOString().slice(0, 10) } };
      for (const value of body as unknown[]) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        const quote = row.quote;
        if (row?.base !== 'EUR' || !isCurrencyCode(quote) || quote === 'EUR' || typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0 || row.rate > 1e9 || typeof row.date !== 'string') continue;
        const rate = row.rate.toFixed(12).replace(/\.?0+$/, '');
        const candidate: ExchangeRateSnapshot = { base: 'EUR', provider: 'Frankfurter', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + SNAPSHOT_SECONDS * 1000).toISOString(), rates: { ...rates, [quote]: { rate, date: row.date } } };
        try { quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, quote, candidate, now); rates[quote] = { rate, date: row.date }; } catch { /* Exclude stale or malformed pairs. */ }
      }
      if (Object.keys(rates).length < 2) throw new Error('No current reference rates.');
      this.snapshot = { base: 'EUR', provider: 'Frankfurter', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + SNAPSHOT_SECONDS * 1000).toISOString(), rates };
      this.nextRefreshAt = now + CACHE_SECONDS * 1000;
      try { await this.redis.setJson(CACHE_KEY, this.snapshot, CACHE_SECONDS); } catch { /* Process cache is sufficient for display. */ }
    } catch {
      this.logger.warn('Currency reference rates unavailable; displaying original price currencies.');
    }
    return this.usable(this.snapshot) ? this.snapshot : null;
  }
}
