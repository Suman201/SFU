import { AdminBookingOperationsService } from './admin-booking-operations.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvoicesModule } from '../invoices/invoices.module';
import {
  InvoiceDocument,
  InvoiceSchema,
  InvoiceCounterDocument,
  InvoiceCounterSchema,
  InvoiceSettingsDocument,
  InvoiceSettingsSchema,
} from '../invoices/invoice.schema';
import { BookingCalendarModule } from './booking-calendar.module';
import {
  LessonOfferDocument,
  LessonOfferSchema,
  LessonSlotDocument,
  LessonSlotSchema,
  BookingOrderDocument,
  BookingOrderSchema,
  BookingRefundDocument,
  BookingRefundSchema,
  PaymentWebhookDocument,
  PaymentWebhookSchema,
  BookingCreditNoteDocument,
  BookingCreditNoteSchema,
} from './booking.schema';
import { StripeGateway } from './stripe.gateway';
import { BookingBillingService } from './booking-billing.service';
import { BookingsService } from './bookings.service';
import { BookingWorkerService } from './booking-worker.service';
import {
  BookingsController,
  BookingsPublicController,
  TeacherBookingsController,
  AdminBookingsController,
} from './bookings.controller';

@Module({
  imports: [
    AuthModule,
    AuditLogsModule,
    DatabaseModule,
    NotificationsModule,
    InvoicesModule,
    BookingCalendarModule,
    MongooseModule.forFeature([
      { name: LessonOfferDocument.name, schema: LessonOfferSchema },
      { name: LessonSlotDocument.name, schema: LessonSlotSchema },
      { name: BookingOrderDocument.name, schema: BookingOrderSchema },
      { name: BookingRefundDocument.name, schema: BookingRefundSchema },
      { name: PaymentWebhookDocument.name, schema: PaymentWebhookSchema },
      { name: BookingCreditNoteDocument.name, schema: BookingCreditNoteSchema },
      { name: InvoiceDocument.name, schema: InvoiceSchema },
      { name: InvoiceCounterDocument.name, schema: InvoiceCounterSchema },
      { name: InvoiceSettingsDocument.name, schema: InvoiceSettingsSchema },
    ]),
  ],
  providers: [
    StripeGateway,
    BookingBillingService,
    BookingsService,
    AdminBookingOperationsService,
    BookingWorkerService,
  ],
  controllers: [
    BookingsPublicController,
    BookingsController,
    TeacherBookingsController,
    AdminBookingsController,
  ],
})
export class BookingsModule {}
