export function formatBatchFee(value: number | null | undefined): string {
  const amount = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'Free';
  }
  return `Fee ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
