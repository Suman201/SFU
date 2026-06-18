import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import mongoose from 'mongoose';
import { ProducerDocument, ProducerSchema } from './schemas';

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/native_sfu';

async function main(): Promise<void> {
  loadEnvFiles();

  const mongoUri = process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
  const targetNodeId = process.env.PRODUCER_BACKFILL_NODE_ID ?? process.env.NODE_ID ?? `node-${hostname()}`;
  const writeEnabled = String(process.env.PRODUCER_BACKFILL_WRITE ?? 'false').toLowerCase() === 'true';
  const producers = mongoose.model<ProducerDocument>(ProducerDocument.name, ProducerSchema);
  const filter = buildMissingNodeIdFilter();

  await mongoose.connect(mongoUri, { autoIndex: true });

  const matches = (await producers
    .find(filter)
    .select('_id roomId participantId kind status nodeId')
    .lean()) as Array<{ _id: unknown; roomId: string; participantId: string; kind: string; status: string; nodeId?: string }>;

  console.log(`Found ${matches.length} producer record(s) with missing nodeId.`);
  console.log(`Target nodeId: ${targetNodeId}`);
  console.log(`Mode: ${writeEnabled ? 'write' : 'dry-run'}`);

  if (matches.length > 0) {
    for (const match of matches.slice(0, 20)) {
      console.log(
        [
          `producer=${String(match._id)}`,
          `room=${match.roomId}`,
          `participant=${match.participantId}`,
          `kind=${match.kind}`,
          `status=${match.status}`,
          `nodeId=${match.nodeId ?? '<missing>'}`
        ].join(' ')
      );
    }
    if (matches.length > 20) {
      console.log(`... ${matches.length - 20} more record(s) omitted`);
    }
  }

  if (!writeEnabled || matches.length === 0) {
    return;
  }

  const result = await producers.updateMany(filter, { $set: { nodeId: targetNodeId } });
  console.log(`Updated ${result.modifiedCount} producer record(s).`);
}

function buildMissingNodeIdFilter(): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $or: [{ nodeId: { $exists: false } }, { nodeId: null }, { nodeId: '' }]
  };
  const roomId = process.env.PRODUCER_BACKFILL_ROOM_ID;
  const participantId = process.env.PRODUCER_BACKFILL_PARTICIPANT_ID;
  const producerId = process.env.PRODUCER_BACKFILL_PRODUCER_ID;

  if (roomId) {
    filter.roomId = roomId;
  }
  if (participantId) {
    filter.participantId = participantId;
  }
  if (producerId) {
    filter._id = producerId;
  }
  return filter;
}

function loadEnvFiles(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const cwd = process.cwd();
  const paths = [
    resolve(cwd, `.env.${nodeEnv}.local`),
    resolve(cwd, `.env.${nodeEnv}`),
    resolve(cwd, '.env.local'),
    resolve(cwd, '.env'),
    resolve(cwd, '../../', `.env.${nodeEnv}`),
    resolve(cwd, '../../.env')
  ];

  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    const file = readFileSync(path, 'utf8');
    for (const line of file.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] ??= value;
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
