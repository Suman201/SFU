import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from 'class-validator';
import { INGEST_RESTART_MODES, INGEST_SOURCE_TYPES, type IngestRestartMode, type IngestSourceType } from '@native-sfu/contracts';

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

export class IngestHeaderAuthDto {
  @ApiProperty({ example: 'x-origin-token' })
  @IsString()
  @MaxLength(120)
  @Matches(HEADER_NAME_PATTERN)
  name!: string;

  @ApiProperty({ example: 'vault://media/origin-token' })
  @IsString()
  @MaxLength(500)
  valueSecretRef!: string;
}

export class IngestAuthConfigDto {
  @ApiPropertyOptional({ example: 'publisher-user' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  basicUsername?: string;

  @ApiPropertyOptional({ example: 'vault://media/basic-password' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  basicPasswordSecretRef?: string;

  @ApiPropertyOptional({ example: 'vault://media/bearer-token' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bearerTokenSecretRef?: string;

  @ApiPropertyOptional({ type: [IngestHeaderAuthDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => IngestHeaderAuthDto)
  headers?: IngestHeaderAuthDto[];
}

export class IngestRestartPolicyDto {
  @ApiProperty({ enum: INGEST_RESTART_MODES, example: 'on_failure' })
  @IsIn(INGEST_RESTART_MODES)
  mode!: IngestRestartMode;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxAttempts?: number;

  @ApiPropertyOptional({ example: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  initialBackoffMs?: number;

  @ApiPropertyOptional({ example: 30000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  maxBackoffMs?: number;
}

export class CreateIngestDto {
  @ApiPropertyOptional({ example: 'Marketing pre-roll' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ example: 'System Ingest' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiProperty({ enum: INGEST_SOURCE_TYPES, example: 'hls' })
  @IsIn(INGEST_SOURCE_TYPES)
  sourceType!: IngestSourceType;

  @ApiProperty({ example: 'https://media.example.test/live/index.m3u8' })
  @IsString()
  @MaxLength(4096)
  sourceUrl!: string;

  @ApiPropertyOptional({ type: () => IngestAuthConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => IngestAuthConfigDto)
  auth?: IngestAuthConfigDto;

  @ApiPropertyOptional({ type: () => IngestRestartPolicyDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => IngestRestartPolicyDto)
  restartPolicy?: IngestRestartPolicyDto;
}
