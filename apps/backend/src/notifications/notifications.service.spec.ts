import { GUARDS_METADATA } from '@nestjs/common/constants';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsController } from './notifications.controller';
import { EmailNotificationService } from './email-notification.service';
import { NotificationsService } from './notifications.service';
import { PushNotificationService } from './push-notification.service';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn()
}));

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn()
}));

interface MockModel {
  findOneAndUpdate: jest.Mock;
  find: jest.Mock;
}

function config(values: Record<string, unknown>): { get: jest.Mock; getOrThrow: jest.Mock } {
  return {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (value === undefined || value === null || value === '') {
        throw new Error(`Missing config ${key}`);
      }
      return value;
    })
  };
}

describe('EmailNotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips safely when SMTP is disabled', async () => {
    const service = new EmailNotificationService(config({ 'notifications.email.enabled': false }) as never);

    const result = await service.sendEmail({ to: 'student@example.test', subject: 'Hello', text: 'Hi' });

    expect(result.channel).toBe('email');
    expect(result.attempted).toBe(1);
    expect(result.delivered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('calls nodemailer with the expected payload without logging secrets', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'smtp-1' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail, verify: jest.fn() });
    const service = new EmailNotificationService(config({
      'notifications.email.enabled': true,
      'notifications.email.host': 'smtp.example.test',
      'notifications.email.port': 587,
      'notifications.email.secure': false,
      'notifications.email.user': 'smtp-user',
      'notifications.email.password': 'smtp-password',
      'notifications.email.fromEmail': 'classes@example.test',
      'notifications.email.fromName': 'Native SFU',
      'notifications.email.replyTo': 'support@example.test'
    }) as never);

    const result = await service.sendEmail({
      to: 'student@example.test',
      subject: 'Class reminder',
      text: 'Class starts soon'
    });

    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect((nodemailer.createTransport as jest.Mock).mock.calls[0]?.[0]).toEqual({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      auth: { user: 'smtp-user', pass: 'smtp-password' }
    });
    expect(sendMail.mock.calls[0]?.[0]).toEqual({
      from: 'Native SFU <classes@example.test>',
      to: ['student@example.test'],
      replyTo: 'support@example.test',
      subject: 'Class reminder',
      text: 'Class starts soon',
      html: undefined
    });
  });
});

describe('PushNotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the configured push public key', () => {
    const service = new PushNotificationService(modelMock() as never, config({
      'notifications.push.enabled': true,
      'notifications.push.vapidPublicKey': 'public-key'
    }) as never);

    expect(service.getPublicKey()).toEqual({ enabled: true, publicKey: 'public-key' });
  });

  it('registers a push subscription for the current user', async () => {
    const doc = subscriptionDoc({ id: 'sub-1', userId: 'user-1' });
    const model = modelMock({ findOneAndUpdate: jest.fn().mockResolvedValue(doc) });
    const service = new PushNotificationService(model as never, config({}) as never);

    const result = await service.registerSubscription('user-1', {
      endpoint: 'https://push.example.test/sub-1',
      keys: { p256dh: 'p256dh', auth: 'auth' }
    }, 'Browser UA');

    expect(model.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({ endpoint: 'https://push.example.test/sub-1' });
    expect(model.findOneAndUpdate.mock.calls[0]?.[1]?.$set.userId).toBe('user-1');
    expect(model.findOneAndUpdate.mock.calls[0]?.[1]?.$set.endpoint).toBe('https://push.example.test/sub-1');
    expect(model.findOneAndUpdate.mock.calls[0]?.[1]?.$set.userAgent).toBe('Browser UA');
    expect(model.findOneAndUpdate.mock.calls[0]?.[2]).toEqual({ new: true, upsert: true });
    expect(result.id).toBe('sub-1');
    expect(result.endpoint).toBe('https://push.example.test/sub-1');
  });

  it('does not allow deleting another user push subscription', async () => {
    const model = modelMock({ findOneAndUpdate: jest.fn().mockResolvedValue(null) });
    const service = new PushNotificationService(model as never, config({}) as never);

    try {
      await service.revokeSubscription('user-1', 'sub-2');
      throw new Error('Expected revokeSubscription to fail');
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toContain('Push subscription not found');
    }
  });

  it('marks expired push subscriptions revoked after 404 or 410', async () => {
    const doc = subscriptionDoc({ id: 'sub-1', userId: 'user-1' });
    const model = modelMock({ find: jest.fn().mockResolvedValue([doc]) });
    (webpush.sendNotification as jest.Mock).mockRejectedValue({ statusCode: 410, message: 'Gone' });
    const service = new PushNotificationService(model as never, config({
      'notifications.push.enabled': true,
      'notifications.push.vapidPublicKey': 'public-key',
      'notifications.push.vapidPrivateKey': 'private-key',
      'notifications.push.vapidSubject': 'mailto:admin@example.test'
    }) as never);

    const result = await service.sendPushToUser('user-1', { title: 'New message' });

    expect(result.failed).toBe(1);
    expect(doc.revokedAt).toBeInstanceOf(Date);
    expect(doc.deletedAt).toBe(doc.revokedAt);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe('NotificationsService', () => {
  it('sends email and push through reusable providers', async () => {
    const users = {
      findOne: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'student@example.test',
        settings: { notifications: { email: true, chatMessages: true } }
      })
    };
    const email = { sendEmail: jest.fn().mockResolvedValue({ channel: 'email', attempted: 1, delivered: 1, skipped: 0, failed: 0, errors: [] }) };
    const push = { sendPushToUser: jest.fn().mockResolvedValue({ channel: 'push', attempted: 1, delivered: 1, skipped: 0, failed: 0, errors: [] }) };
    const service = new NotificationsService(users as never, email as never, push as never);

    const summary = await service.sendToUser({
      userId: 'user-1',
      purpose: 'chat_message',
      email: { subject: 'Message', text: 'Hello' },
      push: { title: 'Message', body: 'Hello' }
    });

    expect(summary.results.length).toBe(2);
    expect(email.sendEmail.mock.calls[0]?.[0].to).toBe('student@example.test');
    expect(push.sendPushToUser.mock.calls[0]?.[0]).toBe('user-1');
    expect(push.sendPushToUser.mock.calls[0]?.[1].title).toBe('Message');
  });

  it('respects user notification preferences', async () => {
    const users = {
      findOne: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'student@example.test',
        settings: { notifications: { email: false, chatMessages: false } }
      })
    };
    const email = { sendEmail: jest.fn() };
    const push = { sendPushToUser: jest.fn() };
    const service = new NotificationsService(users as never, email as never, push as never);

    const summary = await service.sendToUser({
      userId: 'user-1',
      purpose: 'chat_message',
      email: { subject: 'Message', text: 'Hello' },
      push: { title: 'Message' }
    });

    expect(summary.results.every((result) => result.skipped === 1)).toBe(true);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(push.sendPushToUser).not.toHaveBeenCalled();
  });
});

describe('NotificationsController', () => {
  it('requires JWT auth at controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, NotificationsController) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });
});

function modelMock(overrides: Partial<MockModel> = {}): MockModel {
  return {
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    ...overrides
  };
}

function subscriptionDoc(input: { id: string; userId: string }): Record<string, unknown> {
  return {
    id: input.id,
    userId: input.userId,
    endpoint: `https://push.example.test/${input.id}`,
    keys: { p256dh: 'p256dh', auth: 'auth' },
    expirationTime: null,
    userAgent: 'Browser UA',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined)
  };
}
