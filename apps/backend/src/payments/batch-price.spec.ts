import { batchPrice } from './batch-price';

describe('payment checkout price after multi-currency merge', () => {
  it('uses authoritative minor units and the original charge currency', () => {
    expect(batchPrice({ feeAmount: 1, feeMinor: 12345, feeCurrency: 'USD' })).toEqual({ amountMinor: 12345, currency: 'USD' });
    expect(batchPrice({ feeMinor: 500, feeCurrency: 'INR' })).toEqual({ amountMinor: 500, currency: 'INR' });
  });
  it('never assigns USD to a legacy amount without an explicit currency', () => {
    expect(() => batchPrice({ feeAmount: 25 }, 'USD')).toThrow('explicit supported payment currency');
  });
  it('preserves a registered EUR price independently of checkout gateway support', () => {
    expect(batchPrice({ feeMinor: 2500, feeCurrency: 'EUR' }, 'USD')).toEqual({ amountMinor: 2500, currency: 'EUR' });
    expect(() => batchPrice({ feeMinor: 2500, feeCurrency: 'ZZZ' as never }, 'USD')).toThrow('explicit supported payment currency');
  });
  it('reads an explicitly tagged legacy payment price without guessing', () => {
    expect(batchPrice({ feeAmount: 19.99, currency: 'USD' })).toEqual({ amountMinor: 1999, currency: 'USD' });
  });
});
