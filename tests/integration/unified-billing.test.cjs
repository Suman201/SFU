'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');
const { promotionBillingFixture } = require('../browser/helpers/promotion-billing.cjs');

test('unified billing includes promotions with verified totals and owned fiscal links', { timeout: 180000 }, async t => {
  const stack = await startBookingStack(); t.after(() => stack.stop());
  const db = stack.connection.db, tokens = {}, fixture = await promotionBillingFixture(stack);
  async function api(name, method, endpoint, data, expected = method === 'POST' ? 201 : 200) {
    const response = await fetch(stack.origin + '/api/v1/' + endpoint, { method, headers: { authorization: 'Bearer ' + (tokens[name] || ''), 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text(); assert.equal(response.status, expected, endpoint + ': ' + text);
    const value = text ? JSON.parse(text) : undefined; return value?.data ?? value;
  }
  for (const name of Object.keys(stack.users)) tokens[name] = (await api('', 'POST', 'auth/login', { email: stack.users[name].email, password: stack.password }, 200)).accessToken;
  const yen = await fixture.purchase(api), euro = await fixture.purchase(api, 'teacher', { currency: 'EUR', amountMinor: 10000, taxMinor: 2000, name: 'Taxed teacher promotion' });
  const open = await fixture.purchase(api, 'teacher', { currency: 'GBP', amountMinor: 500, pay: false, name: 'Unpaid promotion quote' });
  const outside = await fixture.purchase(api, 'secondTeacher', { name: 'Private second teacher invoice' });
  const root = order => 'billing/purchases/promotion/' + order.id;
  await t.test('owned promotion snapshots use charged tax and do not expose provider or customer data', async () => {
    const history = await api('teacher', 'GET', 'billing/history'); assert.equal(history.total, 3);
    assert.deepEqual(history.summary.map(row => row.currency), ['EUR', 'GBP', 'JPY']);
    assert.equal(history.summary.find(row => row.currency === 'EUR').paidMinor, 12000);
    assert.equal(history.summary.find(row => row.currency === 'GBP').paidMinor, 0); assert.equal(history.summary.find(row => row.currency === 'GBP').openCount, 1);
    const paid = history.items.find(row => row.recordId === yen.id); assert.equal(paid.source, 'promotion'); assert.equal(paid.document.kind, 'invoice'); assert.equal(paid.document.number, 'PROMO-JPY');
    assert.equal(history.items.find(row => row.recordId === open.id).document, undefined);
    assert.doesNotMatch(JSON.stringify(history), /checkoutSessionId|paymentIntentId|checkoutUrl|@booking.test|reviewReason/);
    assert.equal((await api('student', 'GET', 'billing/history')).total, 0);
    assert.equal((await api('teacher', 'GET', 'billing/history?source=promotion&status=paid')).total, 2);
    assert.equal((await api('teacher', 'GET', 'billing/history?q=Taxed&currency=EUR')).total, 1);
    await api('teacher', 'GET', 'billing/history?source=unknown', undefined, 400);
  });
  await t.test('links are private, owner-scoped and only available for verified documents', async () => {
    const response = await fetch(stack.origin + '/api/v1/' + root(yen) + '/document-link', { headers: { authorization: 'Bearer ' + tokens.teacher } });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private.*no-store/);
    assert.equal((await response.json()).data.url, 'https://invoice.stripe.com/i/' + yen.id);
    const calls = fixture.documentCalls.length;
    for (const name of ['student', 'other', 'secondTeacher', 'admin']) {
      await api(name, 'GET', root(yen) + '/document-link', undefined, 404);
      await api(name, 'GET', root(yen) + '/refunds', undefined, 404);
    }
    await api('teacher', 'GET', root(outside) + '/document-link', undefined, 404);
    await api('teacher', 'GET', root(open) + '/document-link', undefined, 404);
    await api('teacher', 'GET', root(yen) + '/document', undefined, 404);
    assert.equal(fixture.documentCalls.length, calls);
    await db.collection('promotion_orders').updateOne({ _id: yen.id }, { $set: { invoiceId: 'in_' + outside.id } });
    await api('teacher', 'GET', root(yen) + '/document-link', undefined, 503);
    await db.collection('promotion_orders').updateOne({ _id: yen.id }, { $set: { invoiceId: 'in_' + yen.id } });
    fixture.invoices.get('in_' + yen.id).hosted_invoice_url = 'https://attacker.test/document';
    await api('teacher', 'GET', root(yen) + '/document-link', undefined, 503);
    fixture.invoices.get('in_' + yen.id).hosted_invoice_url = 'https://invoice.stripe.com/i/' + yen.id;
  });
  await t.test('refunds in progress remain separate and confirmed credit notes belong to that order', async () => {
    await api('admin', 'POST', 'admin/promotion-commerce/orders/' + yen.id + '/refund', { requestId: randomUUID(), reason: 'Unified billing refund acceptance.' });
    let history = await api('teacher', 'GET', 'billing/history?status=refunds');
    assert.equal(history.total, 1); assert.equal(history.summary.find(row => row.currency === 'JPY').refundedMinor, 0); assert.equal(history.summary.find(row => row.currency === 'JPY').refundPendingMinor, 101);
    let refunds = await api('teacher', 'GET', root(yen) + '/refunds'); assert.equal(refunds.items[0].status, 'queued'); assert.equal(refunds.items[0].creditNote, undefined);
    await fixture.commerce.tick();
    refunds = await api('teacher', 'GET', root(yen) + '/refunds'); assert.equal(refunds.items[0].status, 'succeeded');
    const creditId = refunds.items[0].creditNote.id;
    assert.equal((await api('teacher', 'GET', root(yen) + '/credits/' + creditId + '/link')).url, 'https://pay.stripe.com/credit/in_' + yen.id + '.pdf');
    await api('secondTeacher', 'GET', root(yen) + '/credits/' + creditId + '/link', undefined, 404);
    await api('teacher', 'GET', root(euro) + '/credits/' + creditId + '/link', undefined, 404);
    fixture.credits.get(creditId).invoice = 'in_other'; await api('teacher', 'GET', root(yen) + '/credits/' + creditId + '/link', undefined, 503); fixture.credits.get(creditId).invoice = 'in_' + yen.id;
    history = await api('teacher', 'GET', 'billing/history'); assert.equal(history.summary.find(row => row.currency === 'JPY').refundedMinor, 101); assert.equal(history.summary.find(row => row.currency === 'JPY').refundPendingMinor, 0);
  });
  await t.test('mixed-source pagination is stable and filters never change all-time totals', async () => {
    const template = await db.collection('promotion_orders').findOne({ _id: euro.id });
    const rows = Array.from({ length: 53 }, (_, i) => ({ ...template, _id: randomUUID(), teacherId: stack.users.teacher.id, requestId: randomUUID(), plan: { ...template.plan, name: 'Historical promo ' + i }, createdAt: new Date('2025-01-01'), totalMinor: 300, refundedMinor: 0, refundPendingMinor: 0, invoiceId: undefined, invoiceReady: false, checkoutSessionId: 'cs_history_' + randomUUID(), paymentIntentId: 'pi_history_' + randomUUID() }));
    await db.collection('promotion_orders').insertMany(rows, { ignoreUndefined: true });
    await db.collection('booking_orders').insertOne({ _id: randomUUID(), studentId: stack.users.teacher.id, teacherName: 'Historical tutor', title: 'Historical booking purchase', status: 'confirmed', createdAt: new Date('2024-01-01'), paidAt: new Date('2024-01-01'), invoiceSource: { currency: 'EUR', totalMinor: 1000 } });
    await db.collection('payments').insertOne({ _id: randomUUID(), studentId: stack.users.teacher.id, teacherName: 'Historical tutor', batchName: 'Historical class payment', status: 'succeeded', createdAt: new Date('2024-01-01'), paidAt: new Date('2024-01-01'), currency: 'EUR', amountMinor: 500 });
    const ids = new Set(); let summary;
    for (let page = 1; page <= 3; page++) { const result = await api('teacher', 'GET', 'billing/history?page=' + page); assert.equal(result.total, 58); for (const row of result.items) ids.add(row.id); if (!summary) summary = result.summary; else assert.deepEqual(result.summary, summary); }
    assert.equal(ids.size, 58); assert.equal(summary.find(row => row.currency === 'EUR').paidMinor, 29400);
    for (const source of ['booking', 'payment', 'promotion']) { const result = await api('teacher', 'GET', 'billing/history?source=' + source); assert.deepEqual(result.summary, summary); assert.ok(result.items.every(row => row.source === source)); }
    assert.equal((await api('teacher', 'GET', 'billing/history?q=Historical%20promo')).total, 53);
    assert.equal((await api('student', 'GET', 'billing/history')).total, 0);
  });
  await t.test('refund pagination includes failed attempts without granting credit-note access', async () => {
    await db.collection('promotion_refunds').insertMany(Array.from({ length: 26 }, () => ({ _id: randomUUID(), orderId: yen.id, requestId: randomUUID(), amountMinor: 101, currency: 'JPY', status: 'failed', reason: 'Historical failed attempt', creditNoteId: 'cn_unconfirmed', createdAt: new Date('2024-01-01') })));
    const first = await api('teacher', 'GET', root(yen) + '/refunds?page=1'), second = await api('teacher', 'GET', root(yen) + '/refunds?page=2');
    assert.equal(first.total, 27); assert.equal(first.items.length, 25); assert.equal(second.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 27);
    assert.ok([...first.items, ...second.items].filter(row => row.status === 'failed').every(row => !row.creditNote));
    await api('teacher', 'GET', root(yen) + '/credits/cn_unconfirmed/link', undefined, 404);
    await api('teacher', 'GET', root(yen) + '/refunds?page=0', undefined, 400);
    stack.app.get(require('@nestjs/config').ConfigService).set('promotions.enabled', false);
    assert.equal((await api('teacher', 'GET', root(yen) + '/document-link')).url, 'https://invoice.stripe.com/i/' + yen.id);
  });
});
