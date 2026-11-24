/** ISO 4217 accounting units. Gateway-specific charge/payout rules belong in its adapter. */
export const CURRENCY_DECIMALS = {
  EUR: 2, GBP: 2, USD: 2, INR: 2, AUD: 2, CAD: 2, NZD: 2,
  CHF: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, RON: 2,
  AED: 2, SAR: 2, SGD: 2, HKD: 2, CNY: 2, BRL: 2, MXN: 2, ZAR: 2,
  JPY: 0, KRW: 0, KWD: 3, BHD: 3,
} as const;
export type CurrencyCode = keyof typeof CURRENCY_DECIMALS;
export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_DECIMALS) as CurrencyCode[];
export const DEFAULT_CURRENCY: CurrencyCode = 'EUR';
export const MAX_MONEY_MINOR = 100_000_000_000;
export interface Money { amountMinor: number; currency: CurrencyCode }
export interface BatchMoneyFields { feeMinor?: number; feeCurrency?: CurrencyCode }
export interface ExchangeRateSnapshot {
  base: 'EUR';
  provider: 'Frankfurter';
  fetchedAt: string;
  expiresAt: string;
  rates: Partial<Record<CurrencyCode, { rate: string; date: string }>>;
}
export interface CurrencyCatalogue {
  currencies: CurrencyCode[];
  defaultCurrency: CurrencyCode;
  snapshot: ExchangeRateSnapshot | null;
}
export interface DisplayMoneyQuote {
  original: Money;
  converted: Money;
  indicative: true;
  provider: string;
  rateDate: string;
  expiresAt: string;
}
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, value);
}
export function currencyScale(currency: CurrencyCode): number {
  if (!isCurrencyCode(currency)) throw new Error('Unsupported currency.');
  return 10 ** CURRENCY_DECIMALS[currency];
}
export function assertMoney(value: Money): void {
  currencyScale(value.currency);
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || value.amountMinor > MAX_MONEY_MINOR) {
    throw new Error('Invalid money amount.');
  }
}
/** Parse decimals exactly; excess precision is rejected rather than silently rounded. */
export function majorToMinor(value: string | number, currency: CurrencyCode): number {
  const scale = currencyScale(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) throw new Error('Enter a non-negative decimal amount.');
  const decimals = CURRENCY_DECIMALS[currency];
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) throw new Error(`${currency} supports ${decimals} decimal places.`);
  const minor = BigInt(match[1]!) * BigInt(scale) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (minor > BigInt(MAX_MONEY_MINOR)) throw new Error('Money amount is too large.');
  return Number(minor);
}
export function minorToMajor(amountMinor: number, currency: CurrencyCode): number {
  assertMoney({ amountMinor, currency });
  return amountMinor / currencyScale(currency);
}
export function formatMoney(value: Money, locale?: string): string {
  assertMoney(value);
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: value.currency,
    minimumFractionDigits: CURRENCY_DECIMALS[value.currency],
    maximumFractionDigits: CURRENCY_DECIMALS[value.currency],
  }).format(minorToMajor(value.amountMinor, value.currency));
}
export function formatMoneyWithCode(value: Money, locale?: string): string {
  const formatted = formatMoney(value, locale);
  return formatted.includes(value.currency) ? formatted : `${formatted} ${value.currency}`;
}
function rateFraction(rate: string): [bigint, bigint] {
  if (!/^\d+(?:\.\d{1,12})?$/.test(rate) || !Number.isFinite(Number(rate)) || Number(rate) <= 0 || Number(rate) > 1e9) {
    throw new Error('Invalid exchange rate.');
  }
  const [whole, fraction = ''] = rate.split('.');
  return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
}
/** Reference conversion only. Never use browser quotes to authorise a payment. */
export function quoteDisplayMoney(original: Money, target: CurrencyCode, snapshot: ExchangeRateSnapshot, now = Date.now()): DisplayMoneyQuote {
  assertMoney(original);
  currencyScale(target);
  if (snapshot.base !== 'EUR' || !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= now) {
    throw new Error('Exchange rates have expired.');
  }
  const source = snapshot.rates[original.currency];
  const destination = snapshot.rates[target];
  if (!source || !destination) throw new Error('Exchange rate unavailable.');
  for (const entry of [source, destination]) {
    const date = Date.parse(entry.date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(date) || date > now + 86400000 || now - date > 7 * 86400000) {
      throw new Error('Exchange reference date is unavailable or too old.');
    }
  }
  const [sn, sd] = rateFraction(source.rate);
  const [tn, td] = rateFraction(destination.rate);
  const numerator = BigInt(original.amountMinor) * tn * sd * BigInt(currencyScale(target));
  const denominator = sn * td * BigInt(currencyScale(original.currency));
  const rounded = (numerator * 2n + denominator) / (2n * denominator);
  const converted: Money = { amountMinor: Number(rounded), currency: target };
  assertMoney(converted);
  return { original: { ...original }, converted, indicative: true, provider: snapshot.provider,
    rateDate: source.date < destination.date ? source.date : destination.date, expiresAt: snapshot.expiresAt };
}
