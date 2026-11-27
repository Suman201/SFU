import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  DISPUTE_STATUSES,
  LEDGER_ENTRY_TYPES,
  PAYMENT_CURRENCY_CODES,
  PAYMENT_DISPUTE_STATES,
  PAYMENT_STATUSES,
  PAYOUT_STATUSES,
  REFUND_STATUSES,
  type DisputeStatus,
  type FinanceSettings,
  type LedgerEntryType,
  type LedgerLine,
  type PaymentCurrency,
  type PaymentDisputeState,
  type PaymentEnrollmentState,
  type PaymentGatewayId,
  type PaymentStatus,
  type PayoutStatus,
  type RefundStatus,
} from '@native-sfu/contracts';

const uuid = () => randomUUID();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

@Schema({ collection: 'finance_settings', versionKey: false })
export class FinanceSettingsDocument {
  @Prop({ type: String, default: 'default' }) _id!: string;
  @Prop({ type: Object, required: true }) value!: FinanceSettings;
}
export const FinanceSettingsSchema = SchemaFactory.createForClass(FinanceSettingsDocument);

@Schema({ collection: 'finance_counters', versionKey: false })
export class FinanceCounterDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ default: 0 }) next!: number;
}
export const FinanceCounterSchema = SchemaFactory.createForClass(FinanceCounterDocument);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

@Schema({ collection: 'payments', timestamps: true, optimisticConcurrency: false })
export class PaymentDocument {
  @Prop({ type: String, default: uuid }) _id!: string;
  @Prop({ required: true, enum: PAYMENT_STATUSES, default: 'pending', index: true }) status!: PaymentStatus;
  @Prop({ required: true, enum: ['stripe', 'test'] }) gateway!: PaymentGatewayId;
  @Prop({ required: true, enum: PAYMENT_CURRENCY_CODES }) currency!: PaymentCurrency;
  @Prop({ required: true, min: 0 }) amountMinor!: number;
  /** Commission rate captured when the checkout was created. */
  @Prop({ required: true, min: 0 }) commissionBps!: number;
  @Prop({ required: true, min: 0 }) commissionMinor!: number;
  @Prop({ required: true, min: 0 }) teacherMinor!: number;
  @Prop({ default: 0 }) gatewayFeeMinor!: number;
  @Prop({ default: 0 }) refundedMinor!: number;
  @Prop({ default: 0 }) refundedCommissionMinor!: number;
  @Prop({ default: 0 }) refundedTeacherMinor!: number;
  /** Refund amount requested but not yet confirmed by the gateway. */
  @Prop({ default: 0 }) refundPendingMinor!: number;

  @Prop({ required: true, index: true }) studentId!: string;
  @Prop({ required: true }) studentName!: string;
  @Prop({ required: true }) studentEmail!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true }) teacherName!: string;
  @Prop({ required: true, index: true }) batchId!: string;
  @Prop({ required: true }) batchName!: string;
  @Prop({ required: true }) description!: string;

  /**
   * Set while a checkout is open or paid so a student cannot start a second
   * payment for the same batch. Cleared when the payment fails, expires or is
   * fully refunded.
   */
  @Prop({ type: String }) activeKey?: string;

  @Prop({ type: String }) gatewaySessionId?: string;
  @Prop({ type: String }) gatewayPaymentId?: string;
  @Prop({ type: String }) gatewayChargeId?: string;
  @Prop({ type: String }) checkoutUrl?: string;
  @Prop({ type: Date }) expiresAt?: Date;
  /** Seat reservation for this checkout. */
  @Prop({ type: Date }) seatHoldUntil?: Date;

  @Prop({ type: Date }) paidAt?: Date;
  @Prop({ type: Date }) failedAt?: Date;
  @Prop({ type: String }) failureReason?: string;

  @Prop({ required: true, enum: ['pending', 'granted', 'refund_required', 'not_granted'], default: 'pending' })
  enrollmentState!: PaymentEnrollmentState;
  @Prop({ type: String }) enrollmentId?: string;

  @Prop({ required: true, enum: PAYMENT_DISPUTE_STATES, default: 'none' }) disputeState!: PaymentDisputeState;
  @Prop({ type: Date, index: true }) earningsAvailableAt?: Date;
  @Prop({ type: Date }) earningsReleasedAt?: Date;

  @Prop({ type: String }) receiptNumber?: string;
  /** Whether the gateway processing fee has been recorded in the ledger. */
  @Prop({ default: false }) feeRecorded!: boolean;
  /** Short lease that serialises every state change of one payment. */
  @Prop({ type: String }) lockToken?: string;
  @Prop({ type: Date }) lockUntil?: Date;
  @Prop({ type: Object }) receiptEmail?: {
    status: 'pending' | 'processing' | 'sent' | 'failed' | 'disabled';
    attempts: number;
    nextAttemptAt: Date;
    leaseToken?: string;
    leaseUntil?: Date;
  };

  createdAt!: Date;
  updatedAt!: Date;
}
export type PaymentMongo = HydratedDocument<PaymentDocument>;
export const PaymentSchema = SchemaFactory.createForClass(PaymentDocument);
PaymentSchema.index({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } });
PaymentSchema.index({ gateway: 1, gatewaySessionId: 1 }, { unique: true, partialFilterExpression: { gatewaySessionId: { $type: 'string' } } });
PaymentSchema.index({ gateway: 1, gatewayPaymentId: 1 }, { unique: true, partialFilterExpression: { gatewayPaymentId: { $type: 'string' } } });
PaymentSchema.index({ receiptNumber: 1 }, { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } });
PaymentSchema.index({ createdAt: -1, _id: 1 });
PaymentSchema.index({ studentId: 1, createdAt: -1 });
PaymentSchema.index({ teacherId: 1, status: 1, createdAt: -1 });
PaymentSchema.index({ batchId: 1, status: 1, seatHoldUntil: 1 });
PaymentSchema.index({ status: 1, earningsReleasedAt: 1, earningsAvailableAt: 1 });
PaymentSchema.index({ 'receiptEmail.status': 1, 'receiptEmail.nextAttemptAt': 1 });

// ---------------------------------------------------------------------------
// Refunds and disputes
// ---------------------------------------------------------------------------

@Schema({ collection: 'payment_refunds', timestamps: true })
export class RefundDocument {
  @Prop({ type: String, default: uuid }) _id!: string;
  @Prop({ required: true, index: true }) paymentId!: string;
  /** Client or system supplied key; one refund per key. */
  @Prop({ required: true }) requestKey!: string;
  @Prop({ required: true, enum: PAYMENT_CURRENCY_CODES }) currency!: PaymentCurrency;
  @Prop({ required: true, min: 1 }) amountMinor!: number;
  @Prop({ required: true, min: 0 }) commissionMinor!: number;
  @Prop({ required: true, min: 0 }) teacherMinor!: number;
  @Prop({ required: true }) reason!: string;
  @Prop({ required: true, enum: REFUND_STATUSES, default: 'pending', index: true }) status!: RefundStatus;
  @Prop({ required: true, enum: ['admin', 'system', 'gateway'] }) initiatedBy!: 'admin' | 'system' | 'gateway';
  @Prop({ type: String }) requestedById?: string;
  @Prop({ type: String }) requestedByName?: string;
  @Prop({ type: String }) gatewayRefundId?: string;
  @Prop({ type: String }) failureReason?: string;
  @Prop({ type: Date }) completedAt?: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type RefundMongo = HydratedDocument<RefundDocument>;
export const RefundSchema = SchemaFactory.createForClass(RefundDocument);
RefundSchema.index({ paymentId: 1, requestKey: 1 }, { unique: true });
RefundSchema.index({ gatewayRefundId: 1 }, { unique: true, partialFilterExpression: { gatewayRefundId: { $type: 'string' } } });
RefundSchema.index({ createdAt: -1 });

@Schema({ collection: 'payment_disputes', timestamps: true })
export class DisputeDocument {
  @Prop({ type: String, default: uuid }) _id!: string;
  @Prop({ required: true, index: true }) paymentId!: string;
  @Prop({ required: true, unique: true }) gatewayDisputeId!: string;
  @Prop({ required: true, enum: PAYMENT_CURRENCY_CODES }) currency!: PaymentCurrency;
  @Prop({ required: true, min: 0 }) amountMinor!: number;
  @Prop({ default: 0 }) feeMinor!: number;
  /** Teacher share frozen while the dispute is open. */
  @Prop({ default: 0 }) frozenTeacherMinor!: number;
  @Prop({ default: 0 }) frozenCommissionMinor!: number;
  /** Bucket the frozen teacher share came from, so it can be returned there. */
  @Prop({ type: String, enum: ['teacher_pending', 'teacher_available'] }) frozenFrom?: 'teacher_pending' | 'teacher_available';
  @Prop({ required: true }) reason!: string;
  @Prop({ required: true, enum: DISPUTE_STATUSES, index: true }) status!: DisputeStatus;
  @Prop({ type: Date }) evidenceDueBy?: Date;
  @Prop({ type: Date }) resolvedAt?: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DisputeMongo = HydratedDocument<DisputeDocument>;
export const DisputeSchema = SchemaFactory.createForClass(DisputeDocument);

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

@Schema({ collection: 'teacher_payouts', timestamps: true })
export class PayoutDocument {
  @Prop({ type: String, default: uuid }) _id!: string;
  @Prop({ required: true, index: true }) teacherId!: string;
  @Prop({ required: true }) teacherName!: string;
  @Prop({ required: true }) requestKey!: string;
  @Prop({ required: true, enum: PAYMENT_CURRENCY_CODES }) currency!: PaymentCurrency;
  @Prop({ required: true, min: 1 }) amountMinor!: number;
  @Prop({ required: true, enum: PAYOUT_STATUSES, default: 'requested', index: true }) status!: PayoutStatus;
  @Prop({ required: true, enum: ['stripe', 'test'] }) gateway!: PaymentGatewayId;
  @Prop({ type: String }) note?: string;
  @Prop({ type: String }) adminNote?: string;
  @Prop({ type: String }) failureReason?: string;
  @Prop({ type: String }) gatewayTransferId?: string;
  @Prop({ type: Number }) reversedMinor?: number;
  @Prop({ type: Date }) transferAttemptedAt?: Date;
  @Prop({ type: String }) gatewayAccountId?: string;
  @Prop({ type: Boolean }) gatewayTestMode?: boolean;
  @Prop({ type: String }) decidedById?: string;
  @Prop({ type: String }) decidedByName?: string;
  @Prop({ type: Date }) decidedAt?: Date;
  @Prop({ type: Date }) paidAt?: Date;
  /** Lease held while the transfer is sent so two admins cannot pay twice. */
  @Prop({ type: String }) leaseToken?: string;
  @Prop({ type: Date }) leaseUntil?: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayoutMongo = HydratedDocument<PayoutDocument>;
export const PayoutSchema = SchemaFactory.createForClass(PayoutDocument);
PayoutSchema.index({ teacherId: 1, requestKey: 1 }, { unique: true });
PayoutSchema.index({ gatewayTransferId: 1 }, { unique: true, partialFilterExpression: { gatewayTransferId: { $type: 'string' } } });
PayoutSchema.index({ createdAt: -1 });

@Schema({ collection: 'teacher_payout_accounts', timestamps: true, versionKey: false })
export class PayoutAccountDocument {
  /** Teacher user id. */
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, enum: ['stripe', 'test'] }) gateway!: PaymentGatewayId;
  @Prop({ required: true }) accountId!: string;
  @Prop({ default: false }) detailsSubmitted!: boolean;
  @Prop({ default: false }) payoutsEnabled!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayoutAccountMongo = HydratedDocument<PayoutAccountDocument>;
export const PayoutAccountSchema = SchemaFactory.createForClass(PayoutAccountDocument);
PayoutAccountSchema.index({ gateway: 1, accountId: 1 }, { unique: true });

/** Transaction revision used to serialize balance changes; legacy lease fields remain readable. */
@Schema({ collection: 'teacher_balance_locks', versionKey: false })
export class TeacherBalanceLockDocument {
  @Prop({ type: Number }) revision?: number;
  @Prop({ type: String }) _id!: string;
  @Prop({ type: String }) token?: string;
  @Prop({ type: Date }) until?: Date;
}
export const TeacherBalanceLockSchema = SchemaFactory.createForClass(TeacherBalanceLockDocument);

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * One balanced journal entry. All lines are stored in a single document, so an
 * entry is written atomically even on a standalone MongoDB server, and the
 * unique key makes every posting idempotent.
 */
@Schema({ collection: 'ledger_entries', timestamps: { createdAt: true, updatedAt: false }, versionKey: false })
export class LedgerEntryDocument {
  @Prop({ type: String, default: uuid }) _id!: string;
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true, enum: LEDGER_ENTRY_TYPES, index: true }) type!: LedgerEntryType;
  @Prop({ required: true, enum: PAYMENT_CURRENCY_CODES }) currency!: PaymentCurrency;
  @Prop({ required: true, index: true }) occurredAt!: Date;
  @Prop({ required: true }) memo!: string;
  @Prop({ type: String, index: true }) paymentId?: string;
  @Prop({ type: String, index: true }) bookingOrderId?: string;
  @Prop({ type: String }) refundId?: string;
  @Prop({ type: String }) disputeId?: string;
  @Prop({ type: String, index: true }) payoutId?: string;
  @Prop({ type: String, index: true }) teacherId?: string;
  @Prop({
    type: [{ _id: false, account: String, teacherId: String, debitMinor: Number, creditMinor: Number }],
    required: true,
  })
  lines!: LedgerLine[];
  createdAt!: Date;
}
export type LedgerEntryMongo = HydratedDocument<LedgerEntryDocument>;
export const LedgerEntrySchema = SchemaFactory.createForClass(LedgerEntryDocument);
LedgerEntrySchema.index({ 'lines.account': 1, 'lines.teacherId': 1, currency: 1 });
LedgerEntrySchema.index({ teacherId: 1, occurredAt: -1 });

// ---------------------------------------------------------------------------
// Gateway events
// ---------------------------------------------------------------------------

/**
 * Verified gateway notifications. The id is `${gateway}:${eventId}`, so a
 * redelivered notification is stored only once.
 */
@Schema({ collection: 'payment_gateway_events', timestamps: { createdAt: 'receivedAt', updatedAt: true }, versionKey: false })
export class GatewayEventDocument {
  @Prop({ type: String }) _id!: string;
  @Prop({ required: true, enum: ['stripe', 'test'] }) gateway!: PaymentGatewayId;
  @Prop({ required: true }) type!: string;
  @Prop({ type: Object, required: true }) event!: Record<string, unknown>;
  @Prop({ required: true, enum: ['pending', 'processing', 'done', 'failed', 'ignored'], default: 'pending', index: true })
  status!: 'pending' | 'processing' | 'done' | 'failed' | 'ignored';
  @Prop({ default: 0 }) attempts!: number;
  @Prop({ type: Date, default: () => new Date() }) nextAttemptAt!: Date;
  @Prop({ type: String }) leaseToken?: string;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop({ type: String }) lastError?: string;
  @Prop({ type: String, index: true }) paymentId?: string;
  @Prop({ type: Date }) processedAt?: Date;
  receivedAt!: Date;
  updatedAt!: Date;
}
export type GatewayEventMongo = HydratedDocument<GatewayEventDocument>;
export const GatewayEventSchema = SchemaFactory.createForClass(GatewayEventDocument);
GatewayEventSchema.index({ status: 1, nextAttemptAt: 1 });
GatewayEventSchema.index({ receivedAt: -1 });

export const PAYMENT_MODELS = [
  { name: FinanceSettingsDocument.name, schema: FinanceSettingsSchema },
  { name: FinanceCounterDocument.name, schema: FinanceCounterSchema },
  { name: PaymentDocument.name, schema: PaymentSchema },
  { name: RefundDocument.name, schema: RefundSchema },
  { name: DisputeDocument.name, schema: DisputeSchema },
  { name: PayoutDocument.name, schema: PayoutSchema },
  { name: PayoutAccountDocument.name, schema: PayoutAccountSchema },
  { name: TeacherBalanceLockDocument.name, schema: TeacherBalanceLockSchema },
  { name: LedgerEntryDocument.name, schema: LedgerEntrySchema },
  { name: GatewayEventDocument.name, schema: GatewayEventSchema },
];
