import Stripe from 'stripe';
import { expect } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { PromotionStripeGateway } from './promotion-stripe.gateway';
import { PromotionOrderDocument } from './promotion.schema';
describe('Promotion Stripe boundary', () => {
  function fixture() { return new PromotionStripeGateway(new ConfigService({ payments: { stripe: { secretKey: 'sk_test_synthetic_only' } }, promotions: { webhookSecret: 'whsec_synthetic_only' }, FRONTEND_URL: 'https://learn.example.com' })); }
  it('rejects arbitrary redirects and payment document hosts', () => {
    const gateway = fixture();
    for (const url of ['http://invoice.stripe.com/i/1','https://invoice.stripe.com.evil.test/i/1','https://user@invoice.stripe.com/i/1','javascript:alert(1)','https://invoice.stripe.com:444/i/1']) expect(() => gateway.safeUrl(url)).toThrow();
    expect(gateway.safeUrl('https://invoice.stripe.com/i/1')).toBe('https://invoice.stripe.com/i/1');
  });
  it('requires an authentic raw webhook and the configured live/test environment', () => {
    const gateway = fixture();
    const payload = JSON.stringify({ id: 'evt_test', object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test' } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_synthetic_only' });
    expect(gateway.webhook(Buffer.from(payload), signature).id).toBe('evt_test');
    expect(() => gateway.webhook(Buffer.from(payload + ' '), signature)).toThrow();
    const live = payload.replace('"livemode":false', '"livemode":true');
    expect(() => gateway.webhook(Buffer.from(live), Stripe.webhooks.generateTestHeaderString({ payload: live, secret: 'whsec_synthetic_only' }))).toThrow();
  });
  it('refreshes document links and rejects credits issued for another invoice', async () => {
    const gateway = fixture(), invoice = jest.fn().mockResolvedValue({ hosted_invoice_url: 'https://invoice.stripe.com/i/current' });
    const credit = jest.fn().mockResolvedValue({ invoice: 'in_owned', pdf: 'https://pay.stripe.com/credit.pdf' });
    Object.assign(gateway, { client: { invoices: { retrieve: invoice }, creditNotes: { retrieve: credit } } });
    expect(await gateway.document('in_owned')).toBe('https://invoice.stripe.com/i/current');
    expect(await gateway.document('in_owned', 'cn_owned')).toBe('https://pay.stripe.com/credit.pdf');
    credit.mockResolvedValueOnce({ invoice: { id: 'in_owned' }, pdf: 'https://pay.stripe.com/credit.pdf' });
    await expect(gateway.document('in_owned', 'cn_owned')).resolves.toBe('https://pay.stripe.com/credit.pdf');
    credit.mockResolvedValueOnce({ invoice: 'in_other', pdf: 'https://pay.stripe.com/credit.pdf' });
    await expect(gateway.document('in_owned', 'cn_other')).rejects.toThrow('does not match');
    invoice.mockResolvedValueOnce({ hosted_invoice_url: 'https://attacker.test/document' });
    await expect(gateway.document('in_owned')).rejects.toThrow('Invalid payment document');
    invoice.mockResolvedValueOnce({ hosted_invoice_url: 'https://invoice.stripe.com/i/owned', metadata: { purpose: 'teacher_promotion', orderId: 'order_owned' } });
    await expect(gateway.document('in_owned', undefined, 'order_owned')).resolves.toBe('https://invoice.stripe.com/i/owned');
    invoice.mockResolvedValueOnce({ hosted_invoice_url: 'https://invoice.stripe.com/i/other', metadata: { purpose: 'teacher_promotion', orderId: 'order_other' } });
    await expect(gateway.document('in_owned', undefined, 'order_owned')).rejects.toThrow('does not match this purchase');
  });
  it('uses server minor units, an immutable order key, invoices and tax configuration for Checkout', async () => {
    const gateway = fixture(), create = jest.fn().mockResolvedValue({ id: 'cs_test' });
    Object.assign(gateway, { client: { checkout: { sessions: { create } } } });
    const order = { _id: 'order-id', teacherId: 'teacher-id', expiresAt: new Date('2026-12-01T01:00:00Z'), plan: { id: 'plan-id', name: 'JPY promotion', currency: 'JPY', amountMinor: 101, automaticTax: true, taxCode: 'txcd_10000000' } } as PromotionOrderDocument;
    await gateway.checkout(order, 'teacher@example.com');
    const [params, options] = create.mock.calls[0]!;
    expect(params.line_items[0].price_data.unit_amount).toBe(101);
    expect(params.line_items[0].price_data.currency).toBe('jpy');
    expect(params.automatic_tax.enabled).toBe(true); expect(params.invoice_creation.enabled).toBe(true);
    expect(params.payment_intent_data.metadata).toEqual(params.metadata);
    expect(options.idempotencyKey).toBe('promotion-checkout-order-id');
    expect(params.success_url).toBe('https://learn.example.com/teacher/promotions?order=order-id&checkout=returned');
  });
});
