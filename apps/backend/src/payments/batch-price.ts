import { BadRequestException } from '@nestjs/common';
import { assertMoney, isPaymentCurrency, majorToMinor, type BatchMoneyFields, type PaymentCurrency } from '@native-sfu/contracts';

export interface BatchPrice { amountMinor: number; currency: PaymentCurrency }

/** Never infer a charge currency from a display/default currency. */
export function batchPrice(batch: BatchMoneyFields & { feeAmount?: number | null; currency?: string | null }, _fallback?: PaymentCurrency): BatchPrice {
  const code = batch.feeCurrency ?? batch.currency;
  if (!isPaymentCurrency(code)) throw new BadRequestException('Set an explicit supported payment currency on this class before collecting payment.');
  const amountMinor = batch.feeMinor ?? majorToMinor(batch.feeAmount ?? 0, code);
  assertMoney({ amountMinor, currency: code });
  return { amountMinor, currency: code };
}

export function paymentsEnabledFromEnv(config: { get<T>(key: string, fallback?: T): T | undefined } | undefined): boolean {
  return Boolean(config?.get<boolean>('payments.enabled', false));
}
