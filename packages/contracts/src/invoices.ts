export const INVOICE_CURRENCIES = [
  'EUR',
  'GBP',
  'USD',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
] as const;
export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];
export interface InvoiceParty {
  name: string;
  email: string;
  address: string;
  countryCode: string;
  vatNumber: string;
}
export interface InvoiceSeller extends InvoiceParty {
  registrationNumber: string;
  paymentInstructions: string;
}
export interface InvoiceSettings {
  version: number;
  seller: InvoiceSeller;
  defaultCurrency: InvoiceCurrency;
  defaultTaxNote: string;
}
export interface InvoiceLine {
  description: string;
  quantityMilli: number;
  unitPriceMinor: number;
  taxRateBps: number;
}
export interface InvoiceInput {
  customer: InvoiceParty;
  invoiceDate: string;
  dueDate: string;
  supplyDate: string;
  currency: InvoiceCurrency;
  lines: InvoiceLine[];
  taxNote: string;
  notes: string;
  reference: string;
}
export interface InvoiceTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  lines: Array<{ netMinor: number; taxMinor: number; totalMinor: number }>;
  taxes: Array<{ rateBps: number; netMinor: number; taxMinor: number }>;
}
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';
export interface InvoiceEmailAttempt {
  requestId: string;
  status: 'sending' | 'sent' | 'failed' | 'disabled';
  at: string;
  completedAt?: string;
}
export interface InvoiceRecord extends InvoiceInput {
  id: string;
  version: number;
  status: InvoiceStatus;
  number?: string;
  seller: InvoiceSeller;
  totals: InvoiceTotals;
  createdAt: string;
  issuedAt?: string;
  paidAt?: string;
  paymentReference?: string;
  voidReason?: string;
  emailAttempts: InvoiceEmailAttempt[];
  paymentEmail?: {
    status: 'pending' | 'processing' | 'done' | 'failed';
    attempts: number;
  };
}
export interface InvoicePage {
  items: InvoiceRecord[];
  total: number;
  page: number;
  limit: number;
}
/** All persisted amounts are integers. Tax is rounded half-up for each line. */
export function invoiceTotals(lines: InvoiceLine[]): InvoiceTotals {
  const result: InvoiceTotals = {
    subtotalMinor: 0,
    taxMinor: 0,
    totalMinor: 0,
    lines: [],
    taxes: [],
  };
  const taxes = new Map<
    number,
    { rateBps: number; netMinor: number; taxMinor: number }
  >();
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.quantityMilli) ||
      line.quantityMilli < 1 ||
      line.quantityMilli > 1_000_000 ||
      !Number.isSafeInteger(line.unitPriceMinor) ||
      line.unitPriceMinor < 0 ||
      line.unitPriceMinor > 100_000_000 ||
      !Number.isInteger(line.taxRateBps) ||
      line.taxRateBps < 0 ||
      line.taxRateBps > 10_000
    )
      throw new Error('Invalid invoice line amounts.');
    const netMinor = Number(
      (BigInt(line.quantityMilli) * BigInt(line.unitPriceMinor) + 500n) / 1000n,
    );
    const taxMinor = Number(
      (BigInt(netMinor) * BigInt(line.taxRateBps) + 5000n) / 10000n,
    );
    result.subtotalMinor += netMinor;
    result.taxMinor += taxMinor;
    result.totalMinor += netMinor + taxMinor;
    result.lines.push({ netMinor, taxMinor, totalMinor: netMinor + taxMinor });
    const group = taxes.get(line.taxRateBps) || {
      rateBps: line.taxRateBps,
      netMinor: 0,
      taxMinor: 0,
    };
    group.netMinor += netMinor;
    group.taxMinor += taxMinor;
    taxes.set(line.taxRateBps, group);
  }
  if (result.totalMinor > 100_000_000_000)
    throw new Error('Invoice total is too large.');
  result.taxes = [...taxes.values()].sort((a, b) => a.rateBps - b.rateBps);
  return result;
}

export function invoicePostalAddress(party: InvoiceParty): string {
  const country =
    new Intl.DisplayNames(['en'], { type: 'region' }).of(party.countryCode) ||
    party.countryCode;
  const address = party.address.trim();
  const last = address.split(/\r?\n/).at(-1)?.trim().toLowerCase();
  return last === country.toLowerCase() ||
    last === party.countryCode.toLowerCase()
    ? address
    : address + '\n' + country;
}
