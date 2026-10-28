import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OAuth2Client,
  Credentials,
  CodeChallengeMethod,
} from 'google-auth-library';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { CalendarClass } from '@native-sfu/contracts';
import { CalendarService } from './calendar.service';
import {
  GoogleCalendarConnection,
  GoogleCalendarConnectionDocument,
  GoogleCalendarMapping,
  GoogleCalendarMappingDocument,
  GoogleCalendarState,
  GoogleCalendarStateDocument,
} from './google-calendar.schema';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const API = 'https://www.googleapis.com/calendar/v3';
export const googleEventId = (
  userId: string,
  calendarId: string,
  sessionId: string,
) =>
  createHash('sha256')
    .update(JSON.stringify([userId, calendarId, sessionId]))
    .digest('hex');
export function encryptCalendarSecret(value: string, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
    'base64',
  );
}
export function decryptCalendarSecret(value: string, key: Buffer) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString('utf8');
}
@Injectable()
export class GoogleCalendarService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(GoogleCalendarService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly calendar: CalendarService,
    @InjectModel(GoogleCalendarConnectionDocument.name)
    private readonly connections: Model<GoogleCalendarConnection>,
    @InjectModel(GoogleCalendarStateDocument.name)
    private readonly states: Model<GoogleCalendarState>,
    @InjectModel(GoogleCalendarMappingDocument.name)
    private readonly mappings: Model<GoogleCalendarMapping>,
  ) {}
  private configured() {
    return Boolean(
      this.config.get('GOOGLE_CALENDAR_CLIENT_ID') &&
        this.config.get('GOOGLE_CALENDAR_CLIENT_SECRET') &&
        this.config.get('GOOGLE_CALENDAR_REDIRECT_URI') &&
        /^[a-fA-F0-9]{64}$/.test(
          this.config.get<string>('GOOGLE_CALENDAR_ENCRYPTION_KEY') ?? '',
        ),
    );
  }
  private key() {
    return Buffer.from(
      this.config.get<string>('GOOGLE_CALENDAR_ENCRYPTION_KEY')!,
      'hex',
    );
  }
  private client() {
    return new OAuth2Client({
      clientId: this.config.get<string>('GOOGLE_CALENDAR_CLIENT_ID'),
      clientSecret: this.config.get<string>('GOOGLE_CALENDAR_CLIENT_SECRET'),
      redirectUri: this.config.get<string>('GOOGLE_CALENDAR_REDIRECT_URI'),
    });
  }
  async status(userId: string) {
    const row = await this.connections.findById(userId);
    return {
      configured: this.configured(),
      status: row?.status ?? 'disconnected',
      lastSyncAt: row?.lastSyncAt?.toISOString(),
      message: row?.lastError ?? '',
    };
  }
  async connect(userId: string) {
    if (!this.configured())
      throw new ServiceUnavailableException(
        'Google Calendar connection is currently unavailable.',
      );
    const client = this.client();
    const pkce = await client.generateCodeVerifierAsync();
    const state = randomBytes(32).toString('base64url');
    const revision = randomUUID();
    await this.connections.updateOne(
      { _id: userId },
      {
        $set: { revision },
        $setOnInsert: { status: 'disconnected', attempts: 0 },
      },
      { upsert: true },
    );
    await this.states.deleteMany({ userId });
    await this.states.create({
      _id: createHash('sha256').update(state).digest('hex'),
      userId,
      revision,
      encryptedVerifier: encryptCalendarSecret(pkce.codeVerifier, this.key()),
      expiresAt: new Date(Date.now() + 5 * 60000),
    });
    return {
      url: client.generateAuthUrl({
        scope: [GOOGLE_SCOPE, 'openid'],
        nonce: state,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      }),
    };
  }
  async callback(
    state: string | undefined,
    code: string | undefined,
    denied = false,
  ) {
    if (!this.configured() || !state || state.length > 256)
      throw new BadRequestException(
        'This connection request is invalid or expired. Start again from Sapiovian.',
      );
    const pending = await this.states
      .findOneAndDelete({
        _id: createHash('sha256').update(state).digest('hex'),
        expiresAt: { $gt: new Date() },
      })
      .select('+encryptedVerifier');
    if (
      !pending ||
      !(await this.connections.exists({
        _id: pending.userId,
        revision: pending.revision,
      }))
    )
      throw new BadRequestException(
        'This connection request is invalid or expired. Start again from Sapiovian.',
      );
    if (denied || !code || code.length > 4096)
      throw new BadRequestException(
        'Google Calendar was not connected. You can try again from Sapiovian.',
      );
    const person = await this.calendar.users.findOne({
      _id: pending.userId,
      roles: 'TEACHER',
      disabled: { $ne: true },
      deletedAt: { $exists: false },
    });
    if (!person)
      throw new BadRequestException('Teacher account is unavailable.');
    const client = this.client();
    try {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: decryptCalendarSecret(
          pending.encryptedVerifier,
          this.key(),
        ),
      });
      if (
        !tokens.refresh_token ||
        !tokens.scope?.split(' ').includes(GOOGLE_SCOPE)
      )
        throw new Error('Required offline access was not granted');
      if (!tokens.id_token)
        throw new Error('Google account identity was not returned');
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.config.get<string>('GOOGLE_CALENDAR_CLIENT_ID'),
      });
      const identity = ticket.getPayload();
      if (!identity?.sub || identity.nonce !== state)
        throw new Error(
          'Google account identity did not match this connection',
        );
      const previous = await this.connections
        .findById(pending.userId)
        .select('+accountSubject');
      const changedAccount = previous?.accountSubject !== identity.sub;
      const result = await this.connections.updateOne(
        { _id: pending.userId, revision: pending.revision },
        {
          $set: {
            encryptedTokens: encryptCalendarSecret(
              JSON.stringify(tokens),
              this.key(),
            ),
            accountSubject: identity.sub,
            status: 'connected',
            nextSyncAt: new Date(),
            attempts: 0,
            lastError: '',
          },
          $unset: {
            leaseToken: '',
            leaseUntil: '',
            ...(changedAccount ? { calendarId: '' } : {}),
          },
        },
      );
      if (!result.matchedCount) {
        await client.revokeToken(tokens.refresh_token).catch(() => undefined);
        throw new Error('Connection changed');
      }
      return true;
    } catch {
      throw new BadRequestException(
        'Google Calendar could not connect. Please try again from Sapiovian.',
      );
    }
  }
  async disconnect(userId: string) {
    const previous = await this.connections
      .findOneAndUpdate(
        { _id: userId },
        {
          $set: {
            status: 'disconnected',
            revision: randomUUID(),
            lastError: '',
          },
          $unset: { encryptedTokens: '', accountSubject: '', calendarId: '', leaseUntil: '', leaseToken: '' },
        },
        { new: false },
      )
      .select('+encryptedTokens');
    await this.states.deleteMany({ userId });
    if (previous?.encryptedTokens && this.configured()) {
      try {
        const tokens = JSON.parse(
          decryptCalendarSecret(previous.encryptedTokens, this.key()),
        ) as Credentials;
        const token = tokens.refresh_token ?? tokens.access_token;
        if (token) await this.client().revokeToken(token);
      } catch {
        this.logger.warn(
          'Google Calendar access was removed locally; provider revocation was unavailable.',
        );
      }
    }
    return { status: 'disconnected' };
  }
  async requestSync(userId: string) {
    if (!this.configured())
      throw new ServiceUnavailableException(
        'Google Calendar connection is currently unavailable.',
      );
    await this.connections.updateOne(
      { _id: userId, status: 'connected' },
      { $set: { nextSyncAt: new Date() } },
    );
    return this.status(userId);
  }
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async tick() {
    if (this.busy || !this.configured()) return;
    this.busy = true;
    try {
      for (let i = 0; i < 20; i++) {
        const token = randomUUID();
        const now = new Date();
        const row = await this.connections
          .findOneAndUpdate(
            {
              status: 'connected',
              nextSyncAt: { $lte: now },
              $or: [
                { leaseUntil: { $exists: false } },
                { leaseUntil: { $lt: now } },
              ],
            },
            {
              $set: {
                leaseToken: token,
                leaseUntil: new Date(Date.now() + 10 * 60000),
              },
            },
            { new: true },
          )
          .select('+encryptedTokens');
        if (!row) break;
        await this.sync(row, token);
      }
    } catch {
      this.logger.error('Google Calendar sync worker could not complete.');
    } finally {
      this.busy = false;
    }
  }
  private async sync(row: GoogleCalendarConnection, lease: string) {
    const filter = {
      _id: row.id,
      revision: row.revision,
      status: 'connected',
      leaseToken: lease,
    };
    const client = this.client();
    try {
      const teacher = await this.calendar.users.findOne({
        _id: row.id,
        roles: 'TEACHER',
        disabled: { $ne: true },
        deletedAt: { $exists: false },
      });
      if (!teacher) {
        await this.disconnect(row.id);
        return;
      }
      if (!row.encryptedTokens) throw new Error('Missing credentials');
      const credentials = JSON.parse(
        decryptCalendarSecret(row.encryptedTokens, this.key()),
      ) as Credentials;
      client.setCredentials(credentials);
      const request = async <T>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH',
        path: string,
        data?: unknown,
      ): Promise<T> => {
        if (!(await this.connections.exists(filter)))
          throw new Error('Connection changed');
        const result = await client.request<T>({
          url: API + path,
          method,
          data,
          timeout: 15000,
          retry: false,
        });
        return result.data;
      };
      let calendarId = row.calendarId;
      if (!calendarId) {
        const created = await request<{ id: string }>('POST', '/calendars', {
          summary: 'Sapiovian classes',
          description:
            'Classes managed in Sapiovian. Reschedule or cancel classes in Sapiovian.',
          timeZone: 'UTC',
        });
        calendarId = created.id;
        const stored = await this.connections.updateOne(filter, {
          $set: { calendarId },
        });
        if (!stored.matchedCount) throw new Error('Connection changed');
      }
      const batchList = await this.calendar.batches.find({
        teacherId: row.id,
        deletedAt: { $exists: false },
      });
      const start = Date.now() - 86400000,
        end = Date.now() + 60 * 86400000;
      const classes = (await this.calendar.classesForBatches(batchList)).filter(
        (c) =>
          ['scheduled', 'live'].includes(c.status) &&
          Date.parse(c.scheduledAt) >= start &&
          Date.parse(c.scheduledAt) < end,
      );
      const currentIds = new Set<string>();
      for (const item of classes) {
        const eventId = googleEventId(row.id, calendarId, item.id);
        currentIds.add(eventId);
        const body = this.eventPayload(item);
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(body))
          .digest('hex');
        const existing = await this.mappings.findById(eventId);
        if (existing?.fingerprint === fingerprint) continue;
        const endpoint = `/calendars/${encodeURIComponent(calendarId)}/events`;
        try {
          await request('PUT', `${endpoint}/${eventId}`, body);
        } catch (error) {
          const status = this.errorStatus(error);
          if (status !== 404 && status !== 410) throw error;
          try {
            await request('POST', endpoint, { ...body, id: eventId });
          } catch (insertError) {
            if (this.errorStatus(insertError) !== 409) throw insertError;
            await request('PUT', `${endpoint}/${eventId}`, body);
          }
        }
        await this.mappings.updateOne(
          { _id: eventId },
          {
            $set: {
              userId: row.id,
              calendarId,
              sessionId: item.id,
              fingerprint,
              scheduledAt: new Date(item.scheduledAt),
            },
          },
          { upsert: true },
        );
      }
      const previous = await this.mappings.find({
        userId: row.id,
        calendarId,
        scheduledAt: { $gte: new Date(start) },
      });
      for (const old of previous) {
        if (currentIds.has(old.id)) continue;
        try {
          await request(
            'PATCH',
            `/calendars/${encodeURIComponent(calendarId)}/events/${old.id}`,
            { status: 'cancelled' },
          );
        } catch (e) {
          if (![404, 410].includes(this.errorStatus(e))) throw e;
        }
        await this.mappings.deleteOne({ _id: old.id });
      }
      await this.connections.updateOne(filter, {
        $set: {
          encryptedTokens: encryptCalendarSecret(
            JSON.stringify({ ...credentials, ...client.credentials }),
            this.key(),
          ),
          lastSyncAt: new Date(),
          nextSyncAt: new Date(Date.now() + 60000),
          attempts: 0,
          lastError: '',
        },
        $unset: { leaseToken: '', leaseUntil: '' },
      });
    } catch (error) {
      const grantError =
        (error as { response?: { data?: { error?: string } } }).response?.data
          ?.error === 'invalid_grant' || this.errorStatus(error) === 401;
      const attempts = row.attempts + 1;
      await this.connections.updateOne(filter, {
        $set: {
          attempts,
          status: grantError ? 'reconnect' : 'connected',
          nextSyncAt: new Date(
            Date.now() +
              Math.min(30 * 60000, 60000 * 2 ** Math.min(attempts - 1, 5)),
          ),
          lastError: grantError
            ? 'Reconnect Google Calendar to resume updates.'
            : 'Google Calendar could not sync. We will try again shortly.',
        },
        $unset: { leaseToken: '', leaseUntil: '' },
      });
    }
  }
  private errorStatus(error: unknown) {
    return Number(
      (error as { response?: { status?: number } }).response?.status ?? 0,
    );
  }
  private eventPayload(item: CalendarClass) {
    const base = new URL(
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200',
    );
    base.pathname = '/class-session/teacher';
    base.search = new URLSearchParams({
      sessionId: item.id,
      batchId: item.batchId,
    }).toString();
    base.hash = '';
    return {
      summary: item.batchName,
      description: `${item.title}\nJoin class: ${base.toString()}\nChange this class in Sapiovian.`,
      start: { dateTime: item.scheduledAt, timeZone: item.scheduleTimezone },
      end: {
        dateTime: new Date(
          Date.parse(item.scheduledAt) + item.durationMinutes * 60000,
        ).toISOString(),
        timeZone: item.scheduleTimezone,
      },
      status: 'confirmed',
      visibility: 'private',
      extendedProperties: { private: { sapiovianSessionId: item.id } },
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 15 }],
      },
    };
  }
}
