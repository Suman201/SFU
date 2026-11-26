const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectConfiguration } = require('../../scripts/p0-launch-readiness.cjs');
test('readiness never treats missing or localhost deployment inputs as configured', () => {
  assert.ok(inspectConfiguration({}).every(check => check.status === 'blocked'));
  assert.equal(inspectConfiguration({ STAGING_BASE_URL: 'http://localhost:4200', NODE_A_URL: 'http://localhost:3000' }).find(check => check.id === 'staging-origins').status, 'blocked');
});
test('sandbox checks reject live payment keys and require distinct endpoint secret configuration', () => {
  assert.equal(inspectConfiguration({ STRIPE_SECRET_KEY: 'sk_live_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_a', PAYMENTS_STRIPE_WEBHOOK_SECRET: 'whsec_b' }).find(check => check.id === 'stripe-sandbox').status, 'blocked');
  assert.equal(inspectConfiguration({ STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_a' }).find(check => check.id === 'stripe-sandbox').status, 'blocked');
  assert.equal(inspectConfiguration({ STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_a', PAYMENTS_STRIPE_WEBHOOK_SECRET: 'whsec_b' }).find(check => check.id === 'stripe-sandbox').status, 'configured');
});
