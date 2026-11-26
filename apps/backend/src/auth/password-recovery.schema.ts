import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'password_recovery_jobs', timestamps: true })
export class PasswordRecoveryJob {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, enum: ['reset', 'changed'] }) kind!: 'reset' | 'changed';
  @Prop({ type: String, select: false }) email?: string;
  @Prop({ required: true }) requestId!: string;
  @Prop({ required: true, type: Date }) requestedAt!: Date;
  @Prop({ required: true, type: Date }) availableAt!: Date;
  @Prop({ required: true, type: Date }) expiresAt!: Date;
  @Prop({ required: true, enum: ['queued', 'sending', 'sent', 'failed', 'skipped'] }) state!: string;
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ type: Date }) nextRequestAt?: Date;
  @Prop({ type: Date }) windowStart?: Date;
  @Prop({ default: 0 }) count!: number;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop() leaseToken?: string;
  @Prop({ type: Date }) claimedAt?: Date;
}
export type PasswordRecoveryJobDocument = HydratedDocument<PasswordRecoveryJob>;
export const PasswordRecoveryJobSchema = SchemaFactory.createForClass(PasswordRecoveryJob);
PasswordRecoveryJobSchema.index({ state: 1, availableAt: 1, leaseUntil: 1 });
PasswordRecoveryJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
