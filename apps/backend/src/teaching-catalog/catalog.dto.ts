import { Type } from 'class-transformer';
import {
  ValidateIf,
  ValidateNested,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
export class CatalogWriteDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([
    'knowledge_review',
    'spoken_sample',
    'portfolio_review',
    'practical_demonstration',
  ])
  assessmentType?: string;
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(1000)
  assessmentInstructions?: string;
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(500)
  description?: string;
  @ValidateIf((_, value) => value !== undefined) @IsMongoId() parentId?: string;
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsString({ each: true })
  countryCodes?: string[];
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  aliases?: string[];
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  version?: number;
}
export class SubmitTutorDto {
  @IsInt() @Min(0) revision!: number;
  @IsBoolean() adultTutorConfirmed!: boolean;
  @IsBoolean() codeOfConductAccepted!: boolean;
  @IsBoolean() safeguardingAccepted!: boolean;
}
export class AssessmentResultDto {
  @IsMongoId() categoryId!: string;
  @IsInt() @Min(0) version!: number;
  @IsBoolean() passed!: boolean;
  @IsString() @MinLength(10) @MaxLength(1000) notes!: string;
}
export class ReviewTutorDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  introVideoReviewed?: boolean;
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => AssessmentResultDto)
  assessmentResults?: AssessmentResultDto[];

  @IsIn(['approved', 'changes_requested', 'rejected']) decision!:
    | 'approved'
    | 'changes_requested'
    | 'rejected';
  @IsInt() @Min(0) revision!: number;
  @IsString() @MinLength(10) @MaxLength(2000) note!: string;
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  identityChecked?: boolean;
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  teachingSuitabilityChecked?: boolean;
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  safeguardingChecked?: boolean;
}
