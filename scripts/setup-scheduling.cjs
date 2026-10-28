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
  const position = process.argv.indexOf('--legacy-timezone');
  const zone = position >= 0 ? process.argv[position + 1] : undefined;
  if (zone) new Intl.DateTimeFormat('en', { timeZone: zone }).format();
  const connection = await mongoose
    .createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 8000 })
    .asPromise();
  try {
    const db = connection.db,
      batches = db.collection('batches');
    const missing = {
      $or: [
        { scheduleTimezone: { $exists: false } },
        { scheduleTimezone: null },
        { scheduleTimezone: '' },
      ],
    };
    const count = await batches.countDocuments(missing);
    if (count && !zone)
      throw Error(
        `${count} existing batches need their original server timezone. Rerun with --legacy-timezone Europe/Paris (use the actual original zone).`,
      );
    if (count) {
      await batches.updateMany(missing, { $set: { scheduleTimezone: zone } });
      process.stdout.write(
        `Pinned timezone ${zone} on ${count} existing batches. Stored class instants were preserved.\n`,
      );
    }
    await db
      .collection('class_sessions')
      .createIndex({ status: 1, scheduledAt: 1 });
    await db
      .collection('class_notices')
      .createIndex({
        emailStatus: 1,
        nextAttemptAt: 1,
        availableAt: 1,
        leaseUntil: 1,
      });
    await db
      .collection('class_notices')
      .createIndex({ userId: 1, availableAt: -1 });
    await db
      .collection('google_calendar_connections')
      .createIndex({ status: 1, nextSyncAt: 1, leaseUntil: 1 });
    await db
      .collection('google_calendar_oauth_states')
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db
      .collection('google_calendar_oauth_states')
      .createIndex({ userId: 1 });
    await db
      .collection('google_calendar_event_mappings')
      .createIndex({ userId: 1, calendarId: 1, scheduledAt: 1 });
    process.stdout.write('Scheduling and Google Calendar indexes are ready.\n');
  } finally {
    await connection.close();
  }
})().catch((error) => {
  process.stderr.write((error.message || 'Scheduling setup failed.') + '\n');
  process.exitCode = 1;
});
