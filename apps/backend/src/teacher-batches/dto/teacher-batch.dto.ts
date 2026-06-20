import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BATCH_STATUSES, BATCH_WEEKDAYS, BatchStatus, BatchWeekday } from '../../database/schemas';

export class BatchScheduleDto {
  @ApiProperty({ enum: BATCH_WEEKDAYS, example: 'MONDAY' })
  @IsEnum(BATCH_WEEKDAYS)
  dayOfWeek!: BatchWeekday;

  @ApiProperty({ example: '10:00', description: '24-hour HH:mm start time.' })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must use HH:mm format' })
  startTime!: string;
}

export class CreateTeacherBatchDto {
  @ApiProperty({ example: 'Laravel Morning Batch 2026' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'course_uuid' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courseId?: string;

  @ApiPropertyOptional({ example: 'Laravel' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courseName?: string;

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 30 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxCapacity!: number;

  @ApiProperty({ type: [BatchScheduleDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchScheduleDto)
  schedule!: BatchScheduleDto[];
}

export class UpdateTeacherBatchDto {
  @ApiPropertyOptional({ example: 'Laravel Morning Batch 2026' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'course_uuid' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courseId?: string;

  @ApiPropertyOptional({ example: 'Laravel' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courseName?: string;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxCapacity?: number;

  @ApiPropertyOptional({ type: [BatchScheduleDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchScheduleDto)
  schedule?: BatchScheduleDto[];
}

export class UpdateTeacherBatchStatusDto {
  @ApiProperty({ enum: BATCH_STATUSES, example: 'ACTIVE' })
  @IsEnum(BATCH_STATUSES)
  status!: BatchStatus;
}
