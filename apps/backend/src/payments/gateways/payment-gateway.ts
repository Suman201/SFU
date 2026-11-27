import type { PaymentCurrency, PaymentGatewayId } from '@native-sfu/contracts';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/**
 * Gateway notifications translated into provider-neutral events. Payment,
 * refund, dispute and payout logic only ever sees these shapes, so adding a
 * provider (for example Razorpay for INR) means adding an adapter, not
 * changing the ledger or the payment state machine.
 */
export type GatewayEvent =
  | {
      kind: 'checkout.completed';
      eventId: string;
      sessionId: string;
      gatewayPaymentId?: string;
      amountMinor: number;
      currency: string;
      /** False when the payment method settles later (bank debits). */
      paid: boolean;
      paymentRef?: string;
    }
  | { kind: 'checkout.async_succeeded'; eventId: string; sessionId: string; gatewayPaymentId?: string; amountMinor: number; currency: string; paymentRef?: string }
  | { kind: 'checkout.async_failed'; eventId: string; sessionId: string; reason: string; paymentRef?: string }
  | { kind: 'checkout.expired'; eventId: string; sessionId: string; paymentRef?: string }
  | { kind: 'payment.failed'; eventId: string; gatewayPaymentId: string; reason: string; paymentRef?: string }
  | {
      kind: 'refund.updated';
      eventId: string;
      gatewayRefundId: string;
      gatewayPaymentId: string;
      amountMinor: number;
      currency: string;
      status: 'pending' | 'succeeded' | 'failed';
      refundRef?: string;
      reason?: string;
    }
  | {
      kind: 'dispute.updated';
      eventId: string;
      gatewayDisputeId: string;
      gatewayPaymentId: string;
      amountMinor: number;
      currency: string;
      feeMinor: number;
      reason: string;
      status: 'needs_response' | 'under_review' | 'won' | 'lost' | 'closed';
      /** Inquiries (Stripe "warning" disputes) do not withdraw funds. */
      inquiry: boolean;
      evidenceDueBy?: string;
    }
  | { kind: 'payout_account.updated'; eventId: string; accountId: string; detailsSubmitted: boolean; payoutsEnabled: boolean }
  | { kind: 'transfer.reversed'; eventId: string; transferId: string; amountReversedMinor: number; payoutRef?: string }
  | { kind: 'ignored'; eventId: string; type: string };

export interface CheckoutInput {
  paymentId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  productName: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  expiresAt: Date;
}

export interface RefundInput {
  gatewayPaymentId: string;
  amountMinor: number;
  idempotencyKey: string;
  refundId: string;
  paymentId: string;
}

export interface TransferInput {
  accountId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  idempotencyKey: string;
  payoutId: string;
  teacherId: string;
}

export interface VerifiedTransfer {
  transferId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
  amountReversedMinor: number;
  payoutId?: string;
  teacherId?: string;
  livemode: boolean;
}

export interface PaymentGateway {
  readonly id: PaymentGatewayId;
  readonly testMode: boolean;
  /** Whether teacher payouts can be sent through this gateway. */
  readonly payoutsSupported: boolean;
  supportsCurrency(currency: PaymentCurrency): boolean;
  supportsPayoutCurrency?(currency: PaymentCurrency): boolean;
  retrieveTransfer?(transferId: string): Promise<VerifiedTransfer>;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  expireCheckout(sessionId: string): Promise<void>;
  /** Verifies the signature and returns the normalised event. Throws when invalid. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayEvent;
  /** Processing fee charged by the gateway for a settled payment, or null when not yet known. */
  fetchPaymentFee(input: { gatewayPaymentId: string; amountMinor: number }): Promise<{ feeMinor: number; chargeId?: string } | null>;
  refund(input: RefundInput): Promise<{ gatewayRefundId: string; status: 'pending' | 'succeeded' | 'failed'; failureReason?: string }>;
  createPayoutAccount(input: { teacherId: string; email: string; country?: string }): Promise<{ accountId: string }>;
  payoutAccountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  payoutAccountStatus(accountId: string): Promise<{ detailsSubmitted: boolean; payoutsEnabled: boolean }>;
  transfer(input: TransferInput): Promise<{ transferId: string }>;
}

export class GatewayUnavailableError extends Error {}
export class InvalidWebhookSignatureError extends Error {}
