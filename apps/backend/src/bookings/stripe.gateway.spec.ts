import { describe, it, expect, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { StripeGateway } from './stripe.gateway';
import { BookingOrderDocument } from './booking.schema';

describe('StripeGateway provider boundary', () => {
  const config = () =>
    new ConfigService({
      STRIPE_SECRET_KEY: 'sk_test_local_unit_only',
      STRIPE_WEBHOOK_SECRET: 'whsec_local_unit_only',
      FRONTEND_URL: 'https://learning.test',
      BOOKING_CHARGE_CURRENCIES: 'EUR,GBP,USD',
    });
  it('creates a hosted card checkout from the immutable server total and stable idempotency key', async () => {
    const gateway = new StripeGateway(config());
    const client = (
      gateway as unknown as {
        client: { checkout: { sessions: { create: jest.Mock } } };
      }
    ).client;
    client.checkout.sessions.create = jest.fn(async () => ({
      id: 'cs_test_unit',
      client_reference_id: 'order-unit',
      metadata: { studentId: 'student-unit' },
      amount_total: 1234,
      currency: 'eur',
      payment_status: 'unpaid',
      status: 'open',
      payment_intent: null,
      created: 1234,
      url: 'https://checkout.stripe.com/test',
      livemode: false,
    }));
    const order = {
      _id: 'order-unit',
      studentId: 'student-unit',
      title: 'Saved lesson title',
      expiresAt: new Date(Date.now() + 45 * 60000),
      invoiceSource: {
        billing: { email: 'purchaser@learning.test' },
        totalMinor: 1234,
        currency: 'EUR',
      },
    } as BookingOrderDocument;
    const result = await gateway.createCheckout(order);
    expect(result.paid).toBe(false);
    expect(client.checkout.sessions.create.mock.calls[0]![0]).toMatchObject({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      client_reference_id: 'order-unit',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: 1234,
            product_data: { name: 'Saved lesson title' },
          },
        },
      ],
      success_url:
        'https://learning.test/bookings/order-unit?checkout=returned',
    });
    expect(client.checkout.sessions.create.mock.calls[0]![1]).toEqual({
      idempotencyKey: 'booking-checkout:order-unit',
    });
  });
  it('requires successful provider intent and exact received amount to call checkout paid', async () => {
    const gateway = new StripeGateway(config());
    const client = (
      gateway as unknown as {
        client: { checkout: { sessions: { retrieve: jest.Mock } } };
      }
    ).client;
    const remote = {
      id: 'cs_test_paid',
      client_reference_id: 'order-unit',
      metadata: { studentId: 'student-unit' },
      amount_total: 6000,
      currency: 'eur',
      payment_status: 'paid',
      status: 'complete',
      payment_intent: {
        id: 'pi_test_unit',
        status: 'processing',
        amount_received: 6000,
      },
      created: 1234,
      url: null,
      livemode: false,
    };
    client.checkout.sessions.retrieve = jest.fn(async () => remote);
    expect((await gateway.retrieveCheckout(remote.id)).paid).toBe(false);
    remote.payment_intent.status = 'succeeded';
    remote.payment_intent.amount_received = 1;
    expect((await gateway.retrieveCheckout(remote.id)).paid).toBe(false);
    remote.payment_intent.amount_received = 6000;
    expect((await gateway.retrieveCheckout(remote.id)).paid).toBe(true);
  });
});
