import { IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class PushSubscriptionKeysDto {
  @IsString()
  @IsNotEmpty()
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  auth!: string;
}

export class RegisterPushSubscriptionDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(4096)
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;

  @IsOptional()
  @IsNumber()
  expirationTime?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}
