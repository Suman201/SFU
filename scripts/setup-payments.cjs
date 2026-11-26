#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
async function setupPaymentIndexes(connection) {
  const { PAYMENT_MODELS } = require(path.resolve(__dirname, '../apps/backend/dist/payments/payment.schemas.js'));
  for (const { name, schema } of PAYMENT_MODELS) {
    const model = connection.models[name] || connection.model(name, schema);
    await model.createCollection();
    await model.createIndexes();
  }
  return PAYMENT_MODELS.map(({ name }) => name);
}
module.exports = { setupPaymentIndexes };
if (require.main === module) (async () => {
  const uri = process.env.MONGODB_URI || (process.env.MONGODB_URI_FILE ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim() : '');
  if (!uri) throw Error('Set MONGODB_URI or MONGODB_URI_FILE.');
  if (!['127.0.0.1', 'localhost', 'mongo'].includes(new URL(uri).hostname) && !process.argv.includes('--allow-remote')) throw Error('Use --allow-remote only for the reviewed deployment database.');
  const connection = await mongoose.createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try { const models = await setupPaymentIndexes(connection); process.stdout.write(`Payment ledger, idempotency and payout indexes are ready (${models.length} models). Existing records preserved.\n`); }
  finally { await connection.close(); }
})().catch(error => { process.stderr.write('Payment setup failed: ' + error.message + '\n'); process.exitCode = 1; });
