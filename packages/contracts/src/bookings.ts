import type { CurrencyCode, Money } from './money.js';
import type { InvoiceParty, InvoiceSeller } from './invoices.js';

export type BookingOrderStatus =
  | 'awaiting_payment'
  | 'processing'
  | 'confirmed'
  | 'expired'
  | 'cancelled'
  | 'refund_pending'
  | 'refunded'
  | 'payment_review';
export interface LessonOffer {
  id: string;
  teacherId: string;
  title: string;
  description: string;
  durationMinutes: number;
  price: Money;
  netMinor: number;
  taxRateBps: number;
  active: boolean;
  version: number;
}
export interface LessonSlot {
  id: string;
  offerId: string;
  teacherId: string;
  startsAt: string;
  endsAt: string;
  status: 'open' | 'held' | 'booked' | 'cancelled';
  orderId?: string;
}
export interface BookingCatalogue {
  teacher: { id: string; name: string; headline: string; timezone: string };
  offers: LessonOffer[];
  slots: LessonSlot[];
  paymentsAvailable: boolean;
  cancellationNoticeHours: number;
}
export interface BookingRefund {
  id: string;
  amountMinor: number;
  currency: CurrencyCode;
  status: 'queued' | 'pending' | 'succeeded' | 'failed';
  reason: string;
  createdAt: string;
  creditNoteId?: string;
}
export interface BookingOrder {
  id: string;
  kind: 'lesson' | 'batch';
  studentId: string;
  studentName: string;
  teacherId: string;
  teacherName: string;
  title: string;
  status: BookingOrderStatus;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
  cancellationDeadline: string;
  price: Money;
  netMinor: number;
  taxMinor: number;
  taxRateBps: number;
  createdAt: string;
  paidAt?: string;
  cancelledAt?: string;
  slotId?: string;
  batchId?: string;
  sessionId?: string;
  invoiceId?: string;
  checkoutUrl?: string;
  refundedMinor: number;
  refundPendingMinor: number;
  refunds: BookingRefund[];
  canCancel: boolean;
  cancellationReason?: string;
}
export interface BookingOrderRequest {
  requestId: string;
  expectedTotalMinor: number;
  expectedOfferVersion?: number;
  billing: InvoiceParty;
  goal?: string;
}
export interface BookingInvoiceSource {
  orderId: string;
  studentId: string;
  billing: InvoiceParty;
  seller: InvoiceSeller;
  title: string;
  startsAt: string;
  currency: CurrencyCode;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxRateBps: number;
  taxNote: string;
  paymentReference: string;
  paidAt: Date;
}
export interface BookingBatchCatalogue {
  id: string;
  title: string;
  teacherId: string;
  teacherName: string;
  price: Money;
  startsAt: string;
  endsAt: string;
  placesAvailable: number;
  paymentsAvailable: boolean;
  cancellationNoticeHours: number;
}
