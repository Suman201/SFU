import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
@Schema({ collection: 'account_email_jobs', timestamps: true })
export class AccountEmailJob {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) requestId!: string;
  @Prop({ required: true, enum: ['confirm', 'changed_notice'] }) kind!: 'confirm' | 'changed_notice';
  @Prop({ required: true, select: false }) targetEmail!: string;
  @Prop({ required: true, select: false }) originalEmail!: string;
  @Prop({ required: true }) authVersion!: number;
  @Prop({ required: true, enum: ['queued', 'sending', 'sent', 'consumed', 'failed', 'cancelled'] }) state!: string;
  @Prop({ type: String, select: false }) tokenHash?: string;
  @Prop({ type: Date }) tokenExpiresAt?: Date;
  @Prop({ type: Date, required: true }) requestedAt!: Date;
  @Prop({ type: Date, required: true }) availableAt!: Date;
  @Prop({ type: Date, required: true }) expiresAt!: Date;
  @Prop({ type: Date }) windowStart?: Date;
  @Prop({ type: Number }) requestCount?: number;
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ type: String }) leaseToken?: string;
  @Prop({ type: Date }) leaseUntil?: Date;
}
export type AccountEmailJobMongo = HydratedDocument<AccountEmailJob>;
export const AccountEmailJobSchema = SchemaFactory.createForClass(AccountEmailJob);
export const ACCOUNT_EMAIL_INDEXES = [
  { key: { tokenHash: 1 } as Record<string, 1 | -1>, unique: true, sparse: true },
  { key: { state: 1, availableAt: 1 } as Record<string, 1 | -1> },
  { key: { expiresAt: 1 } as Record<string, 1 | -1>, expireAfterSeconds: 0 },
];
for (const { key, ...options } of ACCOUNT_EMAIL_INDEXES) AccountEmailJobSchema.index(key, options);
