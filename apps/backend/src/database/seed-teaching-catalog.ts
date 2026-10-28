import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose, { type Model } from 'mongoose';
import {
  TeachingCatalogDocument,
  TeachingCatalogSchema,
} from '../teaching-catalog/catalog.schema';
import { TeachingCatalogService } from '../teaching-catalog/catalog.service';
import {
  AuditLogDocument,
  AuditLogSchema,
  type AuditLogMongoDocument,
} from './schemas';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

async function main() {
  for (const file of [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
  ]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match?.[1] && match[2] !== undefined && !process.env[match[1]])
        process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/native_sfu';
  const parsed = new URL(uri);
  if (
    !['127.0.0.1', 'localhost', 'mongo'].includes(parsed.hostname) &&
    !process.argv.includes('--allow-remote')
  )
    throw new Error(
      'For a reviewed remote database, explicitly pass --allow-remote.',
    );
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    const entries = mongoose.model(
      TeachingCatalogDocument.name,
      TeachingCatalogSchema,
    );
    await entries.init();
    const audit = new AuditLogsService(
      mongoose.model(
        AuditLogDocument.name,
        AuditLogSchema,
      ) as unknown as Model<AuditLogMongoDocument>,
    );
    const catalog = new TeachingCatalogService(entries as any, audit);
    await catalog.starter({
      sub: 'catalogue-seed',
      email: '',
      roles: ['SUPER_ADMIN'],
      permissions: [],
    } as any);
    const counts = await entries.aggregate([
      { $group: { _id: '$kind', count: { $sum: 1 } } },
    ]);
    console.log(
      JSON.stringify({ database: parsed.pathname.slice(1), counts }, null, 2),
    );
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
