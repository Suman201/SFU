import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
@Schema({ collection: 'teaching_catalog', timestamps: true })
export class TeachingCatalogDocument {
  @Prop({ unique: true, sparse: true }) seedKey?: string;
  @Prop({ required: true, enum: ['category', 'subject', 'curriculum'] })
  kind!: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) name!: string;
  @Prop({ required: true }) normalizedName!: string;
  @Prop({ default: '', maxlength: 500 }) description!: string;
  @Prop({ default: '' }) parentId!: string;
  @Prop({ type: [String], default: [] }) countryCodes!: string[];
  @Prop({ type: [String], default: [] }) aliases!: string[];
  @Prop({ default: 'active', enum: ['active', 'archived'] }) status!: string;
  @Prop({ default: 0 }) sortOrder!: number;
  @Prop({ default: 'knowledge_review' }) assessmentType!: string;
  @Prop({
    default:
      'Explain a concept from your selected subjects, include a worked example and describe how you would check understanding.',
    maxlength: 1000,
  })
  assessmentInstructions!: string;
  __v!: number;
}
export type TeachingCatalogMongo = HydratedDocument<TeachingCatalogDocument>;
export const TeachingCatalogSchema = SchemaFactory.createForClass(
  TeachingCatalogDocument,
);
TeachingCatalogSchema.index(
  { kind: 1, parentId: 1, normalizedName: 1 },
  { unique: true },
);
TeachingCatalogSchema.index({ kind: 1, status: 1, sortOrder: 1 });
