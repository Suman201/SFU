'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');
test('customer billing combines owned purchases without rewriting fiscal snapshots', { timeout: 180000 }, async t => {
  const stack = await startBookingStack({ paymentsEnabled: true }); t.after(() => stack.stop());
  const db = stack.connection.db, tokens = {};
  async function api(name, method, endpoint, data, expected = method === 'POST' ? 201 : 200) {
    const response = await fetch(stack.origin + '/api/v1/' + endpoint, { method, headers: { ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}), 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text(); assert.equal(response.status, expected, endpoint + ': ' + text); const value = text ? JSON.parse(text) : undefined; return value?.data ?? value;
  }
  async function document(name, source, id, credit, expected = 200) {
    const response = await fetch(stack.origin + '/api/v1/billing/purchases/' + source + '/' + id + (credit ? '/credits/' + credit : '/document'), { headers: { authorization: 'Bearer ' + tokens[name] } });
    assert.equal(response.status, expected); const bytes = Buffer.from(await response.arrayBuffer()); if (expected === 200) { assert.equal(bytes.subarray(0, 4).toString(), '%PDF'); assert.match(response.headers.get('cache-control'), /no-store/); } return bytes;
  }
  for (const name of ['student', 'teacher', 'other', 'admin']) tokens[name] = (await api('', 'POST', 'auth/login', { email: stack.users[name].email, password: stack.password }, 200)).accessToken;
  let saved;
  await t.test('saved defaults are private, versioned and separate from sign-in identity', async () => {
    const first = await api('student', 'GET', 'billing/profile'); assert.equal(first.saved, false);
    await stack.bookings.users.updateOne({ _id: stack.users.student.id }, { $set: { 'settings.locale': 'bad_legacy_locale' } });
    assert.equal((await api('student', 'GET', 'billing/profile')).locale, 'en-US');
    await stack.bookings.users.updateOne({ _id: stack.users.student.id }, { $set: { 'settings.locale': 'en-US' } });
    const input = { version: first.version, name: 'Synthetic Billing Company', address: '123 Original Invoice Street', countryCode: 'gb', vatNumber: 'GB-TEST-ONLY' };
    saved = await api('student', 'PUT', 'billing/profile', input);
    assert.equal(saved.countryCode, 'GB'); assert.equal(saved.email, stack.users.student.email); assert.equal(saved.saved, true);
    await api('student', 'PUT', 'billing/profile', input, 409);
    await api('student', 'PUT', 'billing/profile', { ...input, version: saved.version, email: 'other@example.com' }, 400);
    await api('student', 'PUT', 'billing/profile', { ...input, version: saved.version, cardNumber: 'synthetic-forbidden-field' }, 400);
    await api('student', 'PUT', 'billing/profile', { ...input, version: saved.version, countryCode: 'ZZ' }, 400);
    const other = await api('other', 'GET', 'billing/profile'); assert.equal(other.saved, false); assert.equal(other.address, '');
    assert.doesNotMatch(JSON.stringify(await api('student', 'GET', 'account')), /123 Original Invoice Street|GB-TEST-ONLY/);
    assert.equal((await db.collection('users').findOne({ email: stack.users.student.email })).displayName, 'student booking');
  });
  let offset = 0;
  const details = () => ({ name: saved.name, address: saved.address, countryCode: saved.countryCode, vatNumber: saved.vatNumber, email: 'client-cannot-select-recipient@example.com' });
  async function reserve(currency, netMinor, owner = 'student', pay = true) {
    const offer = await api('teacher', 'POST', 'bookings/teacher/offers', { title: 'Billing lesson ' + (++offset), description: 'Synthetic customer billing acceptance.', amountMinor: netMinor, currency, durationMinutes: 30, active: true });
    const slot = await api('teacher', 'POST', 'bookings/teacher/slots', { offerId: offer.id, startsAt: new Date(Math.ceil((Date.now() + (96 + offset) * 3600000) / 300000) * 300000).toISOString() });
    const order = await api(owner, 'POST', 'bookings/slots/' + slot.id + '/reserve', { requestId: randomUUID(), expectedTotalMinor: offer.price.amountMinor, expectedOfferVersion: offer.version, billing: details() });
    if (pay) { await api(owner, 'POST', 'bookings/orders/' + order.id + '/checkout'); await stack.bookings.verifyPayment(stack.gateway.pay(order.id)); }
    return db.collection('booking_orders').findOne({ _id: order.id });
  }
  const euro = await reserve('EUR', 10000), yen = await reserve('JPY', 101), outside = await reserve('EUR', 10000, 'other');
  await reserve('EUR', 50, 'student', false);
  const batchId = randomUUID(), start = new Date(Date.now() + 300 * 3600000);
  await stack.bookings.batches.create({ _id: batchId, name: 'Receipt-only class purchase', teacherId: stack.users.teacher.id, year: start.getUTCFullYear(), startDate: start, endDate: new Date(start.getTime() + 3600000), maxCapacity: 10, feeAmount: 25, feeMinor: 2500, feeCurrency: 'USD', status: 'ACTIVE' });
  await stack.bookings.classes.create({ _id: randomUUID(), batchId, teacherId: stack.users.teacher.id, title: 'Receipt class', sessionNumber: 1, scheduledAt: start, durationMinutes: 30, status: 'scheduled', roomId: 'room-' + batchId, chatChannelId: 'chat-' + batchId, whiteboardChannelId: 'board-' + batchId });
  const checkout = await api('student', 'POST', 'payments/checkout', { batchId });
  const payment = await api('student', 'POST', 'payments/test-gateway/' + checkout.paymentId + '/complete', { outcome: 'succeed' });
  let originalPdf;
  await t.test('purchase history includes both sources and preserves original currencies', async () => {
    const history = await api('student', 'GET', 'billing/history'); assert.equal(history.total, 4);
    assert.deepEqual(history.summary.map(item => item.currency), ['EUR', 'JPY', 'USD']);
    assert.equal(history.summary.find(item => item.currency === 'EUR').paidMinor, 12000);
    assert.equal(history.summary.find(item => item.currency === 'EUR').openCount, 1);
    assert.equal(history.summary.find(item => item.currency === 'JPY').paidMinor, 121);
    assert.equal(history.summary.find(item => item.currency === 'USD').paidMinor, 2500);
    assert.equal(history.items.find(item => item.recordId === euro._id).document.kind, 'invoice');
    assert.equal(history.items.find(item => item.recordId === payment.id).document.kind, 'receipt');
    assert.ok(!history.items.some(item => item.recordId === outside._id));
    assert.equal((await api('student', 'GET', 'billing/history?status=open')).total, 1);
    assert.equal((await api('student', 'GET', 'billing/history?currency=JPY')).total, 1);
    assert.equal((await api('student', 'GET', 'billing/history?q=Receipt-only')).total, 1);
    originalPdf = await document('student', 'booking', euro._id);
    await document('student', 'payment', payment.id);
    await document('other', 'booking', euro._id, undefined, 404);
    await document('teacher', 'booking', euro._id, undefined, 404);
    await document('student', 'booking', outside._id, undefined, 404);
    await api('other', 'GET', 'billing/purchases/booking/' + euro._id + '/refunds', undefined, 404);
  });
  let creditId;
  await t.test('pending refunds remain separate until confirmed and credit notes are owned', async () => {
    await api('admin', 'POST', 'admin/bookings/' + euro._id + '/refunds', { requestId: randomUUID(), amountMinor: 2400, reason: 'Customer billing confirmed partial refund.' });
    let history = await api('student', 'GET', 'billing/history');
    assert.equal(history.summary.find(item => item.currency === 'EUR').refundedMinor, 0); assert.equal(history.summary.find(item => item.currency === 'EUR').refundPendingMinor, 2400);
    await stack.worker.tick();
    history = await api('student', 'GET', 'billing/history');
    assert.equal(history.summary.find(item => item.currency === 'EUR').refundedMinor, 2400); assert.equal(history.summary.find(item => item.currency === 'EUR').refundPendingMinor, 0);
    const list = await api('student', 'GET', 'billing/purchases/booking/' + euro._id + '/refunds');
    assert.equal(list.total, 1); assert.equal(list.items[0].status, 'succeeded'); creditId = list.items[0].creditNote.id;
    await document('student', 'booking', euro._id, creditId); await document('other', 'booking', euro._id, creditId, 404); await document('student', 'booking', yen._id, creditId, 404);
  });
  await t.test('saved details can change or clear without changing issued documents', async () => {
    saved = await api('student', 'PUT', 'billing/profile', { version: saved.version, name: 'Changed Billing Company', address: '999 Changed Billing Street', countryCode: 'FR', vatNumber: '' });
    assert.deepEqual(await document('student', 'booking', euro._id), originalPdf);
    const stored = await db.collection('invoices').findOne({ _id: euro.invoiceId });
    assert.equal(stored.input.customer.name, 'Synthetic Billing Company'); assert.equal(stored.input.customer.email, stack.users.student.email);
    assert.equal(stored.input.customer.address, '123 Original Invoice Street');
    await api('student', 'POST', 'billing/profile/clear', { version: saved.version - 1 }, 409);
    saved = await api('student', 'POST', 'billing/profile/clear', { version: saved.version }, 200); assert.equal(saved.saved, false); assert.equal(saved.address, '');
    assert.deepEqual(await document('student', 'booking', euro._id), originalPdf); await document('student', 'booking', euro._id, creditId);
    const audit = await db.collection('audit_logs').find({ action: { $in: ['billing.profile_saved', 'billing.profile_cleared'] } }).toArray();
    assert.doesNotMatch(JSON.stringify(audit), /123 Original Invoice Street|999 Changed Billing Street|GB-TEST-ONLY/);
  });
  await t.test('server pagination reaches historical records and totals do not depend on the page', async () => {
    const seed = [];
    for (let i = 0; i < 125; i++) {
      const id = randomUUID(); const item = { ...euro, _id: id, requestId: randomUUID(), title: 'Historical billing page ' + String(i).padStart(3, '0'), invoiceSource: { ...euro.invoiceSource, orderId: id, netMinor: 250, taxMinor: 50, totalMinor: 300, paymentReference: 'synthetic-history-' + id }, paymentIntentId: 'pi_history_' + id, stripeSessionId: 'cs_history_' + id, refundedMinor: 0, refundPendingMinor: 0, status: 'confirmed', createdAt: new Date('2025-01-01T00:00:00Z') };
      for (const key of ['invoiceId', 'earningsPolicy', 'earningsAvailableAt', 'earningsCreditedAt', 'earningsNextCheckAt', 'nextReconcileAt']) delete item[key];
      seed.push(item);
    }
    await db.collection('booking_orders').insertMany(seed);
    const ids = new Set(); let reference;
    for (let page = 1; page <= 6; page++) { const result = await api('student', 'GET', 'billing/history?page=' + page); assert.equal(result.total, 129); for (const item of result.items) ids.add(item.id); if (!reference) reference = result.summary; else assert.deepEqual(result.summary, reference); }
    assert.equal(ids.size, 129); assert.equal(reference.find(item => item.currency === 'EUR').paidMinor, 49500);
    assert.equal((await api('student', 'GET', 'billing/history?q=Historical')).total, 125);
    assert.equal((await api('student', 'GET', 'billing/history?q=' + encodeURIComponent('.*[test]'))).total, 0);
    assert.equal((await api('student', 'GET', 'billing/history?currency=JPY')).summary.find(item => item.currency === 'EUR').paidMinor, 49500);
    await api('student', 'GET', 'billing/history?page=0', undefined, 400); await api('student', 'GET', 'billing/history?currency=ZZZ', undefined, 400); await api('student', 'GET', 'billing/history?status=unknown', undefined, 400);
  });
  await t.test('verified email changes keep purchase ownership and original invoice recipients', async () => {
    const config = stack.app.get(require('@nestjs/config').ConfigService);
    const mail = stack.app.get(require('../../apps/backend/dist/notifications/email-notification.service.js').EmailNotificationService);
    const emails = stack.app.get(require('../../apps/backend/dist/account/account-email.service.js').AccountEmailService);
    const sent = []; mail.sendEmail = async message => { sent.push(message); return { delivered: 1 }; };
    config.set('notifications.email.enabled', true); config.set('notifications.email.host', '127.0.0.1'); config.set('notifications.email.fromEmail', 'security@example.com'); config.set('passwordRecovery.webUrl', 'http://127.0.0.1:4485'); await emails.onModuleInit();
    const target = 'billing-verified-new@example.com';
    await api('student', 'POST', 'account/email/request', { email: target, currentPassword: stack.password }, 202);
    let token;
    for (let i = 0; i < 100 && !token; i++) { token = sent.map(message => /#token=([a-f0-9]{64})/.exec(message.text)?.[1]).find(Boolean); if (!token) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(token); await api('', 'POST', 'account/email/confirm', { token }, 200); await api('student', 'GET', 'auth/me', undefined, 401);
    tokens.student = (await api('', 'POST', 'auth/login', { email: target, password: stack.password }, 200)).accessToken;
    assert.equal((await api('student', 'GET', 'billing/history')).total, 129); assert.equal((await api('student', 'GET', 'billing/profile')).email, target);
    assert.deepEqual(await document('student', 'booking', euro._id), originalPdf); await document('student', 'booking', euro._id, creditId);
    assert.equal((await db.collection('invoices').findOne({ _id: euro.invoiceId })).input.customer.email, stack.users.student.email);
  });

});
