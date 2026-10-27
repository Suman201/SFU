import { Body, Controller, Get, Headers, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { DesktopService, FinalizeRecordingRequest, PlaybackProgressRequest } from './desktop.service';

@ApiTags('desktop classroom')
@ApiBearerAuth()
@Controller({ path: 'desktop', version: '1' })
export class DesktopController {
  constructor(private readonly desktop: DesktopService) {}

  @Get('classes')
  @UseGuards(JwtAuthGuard)
  classes(@CurrentUser() user: AuthenticatedUser) { return this.desktop.classes(user); }

  @Get('classes/:sessionId')
  @UseGuards(JwtAuthGuard)
  classroom(@CurrentUser() user: AuthenticatedUser, @Param('sessionId') sessionId: string) {
    return this.desktop.classroom(user, sessionId);
  }

  @Get('recordings')
  @UseGuards(JwtAuthGuard)
  recordings(@CurrentUser() user: AuthenticatedUser, @Query('q') q?: string, @Query('courseId') courseId?: string) {
    return this.desktop.listRecordings(user, q, courseId);
  }

  @Get('recordings/:recordingId/playback')
  @UseGuards(JwtAuthGuard)
  playback(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string) { return this.desktop.playback(user, id); }

  @Post('recordings/:recordingId/progress')
  @UseGuards(JwtAuthGuard)
  progress(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string, @Body() body: PlaybackProgressRequest) {
    return this.desktop.saveProgress(user, id, body);
  }

  @Get('recordings/:recordingId/notes')
  @UseGuards(JwtAuthGuard)
  notes(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string) { return this.desktop.notes(user, id); }

  // This route accepts only a short-lived, recording-scoped capability. It rechecks
  // the account, login session, publication, retention and enrollment on every request.
  @Get('recordings/:recordingId/content')
  async content(@Param('recordingId') id: string, @Query('ticket') ticket: string, @Headers('range') range: string | undefined, @Res() response: any) {
    return this.desktop.stream(id, ticket, range, response);
  }

  @Post('recordings/:recordingId/capture')
  @UseGuards(JwtAuthGuard)
  capture(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string, @Body() body: { captureId: string }) {
    return this.desktop.claimCapture(user, id, body?.captureId);
  }

  @Post('recordings/:recordingId/capture-failed')
  @UseGuards(JwtAuthGuard)
  captureFailed(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string,
    @Headers('x-recording-capture-id') captureId: string) {
    return this.desktop.captureFailed(user, id, captureId);
  }

  @Get('recordings/:recordingId/upload')
  @UseGuards(JwtAuthGuard)
  upload(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string) { return this.desktop.uploadStatus(user, id); }

  @Post('recordings/:recordingId/chunks/:index')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 1 } }))
  chunk(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string, @Param('index') index: string,
    @Headers('x-recording-capture-id') captureId: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    return this.desktop.uploadChunk(user, id, index, captureId, file?.buffer);
  }

  @Post('recordings/:recordingId/finalize')
  @UseGuards(JwtAuthGuard)
  finalize(@CurrentUser() user: AuthenticatedUser, @Param('recordingId') id: string,
    @Headers('x-recording-capture-id') captureId: string, @Body() body: FinalizeRecordingRequest) {
    return this.desktop.finalize(user, id, captureId, body);
  }
}
