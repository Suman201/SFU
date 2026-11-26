#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function inspectConfiguration(env) {
  const checks = [];
  const add = (id, ok, action) => checks.push({ id, status: ok ? 'configured' : 'blocked', action: ok ? undefined : action });
  const publicHttps = value => { try { const url = new URL(value); return url.protocol === 'https:' && !['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname) && !url.hostname.endsWith('.example.com'); } catch { return false; } };
  add('staging-origins', publicHttps(env.STAGING_BASE_URL) && Boolean(env.NODE_A_URL), 'Provide the approved HTTPS staging ingress and direct API node URLs.');
  add('operator-access', Boolean(env.OPERATIONS_TOKEN), 'Configure the operations token through an approved secret file/store.');
  add('staging-test-users', Boolean(env.STAGING_EMAIL && env.STAGING_PASSWORD), 'Configure authorized staging QA accounts for real classroom/relay checks.');
  add('stripe-sandbox', /^sk_test_/.test(env.STRIPE_SECRET_KEY || '') && Boolean(env.STRIPE_WEBHOOK_SECRET) && Boolean(env.PAYMENTS_STRIPE_WEBHOOK_SECRET), 'Configure Stripe test credentials and each endpoint signing secret; do not charge live cards for QA.');
  add('smtp', env.SMTP_ENABLED === 'true' && Boolean(env.SMTP_HOST) && Boolean(env.P0_QA_EMAIL), 'Configure SMTP and an authorized QA email recipient; external delivery is not implied by local SMTP tests.');
  add('business-approval', Boolean(env.P0_BUSINESS_APPROVAL_REF) && env.BOOKING_TAX_RATE_BPS !== undefined && Boolean(env.BOOKING_TAX_NOTE), 'Supply approved issuer/tax/legal-policy values and their approval reference.');
  add('encrypted-backup', Boolean(env.BACKUP_AGE_RECIPIENT), 'Configure the backup encryption recipient and a separately retained restore identity.');
  add('production-alert-receiver', Boolean(env.ALERTMANAGER_WEBHOOK_URL), 'Configure the approved Alertmanager receiver secret file.');
  return checks;
}
function main() {
  const flag = process.argv.indexOf('--env-file');
  const source = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '.env'));
  const config = fs.existsSync(source) ? require('dotenv').parse(fs.readFileSync(source)) : {};
  const readinessSecrets = new Set(['OPERATIONS_TOKEN_FILE', 'STAGING_PASSWORD_FILE', 'STRIPE_SECRET_KEY_FILE', 'STRIPE_WEBHOOK_SECRET_FILE', 'PAYMENTS_STRIPE_WEBHOOK_SECRET_FILE', 'ALERTMANAGER_WEBHOOK_URL_FILE', 'BACKUP_AGE_RECIPIENT_FILE']);
  for (const [key, value] of Object.entries(config)) {
    if (readinessSecrets.has(key) && value && !config[key.slice(0, -5)]) {
      try { config[key.slice(0, -5)] = fs.readFileSync(path.resolve(path.dirname(source), value), 'utf8').trim(); } catch { /* The readiness result reports the missing requirement without exposing paths/secrets. */ }
    }
  }
  const checks = inspectConfiguration(config);
  let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
  const report = { generatedAt: new Date().toISOString(), commit, scope: 'configuration-inventory-only', productionReady: false, configured: checks.every(check => check.status === 'configured'), checks,
    remainingProof: ['real staging browser media, TURN and reconnect/drain evidence', 'signed Stripe test checkout, deployed webhook, invoice and refund', 'authorized QA invoice email received externally', 'approved published issuer/tax/legal content', 'target-environment encrypted backup restore and firing/resolved alert receipt', 'measured classroom capacity on the deployment hardware'] };
  const output = path.resolve(process.env.P0_REPORT_DIR || path.join(root, 'reports/p0')); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'launch-readiness.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.configured ? 0 : 2;
}
module.exports = { inspectConfiguration };
if (require.main === module) main();
