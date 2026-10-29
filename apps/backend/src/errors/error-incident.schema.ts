import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
@Schema({ collection: 'error_incidents', versionKey: false })
export class ErrorIncidentDocument {
  @Prop({ required: true }) reference!: string;
  @Prop() requestId?: string;
  @Prop({ required: true }) code!: string;
  @Prop({ required: true }) source!: string;
  @Prop() statusCode?: number;
  @Prop() method?: string;
  @Prop() operation?: string;
  @Prop({ required: true }) path!: string;
  @Prop({ required: true }) title!: string;
  @Prop({ required: true }) message!: string;
  @Prop({ required: true }) nextStep!: string;
  @Prop() exceptionName?: string;
  @Prop() diagnosticKind?: string;
  @Prop() developerHint?: string;
  @Prop({ type: [String], default: [] }) frames!: string[];
  @Prop() userId?: string;
  @Prop({ required: true, default: 'open', enum: ['open', 'resolved'] })
  status!: string;
  @Prop({ required: true, default: Date.now }) createdAt!: Date;
  @Prop() resolvedAt?: Date;
  @Prop() resolvedBy?: string;
}
export type ErrorIncidentModel = HydratedDocument<ErrorIncidentDocument>;
export const ErrorIncidentSchema = SchemaFactory.createForClass(
  ErrorIncidentDocument,
);
ErrorIncidentSchema.index({ createdAt: -1, _id: -1 });
ErrorIncidentSchema.index({ status: 1, createdAt: -1 });
ErrorIncidentSchema.index({ requestId: 1 });
ErrorIncidentSchema.index({ reference: 1 });

ErrorIncidentSchema.index(
  { source: 1, userId: 1, reference: 1 },
  {
    unique: true,
    partialFilterExpression: { source: { $in: ['web', 'desktop', 'admin'] } },
  },
);
