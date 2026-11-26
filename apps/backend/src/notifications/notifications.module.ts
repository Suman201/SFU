import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsController } from './notifications.controller';
import { EmailModule } from './email.module';
import { PushNotificationService } from './push-notification.service';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, DatabaseModule, EmailModule],
  controllers: [NotificationsController],
  providers: [PushNotificationService, NotificationsService],
  exports: [EmailModule, PushNotificationService, NotificationsService]
})
export class NotificationsModule {}
