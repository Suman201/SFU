import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
@Schema({ collection: 'class_notices', timestamps: true })
export class CalendarNoticeDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) userId!: string;
  @Prop({ required: true }) batchId!: string;
  @Prop() sessionId?: string;
  @Prop({ required: true }) kind!: string;
  @Prop({ required: true }) title!: string;
  @Prop({ required: true }) body!: string;
  @Prop({ type: Date, required: true, index: true }) availableAt!: Date;
  @Prop({ type: Date }) readAt?: Date;
  @Prop({
    enum: ['queued', 'sent', 'skipped', 'failed', 'void'],
    default: 'queued',
  })
  emailStatus!: string;
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ type: Date }) nextAttemptAt?: Date;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop() leaseToken?: string;
  @Prop({ type: Date }) scheduledAt?: Date;
  @Prop() enrollmentId?: string;
  @Prop() enrollmentStatus?: string;
  @Prop() lastError?: string;
  createdAt!: Date;
}
export type CalendarNotice = HydratedDocument<CalendarNoticeDocument>;
export const CalendarNoticeSchema = SchemaFactory.createForClass(
  CalendarNoticeDocument,
);
CalendarNoticeSchema.index({
  emailStatus: 1,
  nextAttemptAt: 1,
  availableAt: 1,
  leaseUntil: 1,
});
CalendarNoticeSchema.index({ userId: 1, availableAt: -1 });
