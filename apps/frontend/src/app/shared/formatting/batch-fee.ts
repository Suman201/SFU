import { formatMoney, isPaymentCurrency, toMinorUnits } from '@native-sfu/contracts';

/** Display label for a batch fee stored in major units (e.g. 49.99). Batches without a currency are priced in USD. */
export function formatBatchFee(value: number | null | undefined, currency?: string | null): string {
  const amount = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'Free';
  }
  const code = isPaymentCurrency(currency) ? currency : 'USD';
  return formatMoney(toMinorUnits(amount, code), code);
}
