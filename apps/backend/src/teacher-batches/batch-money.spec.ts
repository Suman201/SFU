import { batchMoneyFields, batchPriceWrite } from './batch-money';

describe('explicit batch price migration', () => {
  it('leaves unknown legacy currencies unset and unchanged on unrelated edits', () => {
    expect(batchMoneyFields({ feeAmount: 1200 })).toEqual({});
    expect(batchPriceWrite({}, { feeAmount: 1200 })).toEqual({});
    expect(batchPriceWrite({ feeAmount: 1200 }, { feeAmount: 1200 })).toEqual({});
    expect(() => batchPriceWrite({ feeAmount: 1400 }, { feeAmount: 1200 })).toThrow('Select');
  });
  it('lets an owner explicitly identify the legacy currency, without conversion', () => {
    expect(batchPriceWrite({ feeCurrency: 'INR' }, { feeAmount: 1200 })).toEqual({ feeAmount: 1200, feeMinor: 120000, feeCurrency: 'INR' });
  });
  it('stores exact minor units and compatibility amounts for all decimal scales', () => {
    expect(batchPriceWrite({ feeMinor: 1234, feeCurrency: 'KWD' })).toEqual({ feeAmount: 1.234, feeMinor: 1234, feeCurrency: 'KWD' });
    expect(batchPriceWrite({ feeAmount: 1500, feeCurrency: 'JPY' }).feeMinor).toBe(1500);
    expect(() => batchPriceWrite({ feeAmount: 1.5, feeCurrency: 'JPY' })).toThrow('decimal');
  });
  it('requires currency on new paid prices and rejects inconsistent representations', () => {
    expect(() => batchPriceWrite({ feeAmount: 1200 })).toThrow('currency');
    expect(() => batchPriceWrite({ feeMinor: 120, feeAmount: 2, feeCurrency: 'USD' })).toThrow('match');
    expect(() => batchPriceWrite({ feeCurrency: 'USD' }, { feeMinor: 100, feeCurrency: 'EUR', feeAmount: 1 })).toThrow('new price');
    expect(() => batchPriceWrite({ feeMinor: -1, feeCurrency: 'USD' })).toThrow();
  });
});
