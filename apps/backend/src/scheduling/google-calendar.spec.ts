import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import {
  GoogleCalendarService,
  encryptCalendarSecret,
  decryptCalendarSecret,
  googleEventId,
} from './google-calendar.service';
const scope = 'https://www.googleapis.com/auth/calendar.app.created';
const key = randomBytes(32);
afterEach(() => {
  jest.restoreAllMocks();
});
describe('Google Calendar connection security and provider contract', () => {
  it('encrypts credentials with authenticated, randomized ciphertext', () => {
    const a = encryptCalendarSecret('private-refresh-token', key),
      b = encryptCalendarSecret('private-refresh-token', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('private-refresh-token');
    expect(decryptCalendarSecret(a, key)).toBe('private-refresh-token');
    const bytes = Buffer.from(a, 'base64');
    bytes[30] = bytes[30]! ^ 1;
    expect(() =>
      decryptCalendarSecret(bytes.toString('base64'), key),
    ).toThrow();
    expect(() => decryptCalendarSecret(a, randomBytes(32))).toThrow();
  });
  it('generates stable Google-compatible event IDs scoped to the teacher and calendar', () => {
    expect(googleEventId('a', 'b', 'c')).toMatch(/^[0-9a-f]{64}$/);
    expect(googleEventId('a', 'b', 'c')).toBe(googleEventId('a', 'b', 'c'));
    expect(googleEventId('a', 'b', 'c')).not.toBe(
      googleEventId('other', 'b', 'c'),
    );
    expect(googleEventId('a', 'bc', 'd')).not.toBe(
      googleEventId('ab', 'c', 'd'),
    );
  });
  it('uses offline OAuth with PKCE, one-use expiring state and narrow app-created-calendar scope', async () => {
    const h = harness();
    const result = await h.service.connect('teacher');
    const url = new URL(result.url);
    const state = url.searchParams.get('state')!;
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      scope,
      'openid',
    ]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.url).not.toContain('client-secret');
    expect(h.pending!._id).not.toBe(state);
    expect(h.pending!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    jest.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: {
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        id_token: 'signed-id-token',
        scope,
      },
      res: null,
    } as never);
    jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockResolvedValue({
        getPayload: () => ({ sub: 'google-account', nonce: state }),
      } as never);
    expect(await h.service.callback(state, 'authorization-code')).toBe(true);
    expect(h.connection.encryptedTokens).not.toContain('secret-refresh');
    expect(
      JSON.parse(decryptCalendarSecret(h.connection.encryptedTokens, key))
        .refresh_token,
    ).toBe('secret-refresh');
    await expect(
      h.service.callback(state, 'authorization-code'),
    ).rejects.toThrow('invalid or expired');
  });
  it('rejects expired state and a connection invalidated before authorization returns', async () => {
    const h = harness();
    const { url } = await h.service.connect('teacher');
    h.pending!.expiresAt = new Date(0);
    await expect(
      h.service.callback(new URL(url).searchParams.get('state')!, 'code'),
    ).rejects.toThrow('invalid or expired');
    const next = await h.service.connect('teacher');
    h.connection.revision = 'disconnected-revision';
    await expect(
      h.service.callback(new URL(next.url).searchParams.get('state')!, 'code'),
    ).rejects.toThrow('invalid or expired');
  });
  it('keeps Google access credentials out of the status response', async () => {
    const h = harness();
    h.connection.encryptedTokens = 'private';
    const status = await h.service.status('teacher');
    expect(status).not.toHaveProperty('encryptedTokens');
    expect(status).not.toHaveProperty('calendarId');
    expect(status.configured).toBe(true);
  });
  it('upserts each class once and propagates moves and cancellations through the provider API', async () => {
    const h = harness();
    h.connection.status = 'connected';
    h.connection.id = 'teacher';
    h.connection.calendarId = 'app-calendar';
    h.connection.encryptedTokens = encryptCalendarSecret(
      JSON.stringify({ refresh_token: 'refresh' }),
      key,
    );
    h.connection.leaseToken = 'lease';
    const remote = new Map<string, any>();
    const requests: any[] = [];
    jest
      .spyOn(OAuth2Client.prototype, 'request')
      .mockImplementation(async (options: any) => {
        requests.push(options);
        const id = options.url.split('/').at(-1);
        if (options.method === 'PUT' && !remote.has(id))
          throw { response: { status: 404 } };
        if (options.method === 'POST') {
          remote.set(options.data.id, options.data);
          return { data: options.data } as never;
        }
        if (options.method === 'PATCH') {
          remote.set(id, { ...remote.get(id), ...options.data });
          return { data: {} } as never;
        }
        remote.set(id, options.data);
        return { data: options.data } as never;
      });
    await (h.service as any).sync(h.connection, 'lease');
    expect(remote.size).toBe(1);
    const count = requests.length;
    await (h.service as any).sync(h.connection, 'lease');
    expect(requests).toHaveLength(count);
    h.classes[0]!.scheduledAt = new Date(
      Date.now() + 2 * 86400000,
    ).toISOString();
    await (h.service as any).sync(h.connection, 'lease');
    expect(remote.size).toBe(1);
    expect([...remote.values()][0].start.dateTime).toBe(
      h.classes[0]!.scheduledAt,
    );
    h.classes.length = 0;
    await (h.service as any).sync(h.connection, 'lease');
    expect([...remote.values()][0].status).toBe('cancelled');
    expect(
      requests.every((r) =>
        r.url.startsWith('https://www.googleapis.com/calendar/v3/'),
      ),
    ).toBe(true);
  });
  it('requires reconnection when Google revokes the offline grant', async () => {
    const h = harness();
    Object.assign(h.connection, {
      id: 'teacher',
      status: 'connected',
      calendarId: 'app-calendar',
      encryptedTokens: encryptCalendarSecret(
        JSON.stringify({ refresh_token: 'refresh' }),
        key,
      ),
      leaseToken: 'lease',
    });
    jest
      .spyOn(OAuth2Client.prototype, 'request')
      .mockImplementation(async () => {
        throw { response: { status: 400, data: { error: 'invalid_grant' } } };
      });
    await (h.service as any).sync(h.connection, 'lease');
    expect(h.connection.status).toBe('reconnect');
    expect(h.connection.lastError).toBe(
      'Reconnect Google Calendar to resume updates.',
    );
  });
});
function harness() {
  const configuration = {
    GOOGLE_CALENDAR_CLIENT_ID: 'client-id',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
    GOOGLE_CALENDAR_REDIRECT_URI:
      'http://localhost:3000/api/v1/calendar/google/callback',
    GOOGLE_CALENDAR_ENCRYPTION_KEY: key.toString('hex'),
    FRONTEND_URL: 'https://sapiovian.example',
  };
  const connection: any = { status: 'disconnected', attempts: 0 };
  let pending: any;
  const mappings = new Map<string, any>();
  const classes = [
    {
      id: 'lesson',
      batchId: 'batch',
      batchName: 'Maths',
      title: 'Maths lesson',
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      durationMinutes: 60,
      scheduleTimezone: 'Europe/Paris',
      status: 'scheduled',
    },
  ];
  const connections = {
    findById: () => ({
      then: (resolve: any) => Promise.resolve(connection).then(resolve),
      select: async () => connection,
    }),
    exists: async (filter: any) =>
      !filter.revision || filter.revision === connection.revision,
    updateOne: async (_filter: any, change: any) => {
      Object.assign(connection, change.$set);
      return { matchedCount: 1 };
    },
  };
  const states = {
    deleteMany: async () => {
      pending = undefined;
    },
    create: async (p: any) => {
      pending = p;
    },
    findOneAndDelete: (filter: any) => ({
      select: async () => {
        if (
          !pending ||
          pending._id !== filter._id ||
          pending.expiresAt <= new Date()
        )
          return null;
        const p = pending;
        pending = undefined;
        return p;
      },
    }),
  };
  const mappingModel = {
    findById: async (id: string) => mappings.get(id),
    updateOne: async (filter: any, change: any) => {
      mappings.set(filter._id, { id: filter._id, ...change.$set });
    },
    find: async () => [...mappings.values()],
    deleteOne: async (filter: any) => {
      mappings.delete(filter._id);
    },
  };
  const calendar = {
    users: { findOne: async () => ({ _id: 'teacher', roles: ['TEACHER'] }) },
    batches: { find: async () => [{ id: 'batch' }] },
    classesForBatches: async () => classes,
  };
  const service = new GoogleCalendarService(
    new ConfigService(configuration),
    calendar as never,
    connections as never,
    states as never,
    mappingModel as never,
  );
  return {
    service,
    connection,
    classes,
    get pending() {
      return pending;
    },
  };
}
