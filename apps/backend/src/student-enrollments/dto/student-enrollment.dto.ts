import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { STUDENT_ENROLLMENT_STATUSES, StudentEnrollmentStatus } from '../../database/schemas';

export class CreateStudentEnrollmentDto {
  @ApiProperty({ example: 'student_uuid' })
  @IsString()
  @MaxLength(120)
  studentId!: string;

  @ApiProperty({ example: 'batch_uuid' })
  @IsString()
  @MaxLength(120)
  batchId!: string;

  @ApiPropertyOptional({ enum: STUDENT_ENROLLMENT_STATUSES, example: 'active' })
  @IsOptional()
  @IsEnum(STUDENT_ENROLLMENT_STATUSES)
  status?: StudentEnrollmentStatus;
}

export class BulkCreateStudentEnrollmentDto {
  @ApiProperty({ example: 'batch_uuid' })
  @IsString()
  @MaxLength(120)
  batchId!: string;

  @ApiProperty({ example: ['student_uuid_1', 'student_uuid_2'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  studentIds!: string[];

  @ApiPropertyOptional({ enum: STUDENT_ENROLLMENT_STATUSES, example: 'active' })
  @IsOptional()
  @IsEnum(STUDENT_ENROLLMENT_STATUSES)
  status?: StudentEnrollmentStatus;
}

export class UpdateStudentEnrollmentStatusDto {
  @ApiProperty({ enum: STUDENT_ENROLLMENT_STATUSES, example: 'suspended' })
  @IsEnum(STUDENT_ENROLLMENT_STATUSES)
  status!: StudentEnrollmentStatus;
}

export class StudentEnrollmentBatchQueryDto {
  @ApiPropertyOptional({ enum: STUDENT_ENROLLMENT_STATUSES, example: 'active' })
  @IsOptional()
  @IsEnum(STUDENT_ENROLLMENT_STATUSES)
  status?: StudentEnrollmentStatus;
}

export class BatchRosterQueryDto {
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Type(() => Boolean)
  includeInactive?: boolean;
}
