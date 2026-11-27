import { SUPPORTED_CURRENCIES } from '@native-sfu/contracts';
import { Transform } from 'class-transformer';
import { IsInt, IsISO31661Alpha2, IsString, IsOptional, IsIn, Matches, MaxLength, Min, MinLength } from 'class-validator';
export class BillingVersionDto { @IsInt() @Min(0) version!: number }
export class CustomerBillingDto extends BillingVersionDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(150) name!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(5) @MaxLength(500) address!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value) @IsISO31661Alpha2() countryCode!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MaxLength(50) vatNumber!: string;
}

export class BillingHistoryQueryDto {
  @IsOptional() @Matches(/^[1-9][0-9]{0,4}$/) page?: string;
  @IsOptional() @IsIn(SUPPORTED_CURRENCIES) currency?: string;
  @IsOptional() @IsIn(['all', 'paid', 'open', 'refunds', 'unsuccessful', 'review']) status?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}
