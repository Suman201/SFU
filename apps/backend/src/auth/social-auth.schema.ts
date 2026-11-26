import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SocialProvider = 'google' | 'apple';
export interface SocialIdentity {
  provider: SocialProvider;
  subject: string;
  email: string;
  name: string;
}

@Schema({ collection: 'social_auth_flows', timestamps: true })
export class SocialAuthFlow {
  @Prop({ required: true, unique: true }) stateHash!: string;
  @Prop({ required: true }) challenge!: string;
  @Prop({ required: true, enum: ['google', 'apple'] }) provider!: SocialProvider;
  @Prop({ required: true, enum: ['student', 'teacher'] }) role!: 'student' | 'teacher';
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ required: true }) nonce!: string;
  @Prop() codeVerifier?: string;
  @Prop({ required: true, enum: ['pending', 'processing', 'ready', 'exchanging', 'completed'] }) status!: string;
  @Prop({ unique: true, sparse: true }) ticketHash?: string;
  @Prop({ type: Object }) identity?: SocialIdentity;
  @Prop({ required: true, type: Date }) expiresAt!: Date;
}
export type SocialAuthFlowDocument = HydratedDocument<SocialAuthFlow>;
export const SocialAuthFlowSchema = SchemaFactory.createForClass(SocialAuthFlow);
SocialAuthFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
