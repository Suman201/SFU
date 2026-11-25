'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcrypt');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');

test('payment branch coexists with bookings, currency and staff access', { timeout: 420000 }, async (t) => {
  const stack = await startBookingStack({ paymentsEnabled: true, debug: Boolean(process.env.PAYMENT_MERGE_DEBUG) });
  t.after(() => stack.stop());
  const tokens = {};
  async function api(name, method, endpoint, data, expected = method === 'POST' ? 201 : 200) {
    const response = await fetch(stack.origin + '/api/v1/' + endpoint, {
      method,
      headers: { 'content-type': 'application/json', ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const json = await response.json();
    assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(json));
    return json.data ?? json;
  }
  for (const [name, user] of Object.entries(stack.users))
    tokens[name] = (await api(name, 'POST', 'auth/login', { email: user.email, password: stack.password }, 200)).accessToken;
  async function batch(currency = 'USD', capacity = 2) {
    const id = randomUUID();
    const startsAt = new Date(Date.now() + 7 * 86400000);
    await stack.bookings.batches.create({
      _id: id, name: 'Payment integration ' + id.slice(0, 6), teacherId: stack.users.teacher.id,
      year: startsAt.getUTCFullYear(), startDate: startsAt, endDate: new Date(startsAt.getTime() + 3600000),
      maxCapacity: capacity, feeAmount: 100, feeMinor: 10000, feeCurrency: currency, status: 'ACTIVE',
    });
    await stack.bookings.classes.create({
      _id: randomUUID(), batchId: id, teacherId: stack.users.teacher.id, title: 'Integration class', sessionNumber: 1,
      scheduledAt: startsAt, durationMinutes: 30, status: 'scheduled', roomId: 'payment-' + id,
      chatChannelId: 'chat-' + id, whiteboardChannelId: 'board-' + id,
    });
    return id;
  }
  function reservation(name) {
    return { requestId: randomUUID(), expectedTotalMinor: 12000, billing: {
      name: 'Synthetic learner', email: stack.users[name].email, address: '123 Test Street', countryCode: 'US', vatNumber: '',
    } };
  }
  const settings = await api('admin', 'GET', 'admin/finance/settings');
  await api('admin', 'PATCH', 'admin/finance/settings', {
    version: settings.version, commissionBps: 1500, holdDays: 0, minimumPayoutMinor: 100, enabledCurrencies: ['USD'], teacherOverrides: [],
  });
  let payment;
  await t.test('retains original currency and blocks free paid enrollment', async () => {
    const euro = await batch('EUR');
    await api('student', 'POST', 'payments/checkout', { batchId: euro }, 400);
    const legacy = await batch();
    await stack.bookings.batches.updateOne({ _id: legacy }, { $unset: { feeCurrency: '', feeMinor: '' } });
    await api('student', 'POST', 'payments/checkout', { batchId: legacy }, 400);
    const paid = await batch();
    await api('student', 'POST', 'student-enrollments/me/batches/' + paid, undefined, 402);
    const first = await api('student', 'POST', 'payments/checkout', { batchId: paid });
    const again = await api('student', 'POST', 'payments/checkout', { batchId: paid });
    assert.equal(again.paymentId, first.paymentId);
    payment = await api('student', 'POST', 'payments/test-gateway/' + first.paymentId + '/complete', { outcome: 'succeed' });
    assert.equal(payment.status, 'succeeded');
    const stored = await api('admin', 'GET', 'admin/finance/payments/' + payment.id);
    assert.equal(stored.amountMinor, 10000);
    assert.equal(stored.currency, 'USD');
    assert.equal(stored.commissionMinor, 1500);
    assert.equal(stored.teacherMinor, 8500);
    assert.equal(stored.enrollmentState, 'granted');
    const receipt = await fetch(stack.origin + '/api/v1/payments/me/' + payment.id + '/receipt', { headers: { authorization: 'Bearer ' + tokens.student } });
    assert.equal(receipt.status, 200);
    assert.equal(Buffer.from(await receipt.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  });
  await t.test('booking reservations protect the last seat from new checkout', async () => {
    const id = await batch('USD', 1);
    await api('student', 'POST', 'bookings/batches/' + id + '/reserve', reservation('student'));
    await api('other', 'POST', 'payments/checkout', { batchId: id }, 409);
  });
  await t.test('new checkout holds protect the last seat from bookings and admin enrollment', async () => {
    const id = await batch('USD', 1);
    await api('student', 'POST', 'payments/checkout', { batchId: id });
    await api('other', 'POST', 'bookings/batches/' + id + '/reserve', reservation('other'), 409);
    await api('admin', 'POST', 'admin/enrollments', { studentId: stack.users.other.id, batchId: id, status: 'active' }, 409);
  });
  await t.test('refund retries do not double reverse commission', async () => {
    const request = { amountMinor: 5000, reason: 'Synthetic merge acceptance refund', requestId: randomUUID() };
    const first = await api('admin', 'POST', 'admin/finance/payments/' + payment.id + '/refunds', request);
    const again = await api('admin', 'POST', 'admin/finance/payments/' + payment.id + '/refunds', request);
    assert.equal(first.id, again.id);
    const stored = await api('admin', 'GET', 'admin/finance/payments/' + payment.id);
    assert.equal(stored.refundedMinor, 5000);
    assert.equal(stored.refunds.length, 1);
  });
  await t.test('teacher earnings can be released and paid out exactly once', async () => {
    const { PaymentsService } = require('../../apps/backend/dist/payments/payments.service.js');
    await stack.app.get(PaymentsService).releaseDueEarnings();
    await api('teacher', 'POST', 'teacher/earnings/payout-account/onboarding');
    await api('teacher', 'POST', 'teacher/earnings/payout-account/refresh');
    const summary = await api('teacher', 'GET', 'teacher/earnings');
    assert.equal(summary.balances.find((b) => b.currency === 'USD').availableMinor, 4250);
    const input = { currency: 'USD', amountMinor: 4250, requestId: randomUUID() };
    const payout = await api('teacher', 'POST', 'teacher/earnings/payouts', input);
    const again = await api('teacher', 'POST', 'teacher/earnings/payouts', input);
    assert.equal(again.id, payout.id);
    const sent = await api('admin', 'POST', 'admin/finance/payouts/' + payout.id + '/approve', { note: 'Synthetic merge acceptance' });
    assert.equal(sent.status, 'paid');
    const repeated = await api('admin', 'POST', 'admin/finance/payouts/' + payout.id + '/approve', {});
    assert.equal(repeated.gatewayTransferId, sent.gatewayTransferId);
    const report = await api('admin', 'GET', 'admin/finance/reconciliation');
    assert.equal(report.ledgerBalanced, true);
  });
  await t.test('managed Finance readers cannot mutate payments or payouts', async () => {
    const staff = await stack.bookings.users.create({ name: 'Finance Reader', displayName: 'Finance Reader', email: 'finance-reader@booking.test', passwordHash: await bcrypt.hash(stack.password, 4), roles: ['ADMIN'], permissions: [], status: 'active', disabled: false });
    const role = await api('admin', 'POST', 'admin/staff/roles', { name: 'Payment Finance reader', description: 'Synthetic acceptance profile', status: 'active', permissions: ['admin:finance:read'] });
    await api('admin', 'POST', 'admin/staff/members/' + staff.id + '/role', { roleId: role.id, expectedRoleId: null, reason: 'Verify payment merge permissions.' });
    tokens.reader = (await api('reader', 'POST', 'auth/login', { email: staff.email, password: stack.password }, 200)).accessToken;
    await api('reader', 'GET', 'admin/finance/payments/' + payment.id);
    await api('reader', 'POST', 'admin/finance/payments/' + payment.id + '/refunds', { amountMinor: 100, reason: 'Unauthorized refund attempt', requestId: randomUUID() }, 403);
    await api('reader', 'POST', 'admin/finance/payouts/not-allowed/approve', {}, 403);
    await api('reader', 'POST', 'admin/finance/reconciliation/repair', {}, 403);
  });
});
