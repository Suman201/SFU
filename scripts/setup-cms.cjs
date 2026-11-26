#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const mongoose = require('mongoose');
class SetupError extends Error {}
async function setupCmsIndexes(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new SetupError('Versioned CMS publication requires a MongoDB replica set or mongos.');
  const schemas = require('../apps/backend/dist/database/schemas.js');
  for (const name of ['CmsPage', 'CmsPageRevision']) {
    const model = connection.models[name + 'Document'] || connection.model(name + 'Document', schemas[name + 'Schema']);
    await model.createCollection(); await model.createIndexes();
  }
}
module.exports = { setupCmsIndexes };
if (require.main === module) (async () => {
  const uri = process.env.MONGODB_URI || (process.env.MONGODB_URI_FILE ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim() : '');
  if (!uri) throw new SetupError('Set MONGODB_URI or MONGODB_URI_FILE.');
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  const hosts = parsed.srvHost ? [parsed.srvHost] : (parsed.hosts || []).map(host => host.host);
  if ((!hosts.length || hosts.some(host => !['127.0.0.1', 'localhost', 'mongo', '::1'].includes(host))) && !process.argv.includes('--allow-remote')) throw new SetupError('Use --allow-remote only for the reviewed target database.');
  const connection = await mongoose.createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  try { await setupCmsIndexes(connection); process.stdout.write('CMS page and publication-history indexes are ready. Existing content and publications were preserved.\n'); }
  finally { await connection.close(); }
})().catch(error => { process.stderr.write((error instanceof SetupError ? error.message : 'CMS setup could not complete. Check database connectivity, replica-set configuration, permissions and index diagnostics.') + '\n'); process.exitCode = 1; });
