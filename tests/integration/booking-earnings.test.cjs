'use strict';
// Real HTTP, replica-set transactions, financial indexes and journal aggregates.
// Only the payment-provider network is substituted; no real funds move.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');

test('bookings fund exact, currency-separated teacher earnings and guarded payouts', { timeout: 360000 }, async t => {
  const stack = await startBookingStack({ paymentsEnabled: true });
  t.after(() => stack.stop());
  const { BookingFinanceService } = require('../../apps/backend/dist/payments/booking-finance.service.js');
  const { LedgerService } = require('../../apps/backend/dist/payments/ledger.service.js');
  const { PAYMENT_GATEWAY } = require('../../apps/backend/dist/payments/gateways/payment-gateway.js');
  const finance = stack.app.get(BookingFinanceService), ledger = stack.app.get(LedgerService), provider = stack.app.get(PAYMENT_GATEWAY);
  const db = stack.connection.db, tokens = {};
  async function api(name, method, endpoint, body, expected = method === 'POST' ? 201 : 200) {
    const response = await fetch(stack.origin + '/api/v1/' + endpoint, { method, headers: { 'content-type': 'application/json', ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json(); assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(envelope)); return envelope.data ?? envelope;
  }
  for (const name of ['teacher', 'student', 'admin', 'other']) tokens[name] = (await api(name, 'POST', 'auth/login', { email: stack.users[name].email, password: stack.password }, 200)).accessToken;
  const billing = { name: 'Finance acceptance learner', email: stack.users.student.email, address: '123 Synthetic Street', countryCode: 'GB', vatNumber: '' };
  let offset = 0;
  async function settings(patch = {}) {
    const current = await api('admin', 'GET', 'admin/finance/settings');
    return api('admin', 'PATCH', 'admin/finance/settings', { version: current.version, commissionBps: 1500, holdDays: 0, minimumPayoutMinor: 100, enabledCurrencies: ['USD'], teacherOverrides: [], payoutMinimums: [{ currency: 'EUR', minimumMinor: 100 }, { currency: 'JPY', minimumMinor: 1 }, { currency: 'KWD', minimumMinor: 1 }], ...patch });
  }
  await settings();
  async function reserve(currency = 'EUR', netMinor = 10000) {
    const offer = await api('teacher', 'POST', 'bookings/teacher/offers', { title: 'Finance lesson ' + (++offset), description: 'Synthetic accounting acceptance lesson.', durationMinutes: 30, amountMinor: netMinor, currency, active: true });
    const slot = await api('teacher', 'POST', 'bookings/teacher/slots', { offerId: offer.id, startsAt: new Date(Math.ceil((Date.now() + (72 + offset) * 3600000) / 300000) * 300000).toISOString() });
    return api('student', 'POST', 'bookings/slots/' + slot.id + '/reserve', { requestId: randomUUID(), expectedTotalMinor: offer.price.amountMinor, expectedOfferVersion: offer.version, billing });
  }
  async function pay(order, fee = 0) {
    await api('student', 'POST', 'bookings/orders/' + order.id + '/checkout');
    const remote = stack.gateway.pay(order.id, { fee: { amountMinor: fee, currency: order.price.currency } });
    await stack.bookings.verifyPayment(remote);
    return db.collection('booking_orders').findOne({ _id: order.id });
  }
  async function mature(id, completed = true) {
    const order = await db.collection('booking_orders').findOne({ _id: id });
    await db.collection('booking_orders').updateOne({ _id: id }, { $set: { endsAt: new Date(Date.now() - 60000), earningsAvailableAt: new Date(0), earningsNextCheckAt: new Date(0) } });
    if (completed) await stack.bookings.classes.updateMany({ batchId: order.batchId }, { $set: { status: 'completed', completedAt: new Date() } });
  }
  async function balance(currency = 'EUR') { return (await api('teacher', 'GET', 'teacher/earnings')).balances.find(item => item.currency === currency); }
  async function refund(orderId, amount, status = 'succeeded', retryOfRefundId) {
    const requestId = randomUUID();
    const actor = { sub: stack.users.admin.id, email: stack.users.admin.email, roles: ['SUPER_ADMIN', 'ADMIN'], permissions: [], tokenId: 'fixture' };
    await stack.bookings.requestRefund(actor, orderId, amount, requestId, 'Synthetic verified refund adjustment', retryOfRefundId);
    const request = await db.collection('booking_refunds').findOne({ orderId, requestId });
    const order = await db.collection('booking_orders').findOne({ _id: orderId });
    const remote = await stack.gateway.refund(order.paymentIntentId, amount, request._id);
    remote.status = status;
    await stack.bookings.syncRefund(remote);
    return { request, remote };
  }
  let first;
  await t.test('snapshot commission excludes tax and fulfillment+journal roll back together', async () => {
    const order = await reserve();
    await settings({ commissionBps: 5000 });
    await api('student', 'POST', 'bookings/orders/' + order.id + '/checkout');
    const remote = stack.gateway.pay(order.id, { fee: { amountMinor: 117, currency: 'EUR' } });
    const post = ledger.post.bind(ledger);
    let fail = true;
    ledger.post = async (draft, session) => { if (fail && draft.bookingOrderId === order.id) { fail = false; throw new Error('Synthetic journal outage'); } return post(draft, session); };
    try { await assert.rejects(stack.bookings.verifyPayment(remote)); } finally { ledger.post = post; }
    const rolledBack = await db.collection('booking_orders').findOne({ _id: order.id });
    assert.equal(rolledBack.paidAt, undefined);
    assert.equal(await db.collection('invoices').countDocuments({ orderId: order.id }), 0);
    await Promise.all([stack.bookings.verifyPayment(remote), stack.bookings.verifyPayment(remote)]);
    first = await db.collection('booking_orders').findOne({ _id: order.id });
    assert.equal(first.earningsPolicy.commissionBps, 1500);
    assert.equal(first.earningsPolicy.commissionMinor, 1500);
    assert.equal(first.earningsPolicy.teacherMinor, 8500);
    assert.equal(await db.collection('ledger_entries').countDocuments({ key: 'booking:' + order.id + ':captured' }), 1);
    const b = await balance(); assert.equal(b.pendingMinor, 8500); assert.equal(b.availableMinor, 0); assert.equal(b.grossMinor, 10000);
    const report = await api('admin', 'GET', 'admin/finance/overview?currency=EUR');
    assert.equal(report.grossMinor, 12000); assert.equal(report.teacherEarningsMinor, 8500); assert.equal(report.commissionMinor, 1500); assert.equal(report.taxPayableMinor, 2000); assert.equal(report.gatewayFeesMinor, 117); assert.equal(report.successfulPayments, 1);
    await settings();
  });
  await t.test('requires completed service and holding period, then releases exactly once', async () => {
    await mature(first._id, false);
    assert.equal(await finance.releaseDue(), 0);
    assert.equal((await balance()).availableMinor, 0);
    await mature(first._id);
    await Promise.all([finance.releaseDue(), finance.releaseDue()]);
    const b = await balance(); assert.equal(b.pendingMinor, 0); assert.equal(b.availableMinor, 8500);
    assert.equal(await db.collection('ledger_entries').countDocuments({ key: 'booking:' + first._id + ':released' }), 1);
    const lines = await api('teacher', 'GET', 'teacher/earnings/transactions?currency=EUR');
    assert.ok(lines.items.some(row => row.bookingOrderId === first._id && row.grossMinor === 10000 && row.taxMinor === 2000));
    const overview = await api('admin', 'GET', 'admin/finance/overview?currency=EUR');
    assert.equal(overview.grossMinor, 12000); assert.equal(overview.commissionMinor, 1500);
    assert.equal(overview.teacherEarningsMinor, 8500); assert.equal(overview.taxPayableMinor, 2000);
    assert.equal(overview.gatewayFeesMinor, 117); assert.equal(overview.platformNetMinor, 1383);
    const eventId = randomUUID();
    const events = stack.app.get(require('../../apps/backend/dist/payments/payment-events.service.js').PaymentEventsService);
    await events.ingest('test', { kind: 'checkout.completed', eventId, sessionId: first.stripeSessionId, gatewayPaymentId: first.paymentIntentId, amountMinor: 12000, currency: 'EUR', paid: true });
    assert.equal((await db.collection('payment_gateway_events').findOne({ _id: 'test:' + eventId })).status, 'done');
    assert.equal(await db.collection('payments').countDocuments(), 0);
  });
  await t.test('payout reservations roll back and concurrent requests cannot overspend', async () => {
    await api('teacher', 'POST', 'teacher/earnings/payout-account/onboarding');
    const post = ledger.post.bind(ledger);
    ledger.post = async (draft, session) => { if (draft.type === 'payout_requested') throw new Error('Synthetic reservation journal outage'); return post(draft, session); };
    try { await api('teacher', 'POST', 'teacher/earnings/payouts', { currency: 'EUR', amountMinor: 7000, requestId: randomUUID() }, 500); } finally { ledger.post = post; }
    assert.equal(await db.collection('teacher_payouts').countDocuments({ teacherId: stack.users.teacher.id }), 0);
    const requests = [randomUUID(), randomUUID()];
    const responses = await Promise.all(requests.map(requestId => fetch(stack.origin + '/api/v1/teacher/earnings/payouts', { method: 'POST', headers: { authorization: 'Bearer ' + tokens.teacher, 'content-type': 'application/json' }, body: JSON.stringify({ currency: 'EUR', amountMinor: 7000, requestId }) })));
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 400]);
    const b = await balance(); assert.equal(b.reservedMinor, 7000); assert.equal(b.availableMinor, 1500);
  });
  let paidPayout;
  await t.test('pending/failed refunds pause payouts; confirmed refunds adjust earnings without duplication', async () => {
    const payout = await db.collection('teacher_payouts').findOne({ teacherId: stack.users.teacher.id, status: 'requested' });
    const failed = await refund(first._id, 2400, 'failed');
    assert.equal((await balance()).availableMinor, 1500);
    await api('admin', 'POST', 'admin/finance/payouts/' + payout._id + '/approve', {}, 400);
    const retried = await refund(first._id, 2400, 'pending', failed.request._id);
    await api('admin', 'POST', 'admin/finance/payouts/' + payout._id + '/approve', {}, 400);
    retried.remote.status = 'succeeded';
    await stack.bookings.syncRefund(retried.remote); await stack.bookings.syncRefund(retried.remote);
    assert.equal((await balance()).availableMinor, -200);
    await api('admin', 'POST', 'admin/finance/payouts/' + payout._id + '/approve', {}, 400);
    await api('admin', 'POST', 'admin/finance/payouts/' + payout._id + '/reject', { note: 'Adjust payout to reflect confirmed booking refund.' });
    assert.equal((await balance()).availableMinor, 6800);
    const input = { currency: 'EUR', amountMinor: 6800, requestId: randomUUID() };
    const request = await api('teacher', 'POST', 'teacher/earnings/payouts', input);
    assert.equal((await api('teacher', 'POST', 'teacher/earnings/payouts', input)).id, request.id);
    await api('teacher', 'POST', 'teacher/earnings/payouts', { ...input, amountMinor: 6700 }, 409);
    paidPayout = await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/approve', {});
    assert.equal(paidPayout.status, 'paid'); assert.equal((await balance()).paidOutMinor, 6800);
  });
  await t.test('post-payout refunds create a visible debt that future earnings offset', async () => {
    await refund(first._id, 9600);
    assert.equal((await balance()).availableMinor, -6800);
    const next = await pay(await reserve()); await mature(next._id); await finance.releaseDue();
    assert.equal((await balance()).availableMinor, 1700);
    const prior = (await ledger.accountTotals({ teacherId: stack.users.teacher.id, currency: 'EUR' })).sort((a, b) => a.account.localeCompare(b.account));
    const journal = await db.collection('ledger_entries').findOne({ bookingOrderId: first._id, type: 'refund' });
    await db.collection('ledger_entries').deleteOne({ _id: journal._id });
    await api('admin', 'POST', 'admin/finance/booking-earnings/' + first._id + '/repair', {});
    assert.deepEqual((await ledger.accountTotals({ teacherId: stack.users.teacher.id, currency: 'EUR' })).sort((a, b) => a.account.localeCompare(b.account)), prior);
  });
  await t.test('zero- and three-decimal currencies retain their original minor units', async () => {
    const yen = await pay(await reserve('JPY', 101));
    const dinar = await pay(await reserve('KWD', 1001));
    assert.equal((await balance('JPY')).pendingMinor, 86); assert.equal((await balance('KWD')).pendingMinor, 851);
    await mature(yen._id); await mature(dinar._id); await finance.releaseDue();
    const request = await api('teacher', 'POST', 'teacher/earnings/payouts', { currency: 'KWD', amountMinor: 851, requestId: randomUUID() });
    await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/approve', {});
    assert.equal((await balance('KWD')).paidOutMinor, 851); assert.equal((await balance('JPY')).availableMinor, 86);
    assert.equal((await balance('EUR')).availableMinor, 1700);
  });
  await t.test('historical adoption requires verified payment, an explicit policy and a reason', async () => {
    const legacy = await pay(await reserve());
    await refund(legacy._id, 6000);
    await db.collection('ledger_entries').deleteMany({ bookingOrderId: legacy._id });
    await db.collection('booking_orders').updateOne({ _id: legacy._id }, { $unset: { earningsPolicy: '', earningsCreditedAt: '', earningsAvailableAt: '', earningsNextCheckAt: '', gatewayFeeMinor: '', gatewayFeeCurrency: '', gatewayFeeRecordedAt: '' } });
    await db.collection('booking_refunds').updateMany({ orderId: legacy._id }, { $unset: { earningsAllocation: '', earningsBucket: '' } });
    const list = await api('admin', 'GET', 'admin/finance/booking-earnings/legacy');
    const row = list.items.find(order => order.orderId === legacy._id); assert.ok(row);
    const body = { commissionBps: 2000, holdDays: 0, reason: 'Reviewed the historical commission agreement.', expectedUpdatedAt: row.updatedAt };
    await api('teacher', 'POST', 'admin/finance/booking-earnings/' + legacy._id + '/adopt', body, 403);
    await api('admin', 'POST', 'admin/finance/booking-earnings/' + legacy._id + '/adopt', body);
    await api('admin', 'POST', 'admin/finance/booking-earnings/' + legacy._id + '/adopt', body);
    const entries = await db.collection('ledger_entries').find({ bookingOrderId: legacy._id }).toArray();
    assert.equal(entries.filter(entry => entry.type === 'payment_captured').length, 1);
    assert.equal(entries.filter(entry => entry.type === 'refund').length, 1);
    const stored = await db.collection('booking_orders').findOne({ _id: legacy._id });
    assert.equal(stored.earningsPolicy.teacherMinor, 8000);
    assert.equal(stored.earningsPolicy.source, 'legacy_review');
    await api('admin', 'POST', 'admin/finance/booking-earnings/' + legacy._id + '/adopt', { ...body, commissionBps: 3000 }, 409);
    assert.equal(await db.collection('audit_logs').countDocuments({ action: 'booking.earnings_policy_reviewed', resourceId: legacy._id }), 1);
  });
  await t.test('provider disputes hold only the affected currency and never silently clear losses', async () => {
    const order = await db.collection('booking_orders').findOne({ teacherId: stack.users.teacher.id, 'invoiceSource.currency': 'EUR', earningsReleasedMinor: 8500, refundedMinor: 0 });
    const request = await api('teacher', 'POST', 'teacher/earnings/payouts', { currency: 'EUR', amountMinor: 100, requestId: randomUUID() });
    const dispute = { id: 'du_test_' + order._id, paymentIntentId: order.paymentIntentId, orderId: order._id, amountMinor: 12000, currency: 'EUR', status: 'needs_response', livemode: false };
    stack.gateway.remoteDisputes.set(dispute.id, dispute);
    // Exercise the durable worker inbox, including a restart-style event replay.
    await db.collection('payment_webhook_events').insertOne({ _id: randomUUID(), eventType: 'charge.dispute.created', objectId: dispute.id, status: 'received', attempts: 0, nextAttemptAt: new Date(0) });
    await stack.worker.tick();
    const eventId = randomUUID();
    const events = stack.app.get(require('../../apps/backend/dist/payments/payment-events.service.js').PaymentEventsService);
    await events.ingest('test', { kind: 'dispute.updated', eventId, gatewayDisputeId: dispute.id, gatewayPaymentId: order.paymentIntentId, amountMinor: 12000, currency: 'EUR', feeMinor: 0, reason: 'fraudulent', status: 'needs_response', inquiry: false });
    assert.equal((await db.collection('payment_gateway_events').findOne({ _id: 'test:' + eventId })).status, 'done');
    assert.match((await balance()).payoutBlockedReason, /disputed/);
    await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/approve', {}, 400);
    await api('teacher', 'POST', 'teacher/earnings/payouts', { currency: 'EUR', amountMinor: 100, requestId: randomUUID() }, 400);
    assert.equal((await balance('JPY')).payoutBlockedReason, undefined);
    assert.ok((await api('admin', 'GET', 'admin/finance/reconciliation')).bookingEarnings.disputedOrderIds.includes(order._id));
    await finance.recordDispute({ ...dispute, status: 'lost' });
    await finance.recordDispute(dispute); // An older open snapshot must not overwrite terminal facts.
    assert.equal((await db.collection('booking_orders').findOne({ _id: order._id })).earningsDisputes[0].status, 'lost');
    assert.match((await balance()).payoutBlockedReason, /disputed/);
    // A provider-confirmed late win can restore the hold; local operators cannot mark a dispute won.
    dispute.status = 'won'; stack.gateway.remoteDisputes.set(dispute.id, dispute);
    await finance.recordDispute(await stack.gateway.retrieveDispute(dispute.id));
    assert.equal((await balance()).payoutBlockedReason, undefined);
    await api('teacher', 'POST', 'teacher/earnings/payouts/' + request.id + '/cancel', {});
  });
  await t.test('unknown transfer outcomes retain reserves and require provider proof after the retry window', async () => {
    const request = await api('teacher', 'POST', 'teacher/earnings/payouts', { currency: 'EUR', amountMinor: 1700, requestId: randomUUID() });
    const send = provider.transfer.bind(provider); let transfer;
    provider.transfer = async input => { transfer = await send(input); throw new Error('Synthetic lost provider response'); };
    try { await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/approve', {}, 503); } finally { provider.transfer = send; }
    assert.equal((await balance()).reservedMinor, 1700);
    const payoutEvents = stack.app.get(require('../../apps/backend/dist/payments/payouts.service.js').PayoutsService);
    await assert.rejects(payoutEvents.applyEvent({ kind: 'transfer.reversed', eventId: randomUUID(), transferId: 'tr_unverified_foreign', amountReversedMinor: 1, payoutRef: request.id }));
    assert.equal((await balance()).reservedMinor, 1700);
    await db.collection('teacher_payouts').updateOne({ _id: request.id }, { $set: { leaseUntil: new Date(0), transferAttemptedAt: new Date(Date.now() - 25 * 3600000) } });
    await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/approve', {}, 409);
    const reconciled = await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/reconcile', { transferId: transfer.transferId, reason: 'Verified original transfer after a lost response.' });
    assert.equal(reconciled.status, 'paid'); assert.equal((await balance()).reservedMinor, 0);
    await api('admin', 'POST', 'admin/finance/payouts/' + request.id + '/reconcile', { transferId: paidPayout.gatewayTransferId, reason: 'Wrong transfer must never be matched to this request.' }, 409);
    const payouts = stack.app.get(require('../../apps/backend/dist/payments/payouts.service.js').PayoutsService);
    for (const amount of [500, 300, 1000, 1000]) await payouts.applyEvent({ kind: 'transfer.reversed', eventId: randomUUID(), transferId: transfer.transferId, amountReversedMinor: amount, payoutRef: request.id });
    assert.equal((await db.collection('teacher_payouts').findOne({ _id: request.id })).reversedMinor, 1000);
    assert.equal(await db.collection('ledger_entries').countDocuments({ payoutId: request.id, type: 'payout_reversed' }), 2);
  });
  await t.test('batch earnings wait for every class and recover release metadata without another credit', async () => {
    const batchId = randomUUID(), start = new Date(Date.now() + 200 * 3600000);
    await stack.bookings.batches.create({ _id: batchId, name: 'Finance group completion', teacherId: stack.users.secondTeacher.id, year: start.getUTCFullYear(), startDate: start, endDate: new Date(start.getTime() + 2 * 3600000), maxCapacity: 5, feeAmount: 50, feeMinor: 5000, feeCurrency: 'EUR', status: 'ACTIVE' });
    const classIds = [randomUUID(), randomUUID()];
    for (let i = 0; i < 2; i++) await stack.bookings.classes.create({ _id: classIds[i], batchId, teacherId: stack.users.secondTeacher.id, title: 'Group lesson ' + i, sessionNumber: i + 1, scheduledAt: new Date(start.getTime() + i * 3600000), durationMinutes: 30, status: 'scheduled', roomId: 'room-' + classIds[i], chatChannelId: 'chat-' + classIds[i], whiteboardChannelId: 'board-' + classIds[i] });
    const order = await api('student', 'POST', 'bookings/batches/' + batchId + '/reserve', { requestId: randomUUID(), expectedTotalMinor: 6000, billing });
    await pay(order); await mature(order.id, false);
    await stack.bookings.classes.updateOne({ _id: classIds[0] }, { $set: { status: 'completed' } });
    await finance.releaseDue();
    assert.equal(await db.collection('ledger_entries').countDocuments({ key: 'booking:' + order.id + ':released' }), 0);
    await stack.bookings.classes.updateOne({ _id: classIds[1] }, { $set: { status: 'completed' } });
    await db.collection('booking_orders').updateOne({ _id: order.id }, { $set: { earningsNextCheckAt: new Date(0) } });
    await finance.releaseDue();
    const release = await db.collection('ledger_entries').findOne({ key: 'booking:' + order.id + ':released' });
    assert.equal(release.lines.find(line => line.account === 'teacher_available').creditMinor, 4250);
    await db.collection('booking_orders').updateOne({ _id: order.id }, { $unset: { earningsReleasedAt: '', earningsReleasedMinor: '' } });
    await finance.releaseDue();
    assert.equal((await db.collection('booking_orders').findOne({ _id: order.id })).earningsReleasedMinor, 4250);
    assert.equal(await db.collection('ledger_entries').countDocuments({ key: 'booking:' + order.id + ':released' }), 1);
  });
  assert.equal((await api('admin', 'GET', 'admin/finance/reconciliation')).ledgerBalanced, true);
});
