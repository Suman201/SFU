import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
@Schema({ collection: 'google_calendar_connections', timestamps: true })
export class GoogleCalendarConnectionDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true }) revision!: string;
  @Prop({
    default: 'disconnected',
    enum: ['connected', 'disconnected', 'reconnect'],
  })
  status!: string;
  @Prop({ select: false }) encryptedTokens?: string;
  @Prop() calendarId?: string;
  @Prop({ select: false }) accountSubject?: string;
  @Prop({ type: Date }) lastSyncAt?: Date;
  @Prop({ type: Date, index: true }) nextSyncAt?: Date;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop() leaseToken?: string;
  @Prop({ default: 0 }) attempts!: number;
  @Prop() lastError?: string;
}
export const GoogleCalendarConnectionSchema = SchemaFactory.createForClass(
  GoogleCalendarConnectionDocument,
);
GoogleCalendarConnectionSchema.index({
  status: 1,
  nextSyncAt: 1,
  leaseUntil: 1,
});
export type GoogleCalendarConnection =
  HydratedDocument<GoogleCalendarConnectionDocument>;
@Schema({ collection: 'google_calendar_oauth_states' })
export class GoogleCalendarStateDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) userId!: string;
  @Prop({ required: true }) revision!: string;
  @Prop({ required: true, select: false }) encryptedVerifier!: string;
  @Prop({ type: Date, required: true }) expiresAt!: Date;
}
export const GoogleCalendarStateSchema = SchemaFactory.createForClass(
  GoogleCalendarStateDocument,
);
GoogleCalendarStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export type GoogleCalendarState = HydratedDocument<GoogleCalendarStateDocument>;
@Schema({ collection: 'google_calendar_event_mappings' })
export class GoogleCalendarMappingDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, index: true }) userId!: string;
  @Prop({ required: true }) calendarId!: string;
  @Prop({ required: true }) sessionId!: string;
  @Prop({ required: true }) fingerprint!: string;
  @Prop({ type: Date, required: true }) scheduledAt!: Date;
}
export const GoogleCalendarMappingSchema = SchemaFactory.createForClass(
  GoogleCalendarMappingDocument,
);
GoogleCalendarMappingSchema.index({ userId: 1, calendarId: 1, scheduledAt: 1 });
export type GoogleCalendarMapping =
  HydratedDocument<GoogleCalendarMappingDocument>;
