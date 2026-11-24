import { DEFAULT_PAYMENT_CURRENCY, isPaymentCurrency, toMinorUnits, type PaymentCurrency } from '@native-sfu/contracts';

export interface BatchPrice {
  amountMinor: number;
  currency: PaymentCurrency;
}

/**
 * Price of a batch in integer minor units. Batches store a two-decimal
 * `feeAmount`; batches created before multi-currency support have no
 * currency and use the platform default (USD).
 */
export function batchPrice(batch: { feeAmount?: number | null; currency?: string | null }, fallback: PaymentCurrency = DEFAULT_PAYMENT_CURRENCY): BatchPrice {
  const currency = isPaymentCurrency(batch.currency) ? batch.currency : fallback;
  const fee = typeof batch.feeAmount === 'number' && Number.isFinite(batch.feeAmount) && batch.feeAmount > 0 ? batch.feeAmount : 0;
  return { amountMinor: toMinorUnits(fee, currency), currency };
}

export function paymentsEnabledFromEnv(config: { get<T>(key: string, fallback?: T): T | undefined } | undefined): boolean {
  return Boolean(config?.get<boolean>('payments.enabled', false));
}
