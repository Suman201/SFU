import Stripe from 'stripe';
import { InvalidWebhookSignatureError } from './gateways/payment-gateway';
import { StripeGateway } from './gateways/stripe.gateway';

const secret = 'whsec_testsecret123';

function pick(value: unknown, expected: Record<string, unknown>): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(expected).map((key) => [key, source[key]]));
}
const stripe = new Stripe('sk_test_123');

function signed(payload: Record<string, unknown>): { body: Buffer; header: string } {
  const body = JSON.stringify(payload);
  return { body: Buffer.from(body), header: stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
}

function event(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return { id: `evt_${type.replace(/\W/g, '_')}`, object: 'event', type, api_version: '2025-02-24.acacia', created: 1, data: { object }, livemode: false, pending_webhooks: 1, request: null };
}

describe('StripeGateway webhooks', () => {
  const gateway = new StripeGateway('sk_test_123', secret, true, stripe);

  it('verifies signatures and normalises a completed checkout', () => {
    const { body, header } = signed(
      event('checkout.session.completed', {
        id: 'cs_test_1',
        object: 'checkout.session',
        payment_intent: 'pi_1',
        amount_total: 4999,
        currency: 'usd',
        payment_status: 'paid',
        client_reference_id: 'payment-1',
        metadata: { paymentId: 'payment-1' },
      }),
    );
    expect(gateway.parseWebhook(body, { 'stripe-signature': header })).toEqual({
      kind: 'checkout.completed',
      eventId: 'evt_checkout_session_completed',
      sessionId: 'cs_test_1',
      gatewayPaymentId: 'pi_1',
      amountMinor: 4999,
      currency: 'USD',
      paid: true,
      paymentRef: 'payment-1',
    });
  });

  it('rejects tampered bodies and missing signatures', () => {
    const { header } = signed(event('checkout.session.completed', { id: 'cs_test_1' }));
    const tampered = Buffer.from(JSON.stringify(event('checkout.session.completed', { id: 'cs_test_2' })));
    expect(() => gateway.parseWebhook(tampered, { 'stripe-signature': header })).toThrow(InvalidWebhookSignatureError);
    expect(() => gateway.parseWebhook(tampered, {})).toThrow(InvalidWebhookSignatureError);
  });

  it('treats an unpaid completed session (bank debit) as not yet paid', () => {
    const result = StripeGateway.normalize(
      event('checkout.session.completed', { id: 'cs_2', payment_intent: 'pi_2', amount_total: 100, currency: 'usd', payment_status: 'unpaid' }) as unknown as Stripe.Event,
    );
    expect(pick(result, { kind: 'checkout.completed', paid: false })).toEqual({ kind: 'checkout.completed', paid: false });
  });

  it('maps refunds, disputes, accounts and transfer reversals', () => {
    expect(
      StripeGateway.normalize(event('refund.updated', { id: 're_1', payment_intent: 'pi_1', amount: 500, currency: 'usd', status: 'succeeded', metadata: { refundId: 'r-1' } }) as unknown as Stripe.Event),
    ).toEqual({ kind: 'refund.updated', eventId: 'evt_refund_updated', gatewayRefundId: 're_1', gatewayPaymentId: 'pi_1', amountMinor: 500, currency: 'USD', status: 'succeeded', refundRef: 'r-1', reason: undefined });

    const dispute = StripeGateway.normalize(
      event('charge.dispute.created', {
        id: 'dp_1',
        payment_intent: 'pi_1',
        amount: 4999,
        currency: 'usd',
        reason: 'fraudulent',
        status: 'needs_response',
        balance_transactions: [{ fee: 1500 }],
        evidence_details: { due_by: 1_800_000_000 },
      }) as unknown as Stripe.Event,
    );
    const expectedDispute = { kind: 'dispute.updated', status: 'needs_response', inquiry: false, feeMinor: 1500, amountMinor: 4999 };
    expect(pick(dispute, expectedDispute)).toEqual(expectedDispute);

    expect(
      pick(StripeGateway.normalize(event('charge.dispute.created', { id: 'dp_2', payment_intent: 'pi_1', amount: 1, currency: 'usd', reason: 'general', status: 'warning_needs_response' }) as unknown as Stripe.Event), { inquiry: true, status: 'needs_response', feeMinor: 0 }),
    ).toEqual({ inquiry: true, status: 'needs_response', feeMinor: 0 });

    expect(StripeGateway.normalize(event('account.updated', { id: 'acct_1', details_submitted: true, payouts_enabled: false }) as unknown as Stripe.Event)).toEqual({
      kind: 'payout_account.updated',
      eventId: 'evt_account_updated',
      accountId: 'acct_1',
      detailsSubmitted: true,
      payoutsEnabled: false,
    });

    expect(StripeGateway.normalize(event('transfer.reversed', { id: 'tr_1', amount_reversed: 800, metadata: { payoutId: 'po-1' } }) as unknown as Stripe.Event)).toEqual({
      kind: 'transfer.reversed',
      eventId: 'evt_transfer_reversed',
      transferId: 'tr_1',
      amountReversedMinor: 800,
      payoutRef: 'po-1',
    });

    expect(StripeGateway.normalize(event('customer.created', { id: 'cus_1' }) as unknown as Stripe.Event)).toEqual({ kind: 'ignored', eventId: 'evt_customer_created', type: 'customer.created' });
  });

  it('supports only USD for now', () => {
    expect(gateway.supportsCurrency('USD')).toBe(true);
    expect(gateway.supportsCurrency('INR')).toBe(false);
    expect(gateway.testMode).toBe(true);
  });
});
