import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import type { EmailMessageInput, NotificationDeliveryResult } from './notification-types';

@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  async sendEmail(message: EmailMessageInput): Promise<NotificationDeliveryResult> {
    const recipients = Array.isArray(message.to) ? message.to.filter(Boolean) : [message.to].filter(Boolean);
    const result = this.emptyResult(recipients.length);
    if (recipients.length === 0) {
      result.skipped = 1;
      result.errors.push('No email recipients provided.');
      return result;
    }
    if (!this.enabled()) {
      result.skipped = recipients.length;
      return result;
    }
    if (!this.configured()) {
      result.skipped = recipients.length;
      result.errors.push('SMTP is enabled but not fully configured.');
      this.logger.warn('SMTP send skipped because provider configuration is incomplete.');
      return result;
    }

    try {
      await this.transport().sendMail({
        from: message.from ?? this.fromAddress(),
        to: recipients,
        replyTo: message.replyTo ?? this.replyToAddress(),
        subject: message.subject,
        text: message.text,
        html: message.html
      });
      result.delivered = recipients.length;
      return result;
    } catch (error) {
      result.failed = recipients.length;
      result.errors.push(this.safeError(error));
      this.logger.warn(`SMTP send failed: ${this.safeError(error)}`);
      return result;
    }
  }

  async sendTemplateEmail(input: EmailMessageInput & { variables?: Record<string, unknown> }): Promise<NotificationDeliveryResult> {
    return this.sendEmail(input);
  }

  async verifyTransport(): Promise<boolean> {
    if (!this.enabled() || !this.configured()) {
      return false;
    }
    try {
      await this.transport().verify();
      return true;
    } catch (error) {
      this.logger.warn(`SMTP verification failed: ${this.safeError(error)}`);
      return false;
    }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('notifications.email.enabled', false);
  }

  private configured(): boolean {
    return Boolean(this.config.get<string>('notifications.email.host'))
      && Boolean(this.config.get<string>('notifications.email.fromEmail'));
  }

  private transport(): Transporter {
    if (this.transporter) {
      return this.transporter;
    }
    const user = this.config.get<string>('notifications.email.user')?.trim();
    const pass = this.config.get<string>('notifications.email.password')?.trim();
    this.transporter = nodemailer.createTransport({
      host: this.config.getOrThrow<string>('notifications.email.host'),
      port: this.config.get<number>('notifications.email.port', 587),
      secure: this.config.get<boolean>('notifications.email.secure', false),
      ...(user && pass ? { auth: { user, pass } } : {})
    });
    return this.transporter;
  }

  private fromAddress(): string {
    const email = this.config.getOrThrow<string>('notifications.email.fromEmail');
    const name = this.config.get<string>('notifications.email.fromName')?.trim();
    return name ? `${name} <${email}>` : email;
  }

  private replyToAddress(): string | undefined {
    return this.config.get<string>('notifications.email.replyTo')?.trim() || undefined;
  }

  private emptyResult(attempted: number): NotificationDeliveryResult {
    return { channel: 'email', attempted, delivered: 0, skipped: 0, failed: 0, errors: [] };
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
