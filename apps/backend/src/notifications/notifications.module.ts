import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsController } from './notifications.controller';
import { EmailNotificationService } from './email-notification.service';
import { PushNotificationService } from './push-notification.service';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [NotificationsController],
  providers: [EmailNotificationService, PushNotificationService, NotificationsService],
  exports: [EmailNotificationService, PushNotificationService, NotificationsService]
})
export class NotificationsModule {}
