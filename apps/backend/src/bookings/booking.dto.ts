import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SUPPORTED_CURRENCIES, type CurrencyCode } from '@native-sfu/contracts';
import { InvoicePartyDto } from '../invoices/invoice.dto';

export class LessonOfferDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsString() @MaxLength(1000) description!: string;
  @IsInt() @Min(15) @Max(180) durationMinutes!: number;
  @IsInt() @Min(0) @Max(100_000_000) amountMinor!: number;
  @IsIn(SUPPORTED_CURRENCIES) currency!: CurrencyCode;
  @IsBoolean() active!: boolean;
  @IsOptional() @IsInt() @Min(0) version?: number;
}
export class LessonSlotDto {
  @IsUUID() offerId!: string;
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  startsAt!: string;
}
export class BookingReserveDto {
  @IsUUID() requestId!: string;
  @IsInt() @Min(0) @Max(200_000_000) expectedTotalMinor!: number;
  @IsOptional() @IsInt() @Min(0) expectedOfferVersion?: number;
  @IsDefined()
  @ValidateNested()
  @Type(() => InvoicePartyDto)
  billing!: InvoicePartyDto;
  @IsOptional() @IsString() @MaxLength(1500) goal?: string;
}
export class BookingCancellationDto {
  @IsUUID() requestId!: string;
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
export class BookingRefundDto extends BookingCancellationDto {
  @IsInt() @Min(1) @Max(100_000_000) amountMinor!: number;
}
