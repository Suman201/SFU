import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminContactController, ContactController } from './contact.controller';
import { ContactInboxService } from './contact-inbox.service';

@Module({
  imports: [AuthModule, DatabaseModule, AuditLogsModule, NotificationsModule],
  controllers: [ContactController, AdminContactController],
  providers: [ContactInboxService],
  exports: [ContactInboxService]
})
export class ContactModule {}
