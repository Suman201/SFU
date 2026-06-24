import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ProfileCredentialDto {
  @IsString()
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  issuer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  year?: string;
}

export class ProfileExperienceDto {
  @IsString()
  @MaxLength(160)
  role!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  organization?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  period?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;
}

export class ProfileSocialLinkDto {
  @IsString()
  @MaxLength(80)
  label!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url!: string;
}

export class UpdateMyProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  languages?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ProfileCredentialDto)
  credentials?: ProfileCredentialDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ProfileCredentialDto)
  education?: ProfileCredentialDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ProfileExperienceDto)
  experience?: ProfileExperienceDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ProfileSocialLinkDto)
  socialLinks?: ProfileSocialLinkDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  availability?: string;

  @IsOptional()
  @IsBoolean()
  publicProfileEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  learningGoals?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  interests?: string[];
}

export class ProfileNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  classReminders?: boolean;

  @IsOptional()
  @IsBoolean()
  chatMessages?: boolean;

  @IsOptional()
  @IsBoolean()
  announcements?: boolean;

  @IsOptional()
  @IsBoolean()
  recordingReady?: boolean;
}

export class ProfilePrivacySettingsDto {
  @IsOptional()
  @IsBoolean()
  showEmailOnPublicProfile?: boolean;

  @IsOptional()
  @IsBoolean()
  allowTeacherMessages?: boolean;
}

export class UpdateMySettingsDto {
  @IsOptional()
  @IsIn(['system', 'light', 'dark'])
  theme?: 'system' | 'light' | 'dark';

  @IsOptional()
  @IsString()
  @MaxLength(24)
  locale?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ProfileNotificationSettingsDto)
  notifications?: ProfileNotificationSettingsDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ProfilePrivacySettingsDto)
  privacy?: ProfilePrivacySettingsDto;
}
