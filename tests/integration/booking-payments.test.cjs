'use strict';
// Real Nest HTTP, MongoDB replica-set transactions and indexes. Only the Stripe
// network boundary is substituted; signature verification uses the official SDK.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');

test(
  'booking payment lifecycle against the real backend',
  { timeout: 180000 },
  async (t) => {
    const stack = await startBookingStack();
    t.after(() => stack.stop());
    const tokens = {};
    async function api(
      name,
      method,
      path,
      body,
      expected = method === 'POST' ? 201 : 200,
    ) {
      const response = await fetch(stack.origin + '/api/v1/' + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await response.json();
      assert.equal(response.status, expected, JSON.stringify(json));
      return json.data ?? json;
    }
    for (const name of Object.keys(stack.users))
      tokens[name] = (
        await api(
          name,
          'POST',
          'auth/login',
          { email: stack.users[name].email, password: stack.password },
          200,
        )
      ).accessToken;
    const billing = {
      name: 'Synthetic Student',
      email: stack.users.student.email,
      address: '123 Acceptance Street',
      countryCode: 'GB',
      vatNumber: '',
    };
    const input = (offer) => ({
      requestId: randomUUID(),
      expectedTotalMinor: offer.price.amountMinor,
      expectedOfferVersion: offer.version,
      billing,
      goal: 'Prepare for my assessment.',
    });
    const offer = await api('teacher', 'POST', 'bookings/teacher/offers', {
      title: 'Mathematics confidence and assessment preparation '
        .repeat(3)
        .slice(0, 120),
      description: 'A focused individual lesson.',
      durationMinutes: 30,
      amountMinor: 5000,
      currency: 'EUR',
      active: true,
    });
    const epoch = Math.ceil((Date.now() + 72 * 3600000) / 300000) * 300000;
    let offset = 0;
    async function slot() {
      return api('teacher', 'POST', 'bookings/teacher/slots', {
        offerId: offer.id,
        startsAt: new Date(epoch + offset++ * 3600000).toISOString(),
      });
    }
    async function reservation() {
      const time = await slot();
      return api(
        'student',
        'POST',
        `bookings/slots/${time.id}/reserve`,
        input(offer),
      );
    }
    async function paid() {
      const order = await reservation();
      await api('student', 'POST', `bookings/orders/${order.id}/checkout`);
      await stack.bookings.verifyPayment(stack.gateway.pay(order.id));
      return api('student', 'GET', `bookings/orders/${order.id}`);
    }
    let first;
    await t.test(
      'rejects forged amounts, missing billing and unauthenticated writes',
      async () => {
        const time = await slot();
        await api(
          'guest',
          'POST',
          `bookings/slots/${time.id}/reserve`,
          input(offer),
          401,
        );
        const missing = input(offer);
        delete missing.billing;
        await api(
          'student',
          'POST',
          `bookings/slots/${time.id}/reserve`,
          missing,
          400,
        );
        await api(
          'student',
          'POST',
          `bookings/slots/${time.id}/reserve`,
          { ...input(offer), studentId: stack.users.other.id },
          400,
        );
        await api(
          'student',
          'POST',
          `bookings/slots/${time.id}/reserve`,
          { ...input(offer), expectedTotalMinor: 1 },
          409,
        );
        await api(
          'student',
          'POST',
          `bookings/slots/${time.id}/reserve`,
          { ...input(offer), expectedOfferVersion: 99 },
          409,
        );
      },
    );
    await t.test(
      'concurrent customers get one hold; idempotent retry creates no duplicates',
      async () => {
        const time = await slot(),
          body = input(offer);
        const results = await Promise.all(
          ['student', 'other'].map(async (name) => {
            const response = await fetch(
              stack.origin + '/api/v1/bookings/slots/' + time.id + '/reserve',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: 'Bearer ' + tokens[name],
                },
                body: JSON.stringify(body),
              },
            );
            return {
              name,
              status: response.status,
              value: await response.json(),
            };
          }),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        const winner = results.find((r) => r.status === 201);
        first = { ...winner.value.data, owner: winner.name };
        assert.equal(
          (
            await api(
              winner.name,
              'POST',
              `bookings/slots/${time.id}/reserve`,
              body,
            )
          ).id,
          first.id,
        );
        assert.equal(
          await stack.connection.db
            .collection('invoices')
            .countDocuments({ orderId: first.id }),
          0,
        );
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            paymentOrderId: first.id,
          }),
          0,
        );
        await api(
          'teacher',
          'POST',
          'bookings/teacher/slots',
          { offerId: offer.id, startsAt: time.startsAt },
          409,
        );
      },
    );
    await t.test(
      'returning to checkout without a verified payment grants no access',
      async () => {
        const checkout = await api(
          first.owner,
          'POST',
          `bookings/orders/${first.id}/checkout`,
        );
        assert.match(
          checkout.checkoutUrl,
          /^https:\/\/checkout\.stripe\.com\//,
        );
        assert.equal(
          (
            await api(
              first.owner,
              'POST',
              `bookings/orders/${first.id}/refresh-payment`,
            )
          ).status,
          'awaiting_payment',
        );
        await api(
          'teacher',
          'POST',
          `bookings/orders/${first.id}/checkout`,
          undefined,
          404,
        );
      },
    );
    await t.test(
      'signed duplicate webhooks fulfill exactly once and persist after restart',
      async () => {
        const remote = stack.gateway.pay(first.id);
        const payload = JSON.stringify({
          id: 'evt_acceptance_paid',
          type: 'checkout.session.completed',
          livemode: false,
          data: { object: { id: remote.id } },
        });
        const timestamp = Math.floor(Date.now() / 1000),
          digest = createHmac('sha256', stack.webhookSecret)
            .update(timestamp + '.' + payload)
            .digest('hex');
        async function webhook(signature) {
          return fetch(stack.origin + '/api/v1/bookings/stripe/webhook', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'stripe-signature': signature,
            },
            body: payload,
          });
        }
        assert.equal((await webhook('invalid')).status, 400);
        assert.equal(
          (await webhook(`t=${timestamp},v1=${digest}`)).status,
          200,
        );
        assert.equal(
          (await webhook(`t=${timestamp},v1=${digest}`)).status,
          200,
        );
        for (let i = 0; i < 40; i++) {
          if (
            (await stack.bookings.orders.findById(first.id)).status ===
            'confirmed'
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await stack.bookings.verifyPayment(remote);
        first = {
          ...first,
          ...(await api(first.owner, 'GET', `bookings/orders/${first.id}`)),
        };
        assert.equal(first.status, 'confirmed');
        await api(
          first.owner,
          'GET',
          `class-sessions/${first.sessionId}?batchId=${first.batchId}`,
        );
        await api(
          first.owner === 'student' ? 'other' : 'student',
          'GET',
          `class-sessions/${first.sessionId}?batchId=${first.batchId}`,
          undefined,
          403,
        );
        assert.equal(
          await stack.connection.db
            .collection('invoices')
            .countDocuments({ orderId: first.id }),
          1,
        );
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            paymentOrderId: first.id,
            status: 'active',
          }),
          1,
        );
        assert.equal(
          await stack.bookings.classes.countDocuments({ _id: first.sessionId }),
          1,
        );
        await stack.restart();
        assert.equal(
          (await api(first.owner, 'GET', `bookings/orders/${first.id}`)).status,
          'confirmed',
        );
        await stack.bookings.verifyPayment(remote);
        assert.equal(
          await stack.connection.db
            .collection('invoices')
            .countDocuments({ orderId: first.id }),
          1,
        );
      },
    );
    let invoice;
    await t.test(
      'paid invoice is immutable and restricted to purchaser or admin',
      async () => {
        const read = async (name) =>
          fetch(stack.origin + `/api/v1/bookings/orders/${first.id}/invoice`, {
            headers: { authorization: 'Bearer ' + tokens[name] },
          });
        invoice = Buffer.from(await (await read(first.owner)).arrayBuffer());
        assert.equal(invoice.subarray(0, 4).toString(), '%PDF');
        assert.equal((await read('teacher')).status, 403);
        assert.equal(
          (await read(first.owner === 'student' ? 'other' : 'student')).status,
          404,
        );
        await stack.connection.db
          .collection('invoice_settings')
          .updateOne(
            { _id: 'issuer' },
            { $set: { 'value.seller.name': 'New issuer after sale' } },
          );
        assert.deepEqual(
          Buffer.from(await (await read(first.owner)).arrayBuffer()),
          invoice,
        );
        const stored = await stack.connection.db
          .collection('invoices')
          .findOne({ orderId: first.id });
        assert.equal(stored.seller.name, 'Acceptance Learning Ltd');
      },
    );
    await t.test(
      'partial and remaining refunds are idempotent, bounded, and retain original invoice',
      async () => {
        const requestId = randomUUID();
        await api('admin', 'POST', `admin/bookings/${first.id}/refunds`, {
          requestId,
          amountMinor: 2001,
          reason: 'Partial goodwill refund.',
        });
        await api('admin', 'POST', `admin/bookings/${first.id}/refunds`, {
          requestId,
          amountMinor: 2001,
          reason: 'Partial goodwill refund.',
        });
        await api(
          'admin',
          'POST',
          `admin/bookings/${first.id}/refunds`,
          {
            requestId: randomUUID(),
            amountMinor: 6000,
            reason: 'Exceeds remaining balance.',
          },
          409,
        );
        await stack.worker.tick();
        let value = await api(
          first.owner,
          'GET',
          `bookings/orders/${first.id}`,
        );
        assert.equal(value.refundedMinor, 2001);
        assert.equal(value.refunds.length, 1);
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            paymentOrderId: first.id,
            status: 'active',
          }),
          1,
        );
        await api(first.owner, 'POST', `bookings/orders/${first.id}/cancel`, {
          requestId: randomUUID(),
          reason: 'I cannot attend this lesson.',
        });
        stack.gateway.failRefundOnce = true;
        await stack.worker.tick();
        await stack.bookings.refunds.updateMany(
          { orderId: first.id, status: 'queued' },
          { $set: { nextAttemptAt: new Date(0) } },
        );
        await stack.worker.tick();
        value = await api(first.owner, 'GET', `bookings/orders/${first.id}`);
        assert.equal(value.status, 'refunded');
        assert.equal(value.refundedMinor, 6000);
        assert.equal(value.refundPendingMinor, 0);
        assert.equal(stack.gateway.refundCreates, 2);
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            paymentOrderId: first.id,
            status: 'active',
          }),
          0,
        );
        await api(
          first.owner,
          'GET',
          `class-sessions/${first.sessionId}?batchId=${first.batchId}`,
          undefined,
          403,
        );
        const credits = await stack.connection.db
          .collection('booking_credit_notes')
          .find({ orderId: first.id })
          .toArray();
        assert.equal(
          credits.reduce((sum, c) => sum + c.value.totals.totalMinor, 0),
          6000,
        );
        assert.equal(
          credits.reduce((sum, c) => sum + c.value.totals.taxMinor, 0),
          1000,
        );
        assert.equal(
          Buffer.from(await stack.bookings.billing.creditPdf(credits[0]._id))
            .subarray(0, 4)
            .toString(),
          '%PDF',
        );
        assert.deepEqual(
          await stack.bookings.billing.pdf(value.invoiceId),
          invoice,
        );
      },
    );
    await t.test(
      'lost checkout response recovers one session and cancellation safely releases it',
      async () => {
        const order = await reservation();
        stack.gateway.failCreateOnce = true;
        await api(
          'student',
          'POST',
          `bookings/orders/${order.id}/checkout`,
          undefined,
          503,
        );
        const before = stack.gateway.creates;
        await stack.bookings.reconcileOrder(order.id);
        assert.equal(stack.gateway.creates, before);
        await api('student', 'POST', `bookings/orders/${order.id}/cancel`, {
          requestId: randomUUID(),
          reason: 'Release the reserved lesson.',
        });
        await stack.bookings.reconcileOrder(order.id);
        assert.equal(stack.gateway.sessions.get(order.id).status, 'expired');
        assert.equal(
          (await stack.bookings.slots.findById(order.slotId)).status,
          'open',
        );
        // A delayed provider payment is refunded without taking the released slot back.
        await stack.bookings.verifyPayment(stack.gateway.pay(order.id));
        await stack.worker.tick();
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'refunded',
        );
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            paymentOrderId: order.id,
          }),
          0,
        );
      },
    );
    await t.test(
      'amount mismatch is quarantined without purchased access',
      async () => {
        const order = await reservation();
        await api('student', 'POST', `bookings/orders/${order.id}/checkout`);
        await stack.bookings.verifyPayment(
          stack.gateway.pay(order.id, { amountMinor: 1 }),
        );
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'payment_review',
        );
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            paymentOrderId: order.id,
          }),
          0,
        );
      },
    );
    await t.test(
      'payment arriving after account disablement is refunded',
      async () => {
        const order = await reservation();
        await api('student', 'POST', `bookings/orders/${order.id}/checkout`);
        await stack.bookings.users.updateOne(
          { _id: stack.users.student.id },
          { $set: { disabled: true } },
        );
        await stack.bookings.verifyPayment(stack.gateway.pay(order.id));
        await stack.worker.tick();
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'refunded',
        );
        await stack.bookings.users.updateOne(
          { _id: stack.users.student.id },
          { $set: { disabled: false } },
        );
      },
    );
    await t.test(
      'paid batch capacity cannot be oversold or bypassed by legacy enrollment',
      async () => {
        const batchId = randomUUID(),
          start = new Date(epoch + 30 * 3600000);
        await stack.bookings.batches.create({
          _id: batchId,
          name: 'Paid group acceptance',
          teacherId: stack.users.secondTeacher.id,
          year: start.getUTCFullYear(),
          startDate: start,
          endDate: new Date(start.getTime() + 2 * 3600000),
          maxCapacity: 1,
          feeAmount: 50,
          feeMinor: 5000,
          feeCurrency: 'EUR',
          status: 'ACTIVE',
        });
        await stack.bookings.classes.create({
          _id: randomUUID(),
          batchId,
          teacherId: stack.users.secondTeacher.id,
          title: 'Group lesson',
          sessionNumber: 1,
          scheduledAt: start,
          durationMinutes: 30,
          status: 'scheduled',
          roomId: 'acceptance-room-' + batchId,
          chatChannelId: 'acceptance-chat-' + batchId,
          whiteboardChannelId: 'acceptance-board-' + batchId,
        });
        await api(
          'student',
          'POST',
          `student-enrollments/me/batches/${batchId}`,
          undefined,
          403,
        );
        const bodies = ['student', 'other'].map(() => ({
          requestId: randomUUID(),
          expectedTotalMinor: 6000,
          billing,
        }));
        const outcomes = await Promise.all(
          ['student', 'other'].map(async (name, index) => {
            const response = await fetch(
              stack.origin + '/api/v1/bookings/batches/' + batchId + '/reserve',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: 'Bearer ' + tokens[name],
                },
                body: JSON.stringify(bodies[index]),
              },
            );
            return {
              name,
              status: response.status,
              value: await response.json(),
            };
          }),
        );
        assert.deepEqual(
          outcomes.map((item) => item.status).sort(),
          [201, 409],
        );
        const winner = outcomes.find((item) => item.status === 201),
          order = winner.value.data;
        await api(
          'admin',
          'POST',
          'student-enrollments',
          {
            studentId:
              stack.users[winner.name === 'student' ? 'other' : 'student'].id,
            batchId,
            status: 'active',
          },
          409,
        );
        await api(winner.name, 'POST', `bookings/orders/${order.id}/checkout`);
        await stack.bookings.verifyPayment(stack.gateway.pay(order.id));
        assert.equal(
          (await stack.bookings.batches.findById(batchId)).paymentReservedCount,
          0,
        );
        assert.equal(
          await stack.bookings.enrollments.countDocuments({
            batchId,
            status: 'active',
          }),
          1,
        );
        await api(
          winner.name,
          'DELETE',
          `student-enrollments/me/batches/${batchId}`,
          undefined,
          409,
        );
        await api(winner.name, 'POST', `bookings/orders/${order.id}/cancel`, {
          requestId: randomUUID(),
          reason: 'Cancel the purchased group class.',
        });
        await stack.worker.tick();
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'refunded',
        );
      },
    );
    await t.test(
      'customer cancellation deadline and active lesson refund guards apply',
      async () => {
        const order = await paid();
        await stack.bookings.orders.updateOne(
          { _id: order.id },
          { $set: { cancellationDeadline: new Date(0) } },
        );
        await api(
          'student',
          'POST',
          `bookings/orders/${order.id}/cancel`,
          { requestId: randomUUID(), reason: 'Too late for self service.' },
          409,
        );
        await stack.bookings.classes.updateOne(
          { _id: order.sessionId },
          { $set: { status: 'live' } },
        );
        await api(
          'admin',
          'POST',
          `admin/bookings/${order.id}/refunds`,
          {
            requestId: randomUUID(),
            amountMinor: 6000,
            reason: 'Full refund during a live lesson.',
          },
          409,
        );
        await stack.bookings.classes.updateOne(
          { _id: order.sessionId },
          { $set: { status: 'completed' } },
        );
        await api('teacher', 'POST', `bookings/orders/${order.id}/cancel`, {
          requestId: randomUUID(),
          reason: 'Teacher-authorized refund.',
        });
        await stack.worker.tick();
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'refunded',
        );
      },
    );
    await t.test(
      'concurrent refunds reserve one balance and provider-side credits reconcile exactly',
      async () => {
        const order = await paid();
        const responses = await Promise.all(
          [1, 2].map(() =>
            fetch(
              stack.origin + '/api/v1/admin/bookings/' + order.id + '/refunds',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: 'Bearer ' + tokens.admin,
                },
                body: JSON.stringify({
                  requestId: randomUUID(),
                  amountMinor: 4000,
                  reason: 'Concurrent partial refund test.',
                }),
              },
            ),
          ),
        );
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [201, 409],
        );
        await stack.worker.tick();
        const intent = (await stack.bookings.orders.findById(order.id))
          .paymentIntentId;
        const external = {
          id: 're_external_' + order.id,
          paymentIntentId: intent,
          amountMinor: 2000,
          currency: 'eur',
          status: 'succeeded',
        };
        stack.gateway.remoteRefunds.set(external.id, external);
        await stack.bookings.syncRefund(external);
        await stack.bookings.syncRefund(external);
        const current = await stack.bookings.orders.findById(order.id);
        assert.equal(current.status, 'refunded');
        assert.equal(current.refundedMinor, 6000);
        assert.equal(
          await stack.connection.db
            .collection('booking_credit_notes')
            .countDocuments({ orderId: order.id }),
          2,
        );
      },
    );
    await t.test(
      'payment racing cancellation cannot bypass the saved refund deadline',
      async () => {
        const order = await reservation();
        await api('student', 'POST', `bookings/orders/${order.id}/checkout`);
        await stack.bookings.orders.updateOne(
          { _id: order.id },
          { $set: { cancellationDeadline: new Date(0) } },
        );
        const original = stack.bookings.ownedOrder;
        let raced = false;
        try {
          stack.bookings.ownedOrder = async function (...args) {
            const initial = await original.apply(this, args);
            if (!raced) {
              raced = true;
              await this.verifyPayment(stack.gateway.pay(order.id));
            }
            return initial;
          };
          await api(
            'student',
            'POST',
            `bookings/orders/${order.id}/cancel`,
            {
              requestId: randomUUID(),
              reason: 'Payment is confirmed during cancellation.',
            },
            409,
          );
          assert.equal(
            (await stack.bookings.orders.findById(order.id)).status,
            'confirmed',
          );
        } finally {
          stack.bookings.ownedOrder = original;
        }
        await api('teacher', 'POST', `bookings/orders/${order.id}/cancel`, {
          requestId: randomUUID(),
          reason: 'Teacher-approved exception after deadline.',
        });
        await stack.worker.tick();
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'refunded',
        );
      },
    );
    await t.test(
      'definitive refund rejection releases the balance after checking provider truth',
      async () => {
        const Stripe = require('stripe');
        const order = await paid();
        await api('admin', 'POST', `admin/bookings/${order.id}/refunds`, {
          requestId: randomUUID(),
          amountMinor: 2000,
          reason: 'Verify rejected refund recovery.',
        });
        const original = stack.gateway.refund;
        try {
          stack.gateway.refund = async () => {
            throw new Stripe.errors.StripeInvalidRequestError({
              type: 'invalid_request_error',
              message: 'Synthetic definitive rejection',
            });
          };
          await stack.worker.tick();
          const current = await stack.bookings.orders.findById(order.id);
          assert.equal(current.refundPendingMinor, 0);
          assert.equal(current.refundedMinor, 0);
          assert.equal(
            (await stack.bookings.refunds.findOne({ orderId: order.id }))
              .status,
            'failed',
          );
          assert.equal(
            await stack.connection.db
              .collection('booking_credit_notes')
              .countDocuments({ orderId: order.id }),
            0,
          );
        } finally {
          stack.gateway.refund = original;
        }
        await api('admin', 'POST', `admin/bookings/${order.id}/refunds`, {
          requestId: randomUUID(),
          amountMinor: 6000,
          reason: 'Authorized retry after rejection.',
        });
        await stack.worker.tick();
        assert.equal(
          (await stack.bookings.orders.findById(order.id)).status,
          'refunded',
        );
      },
    );
    await t.test(
      'credit-note email retries preserve the settled refund and attach its actual PDF',
      async () => {
        const { ConfigService } = require('@nestjs/config');
        const {
          EmailNotificationService,
        } = require('../../apps/backend/dist/notifications/email-notification.service.js');
        const config = stack.app.get(ConfigService),
          email = stack.app.get(EmailNotificationService);
        const original = email.sendEmail;
        let attachment;
        try {
          config.set('notifications.email.enabled', true);
          email.sendEmail = async (message) => {
            attachment = message.attachments[0].content;
            return { delivered: false };
          };
          await stack.worker.tick();
          const pending = await stack.connection.db
            .collection('booking_credit_notes')
            .findOne({ emailStatus: 'pending', emailAttempts: { $gte: 1 } });
          assert.ok(pending);
          assert.equal(
            Buffer.from(attachment).subarray(0, 4).toString(),
            '%PDF',
          );
          assert.equal(
            (await stack.bookings.orders.findById(pending.orderId)).status,
            'refunded',
          );
          await stack.connection.db
            .collection('booking_credit_notes')
            .updateOne(
              { _id: pending._id },
              { $set: { emailNextAttemptAt: new Date(0) } },
            );
          email.sendEmail = async () => ({ delivered: true });
          await stack.worker.tick();
          assert.equal(
            (
              await stack.connection.db
                .collection('booking_credit_notes')
                .findOne({ _id: pending._id })
            ).emailStatus,
            'sent',
          );
        } finally {
          config.set('notifications.email.enabled', false);
          email.sendEmail = original;
        }
      },
    );
  },
);
