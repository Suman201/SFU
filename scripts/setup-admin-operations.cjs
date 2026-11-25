#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const mongoose = require('mongoose');
const { setupBookingIndexes } = require('./setup-bookings.cjs');
async function setupAdminOperationsIndexes(connection) {
  await setupBookingIndexes(connection);
  const schemas = require('../apps/backend/dist/database/schemas.js');
  for (const name of [
    'Role',
    'ClassSessionWhiteboardState',
    'ClassSessionWhiteboardVersion',
  ]) {
    const model =
      connection.models[name + 'Document'] ||
      connection.model(name + 'Document', schemas[name + 'Schema']);
    await model.createCollection();
    await model.createIndexes();
  }
}
module.exports = { setupAdminOperationsIndexes };
if (require.main === module) {
  (async () => {
    const uri =
      process.env.MONGODB_URI ||
      (process.env.MONGODB_URI_FILE
        ? fs.readFileSync(process.env.MONGODB_URI_FILE, 'utf8').trim()
        : '');
    if (!uri) throw new Error('Set MONGODB_URI or MONGODB_URI_FILE.');
    if (
      !['localhost', '127.0.0.1', 'mongo'].includes(new URL(uri).hostname) &&
      !process.argv.includes('--allow-remote')
    )
      throw new Error(
        'Use --allow-remote only for the intended reviewed database.',
      );
    const connection = await mongoose
      .createConnection(uri, {
        autoIndex: false,
        serverSelectionTimeoutMS: 10000,
      })
      .asPromise();
    try {
      const hello = await connection.db.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid')
        throw new Error(
          'Admin whiteboard recovery requires a MongoDB replica set or mongos.',
        );
      await setupAdminOperationsIndexes(connection);
      process.stdout.write(
        'Admin access, whiteboard and booking reporting indexes are ready. Existing records and access assignments were preserved.\n',
      );
    } finally {
      await connection.close();
    }
  })().catch((error) => {
    process.stderr.write(
      'Admin operations setup failed: ' + error.message + '\n',
    );
    process.exitCode = 1;
  });
}
