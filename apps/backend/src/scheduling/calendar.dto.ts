import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
} from 'class-validator';
export class CalendarRangeDto {
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
}
export class CalendarChangeDto {
  @IsIn(['reschedule', 'cancel']) action!: 'reschedule' | 'cancel';
  @IsISO8601({ strict: true }) expectedScheduledAt!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) localTime?: string;
  @IsOptional() @IsTimeZone() timeZone?: string;
  @IsOptional() @IsISO8601({ strict: true }) chosenInstant?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class CalendarPreferenceDto {
  @IsTimeZone() timeZone!: string;
}
