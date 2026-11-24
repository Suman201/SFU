#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

async function setupBookingIndexes(connection) {
  const root = path.resolve(__dirname, '..');
  const booking = require(
    path.join(root, 'apps/backend/dist/bookings/booking.schema.js'),
  );
  const invoice = require(
    path.join(root, 'apps/backend/dist/invoices/invoice.schema.js'),
  );
  const core = require(
    path.join(root, 'apps/backend/dist/database/schemas.js'),
  );
  const names = [
    'LessonOffer',
    'LessonSlot',
    'BookingCalendarLock',
    'BookingOrder',
    'BookingRefund',
    'PaymentWebhook',
    'BookingCreditNote',
  ];
  const models = names.map((name) =>
    connection.model(name + 'Document', booking[name + 'Schema']),
  );
  for (const name of ['Invoice', 'InvoiceCounter', 'InvoiceSettings'])
    models.push(connection.model(name + 'Document', invoice[name + 'Schema']));
  for (const name of [
    'Batch',
    'BatchSchedule',
    'ClassSession',
    'StudentEnrollment',
    'User',
  ])
    models.push(connection.model(name + 'Document', core[name + 'Schema']));
  for (const model of models) {
    await model.createCollection();
    await model.createIndexes();
  }
}
module.exports = { setupBookingIndexes };
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
        throw new Error('Bookings require a MongoDB replica set or mongos.');
      await setupBookingIndexes(connection);
      process.stdout.write(
        'Booking, payment, invoice and enrollment indexes are ready. Existing records were preserved.\n',
      );
    } finally {
      await connection.close();
    }
  })().catch((error) => {
    process.stderr.write('Booking setup failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
