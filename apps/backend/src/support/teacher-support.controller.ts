import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { SupportRequestListQuery, SupportRequestStatus, SupportIssueType } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SupportService } from './support.service';
class TeacherRequestDto {
  @IsIn(['access', 'class_issue', 'recording_access', 'recording_problem', 'audio_video', 'assignment', 'other']) issueType!: SupportIssueType;
  @IsString() @MinLength(3) @MaxLength(180) subject!: string;
  @IsString() @MinLength(5) @MaxLength(5000) message!: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MaxLength(160) batchId?: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MaxLength(160) sessionId?: string;
}
export class SupportReplyDto {
  @IsString() @MinLength(1) @MaxLength(5000) message!: string;
  @IsISO8601() expectedUpdatedAt!: string;
}
class TeacherReplyDto {
  @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(1) @MaxLength(5000) message?: string;
  @ValidateIf((_, value) => value !== undefined) @IsIn(['in_review', 'waiting_for_student', 'resolved']) status?: SupportRequestStatus;
  @IsISO8601() expectedUpdatedAt!: string;
}
class TeacherSupportQuery {
  @IsOptional() @IsIn(['mine', 'class']) view?: 'mine' | 'class';
  @IsOptional() @IsString() @MaxLength(10) page?: string;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @IsIn(['all', 'open', 'in_review', 'waiting_for_student', 'resolved', 'closed']) status?: SupportRequestStatus | 'all';
}
@Controller({ path: 'teacher/support/requests', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class TeacherSupportController {
  constructor(private readonly support: SupportService) {}
  @Get() @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() user: AuthenticatedUser, @Query() input: TeacherSupportQuery) { return this.support.listTeacherRequests(user, { page: Number(input.page ?? 1), limit: 25, search: input.search, status: input.status } as SupportRequestListQuery, input.view ?? 'mine'); }
  @Get(':id') @Header('Cache-Control', 'private, no-store')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.support.getTeacherRequest(user, id); }
  @Post() @Throttle({ default: { limit: 10, ttl: 60000 } })
  create(@CurrentUser() user: AuthenticatedUser, @Body() input: TeacherRequestDto) { return this.support.createTeacherRequest(user, input); }
  @Post(':id/replies') @Throttle({ default: { limit: 20, ttl: 60000 } })
  reply(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() input: TeacherReplyDto) { return this.support.replyTeacherRequest(user, id, input); }
}
