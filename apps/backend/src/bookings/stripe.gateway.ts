import {
  Injectable,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { isCurrencyCode, type CurrencyCode } from '@native-sfu/contracts';
import { BookingOrderDocument } from './booking.schema';

export interface VerifiedCheckout {
  id: string;
  orderId: string;
  studentId: string;
  status: string | null;
  paid: boolean;
  failed: boolean;
  amountMinor: number;
  currency: string;
  paymentIntentId: string;
  paidAt: Date;
  url: string | null;
  livemode: boolean;
}
export interface VerifiedRefund {
  id: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  requestId?: string;
}

@Injectable()
export class StripeGateway {
  private readonly client?: Stripe;
  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    if (key)
      this.client = new Stripe(key, { timeout: 10000, maxNetworkRetries: 2 });
  }
  get enabled(): boolean {
    return Boolean(
      this.client && this.config.get<string>('STRIPE_WEBHOOK_SECRET'),
    );
  }
  get live(): boolean {
    return this.config
      .get<string>('STRIPE_SECRET_KEY', '')
      .startsWith('sk_live_');
  }
  get currencies(): CurrencyCode[] {
    return this.config
      .get<string>('BOOKING_CHARGE_CURRENCIES', 'EUR,GBP,USD')
      .split(',')
      .map((code) => code.trim())
      .filter(isCurrencyCode);
  }
  private api(): Stripe {
    if (!this.client || !this.enabled)
      throw new ServiceUnavailableException(
        'Online payments are not configured.',
      );
    return this.client;
  }
  assertCurrency(currency: CurrencyCode, amountMinor: number): void {
    if (amountMinor > 0 && !this.currencies.includes(currency))
      throw new BadRequestException(
        'This currency is not enabled for payment collection.',
      );
  }
  async createCheckout(order: BookingOrderDocument): Promise<VerifiedCheckout> {
    const origin = this.config
      .getOrThrow<string>('FRONTEND_URL')
      .replace(/\/$/, '');
    const session = await this.api().checkout.sessions.create(
      {
        mode: 'payment',
        allowed_payment_method_types: ['card'],
        customer_email: order.invoiceSource.billing.email,
        client_reference_id: order._id,
        metadata: { orderId: order._id, studentId: order.studentId },
        payment_intent_data: {
          metadata: { orderId: order._id, studentId: order.studentId },
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: order.invoiceSource.currency.toLowerCase(),
              unit_amount: order.invoiceSource.totalMinor,
              product_data: { name: order.title },
            },
          },
        ],
        billing_address_collection: 'required',
        success_url: `${origin}/bookings/${order._id}?checkout=returned`,
        cancel_url: `${origin}/bookings/${order._id}?checkout=cancelled`,
        expires_at: Math.floor(order.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: `booking-checkout:${order._id}` },
    );
    return this.checkoutView(session);
  }
  async retrieveCheckout(id: string): Promise<VerifiedCheckout> {
    return this.checkoutView(
      await this.api().checkout.sessions.retrieve(id, {
        expand: ['payment_intent.latest_charge'],
      }),
    );
  }
  async recoverCheckout(
    order: BookingOrderDocument,
  ): Promise<VerifiedCheckout | null> {
    try {
      return await this.createCheckout(order);
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError))
        throw error;
      let checked = 0;
      const from = Math.floor((order.createdAt.getTime() - 60000) / 1000);
      const to = Math.ceil(order.expiresAt.getTime() / 1000);
      for await (const candidate of this.api().checkout.sessions.list({
        created: { gte: from, lte: to },
        limit: 100,
      })) {
        if (++checked > 10000)
          throw new Error(
            'Checkout recovery requires operator reconciliation.',
          );
        if (
          candidate.client_reference_id === order._id &&
          candidate.metadata?.studentId === order.studentId
        )
          return this.retrieveCheckout(candidate.id);
      }
      if (order.expiresAt.getTime() > Date.now()) throw error;
      return null;
    }
  }
  async refundsForCharge(chargeId: string): Promise<VerifiedRefund[]> {
    const charge = await this.api().charges.retrieve(chargeId);
    const id =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id;
    return id ? this.refundsFor(id) : [];
  }
  async expireCheckout(id: string): Promise<void> {
    try {
      await this.api().checkout.sessions.expire(id);
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError))
        throw error;
    }
  }
  private checkoutView(session: Stripe.Checkout.Session): VerifiedCheckout {
    const intent =
      session.payment_intent && typeof session.payment_intent !== 'string'
        ? session.payment_intent
        : undefined;
    const charge =
      intent?.latest_charge && typeof intent.latest_charge !== 'string'
        ? intent.latest_charge
        : undefined;
    return {
      id: session.id,
      orderId: session.client_reference_id ?? session.metadata?.orderId ?? '',
      studentId: session.metadata?.studentId ?? '',
      status: session.status,
      failed:
        session.status === 'complete' &&
        (intent?.status === 'canceled' ||
          intent?.status === 'requires_payment_method'),
      paid:
        session.payment_status === 'paid' &&
        intent?.status === 'succeeded' &&
        intent.amount_received === session.amount_total,
      amountMinor: session.amount_total ?? -1,
      currency: session.currency ?? '',
      paymentIntentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (intent?.id ?? ''),
      paidAt: new Date((charge?.created ?? session.created) * 1000),
      url: session.url,
      livemode: session.livemode,
    };
  }
  verifyWebhook(
    raw: Buffer,
    signature: string,
  ): { id: string; type: string; objectId: string } {
    const event = this.api().webhooks.constructEvent(
      raw,
      signature,
      this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET'),
      300,
    );
    if (event.livemode !== this.live)
      throw new BadRequestException('Payment environment does not match.');
    const object = event.data.object as { id?: string };
    if (!object.id) throw new BadRequestException('Missing event object.');
    return { id: event.id, type: event.type, objectId: object.id };
  }
  isDefinitiveRefundRejection(error: unknown): boolean {
    return error instanceof Stripe.errors.StripeInvalidRequestError;
  }
  async refund(
    paymentIntentId: string,
    amountMinor: number,
    requestId: string,
  ): Promise<VerifiedRefund> {
    return this.refundView(
      await this.api().refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amountMinor,
          metadata: { bookingRefundId: requestId },
        },
        { idempotencyKey: `booking-refund:${requestId}` },
      ),
    );
  }
  async retrieveRefund(id: string): Promise<VerifiedRefund> {
    return this.refundView(await this.api().refunds.retrieve(id));
  }
  async refundsFor(paymentIntentId: string): Promise<VerifiedRefund[]> {
    const refunds: VerifiedRefund[] = [];
    for await (const item of this.api().refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
    }))
      refunds.push(this.refundView(item));
    return refunds;
  }
  private refundView(refund: Stripe.Refund): VerifiedRefund {
    return {
      id: refund.id,
      paymentIntentId:
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? ''),
      amountMinor: refund.amount,
      currency: refund.currency,
      status:
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'failed' || refund.status === 'canceled'
            ? 'failed'
            : 'pending',
      requestId: refund.metadata?.bookingRefundId,
    };
  }
}
