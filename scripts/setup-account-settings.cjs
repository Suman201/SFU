#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const mongoose = require('mongoose');
async function setupAccountSettingsIndexes(connection) {
  const { ACCOUNT_EMAIL_INDEXES } = require('../apps/backend/dist/account/account-email.schema.js');
  for (const { key, ...options } of ACCOUNT_EMAIL_INDEXES) await connection.collection('account_email_jobs').createIndex(key, options);
}
module.exports = { setupAccountSettingsIndexes };
if (require.main === module) (async () => {
  const uri = process.env.MONGODB_URI || (process.env.MONGODB_URI_FILE ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim() : '');
  if (!uri) throw Error('Set MONGODB_URI or MONGODB_URI_FILE.');
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  const hosts = parsed.srvHost ? [parsed.srvHost] : (parsed.hosts || []).map(host => host.host);
  if ((!hosts.length || hosts.some(host => !['127.0.0.1', 'localhost', 'mongo', '::1'].includes(host))) && !process.argv.includes('--allow-remote')) throw Error('Use --allow-remote only for the reviewed database.');
  const connection = await mongoose.createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try { await setupAccountSettingsIndexes(connection); process.stdout.write('Account email indexes are ready. Existing accounts and indexes were preserved.\n'); }
  finally { await connection.close(); }
})().catch(() => { process.stderr.write('Account settings setup failed. Check the reviewed database and index diagnostics. No records or indexes are dropped.\n'); process.exitCode = 1; });
