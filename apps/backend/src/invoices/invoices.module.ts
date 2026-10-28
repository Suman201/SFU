import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  InvoiceDocument,
  InvoiceSchema,
  InvoiceSettingsDocument,
  InvoiceSettingsSchema,
  InvoiceCounterDocument,
  InvoiceCounterSchema,
} from './invoice.schema';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
@Module({
  imports: [
    AuthModule,
    AuditLogsModule,
    NotificationsModule,
    MongooseModule.forFeature([
      { name: InvoiceDocument.name, schema: InvoiceSchema },
      { name: InvoiceSettingsDocument.name, schema: InvoiceSettingsSchema },
      { name: InvoiceCounterDocument.name, schema: InvoiceCounterSchema },
    ]),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
