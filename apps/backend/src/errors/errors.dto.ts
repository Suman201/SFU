import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ERROR_CATALOG } from '@native-sfu/contracts';
export class ReportErrorDto {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{8,128}$/) reference!: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{8,128}$/)
  requestId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  frames?: string[];
  @IsIn(Object.keys(ERROR_CATALOG)) code!: keyof typeof ERROR_CATALOG;
  @IsIn(['web', 'desktop', 'admin']) source!: 'web' | 'desktop' | 'admin';
  @IsString() @MaxLength(4096) path!: string;
  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
  method?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9:_-]{1,80}$/)
  operation?: string;
  @IsOptional() @IsInt() @Min(0) @Max(599) statusCode?: number;
}
export class ListErrorsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @IsOptional() @IsIn(['all', 'open', 'resolved']) status:
    | 'all'
    | 'open'
    | 'resolved' = 'all';
  @IsOptional() @IsIn(['all', 'server', 'web', 'desktop', 'admin']) source =
    'all';
  @IsOptional() @IsString() @MaxLength(128) reference = '';
}
export class UpdateErrorDto {
  @IsIn(['open', 'resolved']) status!: 'open' | 'resolved';
}
