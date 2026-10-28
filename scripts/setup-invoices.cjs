#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
for (const file of [path.resolve('.env'), path.resolve('../../.env')]) {
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
    throw Error('Pass --allow-remote only for the intended reviewed database.');
  const connection = await mongoose
    .createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 8000 })
    .asPromise();
  try {
    const invoices = connection.db.collection('invoices');
    await invoices.createIndex(
      { number: 1 },
      {
        unique: true,
        partialFilterExpression: { number: { $type: 'string' } },
      },
    );
    await invoices.createIndex({ createdAt: -1, _id: 1 });
    await invoices.createIndex({ status: 1 });
    await invoices.createIndex({
      'paymentEmail.status': 1,
      'paymentEmail.nextAttemptAt': 1,
    });
    process.stdout.write(
      'Invoice indexes are ready. Existing records were preserved.\n',
    );
  } finally {
    await connection.close();
  }
})().catch(() => {
  process.stderr.write(
    'Invoice setup failed. Check the database connection and resolve duplicate invoice numbers before retrying.\n',
  );
  process.exitCode = 1;
});
