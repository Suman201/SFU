import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bcrypt from 'bcrypt';
import mongoose, { Model } from 'mongoose';
import { Role } from '@native-sfu/contracts';
import { UserDocument, UserSchema } from './schemas';

interface SeedUser {
  displayName: string;
  email: string;
  password: string;
  roles: Role[];
}

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/native_sfu';

async function main(): Promise<void> {
  loadEnvFiles();

  const seedPassword = process.env.SEED_USER_PASSWORD ?? 'Password@12345';
  const dummyUsers = getDummyUsers(seedPassword);
  const mongoUri = process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
  await mongoose.connect(mongoUri, { autoIndex: true });

  const users = mongoose.model<UserDocument>(UserDocument.name, UserSchema);
  const results = await Promise.all(dummyUsers.map((user) => upsertSeedUser(users, user)));

  for (const result of results) {
    const roleLabel = result.roles.includes(Role.HOST) ? 'teacher/host' : 'student/participant';
    console.log(`${result.action}: ${result.email} (${roleLabel})`);
  }

  console.log(`Seeded ${results.length} dummy users. Password: ${seedPassword}`);
}

function getDummyUsers(password: string): SeedUser[] {
  return [
    {
      displayName: 'Teacher One',
      email: 'teacher.one@example.com',
      password,
      roles: [Role.HOST]
    },
    {
      displayName: 'Teacher Two',
      email: 'teacher.two@example.com',
      password,
      roles: [Role.HOST]
    },
    {
      displayName: 'Student One',
      email: 'student.one@example.com',
      password,
      roles: [Role.PARTICIPANT]
    },
    {
      displayName: 'Student Two',
      email: 'student.two@example.com',
      password,
      roles: [Role.PARTICIPANT]
    },
    {
      displayName: 'Student Three',
      email: 'student.three@example.com',
      password,
      roles: [Role.PARTICIPANT]
    }
  ];
}

async function upsertSeedUser(
  users: Model<UserDocument>,
  user: SeedUser
): Promise<{ action: 'created' | 'updated'; email: string; roles: Role[] }> {
  const email = user.email.toLowerCase();
  const passwordHash = await bcrypt.hash(user.password, 12);
  const existing = await users.exists({ email });
  await users.updateOne(
    { email },
    {
      $set: {
        displayName: user.displayName,
        email,
        passwordHash,
        roles: user.roles,
        disabled: false,
        refreshTokenIds: []
      }
    },
    { upsert: true }
  );
  return { action: existing ? 'updated' : 'created', email, roles: user.roles };
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
