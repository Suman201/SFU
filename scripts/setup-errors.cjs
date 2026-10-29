#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const mongoose = require('mongoose');
for (const file of ['.env', '../../.env']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]])
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
(async () => {
  const uri =
    process.env.MONGODB_URI ||
    (process.env.MONGODB_URI_FILE
      ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim()
      : '');
  if (!uri) throw Error('Set MONGODB_URI or MONGODB_URI_FILE.');
  if (
    !['127.0.0.1', 'localhost', 'mongo'].includes(new URL(uri).hostname) &&
    !process.argv.includes('--allow-remote')
  )
    throw Error('Use --allow-remote only for the reviewed target database.');
  const connection = await mongoose
    .createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 8000 })
    .asPromise();
  try {
    const collection = connection.db.collection('error_incidents');
    await collection.createIndex({ createdAt: -1, _id: -1 });
    await collection.createIndex({ status: 1, createdAt: -1 });
    await collection.createIndex({ requestId: 1 });
    await collection.createIndex({ reference: 1 });
    await collection.createIndex(
      { source: 1, userId: 1, reference: 1 },
      {
        unique: true,
        partialFilterExpression: {
          source: { $in: ['web', 'desktop', 'admin'] },
        },
      },
    );
    process.stdout.write(
      'Error log indexes are ready. No historical errors were imported or deleted.\n',
    );
  } finally {
    await connection.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
