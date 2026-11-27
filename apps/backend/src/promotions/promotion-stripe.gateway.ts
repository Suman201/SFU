import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PromotionOrderDocument } from './promotion.schema';
@Injectable()
export class PromotionStripeGateway {
  private readonly client?: Stripe;
  constructor(private readonly config: ConfigService) { const key = config.get<string>('payments.stripe.secretKey'); if (key) this.client = new Stripe(key, { timeout: 10000, maxNetworkRetries: 2 }); }
  get live(): boolean { return this.config.get<string>('payments.stripe.secretKey', '').startsWith('sk_live_'); }
  get enabled(): boolean { return Boolean(this.client && this.config.get<string>('promotions.webhookSecret')); }
  private api(): Stripe { if (!this.enabled || !this.client) throw new ServiceUnavailableException('Promotion payments are not configured.'); return this.client; }
  async checkout(order: PromotionOrderDocument, email: string): Promise<Stripe.Checkout.Session> {
    const origin = new URL(this.config.getOrThrow<string>('FRONTEND_URL')).origin;
    const metadata = { purpose: 'teacher_promotion', orderId: order._id, teacherId: order.teacherId, planId: order.plan.id };
    return this.api().checkout.sessions.create({ mode: 'payment', allowed_payment_method_types: ['card'], customer_creation: 'always', customer_email: email,
      client_reference_id: order._id, metadata, payment_intent_data: { metadata }, invoice_creation: { enabled: true, invoice_data: { metadata } },
      line_items: [{ quantity: 1, price_data: { currency: order.plan.currency.toLowerCase(), unit_amount: order.plan.amountMinor, tax_behavior: 'exclusive', product_data: { name: order.plan.name, ...(order.plan.taxCode ? { tax_code: order.plan.taxCode } : {}) } } }],
      automatic_tax: { enabled: order.plan.automaticTax }, billing_address_collection: 'required', tax_id_collection: { enabled: true },
      expires_at: Math.floor(order.expiresAt.getTime() / 1000), success_url: origin + '/teacher/promotions?order=' + order._id + '&checkout=returned', cancel_url: origin + '/teacher/promotions?order=' + order._id + '&checkout=cancelled'
    }, { idempotencyKey: 'promotion-checkout-' + order._id });
  }
  session(id: string): Promise<Stripe.Checkout.Session> { return this.api().checkout.sessions.retrieve(id, { expand: ['payment_intent.latest_charge.balance_transaction', 'invoice'] }); }
  refunds(intent: string): Promise<Stripe.ApiList<Stripe.Refund>> { return this.api().refunds.list({ payment_intent: intent, limit: 100 }); }
  refund(intent: string, amount: number, id: string): Promise<Stripe.Refund> { return this.api().refunds.create({ payment_intent: intent, amount, reason: 'requested_by_customer', metadata: { purpose: 'teacher_promotion', requestId: id } }, { idempotencyKey: 'promotion-refund-' + id }); }
  getRefund(id: string): Promise<Stripe.Refund> { return this.api().refunds.retrieve(id); }
  async credit(invoice: string, refund: Stripe.Refund): Promise<Stripe.CreditNote> {
    return this.api().creditNotes.create({ invoice, amount: refund.amount, refunds: [{ refund: refund.id, amount_refunded: refund.amount }], metadata: { purpose: 'teacher_promotion' } }, { idempotencyKey: 'promotion-credit-' + refund.id });
  }
  async document(invoiceId: string, creditId?: string, orderId?: string): Promise<string> {
    const invoice = !creditId || orderId ? await this.api().invoices.retrieve(invoiceId) : undefined;
    if (orderId && (invoice?.metadata?.purpose !== 'teacher_promotion' || invoice.metadata.orderId !== orderId)) throw new ServiceUnavailableException('The invoice does not match this purchase.');
    let url: string | null | undefined;
    if (creditId) {
      const credit = await this.api().creditNotes.retrieve(creditId);
      if ((typeof credit.invoice === 'string' ? credit.invoice : credit.invoice?.id) !== invoiceId) throw new ServiceUnavailableException('The credit note does not match this invoice.');
      url = credit.pdf;
    } else url = invoice?.hosted_invoice_url;
    return this.safeUrl(url);
  }
  safeUrl(value?: string | null): string { let url: URL; try { url = new URL(value ?? ''); } catch { throw new ServiceUnavailableException('The payment document is not ready.'); } if (url.protocol !== 'https:' || !['invoice.stripe.com', 'pay.stripe.com', 'checkout.stripe.com'].includes(url.hostname) || url.username || url.password || url.port) throw new ServiceUnavailableException('Invalid payment document URL.'); return url.href; }
  webhook(body: Buffer, signature?: string): Stripe.Event { if (!signature) throw new BadRequestException('Missing Stripe signature.'); try { const event = this.api().webhooks.constructEvent(body, signature, this.config.getOrThrow<string>('promotions.webhookSecret')); if (event.livemode !== this.live) throw new Error('mode'); return event; } catch { throw new BadRequestException('Invalid Stripe signature or environment.'); } }
  async eventIntent(event: Stripe.Event): Promise<string | undefined> {
    const object = event.data.object as unknown as { object: string; payment_intent?: string | { id: string }; charge?: string };
    if (object.payment_intent) return typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent.id;
    if (object.charge) { const charge = await this.api().charges.retrieve(object.charge); return typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id; }
    return undefined;
  }
}
