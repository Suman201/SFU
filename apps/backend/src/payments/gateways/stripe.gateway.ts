import Stripe from 'stripe';
import type { PaymentCurrency } from '@native-sfu/contracts';
import {
  InvalidWebhookSignatureError,
  type CheckoutInput,
  type CheckoutSession,
  type GatewayEvent,
  type PaymentGateway,
  type RefundInput,
  type TransferInput,
} from './payment-gateway';

const SUPPORTED_CURRENCIES = new Set<PaymentCurrency>(['USD']);

function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
}

function disputeStatus(status: string): { status: 'needs_response' | 'under_review' | 'won' | 'lost' | 'closed'; inquiry: boolean } {
  switch (status) {
    case 'warning_needs_response':
      return { status: 'needs_response', inquiry: true };
    case 'warning_under_review':
      return { status: 'under_review', inquiry: true };
    case 'warning_closed':
      return { status: 'closed', inquiry: true };
    case 'won':
      return { status: 'won', inquiry: false };
    case 'lost':
      return { status: 'lost', inquiry: false };
    case 'under_review':
      return { status: 'under_review', inquiry: false };
    case 'prevented':
      return { status: 'closed', inquiry: true };
    default:
      return { status: 'needs_response', inquiry: false };
  }
}

/**
 * Stripe Checkout for collection and Stripe Connect (Express accounts with
 * separate transfers) for teacher payouts. Card data never reaches Sapiovian
 * servers: students pay on the Stripe-hosted page.
 */
export class StripeGateway implements PaymentGateway {
  readonly id = 'stripe' as const;
  readonly testMode: boolean;
  readonly payoutsSupported: boolean;
  private readonly client: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    connectEnabled: boolean,
    client?: Stripe,
  ) {
    this.client = client ?? new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'Sapiovian' } });
    this.testMode = secretKey.includes('_test_');
    this.payoutsSupported = connectEnabled;
  }

  supportsCurrency(currency: PaymentCurrency): boolean {
    return SUPPORTED_CURRENCIES.has(currency);
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const session = await this.client.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: input.paymentId,
        customer_email: input.customerEmail,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountMinor,
              product_data: { name: input.productName, description: input.description },
            },
          },
        ],
        metadata: input.metadata,
        payment_intent_data: { metadata: input.metadata, description: input.description },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) throw new Error('Stripe did not return a checkout URL.');
    return { sessionId: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
  }

  async expireCheckout(sessionId: string): Promise<void> {
    const session = await this.client.checkout.sessions.retrieve(sessionId);
    if (session.status === 'open') await this.client.checkout.sessions.expire(sessionId);
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayEvent {
    const header = headers['stripe-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !this.webhookSecret) throw new InvalidWebhookSignatureError('Missing Stripe signature.');
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new InvalidWebhookSignatureError('Invalid Stripe signature.');
    }
    return StripeGateway.normalize(event);
  }

  static normalize(event: Stripe.Event): GatewayEvent {
    const eventId = event.id;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        const base = {
          eventId,
          sessionId: session.id,
          gatewayPaymentId: idOf(session.payment_intent),
          amountMinor: session.amount_total ?? 0,
          currency: (session.currency ?? '').toUpperCase(),
          paymentRef: session.client_reference_id ?? session.metadata?.paymentId,
        };
        return event.type === 'checkout.session.completed'
          ? { kind: 'checkout.completed', ...base, paid: session.payment_status !== 'unpaid' }
          : { kind: 'checkout.async_succeeded', ...base };
      }
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          kind: 'checkout.async_failed',
          eventId,
          sessionId: session.id,
          reason: 'The bank payment did not complete.',
          paymentRef: session.client_reference_id ?? session.metadata?.paymentId,
        };
      }
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        return { kind: 'checkout.expired', eventId, sessionId: session.id, paymentRef: session.client_reference_id ?? session.metadata?.paymentId };
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          kind: 'payment.failed',
          eventId,
          gatewayPaymentId: intent.id,
          reason: intent.last_payment_error?.message ?? 'The payment was declined.',
          paymentRef: intent.metadata?.paymentId,
        };
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
      case 'charge.refund.updated': {
        const refund = event.data.object as Stripe.Refund;
        const status = refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' || refund.status === 'canceled' ? 'failed' : 'pending';
        const gatewayPaymentId = idOf(refund.payment_intent);
        if (!gatewayPaymentId) return { kind: 'ignored', eventId, type: event.type };
        return {
          kind: 'refund.updated',
          eventId,
          gatewayRefundId: refund.id,
          gatewayPaymentId,
          amountMinor: refund.amount,
          currency: refund.currency.toUpperCase(),
          status,
          refundRef: refund.metadata?.refundId,
          reason: refund.failure_reason ?? undefined,
        };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        const dispute = event.data.object as Stripe.Dispute;
        const gatewayPaymentId = idOf(dispute.payment_intent);
        if (!gatewayPaymentId) return { kind: 'ignored', eventId, type: event.type };
        const mapped = disputeStatus(dispute.status);
        const feeMinor = (dispute.balance_transactions ?? []).reduce((sum, item) => sum + Math.max(0, item.fee ?? 0), 0);
        return {
          kind: 'dispute.updated',
          eventId,
          gatewayDisputeId: dispute.id,
          gatewayPaymentId,
          amountMinor: dispute.amount,
          currency: dispute.currency.toUpperCase(),
          feeMinor,
          reason: dispute.reason,
          ...mapped,
          evidenceDueBy: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : undefined,
        };
      }
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        return {
          kind: 'payout_account.updated',
          eventId,
          accountId: account.id,
          detailsSubmitted: Boolean(account.details_submitted),
          payoutsEnabled: Boolean(account.payouts_enabled),
        };
      }
      case 'transfer.reversed': {
        const transfer = event.data.object as Stripe.Transfer;
        return {
          kind: 'transfer.reversed',
          eventId,
          transferId: transfer.id,
          amountReversedMinor: transfer.amount_reversed,
          payoutRef: transfer.metadata?.payoutId,
        };
      }
      default:
        return { kind: 'ignored', eventId, type: event.type };
    }
  }

  async fetchPaymentFee(input: { gatewayPaymentId: string; amountMinor: number }): Promise<{ feeMinor: number; chargeId?: string } | null> {
    const intent = await this.client.paymentIntents.retrieve(input.gatewayPaymentId, { expand: ['latest_charge.balance_transaction'] });
    const charge = intent.latest_charge;
    if (!charge || typeof charge === 'string') return null;
    const transaction = charge.balance_transaction;
    if (!transaction || typeof transaction === 'string') return null;
    return { feeMinor: transaction.fee, chargeId: charge.id };
  }

  async refund(input: RefundInput): Promise<{ gatewayRefundId: string; status: 'pending' | 'succeeded' | 'failed'; failureReason?: string }> {
    const refund = await this.client.refunds.create(
      {
        payment_intent: input.gatewayPaymentId,
        amount: input.amountMinor,
        metadata: { refundId: input.refundId, paymentId: input.paymentId },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    const status = refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' || refund.status === 'canceled' ? 'failed' : 'pending';
    return { gatewayRefundId: refund.id, status, failureReason: refund.failure_reason ?? undefined };
  }

  async createPayoutAccount(input: { teacherId: string; email: string; country?: string }): Promise<{ accountId: string }> {
    const account = await this.client.accounts.create(
      {
        type: 'express',
        email: input.email,
        ...(input.country ? { country: input.country } : {}),
        capabilities: { transfers: { requested: true } },
        metadata: { teacherId: input.teacherId },
      },
      { idempotencyKey: `payout-account:${input.teacherId}` },
    );
    return { accountId: account.id };
  }

  async payoutAccountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }> {
    const link = await this.client.accountLinks.create({
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url };
  }

  async payoutAccountStatus(accountId: string): Promise<{ detailsSubmitted: boolean; payoutsEnabled: boolean }> {
    const account = await this.client.accounts.retrieve(accountId);
    return { detailsSubmitted: Boolean(account.details_submitted), payoutsEnabled: Boolean(account.payouts_enabled) };
  }

  async transfer(input: TransferInput): Promise<{ transferId: string }> {
    const transfer = await this.client.transfers.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        destination: input.accountId,
        transfer_group: `payout_${input.payoutId}`,
        metadata: { payoutId: input.payoutId, teacherId: input.teacherId },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { transferId: transfer.id };
  }
}
