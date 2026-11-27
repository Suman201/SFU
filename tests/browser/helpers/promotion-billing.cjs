'use strict';
const { randomUUID } = require('node:crypto');

// Provider-network adapter only. The actual commerce reconciler, ledger, Mongo
// transactions, billing API and document URL/credit-invoice checks still run.
async function promotionBillingFixture(stack) {
  const config = stack.app.get(require('@nestjs/config').ConfigService);
  const commerce = stack.app.get(require('../../../apps/backend/dist/promotions/promotion-commerce.service.js').PromotionCommerceService);
  const gateway = stack.app.get(require('../../../apps/backend/dist/promotions/promotion-stripe.gateway.js').PromotionStripeGateway);
  await commerce.onModuleDestroy();
  await require('../../../scripts/setup-promotions.cjs').setupPromotionIndexes(stack.connection);
  config.set('promotions.enabled', true); config.set('promotions.webhookSecret', 'whsec_billing_fixture');
  config.set('promotions.currencies', ['EUR', 'JPY', 'GBP', 'USD', 'INR']);
  const sessions = new Map(), refunds = new Map(), invoices = new Map(), credits = new Map(), documentCalls = [];
  Object.assign(gateway, { client: {
    invoices: { retrieve: async id => { documentCalls.push(id); return invoices.get(id); } },
    creditNotes: { retrieve: async id => { documentCalls.push(id); return credits.get(id); } },
  } });
  gateway.checkout = async order => {
    if (!sessions.has(order._id)) sessions.set(order._id, { id: 'cs_' + order._id, url: 'https://checkout.stripe.com/c/pay/' + order._id, status: 'open', payment_status: 'unpaid', livemode: false, client_reference_id: order._id, metadata: { purpose: 'teacher_promotion', orderId: order._id, teacherId: order.teacherId, planId: order.plan.id }, currency: order.plan.currency.toLowerCase(), amount_subtotal: order.plan.amountMinor, amount_total: order.plan.amountMinor, total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 } });
    return structuredClone(sessions.get(order._id));
  };
  gateway.session = async id => structuredClone([...sessions.values()].find(item => item.id === id));
  gateway.refunds = async intent => ({ data: [...refunds.values()].filter(item => item.payment_intent === intent), has_more: false });
  gateway.refund = async (intent, amount, id) => {
    const session = [...sessions.values()].find(item => item.payment_intent?.id === intent);
    if (!refunds.has(id)) refunds.set(id, { id: 're_' + id, amount, currency: session.currency, status: 'succeeded', payment_intent: intent, created: Math.floor(Date.now() / 1000), metadata: { requestId: id } });
    return structuredClone(refunds.get(id));
  };
  gateway.getRefund = async id => structuredClone([...refunds.values()].find(item => item.id === id));
  gateway.credit = async (invoice, refund) => {
    const value = { id: 'cn_' + invoice, invoice, number: 'CREDIT-' + invoice, total: refund.amount, currency: refund.currency, pdf: 'https://pay.stripe.com/credit/' + invoice + '.pdf' };
    credits.set(value.id, value); return value;
  };
  let sequence = 0;
  async function purchase(api, owner = 'teacher', options = {}) {
    const { currency = 'JPY', amountMinor = 101, taxMinor = 0, name = 'Unified promotion invoice', pay = true } = options;
    const placement = ['search_boost', 'marketplace_featured', 'profile_badge'][sequence % 3];
    const plan = await api('admin', 'PUT', 'admin/promotion-commerce/plans/' + randomUUID(), { revision: 0, name, placement, amountMinor, currency, durationDays: 1, enabled: true, autoApprove: true, automaticTax: taxMinor > 0, ...(taxMinor ? { taxCode: 'txcd_10000000' } : {}) });
    const order = await api(owner, 'POST', 'teacher/promotion-commerce/orders', { requestId: randomUUID(), planId: plan.id, revision: plan.revision, expectedAmountMinor: amountMinor, startsAt: new Date(Date.now() + (2 + sequence++ * 2) * 86400000).toISOString() });
    await api(owner, 'POST', 'teacher/promotion-commerce/orders/' + order.id + '/checkout');
    if (pay) {
      const session = sessions.get(order.id);
      session.status = 'complete'; session.payment_status = 'paid'; session.amount_total += taxMinor; session.total_details.amount_tax = taxMinor;
      if (taxMinor) session.automatic_tax = { status: 'complete' };
      session.payment_intent = { id: 'pi_' + order.id, status: 'succeeded', amount_received: session.amount_total, currency: session.currency, metadata: { ...session.metadata } };
      session.invoice = { id: 'in_' + order.id, number: 'PROMO-' + currency, metadata: { ...session.metadata }, hosted_invoice_url: 'https://invoice.stripe.com/i/' + order.id };
      invoices.set(session.invoice.id, session.invoice);
    }
    return api(owner, 'POST', 'teacher/promotion-commerce/orders/' + order.id + '/reconcile');
  }
  return { purchase, commerce, gateway, sessions, invoices, credits, documentCalls };
}
module.exports = { promotionBillingFixture };
