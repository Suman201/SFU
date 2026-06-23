import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AdminRecordingDetail,
  AdminRecordingListQuery,
  AdminRecordingListResponse,
  AdminRecordingPlaybackResponse,
  AdminRecordingRetentionUpdateRequest,
  AdminRecordingSort,
  AdminRecordingStatus
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { RecordingsService } from './recordings.service';

interface AdminRecordingQueryParams {
  status?: AdminRecordingStatus | 'all';
  sessionId?: string;
  batchId?: string;
  courseId?: string;
  teacherId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: AdminRecordingSort;
  page?: string;
  limit?: string;
}

@ApiTags('admin recordings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/recordings')
export class AdminRecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List class-session recordings for administrators' })
  listRecordings(@Query() query: AdminRecordingQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<AdminRecordingListResponse> {
    return this.recordings.listAdminRecordings(this.toListQuery(query), user);
  }

  @Get(':recordingId')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get recording metadata for administrators' })
  getRecording(@Param('recordingId') recordingId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminRecordingDetail> {
    return this.recordings.getAdminRecording(recordingId, user);
  }

  @Get(':recordingId/playback')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get guarded recording playback metadata' })
  getPlayback(@Param('recordingId') recordingId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminRecordingPlaybackResponse> {
    return this.recordings.getAdminRecordingPlayback(recordingId, user);
  }

  @Get(':recordingId/download')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Header('Content-Type', 'application/vnd.native-sfu.recording-manifest+json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="class-session-recording.json"')
  @ApiOperation({ summary: 'Download a guarded recording manifest' })
  async downloadRecording(@Param('recordingId') recordingId: string, @CurrentUser() user: AuthenticatedUser): Promise<string> {
    const download = await this.recordings.readAdminRecordingDownload(recordingId, user);
    return download.content;
  }

  @Patch(':recordingId/retention')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update recording retention expiry' })
  updateRetention(
    @Param('recordingId') recordingId: string,
    @Body() body: AdminRecordingRetentionUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AdminRecordingDetail> {
    return this.recordings.updateAdminRecordingRetention(recordingId, body.retentionExpiresAt, user);
  }

  @Post(':recordingId/archive')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Expire a recording without deleting physical storage' })
  archiveRecording(@Param('recordingId') recordingId: string, @CurrentUser() user: AuthenticatedUser): Promise<AdminRecordingDetail> {
    return this.recordings.expireAdminRecording(recordingId, user);
  }

  private toListQuery(query: AdminRecordingQueryParams): AdminRecordingListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}
