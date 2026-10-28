import {
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import {
  IntroVideoService,
  INTRO_VIDEO_MAX_BYTES,
} from './intro-video.service';
interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string | number): void;
}
async function streamVideo(
  videos: IntroVideoService,
  id: string,
  publicOnly: boolean,
  range: string | undefined,
  response: Response,
) {
  const video = await videos.read(id, publicOnly, range);
  response.status(video.status);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!video.stream) {
    response.setHeader('Content-Range', `bytes */${video.size}`);
    return;
  }
  response.setHeader('Content-Type', video.mimeType!);
  response.setHeader('Content-Length', video.end! - video.start! + 1);
  if (video.status === 206)
    response.setHeader(
      'Content-Range',
      `bytes ${video.start}-${video.end}/${video.size}`,
    );
  return new StreamableFile(video.stream);
}
@Controller('tutor-application/me/introduction-video')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class TutorIntroVideoController {
  constructor(private readonly videos: IntroVideoService) {}
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: INTRO_VIDEO_MAX_BYTES },
    }),
  )
  upload(@CurrentUser() actor: AuthenticatedUser, @UploadedFile() file: any) {
    return this.videos.upload(actor.sub, file);
  }
  @Delete() remove(@CurrentUser() actor: AuthenticatedUser) {
    return this.videos.remove(actor.sub);
  }
  @Get() read(
    @CurrentUser() actor: AuthenticatedUser,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return streamVideo(this.videos, actor.sub, false, range, response);
  }
}
@Controller('admin/tutor-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminTutorIntroVideoController {
  constructor(private readonly videos: IntroVideoService) {}
  @Get(':id/introduction-video') read(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return streamVideo(this.videos, id, false, range, response);
  }
}
@Controller('teachers')
export class PublicTutorIntroVideoController {
  constructor(private readonly videos: IntroVideoService) {}
  @Get(':id/introduction-video') read(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return streamVideo(this.videos, id, true, range, response);
  }
}
