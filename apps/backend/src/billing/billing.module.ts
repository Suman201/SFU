import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { BookingsModule } from '../bookings/bookings.module';
import { PaymentsModule } from '../payments/payments.module';
import { BookingOrderDocument, BookingOrderSchema, BookingRefundDocument, BookingRefundSchema, BookingCreditNoteDocument, BookingCreditNoteSchema } from '../bookings/booking.schema';
import { PaymentDocument, PaymentSchema, RefundDocument, RefundSchema } from '../payments/payment.schemas';
import { InvoiceDocument, InvoiceSchema } from '../invoices/invoice.schema';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PromotionsModule } from '../promotions/promotions.module';
import { PromotionOrderDocument, PromotionOrderSchema, PromotionRefundDocument, PromotionRefundSchema } from '../promotions/promotion.schema';
@Module({ imports: [AuthModule, DatabaseModule, AuditLogsModule, BookingsModule, PaymentsModule, PromotionsModule, MongooseModule.forFeature([
  { name: BookingOrderDocument.name, schema: BookingOrderSchema }, { name: BookingRefundDocument.name, schema: BookingRefundSchema }, { name: BookingCreditNoteDocument.name, schema: BookingCreditNoteSchema },
  { name: PaymentDocument.name, schema: PaymentSchema }, { name: RefundDocument.name, schema: RefundSchema }, { name: InvoiceDocument.name, schema: InvoiceSchema },
  { name: PromotionOrderDocument.name, schema: PromotionOrderSchema }, { name: PromotionRefundDocument.name, schema: PromotionRefundSchema },
])], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
