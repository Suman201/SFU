import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'Teaching Assistant' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'TEACHING_ASSISTANT' })
  @IsString()
  @Matches(/^[A-Z0-9_]+$/)
  @MaxLength(80)
  slug!: string;

  @ApiPropertyOptional({ example: 'Can assist teachers during live classes' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'Teaching Assistant' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'Can assist teachers during live classes' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class AssignRolePermissionsDto {
  @ApiProperty({ example: ['rooms:read', 'sessions:read'] })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissionSlugs!: string[];
}
