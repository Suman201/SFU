import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Recording, RecordingScope } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RecordingsService } from './recordings.service';

@ApiTags('recordings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'recordings', version: '1' })
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Post('start')
  start(@CurrentUser() user: AuthenticatedUser, @Body() body: { roomId: string; scope: RecordingScope; participantId?: string }): Promise<Recording> {
    return this.recordings.start(user.sub, body.roomId, body.scope, body.participantId);
  }

  @Post(':recordingId/stop')
  stop(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') recordingId: string): Promise<Recording> {
    return this.recordings.stop(user.sub, recordingId);
  }

  @Get('rooms/:roomId')
  list(@CurrentUser() user: AuthenticatedUser, @Param('roomId') roomId: string): Promise<Recording[]> {
    return this.recordings.listForRoom(user.sub, roomId);
  }
}
