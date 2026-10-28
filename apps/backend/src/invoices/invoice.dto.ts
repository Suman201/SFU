import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  INVOICE_CURRENCIES,
  type InvoiceCurrency,
} from '@native-sfu/contracts';
export class InvoicePartyDto {
  @IsString() @MinLength(2) @MaxLength(150) name!: string;
  @IsEmail() @MaxLength(200) email!: string;
  @IsString() @MinLength(5) @MaxLength(500) address!: string;
  @Matches(/^[A-Z]{2}$/) countryCode!: string;
  @IsString() @MaxLength(50) vatNumber!: string;
}
export class InvoiceSellerDto extends InvoicePartyDto {
  @IsString() @MaxLength(100) registrationNumber!: string;
  @IsString() @MaxLength(1000) paymentInstructions!: string;
}
export class InvoiceLineDto {
  @IsString() @MinLength(2) @MaxLength(240) description!: string;
  @IsInt() @Min(1) @Max(1_000_000) quantityMilli!: number;
  @IsInt() @Min(0) @Max(100_000_000) unitPriceMinor!: number;
  @IsInt() @Min(0) @Max(10_000) taxRateBps!: number;
}
export class InvoiceWriteDto {
  @IsOptional() @IsInt() @Min(0) version?: number;
  @IsDefined()
  @ValidateNested()
  @Type(() => InvoicePartyDto)
  customer!: InvoicePartyDto;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) invoiceDate!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) supplyDate!: string;
  @IsIn(INVOICE_CURRENCIES) currency!: InvoiceCurrency;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
  @IsString() @MaxLength(500) taxNote!: string;
  @IsString() @MaxLength(1000) notes!: string;
  @IsString() @MaxLength(100) reference!: string;
}
export class InvoiceSettingsDto {
  @IsInt() @Min(0) version!: number;
  @IsDefined()
  @ValidateNested()
  @Type(() => InvoiceSellerDto)
  seller!: InvoiceSellerDto;
  @IsIn(INVOICE_CURRENCIES) defaultCurrency!: InvoiceCurrency;
  @IsString() @MaxLength(500) defaultTaxNote!: string;
}
export class InvoiceVersionDto {
  @IsInt() @Min(0) version!: number;
}
export class InvoicePaymentDto extends InvoiceVersionDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) paidDate!: string;
  @IsString() @MinLength(3) @MaxLength(150) reference!: string;
}
export class InvoiceVoidDto extends InvoiceVersionDto {
  @IsString() @MinLength(10) @MaxLength(500) reason!: string;
}
export class InvoiceEmailDto {
  @IsUUID('4') requestId!: string;
}
