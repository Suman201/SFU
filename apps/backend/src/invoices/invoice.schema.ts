import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type {
  InvoiceInput,
  InvoiceSeller,
  InvoiceSettings,
  InvoiceTotals,
  InvoiceEmailAttempt,
} from '@native-sfu/contracts';
@Schema({ collection: 'invoices', timestamps: true })
export class InvoiceDocument {
  @Prop({ type: String, default: () => randomUUID() }) _id!: string;
  @Prop({ default: 0 }) version!: number;
  @Prop({
    default: 'draft',
    enum: ['draft', 'issued', 'paid', 'void'],
    index: true,
  })
  status!: string;
  @Prop({ type: String }) number?: string;
  @Prop({ type: Object, required: true }) input!: InvoiceInput;
  @Prop({ type: Object, required: true }) seller!: InvoiceSeller;
  @Prop({ type: Object, required: true }) totals!: InvoiceTotals;
  @Prop({ type: Buffer }) pdf?: Buffer;
  @Prop({ type: Buffer }) voidPdf?: Buffer;
  @Prop({ type: Date }) issuedAt?: Date;
  @Prop({ type: Date }) paidAt?: Date;
  @Prop({ type: String }) paymentReference?: string;
  @Prop({ type: String }) voidReason?: string;
  @Prop({ type: String }) createdBy!: string;
  @Prop({ type: [Object], default: [] }) emailAttempts!: InvoiceEmailAttempt[];
  @Prop({ type: Date }) emailLeaseUntil?: Date;
  @Prop({ type: String }) emailLeaseToken?: string;
  @Prop({ type: Object }) paymentEmail?: {
    status: 'pending' | 'processing' | 'done' | 'failed';
    attempts: number;
    nextAttemptAt: Date;
    leaseUntil?: Date;
    leaseToken?: string;
  };
  createdAt!: Date;
  updatedAt!: Date;
}
export type InvoiceMongo = HydratedDocument<InvoiceDocument>;
export const InvoiceSchema = SchemaFactory.createForClass(InvoiceDocument);
InvoiceSchema.index(
  { number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'string' } } },
);
InvoiceSchema.index({ createdAt: -1, _id: 1 });
InvoiceSchema.index({
  'paymentEmail.status': 1,
  'paymentEmail.nextAttemptAt': 1,
});
@Schema({ collection: 'invoice_settings', versionKey: false })
export class InvoiceSettingsDocument {
  @Prop({ type: String, default: 'issuer' }) _id!: string;
  @Prop({ type: Object, required: true }) value!: InvoiceSettings;
}
export const InvoiceSettingsSchema = SchemaFactory.createForClass(
  InvoiceSettingsDocument,
);
@Schema({ collection: 'invoice_counters', versionKey: false })
export class InvoiceCounterDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ default: 0 }) next!: number;
}
export const InvoiceCounterSchema = SchemaFactory.createForClass(
  InvoiceCounterDocument,
);
