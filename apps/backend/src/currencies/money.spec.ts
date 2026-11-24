import { majorToMinor, minorToMajor, formatMoney, quoteDisplayMoney, type ExchangeRateSnapshot } from '@native-sfu/contracts';

describe('currency accounting and reference conversion', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const snapshot: ExchangeRateSnapshot = { base: 'EUR', provider: 'Frankfurter', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), rates: {
    EUR: { rate: '1', date: '2026-11-24' }, USD: { rate: '1.1', date: '2026-11-24' },
    INR: { rate: '90', date: '2026-11-24' }, JPY: { rate: '160.5', date: '2026-11-24' }, KWD: { rate: '0.35', date: '2026-11-24' },
  } };
  it('preserves decimal amounts without floating-point multiplication', () => {
    expect(majorToMinor('0.29', 'USD')).toBe(29);
    expect(majorToMinor('1.234', 'KWD')).toBe(1234);
    expect(majorToMinor('1200', 'JPY')).toBe(1200);
    expect(minorToMajor(1234, 'KWD')).toBe(1.234);
  });
  it('rejects excessive precision, invalid amounts and unsafe integer amounts', () => {
    for (const value of ['1.234', '-1', 'Infinity', 'NaN', '1e10', '1000000001']) expect(() => majorToMinor(value, 'USD')).toThrow();
    expect(() => majorToMinor('1.1', 'JPY')).toThrow('0 decimal');
    expect(majorToMinor('1.000', 'JPY')).toBe(1);
  });
  it('rounds half-up once, using source and target accounting units', () => {
    expect(quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, 'JPY', snapshot, now).converted.amountMinor).toBe(161);
    expect(quoteDisplayMoney({ amountMinor: 9000, currency: 'INR' }, 'USD', snapshot, now).converted.amountMinor).toBe(110);
    expect(quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, 'KWD', snapshot, now).converted.amountMinor).toBe(350);
    expect(quoteDisplayMoney({ amountMinor: 1234, currency: 'KWD' }, 'KWD', snapshot, now).converted.amountMinor).toBe(1234);
  });
  it('rejects expired, missing and obsolete rates', () => {
    expect(() => quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, 'USD', snapshot, now + 3600000)).toThrow('expired');
    expect(() => quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, 'CAD', snapshot, now)).toThrow('unavailable');
    const stale = { ...snapshot, rates: { ...snapshot.rates, USD: { rate: '1.1', date: '2025-01-01' } } };
    expect(() => quoteDisplayMoney({ amountMinor: 100, currency: 'EUR' }, 'USD', stale, now)).toThrow('old');
  });
  it('formats zero- and three-decimal currencies without applying a cents assumption', () => {
    expect(formatMoney({ amountMinor: 1200, currency: 'JPY' }, 'en-US')).toContain('1,200');
    expect(formatMoney({ amountMinor: 1234, currency: 'KWD' }, 'en-US')).toContain('1.234');
  });
});
