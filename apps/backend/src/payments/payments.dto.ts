import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PAYMENT_CURRENCY_CODES, type PaymentCurrency } from '@native-sfu/contracts';

export class CheckoutDto {
  @IsString() @Length(1, 64) batchId!: string;
}

export class RefundDto {
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) amountMinor?: number;
  @IsString() @Length(5, 300) reason!: string;
  @IsString() @Length(8, 100) requestId!: string;
}

export class PayoutRequestDto {
  @IsIn(PAYMENT_CURRENCY_CODES) currency!: PaymentCurrency;
  @IsInt() @Min(1) @Max(100_000_000) amountMinor!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsString() @Length(8, 100) requestId!: string;
}

export class PayoutDecisionDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class TeacherCommissionOverrideDto {
  @IsString() @Length(1, 64) teacherId!: string;
  @IsOptional() @IsString() @MaxLength(200) teacherName?: string;
  @IsInt() @Min(0) @Max(10_000) commissionBps!: number;
}

export class FinanceSettingsDto {
  @IsInt() @Min(0) version!: number;
  @IsInt() @Min(0) @Max(10_000) commissionBps!: number;
  @IsInt() @Min(0) @Max(90) holdDays!: number;
  @IsInt() @Min(100) @Max(10_000_000) minimumPayoutMinor!: number;
  @IsArray() @ArrayMaxSize(10) @IsIn(PAYMENT_CURRENCY_CODES, { each: true }) enabledCurrencies!: PaymentCurrency[];
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => TeacherCommissionOverrideDto) teacherOverrides!: TeacherCommissionOverrideDto[];
}

export class TestCheckoutDto {
  @IsIn(['succeed', 'decline']) outcome!: 'succeed' | 'decline';
}

export class TestDisputeDto {
  @IsIn(['needs_response', 'won', 'lost']) status!: 'needs_response' | 'won' | 'lost';
}
