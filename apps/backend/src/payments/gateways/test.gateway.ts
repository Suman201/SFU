import { createHash, randomUUID } from 'node:crypto';
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

/**
 * Local development gateway. It never moves money. Checkout opens a page on
 * the Sapiovian website where a developer chooses "succeed" or "decline";
 * that page calls a development-only endpoint which feeds the same
 * provider-neutral events into the normal processing pipeline as Stripe
 * webhooks do. Configuration validation rejects this gateway in production.
 */
export class TestGateway implements PaymentGateway {
  private static readonly transfers = new Map<string, import('./payment-gateway').VerifiedTransfer>();
  readonly id = 'test' as const;
  readonly testMode = true;
  readonly payoutsSupported = true;

  constructor(private readonly webUrl: string) {}

  supportsCurrency(_currency: PaymentCurrency): boolean {
    return true;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const sessionId = `test_cs_${randomUUID().replace(/-/g, '')}`;
    return { sessionId, url: `${this.webUrl}/payments/test-checkout/${encodeURIComponent(input.paymentId)}`, expiresAt: input.expiresAt };
  }

  async expireCheckout(_sessionId: string): Promise<void> {
    return;
  }

  parseWebhook(_rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): GatewayEvent {
    throw new InvalidWebhookSignatureError('The test gateway does not accept webhooks.');
  }

  /** Mirrors a typical card fee (2.9% + 30 cents) so reports show realistic numbers. */
  async fetchPaymentFee(input: { gatewayPaymentId: string; amountMinor: number }): Promise<{ feeMinor: number; chargeId?: string } | null> {
    if (input.amountMinor <= 0) return { feeMinor: 0 };
    return { feeMinor: Math.min(input.amountMinor, Math.round(input.amountMinor * 0.029) + 30), chargeId: `test_ch_${input.gatewayPaymentId.slice(-12)}` };
  }

  async refund(_input: RefundInput): Promise<{ gatewayRefundId: string; status: 'pending' | 'succeeded' | 'failed' }> {
    return { gatewayRefundId: `test_re_${randomUUID().replace(/-/g, '')}`, status: 'succeeded' };
  }

  async createPayoutAccount(input: { teacherId: string; email: string }): Promise<{ accountId: string }> {
    return { accountId: `test_acct_${input.teacherId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}` };
  }

  async payoutAccountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }> {
    return { url: input.returnUrl };
  }

  async payoutAccountStatus(_accountId: string): Promise<{ detailsSubmitted: boolean; payoutsEnabled: boolean }> {
    return { detailsSubmitted: true, payoutsEnabled: true };
  }

  async transfer(input: TransferInput): Promise<{ transferId: string }> {
    const transferId = 'test_tr_' + createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32);
    const existing = TestGateway.transfers.get(transferId);
    if (existing && (existing.amountMinor !== input.amountMinor || existing.currency !== input.currency || existing.accountId !== input.accountId)) throw new Error('Idempotent transfer parameters changed.');
    TestGateway.transfers.set(transferId, { transferId, accountId: input.accountId, amountMinor: input.amountMinor, currency: input.currency, payoutId: input.payoutId, teacherId: input.teacherId, amountReversedMinor: existing?.amountReversedMinor ?? 0, livemode: false });
    return { transferId };
  }

  async retrieveTransfer(transferId: string) {
    const transfer = TestGateway.transfers.get(transferId);
    if (!transfer) throw new Error('Test transfer not found.');
    return { ...transfer };
  }
}
