import { Module } from '@nestjs/common';
import { EmailNotificationService } from './email-notification.service';

/** Mail transport has no authentication-controller dependencies. */
@Module({ providers: [EmailNotificationService], exports: [EmailNotificationService] })
export class EmailModule {}
