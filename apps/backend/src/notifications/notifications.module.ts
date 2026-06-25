import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { NotificationsController } from './notifications.controller';
import { EmailNotificationService } from './email-notification.service';
import { PushNotificationService } from './push-notification.service';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [EmailNotificationService, PushNotificationService, NotificationsService],
  exports: [EmailNotificationService, PushNotificationService, NotificationsService]
})
export class NotificationsModule {}
