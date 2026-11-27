import type { CurrencyCode } from './money.js';
import type { InvoiceParty } from './invoices.js';
export interface CustomerBillingProfile extends InvoiceParty { version: number; saved: boolean; locale: string; timezone?: string }
export interface CustomerBillingUpdate { version: number; name: string; address: string; countryCode: string; vatNumber: string }
export type BillingPurchaseStatus = 'paid' | 'partially_refunded' | 'refunded' | 'refund_pending' | 'awaiting_payment' | 'processing' | 'cancelled' | 'expired' | 'failed' | 'review';
export type BillingSource = 'booking' | 'payment';
export interface BillingPurchase {
  id: string; recordId: string; source: BillingSource; title: string; teacherName: string;
  createdAt: string; paidAt?: string; currency: CurrencyCode; amountMinor: number; refundedMinor: number; refundPendingMinor: number;
  status: BillingPurchaseStatus; disputed: boolean; document?: { kind: 'invoice' | 'receipt'; number: string };
}
export interface BillingCurrencySummary { currency: CurrencyCode; paidMinor: number; refundedMinor: number; refundPendingMinor: number; paidCount: number; openCount: number; disputedCount: number }
export interface BillingHistory { items: BillingPurchase[]; total: number; page: number; limit: number; summary: BillingCurrencySummary[] }
export interface BillingRefund { id: string; amountMinor: number; currency: CurrencyCode; status: string; reason: string; createdAt: string; completedAt?: string; creditNote?: { id: string; number: string } }
export interface BillingRefundPage { items: BillingRefund[]; total: number; page: number; limit: number }
