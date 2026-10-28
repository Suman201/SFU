import { invoiceTotals } from '@native-sfu/contracts';
describe('Invoice amounts', () => {
  it('calculates fractional quantities and rounds tax per line', () => {
    const result = invoiceTotals([
      {
        description: 'Session',
        quantityMilli: 1500,
        unitPriceMinor: 3333,
        taxRateBps: 1900,
      },
    ]);
    expect([result.subtotalMinor, result.taxMinor, result.totalMinor]).toEqual([
      5000, 950, 5950,
    ]);
  });
  it('groups different tax rates without combining currencies or inventing fees', () => {
    const result = invoiceTotals([
      {
        description: 'Lesson',
        quantityMilli: 2000,
        unitPriceMinor: 3500,
        taxRateBps: 2000,
      },
      {
        description: 'Meeting',
        quantityMilli: 1000,
        unitPriceMinor: 1500,
        taxRateBps: 0,
      },
    ]);
    expect(result.totalMinor).toBe(9900);
    expect(result.taxes).toEqual([
      { rateBps: 0, netMinor: 1500, taxMinor: 0 },
      { rateBps: 2000, netMinor: 7000, taxMinor: 1400 },
    ]);
  });
  it('keeps repeated small amounts exact', () => {
    const result = invoiceTotals(
      Array.from({ length: 50 }, () => ({
        description: 'Item',
        quantityMilli: 1000,
        unitPriceMinor: 10,
        taxRateBps: 2000,
      })),
    );
    expect(result.totalMinor).toBe(600);
  });
  for (const unitPriceMinor of [-1, 1.5, Infinity, NaN])
    it('rejects invalid minor-unit prices: ' + unitPriceMinor, () => {
      expect(() =>
        invoiceTotals([
          {
            description: 'Invalid',
            quantityMilli: 1000,
            unitPriceMinor,
            taxRateBps: 0,
          },
        ]),
      ).toThrow();
    });
});
