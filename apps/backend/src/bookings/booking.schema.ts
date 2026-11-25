import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type {
  BookingInvoiceSource,
  BookingOrderStatus,
  InvoiceRecord,
  LessonOffer,
} from '@native-sfu/contracts';

@Schema({ collection: 'lesson_offers', timestamps: true })
export class LessonOfferDocument {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true, type: Object }) value!: Omit<LessonOffer, 'id'>;
}
export type LessonOfferMongo = HydratedDocument<LessonOfferDocument>;
export const LessonOfferSchema =
  SchemaFactory.createForClass(LessonOfferDocument);

@Schema({ collection: 'lesson_slots', timestamps: true })
export class LessonSlotDocument {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true, index: true }) offerId!: string;
  @Prop({ required: true, type: Date, index: true }) startsAt!: Date;
  @Prop({ required: true, type: Date }) endsAt!: Date;
  @Prop({ enum: ['open', 'held', 'booked', 'cancelled'], default: 'open' })
  status!: 'open' | 'held' | 'booked' | 'cancelled';
  @Prop({ type: String }) orderId?: string;
}
export type LessonSlotMongo = HydratedDocument<LessonSlotDocument>;
export const LessonSlotSchema =
  SchemaFactory.createForClass(LessonSlotDocument);
LessonSlotSchema.index({ teacherId: 1, startsAt: 1, status: 1 });

/** All schedule writers take the same teacher document lock inside their transaction. */
@Schema({ collection: 'booking_calendar_locks', versionKey: false })
export class BookingCalendarLockDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ default: 0 }) revision!: number;
}
export const BookingCalendarLockSchema = SchemaFactory.createForClass(
  BookingCalendarLockDocument,
);

@Schema({ collection: 'booking_orders', timestamps: true })
export class BookingOrderDocument {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ required: true }) requestId!: string;
  @Prop({ required: true, index: true }) studentId!: string;
  @Prop({ required: true }) studentName!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true }) teacherName!: string;
  @Prop({ required: true, enum: ['lesson', 'batch'] }) kind!:
    | 'lesson'
    | 'batch';
  @Prop({ required: true }) title!: string;
  @Prop({ type: String }) slotId?: string;
  @Prop({ type: String }) offerId?: string;
  @Prop({ type: String }) batchId?: string;
  @Prop({ type: String }) sessionId?: string;
  @Prop({ type: String }) invoiceId?: string;
  @Prop({ required: true, type: Date }) startsAt!: Date;
  @Prop({ required: true, type: Date }) endsAt!: Date;
  @Prop({ required: true, type: Date, index: true }) expiresAt!: Date;
  @Prop({ required: true, type: Date }) cancellationDeadline!: Date;
  @Prop({ required: true, type: Object }) invoiceSource!: BookingInvoiceSource;
  @Prop({ default: '' }) goal!: string;
  @Prop({ required: true, default: 'awaiting_payment' })
  status!: BookingOrderStatus;
  @Prop({ type: String }) stripeSessionId?: string;
  @Prop({ type: String }) checkoutUrl?: string;
  @Prop({ type: String }) paymentIntentId?: string;
  @Prop({ type: Date }) paidAt?: Date;
  @Prop({ type: Date }) cancelledAt?: Date;
  @Prop({ type: String }) cancellationReason?: string;
  @Prop({ default: 0 }) refundedMinor!: number;
  @Prop({ default: 0 }) refundPendingMinor!: number;
  @Prop({ default: false }) capacityReleased!: boolean;
  @Prop({ type: Date }) checkoutAttemptedAt?: Date;
  @Prop({ type: Date }) nextReconcileAt?: Date;
  @Prop({ type: Date }) reconcileLeaseUntil?: Date;
  @Prop({ type: String }) reconcileLeaseToken?: string;
  @Prop({ type: String }) reviewReason?: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type BookingOrderMongo = HydratedDocument<BookingOrderDocument>;
export const BookingOrderSchema =
  SchemaFactory.createForClass(BookingOrderDocument);
BookingOrderSchema.index({ studentId: 1, requestId: 1 }, { unique: true });
BookingOrderSchema.index(
  { stripeSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeSessionId: { $type: 'string' } },
  },
);
BookingOrderSchema.index(
  { paymentIntentId: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentIntentId: { $type: 'string' } },
  },
);
BookingOrderSchema.index({ status: 1, nextReconcileAt: 1 });
BookingOrderSchema.index({ createdAt: -1, _id: -1 });
BookingOrderSchema.index({ paidAt: 1, 'invoiceSource.currency': 1 });
BookingOrderSchema.index({ cancelledAt: 1, 'invoiceSource.currency': 1 });

@Schema({ collection: 'booking_refunds', timestamps: true })
export class BookingRefundDocument {
  @Prop({ type: String, index: true }) retryOfRefundId?: string;
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ required: true, index: true }) orderId!: string;
  @Prop({ required: true }) requestId!: string;
  @Prop({ required: true }) amountMinor!: number;
  @Prop({ required: true }) currency!: string;
  @Prop({ required: true }) reason!: string;
  @Prop({ required: true }) actorId!: string;
  @Prop({
    enum: ['queued', 'pending', 'succeeded', 'failed'],
    default: 'queued',
  })
  status!: 'queued' | 'pending' | 'succeeded' | 'failed';
  @Prop({ type: String }) stripeRefundId?: string;
  @Prop({ type: String }) creditNoteId?: string;
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ type: Date, default: () => new Date() }) nextAttemptAt!: Date;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop({ type: String }) leaseToken?: string;
  createdAt!: Date;
}
export type BookingRefundMongo = HydratedDocument<BookingRefundDocument>;
export const BookingRefundSchema = SchemaFactory.createForClass(
  BookingRefundDocument,
);
BookingRefundSchema.index({ orderId: 1, requestId: 1 }, { unique: true });
BookingRefundSchema.index(
  { stripeRefundId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeRefundId: { $type: 'string' } },
  },
);
BookingRefundSchema.index({ status: 1, nextAttemptAt: 1 });

@Schema({ collection: 'payment_webhook_events', timestamps: true })
export class PaymentWebhookDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true }) eventType!: string;
  @Prop({ required: true }) objectId!: string;
  @Prop({ enum: ['received', 'processing', 'done'], default: 'received' })
  status!: string;
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ type: Date, default: () => new Date() }) nextAttemptAt!: Date;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop({ type: String }) leaseToken?: string;
}
export const PaymentWebhookSchema = SchemaFactory.createForClass(
  PaymentWebhookDocument,
);
PaymentWebhookSchema.index({ status: 1, nextAttemptAt: 1 });

@Schema({ collection: 'booking_credit_notes', timestamps: true })
export class BookingCreditNoteDocument {
  @Prop({ enum: ['pending', 'sent'], default: 'pending' }) emailStatus!: string;
  @Prop({ default: 0 }) emailAttempts!: number;
  @Prop({ type: Date, default: () => new Date() }) emailNextAttemptAt!: Date;
  @Prop({ type: Date }) emailLeaseUntil?: Date;
  @Prop({ type: String }) emailLeaseToken?: string;
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) orderId!: string;
  @Prop({ required: true }) invoiceId!: string;
  @Prop({ required: true, type: Object }) value!: InvoiceRecord;
  @Prop({ type: Buffer }) pdf?: Buffer;
}
export const BookingCreditNoteSchema = SchemaFactory.createForClass(
  BookingCreditNoteDocument,
);

BookingCreditNoteSchema.index({ createdAt: 1, 'value.currency': 1 });
