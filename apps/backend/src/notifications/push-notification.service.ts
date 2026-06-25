import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import webpush, { PushSubscription } from 'web-push';
import {
  PushSubscriptionDocument,
  PushSubscriptionMongoDocument
} from '../database/schemas';
import { RegisterPushSubscriptionDto } from './dto/notifications.dto';
import type { NotificationDeliveryResult, PushMessageInput } from './notification-types';

interface WebPushError {
  statusCode?: number;
  message?: string;
}

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);
  private vapidConfigured = false;

  constructor(
    @InjectModel(PushSubscriptionDocument.name) private readonly subscriptions: Model<PushSubscriptionMongoDocument>,
    private readonly config: ConfigService
  ) {}

  getPublicKey(): { enabled: boolean; publicKey: string | null } {
    const publicKey = this.config.get<string>('notifications.push.vapidPublicKey')?.trim() || null;
    return {
      enabled: this.enabled() && Boolean(publicKey),
      publicKey
    };
  }

  async registerSubscription(userId: string, input: RegisterPushSubscriptionDto, fallbackUserAgent?: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const doc = await this.subscriptions.findOneAndUpdate(
      { endpoint: input.endpoint },
      {
        $set: {
          userId,
          endpoint: input.endpoint,
          keys: input.keys,
          expirationTime: input.expirationTime ?? null,
          userAgent: input.userAgent ?? fallbackUserAgent
        },
        $unset: {
          revokedAt: '',
          deletedAt: ''
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { new: true, upsert: true }
    );
    return this.toSubscriptionResponse(doc);
  }

  async revokeSubscription(userId: string, subscriptionId: string): Promise<void> {
    const now = new Date();
    const doc = await this.subscriptions.findOneAndUpdate(
      { _id: subscriptionId, userId, deletedAt: { $exists: false } },
      { $set: { revokedAt: now, deletedAt: now } },
      { new: true }
    );
    if (!doc) {
      throw new NotFoundException('Push subscription not found');
    }
  }

  async sendPushToUser(userId: string, message: PushMessageInput): Promise<NotificationDeliveryResult> {
    const result: NotificationDeliveryResult = { channel: 'push', attempted: 0, delivered: 0, skipped: 0, failed: 0, errors: [] };
    if (!this.enabled()) {
      result.skipped = 1;
      return result;
    }
    if (!this.configured()) {
      result.skipped = 1;
      result.errors.push('Push is enabled but VAPID configuration is incomplete.');
      this.logger.warn('Push send skipped because VAPID configuration is incomplete.');
      return result;
    }

    const docs = await this.subscriptions.find({
      userId,
      revokedAt: { $exists: false },
      deletedAt: { $exists: false }
    });
    if (docs.length === 0) {
      result.skipped = 1;
      return result;
    }

    this.ensureVapidDetails();
    result.attempted = docs.length;
    const payload = JSON.stringify(message);
    await Promise.all(docs.map(async (doc) => {
      try {
        await webpush.sendNotification(this.toWebPushSubscription(doc), payload);
        doc.lastUsedAt = new Date();
        await doc.save();
        result.delivered += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push(this.safeError(error));
        if (this.isExpiredSubscription(error)) {
          doc.revokedAt = new Date();
          doc.deletedAt = doc.revokedAt;
          await doc.save();
          return;
        }
        this.logger.warn(`Push send failed for subscription ${doc.id}: ${this.safeError(error)}`);
      }
    }));

    return result;
  }

  private enabled(): boolean {
    return this.config.get<boolean>('notifications.push.enabled', false);
  }

  private configured(): boolean {
    return Boolean(this.config.get<string>('notifications.push.vapidPublicKey')?.trim())
      && Boolean(this.config.get<string>('notifications.push.vapidPrivateKey')?.trim())
      && Boolean(this.config.get<string>('notifications.push.vapidSubject')?.trim());
  }

  private ensureVapidDetails(): void {
    if (this.vapidConfigured) {
      return;
    }
    webpush.setVapidDetails(
      this.config.getOrThrow<string>('notifications.push.vapidSubject'),
      this.config.getOrThrow<string>('notifications.push.vapidPublicKey'),
      this.config.getOrThrow<string>('notifications.push.vapidPrivateKey')
    );
    this.vapidConfigured = true;
  }

  private toWebPushSubscription(doc: PushSubscriptionMongoDocument): PushSubscription {
    return {
      endpoint: doc.endpoint,
      expirationTime: doc.expirationTime ?? null,
      keys: {
        p256dh: doc.keys.p256dh,
        auth: doc.keys.auth
      }
    };
  }

  private toSubscriptionResponse(doc: PushSubscriptionMongoDocument): Record<string, unknown> {
    return {
      id: doc.id,
      endpoint: doc.endpoint,
      userAgent: doc.userAgent,
      createdAt: doc.createdAt?.toISOString(),
      lastUsedAt: doc.lastUsedAt?.toISOString()
    };
  }

  private isExpiredSubscription(error: unknown): boolean {
    const statusCode = (error as WebPushError | undefined)?.statusCode;
    return statusCode === 404 || statusCode === 410;
  }

  private safeError(error: unknown): string {
    return (error as WebPushError | undefined)?.message ?? (error instanceof Error ? error.message : String(error));
  }
}
