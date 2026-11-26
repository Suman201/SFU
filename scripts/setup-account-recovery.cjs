#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const mongoose = require('mongoose');
async function setupAccountRecoveryIndexes(connection) {
  const { RECOVERY_USER_INDEXES, RECOVERY_JOB_INDEXES } = require('../apps/backend/dist/auth/password-recovery.indexes.js');
  for (const [name, indexes] of [['users', RECOVERY_USER_INDEXES], ['password_recovery_jobs', RECOVERY_JOB_INDEXES]]) {
    const collection = connection.collection(name);
    for (const { key, ...options } of indexes) await collection.createIndex(key, options);
  }
}
module.exports = { setupAccountRecoveryIndexes };
if (require.main === module) (async () => {
  const uri = process.env.MONGODB_URI || (process.env.MONGODB_URI_FILE ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim() : '');
  if (!uri) throw Error('Set MONGODB_URI or MONGODB_URI_FILE.');
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  const hosts = parsed.srvHost ? [parsed.srvHost] : (parsed.hosts || []).map(host => host.host);
  if ((!hosts.length || hosts.some(host => !['127.0.0.1', 'localhost', 'mongo', '::1'].includes(host))) && !process.argv.includes('--allow-remote')) throw Error('Use --allow-remote only for the reviewed database.');
  const connection = await mongoose.createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try { await setupAccountRecoveryIndexes(connection); process.stdout.write('Account recovery indexes are ready. Existing accounts and indexes were preserved.\n'); }
  finally { await connection.close(); }
})().catch(() => { process.stderr.write('Account recovery setup failed. Check the target database, permissions and duplicate index diagnostics. No indexes or accounts are dropped.\n'); process.exitCode = 1; });
