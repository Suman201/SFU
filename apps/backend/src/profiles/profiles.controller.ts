import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { LiveClassSettingsPatch, ProfileMediaUploadResponse, ProfileSettings, ProfileUser, PublicTeacherProfile, TeacherLiveClassSettingsResponse } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateMyProfileDto, UpdateMySettingsDto } from './dto/profile.dto';
import { ProfileMediaUploadFile, ProfilesService } from './profiles.service';

interface HeaderResponse {
  setHeader(name: string, value: string | number): void;
}

const PROFILE_MEDIA_MAX_SIZE_BYTES = 2 * 1024 * 1024;

@ApiTags('profiles')
@Controller({ path: 'profile', version: '1' })
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current teacher or student profile' })
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<ProfileUser> {
    return this.profiles.getMyProfile(user);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update the current teacher or student profile' })
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateMyProfileDto): Promise<ProfileUser> {
    return this.profiles.updateMyProfile(user, body);
  }

  @Get('me/settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current user profile settings' })
  async getMySettings(@CurrentUser() user: AuthenticatedUser): Promise<ProfileSettings> {
    return (await this.profiles.getMyProfile(user)).settings;
  }

  @Patch('me/settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update the current user profile settings' })
  async updateMySettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateMySettingsDto): Promise<ProfileSettings> {
    return (await this.profiles.updateMySettings(user, body)).settings;
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: PROFILE_MEDIA_MAX_SIZE_BYTES } }))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload current user avatar image' })
  uploadAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: ProfileMediaUploadFile | undefined
  ): Promise<ProfileMediaUploadResponse> {
    return this.profiles.uploadProfileMedia(user, 'avatarUrl', file);
  }

  @Post('me/cover')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: PROFILE_MEDIA_MAX_SIZE_BYTES } }))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload current teacher cover image' })
  uploadCover(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: ProfileMediaUploadFile | undefined
  ): Promise<ProfileMediaUploadResponse> {
    return this.profiles.uploadProfileMedia(user, 'coverImageUrl', file);
  }

  @Get('media/:userId/:fileName')
  @ApiOperation({ summary: 'Read a stored profile image' })
  async readMedia(
    @Param('userId') userId: string,
    @Param('fileName') fileName: string,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<StreamableFile> {
    const media = await this.profiles.readProfileMedia(userId, fileName);
    response.setHeader('Content-Type', media.mimeType);
    response.setHeader('Content-Length', media.size);
    response.setHeader('Cache-Control', 'public, max-age=86400');
    return new StreamableFile(media.stream);
  }
}

@ApiTags('teacher live settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
@Controller('teacher/live-settings')
export class TeacherLiveSettingsController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  @ApiOperation({ summary: 'Get teacher global live class settings' })
  getLiveSettings(@CurrentUser() user: AuthenticatedUser): Promise<TeacherLiveClassSettingsResponse> {
    return this.profiles.getTeacherLiveSettings(user);
  }

  @Patch()
  @ApiOperation({ summary: 'Update teacher global live class settings' })
  updateLiveSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LiveClassSettingsPatch
  ): Promise<TeacherLiveClassSettingsResponse> {
    return this.profiles.updateTeacherLiveSettings(user, body);
  }
}

@ApiTags('profiles')
@Controller({ path: 'teachers', version: '1' })
export class PublicTeacherProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':teacherId/profile')
  @ApiOperation({ summary: 'Get a safe public teacher profile' })
  getPublicTeacherProfile(@Param('teacherId') teacherId: string): Promise<PublicTeacherProfile> {
    return this.profiles.getPublicTeacherProfile(teacherId);
  }
}
