import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AdminTeacherPromotionUpdateRequest,
  CreateTeacherPublicContentRequest,
  LiveClassSettingsPatch,
  ProfileMediaUploadResponse,
  ProfileSettings,
  ProfileUser,
  PublicTeacherListQuery,
  PublicTeacherListResponse,
  PublicTeacherProfile,
  TeacherPromotion,
  TeacherPromotionListQuery,
  TeacherPromotionListResponse,
  TeacherPromotionRequest,
  TeacherLiveClassSettingsResponse,
  TeacherPublicContentItem,
  TeacherPublicContentListResponse,
  UpdateTeacherPublicContentRequest
} from '@native-sfu/contracts';
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
const PUBLIC_CONTENT_MEDIA_MAX_SIZE_BYTES = 25 * 1024 * 1024;

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

  @Get('me/public-content')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List current teacher public gallery and demo class content' })
  listMyPublicContent(@CurrentUser() user: AuthenticatedUser): Promise<TeacherPublicContentListResponse> {
    return this.profiles.listMyPublicContent(user);
  }

  @Post('me/public-content')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a draft public gallery or demo class item' })
  createMyPublicContent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTeacherPublicContentRequest
  ): Promise<TeacherPublicContentItem> {
    return this.profiles.createMyPublicContent(user, body);
  }

  @Patch('me/public-content/:contentId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a current teacher public gallery or demo class item' })
  updateMyPublicContent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId') contentId: string,
    @Body() body: UpdateTeacherPublicContentRequest
  ): Promise<TeacherPublicContentItem> {
    return this.profiles.updateMyPublicContent(user, contentId, body);
  }

  @Post('me/public-content/:contentId/publish')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Publish a current teacher public gallery or demo class item' })
  publishMyPublicContent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId') contentId: string
  ): Promise<TeacherPublicContentItem> {
    return this.profiles.publishMyPublicContent(user, contentId);
  }

  @Post('me/public-content/:contentId/unpublish')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unpublish a current teacher public gallery or demo class item' })
  unpublishMyPublicContent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId') contentId: string
  ): Promise<TeacherPublicContentItem> {
    return this.profiles.unpublishMyPublicContent(user, contentId);
  }

  @Delete('me/public-content/:contentId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Archive a current teacher public gallery or demo class item' })
  deleteMyPublicContent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId') contentId: string
  ): Promise<{ contentId: string; deleted: true }> {
    return this.profiles.deleteMyPublicContent(user, contentId);
  }

  @Post('me/public-content/:contentId/file')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: PUBLIC_CONTENT_MEDIA_MAX_SIZE_BYTES } }))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload media for a current teacher public gallery or demo class item' })
  uploadPublicContentMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId') contentId: string,
    @UploadedFile() file: ProfileMediaUploadFile | undefined
  ): Promise<TeacherPublicContentItem> {
    return this.profiles.uploadPublicContentMedia(user, contentId, file);
  }

  @Get('public-content/:teacherId/:contentId/:fileName')
  @ApiOperation({ summary: 'Read published teacher public content media' })
  async readPublicContentMedia(
    @Param('teacherId') teacherId: string,
    @Param('contentId') contentId: string,
    @Param('fileName') fileName: string,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<StreamableFile> {
    const media = await this.profiles.readPublicContentMedia(teacherId, contentId, fileName);
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

@ApiTags('teacher promotions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
@Controller('teachers/me/promotions')
export class TeacherPromotionsController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  @ApiOperation({ summary: 'List current teacher profile promotion requests' })
  listMine(@CurrentUser() user: AuthenticatedUser): Promise<TeacherPromotionListResponse> {
    return this.profiles.listMyPromotions(user);
  }

  @Post('request')
  @ApiOperation({ summary: 'Request promotion for the current public teacher profile' })
  requestPromotion(@CurrentUser() user: AuthenticatedUser, @Body() body: TeacherPromotionRequest): Promise<TeacherPromotion> {
    return this.profiles.requestMyPromotion(user, body);
  }
}

@ApiTags('admin teacher promotions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/teacher-promotions')
export class AdminTeacherPromotionsController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  @ApiOperation({ summary: 'List teacher profile promotions for administrators' })
  listPromotions(@Query() query: TeacherPromotionListQuery, @CurrentUser() user: AuthenticatedUser): Promise<TeacherPromotionListResponse> {
    return this.profiles.listAdminPromotions(this.toListQuery(query), user);
  }

  @Post(':promotionId/approve')
  @ApiOperation({ summary: 'Approve or schedule a teacher profile promotion' })
  approve(
    @Param('promotionId') promotionId: string,
    @Body() body: AdminTeacherPromotionUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<TeacherPromotion> {
    return this.profiles.approvePromotion(promotionId, body, user);
  }

  @Post(':promotionId/pause')
  @ApiOperation({ summary: 'Pause a teacher profile promotion' })
  pause(
    @Param('promotionId') promotionId: string,
    @Body() body: AdminTeacherPromotionUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<TeacherPromotion> {
    return this.profiles.pausePromotion(promotionId, body, user);
  }

  @Post(':promotionId/cancel')
  @ApiOperation({ summary: 'Cancel a teacher profile promotion' })
  cancel(
    @Param('promotionId') promotionId: string,
    @Body() body: AdminTeacherPromotionUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<TeacherPromotion> {
    return this.profiles.cancelPromotion(promotionId, body, user);
  }

  @Post(':promotionId/reject')
  @ApiOperation({ summary: 'Reject a teacher profile promotion request' })
  reject(
    @Param('promotionId') promotionId: string,
    @Body() body: AdminTeacherPromotionUpdateRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<TeacherPromotion> {
    return this.profiles.rejectPromotion(promotionId, body, user);
  }

  private toListQuery(query: TeacherPromotionListQuery): TeacherPromotionListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.placement ? { placement: query.placement } : {}),
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {})
    };
  }
}

@ApiTags('profiles')
@Controller({ path: 'teachers', version: '1' })
export class PublicTeacherProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  @ApiOperation({ summary: 'List public teachers for marketplace discovery' })
  listPublicTeachers(@Query() query: PublicTeacherListQuery): Promise<PublicTeacherListResponse> {
    return this.profiles.listPublicTeachers(query);
  }

  @Get(':teacherId/profile')
  @ApiOperation({ summary: 'Get a safe public teacher profile' })
  getPublicTeacherProfile(@Param('teacherId') teacherId: string): Promise<PublicTeacherProfile> {
    return this.profiles.getPublicTeacherProfile(teacherId);
  }
}
