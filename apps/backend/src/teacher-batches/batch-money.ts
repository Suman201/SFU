import { BadRequestException } from '@nestjs/common';
import { assertMoney, isCurrencyCode, majorToMinor, minorToMajor, type BatchMoneyFields, type CurrencyCode } from '@native-sfu/contracts';

interface BatchPrice extends BatchMoneyFields { feeAmount?: number }

/** Keep legacy major-unit data readable without assigning it an unproven currency. */
export function batchMoneyFields(batch: BatchPrice): BatchMoneyFields {
  if (!isCurrencyCode(batch.feeCurrency) || batch.feeMinor === undefined) return {};
  try {
    assertMoney({ amountMinor: batch.feeMinor, currency: batch.feeCurrency });
    return { feeMinor: batch.feeMinor, feeCurrency: batch.feeCurrency };
  } catch { return {}; }
}

export function batchPriceWrite(input: BatchPrice, existing?: BatchPrice): BatchPrice {
  const changed = input.feeAmount !== undefined || input.feeMinor !== undefined || input.feeCurrency !== undefined;
  if (existing && !changed) return {};
  if (existing && !existing.feeCurrency && input.feeCurrency === undefined && input.feeMinor === undefined && input.feeAmount === existing.feeAmount) return {};
  const currency = input.feeCurrency ?? existing?.feeCurrency;
  const amount = input.feeAmount ?? existing?.feeAmount ?? 0;
  if (!currency) {
    if (input.feeMinor !== undefined || amount !== 0) throw new BadRequestException('Select the price currency. Existing fees have no assumed currency.');
    return { feeAmount: 0 };
  }
  if (!isCurrencyCode(currency)) throw new BadRequestException('Unsupported price currency.');
  if (existing?.feeCurrency && currency !== existing.feeCurrency && input.feeAmount === undefined && input.feeMinor === undefined) {
    throw new BadRequestException('Enter the new price when changing its currency.');
  }
  try {
    const feeMinor = input.feeMinor ?? majorToMinor(amount, currency);
    assertMoney({ amountMinor: feeMinor, currency });
    if (input.feeMinor !== undefined && input.feeAmount !== undefined && majorToMinor(input.feeAmount, currency) !== feeMinor) {
      throw new Error('Major and minor amounts do not match.');
    }
    return { feeMinor, feeCurrency: currency as CurrencyCode, feeAmount: minorToMajor(feeMinor, currency) };
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid price.');
  }
}
