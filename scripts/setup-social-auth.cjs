#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const mongoose = require('mongoose');
async function setupSocialAuthIndexes(connection) {
  const { SOCIAL_USER_INDEXES, SOCIAL_FLOW_INDEXES } = require('../apps/backend/dist/auth/social-auth.indexes.js');
  for (const [name, indexes] of [['users', SOCIAL_USER_INDEXES], ['social_auth_flows', SOCIAL_FLOW_INDEXES]]) {
    const collection = connection.collection(name);
    for (const { key, ...options } of indexes) await collection.createIndex(key, options);
  }
}
module.exports = { setupSocialAuthIndexes };
if (require.main === module) (async () => {
  const uri = process.env.MONGODB_URI || (process.env.MONGODB_URI_FILE ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim() : '');
  if (!uri) throw Error('Set MONGODB_URI or MONGODB_URI_FILE.');
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  const hosts = parsed.srvHost ? [parsed.srvHost] : (parsed.hosts || []).map(host => host.host);
  if ((!hosts.length || hosts.some(host => !['127.0.0.1', 'localhost', 'mongo', '::1'].includes(host))) && !process.argv.includes('--allow-remote')) throw Error('Use --allow-remote only for the reviewed target database.');
  const connection = await mongoose.createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try { await setupSocialAuthIndexes(connection); process.stdout.write('Social sign-in identity, replay and expiry indexes are ready. Existing accounts were preserved.\n'); }
  finally { await connection.close(); }
})().catch(() => { process.stderr.write('Social auth index setup failed. Check the selected database, permissions and duplicate identity/index diagnostics. No indexes are dropped by this command.\n'); process.exitCode = 1; });
