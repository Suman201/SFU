import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import type { PromotionPlan, PromotionOrderStatus } from '@native-sfu/contracts';
@Schema({ collection: 'promotion_plans', timestamps: true })
export class PromotionPlanDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, type: Object }) value!: PromotionPlan;
}
export const PromotionPlanSchema = SchemaFactory.createForClass(PromotionPlanDocument);
@Schema({ collection: 'promotion_orders', timestamps: true })
export class PromotionOrderDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true }) teacherName!: string;
  @Prop({ required: true, select: false }) email!: string;
  @Prop({ required: true }) requestId!: string;
  @Prop({ required: true, type: Object }) plan!: PromotionPlan;
  @Prop({ required: true }) status!: PromotionOrderStatus;
  @Prop({ required: true }) startsAt!: Date;
  @Prop({ required: true }) endsAt!: Date;
  @Prop({ required: true }) expiresAt!: Date;
  @Prop({ type: String }) checkoutSessionId?: string;
  @Prop({ type: String, select: false }) checkoutUrl?: string;
  @Prop({ type: Date }) checkoutAttemptedAt?: Date;
  @Prop({ type: String }) paymentIntentId?: string;
  @Prop({ type: Date }) paidAt?: Date;
  @Prop({ type: Number }) totalMinor?: number;
  @Prop({ type: Number }) taxMinor?: number;
  @Prop({ default: 0 }) refundedMinor!: number;
  @Prop({ default: 0 }) refundPendingMinor!: number;
  @Prop({ type: String }) campaignId?: string;
  @Prop({ type: String }) invoiceId?: string;
  @Prop({ type: String }) invoiceNumber?: string;
  @Prop({ default: false }) invoiceReady!: boolean;
  @Prop({ type: String }) reviewReason?: string;
  @Prop({ type: Date }) nextCheckAt?: Date;
  @Prop({ type: String }) leaseToken?: string;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop({ type: Boolean, default: false }) disputed!: boolean;
  createdAt!: Date; updatedAt!: Date;
}
export const PromotionOrderSchema = SchemaFactory.createForClass(PromotionOrderDocument);
PromotionOrderSchema.index({ teacherId: 1, requestId: 1 }, { unique: true });
PromotionOrderSchema.index({ checkoutSessionId: 1 }, { unique: true, sparse: true });
PromotionOrderSchema.index({ paymentIntentId: 1 }, { unique: true, sparse: true });
PromotionOrderSchema.index({ nextCheckAt: 1, leaseUntil: 1 });
export type PromotionOrderMongo = HydratedDocument<PromotionOrderDocument>;
@Schema({ collection: 'promotion_slots', versionKey: false })
export class PromotionSlotDocument { @Prop({ type: String }) _id!: string; @Prop({ required: true }) orderId!: string }
export const PromotionSlotSchema = SchemaFactory.createForClass(PromotionSlotDocument);
@Schema({ collection: 'promotion_refunds', timestamps: true })
export class PromotionRefundDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) orderId!: string;
  @Prop({ required: true }) requestId!: string;
  @Prop({ required: true }) reason!: string;
  @Prop({ required: true }) amountMinor!: number;
  @Prop({ required: true }) currency!: string;
  @Prop({ required: true }) status!: 'queued' | 'pending' | 'succeeded' | 'failed' | 'review';
  @Prop({ type: String, unique: true, sparse: true }) providerRefundId?: string;
  @Prop({ type: String }) creditNoteId?: string;
  @Prop({ type: String }) creditNumber?: string;
  @Prop({ type: Number }) netMinor?: number;
  @Prop({ type: Number }) taxMinor?: number;
  @Prop({ type: Number, default: 0 }) attempts!: number;
  @Prop({ type: Date }) firstAttemptAt?: Date;
  @Prop({ type: Date }) nextCheckAt?: Date;
  createdAt!: Date; updatedAt!: Date;
}
export const PromotionRefundSchema = SchemaFactory.createForClass(PromotionRefundDocument);
PromotionRefundSchema.index({ orderId: 1, requestId: 1 }, { unique: true });
@Schema({ collection: 'promotion_analytics_events', versionKey: false })
export class PromotionAnalyticsEvent {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true }) campaignId!: string;
  @Prop({ required: true }) teacherId!: string;
  @Prop({ required: true }) kind!: string;
  @Prop({ required: true }) occurredAt!: Date;
  @Prop({ required: true }) expiresAt!: Date;
}
export const PromotionAnalyticsEventSchema = SchemaFactory.createForClass(PromotionAnalyticsEvent);
PromotionAnalyticsEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
@Schema({ collection: 'promotion_analytics_daily', versionKey: false })
export class PromotionAnalyticsDaily {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) campaignId!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true }) date!: string;
  @Prop({ default: 0 }) impressions!: number;
  @Prop({ default: 0 }) profileClicks!: number;
  @Prop({ default: 0 }) demoOpens!: number;
  @Prop({ default: 0 }) bookingClicks!: number;
}
export const PromotionAnalyticsDailySchema = SchemaFactory.createForClass(PromotionAnalyticsDaily);
PromotionAnalyticsDailySchema.index({ campaignId: 1, date: 1 }, { unique: true });
export const PROMOTION_MODELS = [{ name: PromotionPlanDocument.name, schema: PromotionPlanSchema }, { name: PromotionOrderDocument.name, schema: PromotionOrderSchema }, { name: PromotionSlotDocument.name, schema: PromotionSlotSchema }, { name: PromotionRefundDocument.name, schema: PromotionRefundSchema }, { name: PromotionAnalyticsEvent.name, schema: PromotionAnalyticsEventSchema }, { name: PromotionAnalyticsDaily.name, schema: PromotionAnalyticsDailySchema }];
