import { IsEmail, IsString, ValidateIf, Matches, MaxLength, MinLength } from 'class-validator';
export class AccountPasswordProofDto {
  @IsString() @MinLength(8) @MaxLength(128) currentPassword!: string;
}
export class AccountPasswordDto extends AccountPasswordProofDto {
  @IsString() @MinLength(10) @MaxLength(72) newPassword!: string;
}
export class AccountEmailDto extends AccountPasswordProofDto {
  @IsEmail() @MaxLength(254) email!: string;
}
export class AccountProviderStartDto extends AccountPasswordProofDto { @Matches(/^[a-f0-9]{64}$/) challenge!: string }
export class AccountProviderCompleteDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/) ticket!: string;
  @Matches(/^[A-Za-z0-9_-]{43}$/) verifier!: string;
}
export class AccountEmailTokenDto { @Matches(/^[a-f0-9]{64}$/) token!: string }

export class AccountProfileDto {
  @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(2) @MaxLength(120) displayName?: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MaxLength(40) phone?: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MaxLength(80) timezone?: string;
}
