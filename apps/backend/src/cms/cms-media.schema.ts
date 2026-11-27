import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
@Schema({ collection: 'cms_media', timestamps: true })
export class CmsMediaDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, unique: true }) digest!: string;
  @Prop({ required: true }) title!: string;
  @Prop({ type: String, default: '' }) altText!: string;
  @Prop({ required: true }) fileName!: string;
  @Prop({ required: true }) mimeType!: string;
  @Prop({ required: true }) extension!: string;
  @Prop({ required: true }) size!: number;
  @Prop({ default: 0 }) revision!: number;
  @Prop({ type: Date }) archivedAt?: Date;
  @Prop({ required: true }) uploadedBy!: string;
  createdAt!: Date; updatedAt!: Date;
}
export const CmsMediaSchema = SchemaFactory.createForClass(CmsMediaDocument);
CmsMediaSchema.index({ archivedAt: 1, createdAt: -1 });
export type CmsMediaMongo = HydratedDocument<CmsMediaDocument>;
