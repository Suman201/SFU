#!/usr/bin/env node
'use strict';
const mongoose = require('mongoose');
const fs = require('node:fs');
async function setupPromotionIndexes(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Promotion payments require a MongoDB replica set or mongos.');
  const { PROMOTION_MODELS } = require('../apps/backend/dist/promotions/promotion.schema.js');
  const { LedgerEntrySchema } = require('../apps/backend/dist/payments/payment.schemas.js');
  const { TeacherPromotionSchema } = require('../apps/backend/dist/database/schemas.js');
  for (const entry of [...PROMOTION_MODELS, { name: 'TeacherPromotionDocument', schema: TeacherPromotionSchema }, { name: 'LedgerEntryDocument', schema: LedgerEntrySchema }]) {
    const model = connection.models[entry.name] || connection.model(entry.name, entry.schema);
    await model.createCollection(); await model.createIndexes();
  }
}
module.exports = { setupPromotionIndexes };
if (require.main === module) (async () => {
  const uri = process.env.MONGODB_URI || (process.env.MONGODB_URI_FILE ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim() : '');
  if (!uri) throw new Error('Set MONGODB_URI or MONGODB_URI_FILE.');
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  const hosts = parsed.srvHost ? [parsed.srvHost] : (parsed.hosts || []).map(host => host.host);
  if ((!hosts.length || hosts.some(host => !['127.0.0.1', 'localhost', 'mongo', '::1'].includes(host))) && !process.argv.includes('--allow-remote')) throw new Error('Use --allow-remote only for the reviewed target database.');
  const connection = await mongoose.createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try { await setupPromotionIndexes(connection); process.stdout.write('Promotion indexes are ready. Existing quotes, payments and campaigns were preserved.\n'); }
  finally { await connection.close(); }
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
