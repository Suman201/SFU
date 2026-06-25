import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { EmailNotificationService } from './email-notification.service';
import { PushNotificationService } from './push-notification.service';
import type {
  EmailMessageInput,
  NotificationChannel,
  NotificationDeliveryResult,
  NotificationDeliverySummary,
  NotificationPurpose,
  PushMessageInput
} from './notification-types';

interface SendToUserInput {
  userId: string;
  purpose: NotificationPurpose;
  channels?: NotificationChannel[];
  email?: Omit<EmailMessageInput, 'to'>;
  push?: PushMessageInput;
  strict?: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly email: EmailNotificationService,
    private readonly push: PushNotificationService
  ) {}

  async sendToUser(input: SendToUserInput): Promise<NotificationDeliverySummary> {
    const user = await this.users.findOne({ _id: input.userId, deletedAt: { $exists: false }, disabled: { $ne: true } });
    if (!user) {
      if (input.strict) {
        throw new NotFoundException('Notification recipient not found');
      }
      return {
        userId: input.userId,
        purpose: input.purpose,
        results: [this.skipped('email', 'Notification recipient not found.'), this.skipped('push', 'Notification recipient not found.')]
      };
    }

    const channels = input.channels ?? this.defaultChannels(input);
    const results: NotificationDeliveryResult[] = [];
    for (const channel of channels) {
      if (!this.preferenceAllows(user, input.purpose, channel)) {
        results.push(this.skipped(channel, 'User notification preferences disabled this purpose or channel.'));
        continue;
      }
      if (channel === 'email') {
        results.push(input.email ? await this.email.sendEmail({ ...input.email, to: user.email }) : this.skipped('email', 'Email payload not provided.'));
        continue;
      }
      results.push(input.push ? await this.push.sendPushToUser(user.id, input.push) : this.skipped('push', 'Push payload not provided.'));
    }

    const summary = { userId: user.id, purpose: input.purpose, results };
    if (input.strict && results.some((result) => result.failed > 0 || result.errors.length > 0)) {
      throw new Error(`Notification delivery failed for ${input.purpose}`);
    }
    return summary;
  }

  async sendToUsers(inputs: SendToUserInput[]): Promise<NotificationDeliverySummary[]> {
    return Promise.all(inputs.map((input) => this.sendToUser(input)));
  }

  async sendEmailToUser(userId: string, purpose: NotificationPurpose, email: Omit<EmailMessageInput, 'to'>, strict = false): Promise<NotificationDeliverySummary> {
    return this.sendToUser({ userId, purpose, email, channels: ['email'], strict });
  }

  async sendPushToUser(userId: string, purpose: NotificationPurpose, push: PushMessageInput, strict = false): Promise<NotificationDeliverySummary> {
    return this.sendToUser({ userId, purpose, push, channels: ['push'], strict });
  }

  private defaultChannels(input: SendToUserInput): NotificationChannel[] {
    const channels: NotificationChannel[] = [];
    if (input.email) {
      channels.push('email');
    }
    if (input.push) {
      channels.push('push');
    }
    return channels;
  }

  private preferenceAllows(user: UserMongoDocument, purpose: NotificationPurpose, channel: NotificationChannel): boolean {
    if (purpose === 'security_notice') {
      return true;
    }
    const preferences = user.settings?.notifications;
    if (channel === 'email' && preferences?.email === false) {
      return false;
    }
    const key = this.preferenceKey(purpose);
    return key ? preferences?.[key] !== false : true;
  }

  private preferenceKey(purpose: NotificationPurpose): 'classReminders' | 'chatMessages' | 'announcements' | 'recordingReady' | undefined {
    switch (purpose) {
      case 'class_reminder':
        return 'classReminders';
      case 'chat_message':
        return 'chatMessages';
      case 'announcement':
      case 'enrollment_update':
        return 'announcements';
      case 'recording_ready':
        return 'recordingReady';
      case 'security_notice':
        return undefined;
    }
  }

  private skipped(channel: NotificationChannel, reason: string): NotificationDeliveryResult {
    this.logger.debug(`Notification ${channel} skipped: ${reason}`);
    return { channel, attempted: 0, delivered: 0, skipped: 1, failed: 0, errors: [reason] };
  }
}
