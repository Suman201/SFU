import { Body, Controller, Get, Header, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CmsMediaService } from './cms-media.service';
class UploadMediaDto { @IsString() @MinLength(2) @MaxLength(160) title!: string; @IsString() @MaxLength(300) altText!: string }
class UpdateMediaDto {
  @IsInt() @Min(0) revision!: number;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @MaxLength(300) altText?: string;
  @ValidateIf((_, value) => value !== undefined) @IsBoolean() archived?: boolean;
}
class MediaQuery { @IsOptional() @IsString() @MaxLength(80) q?: string; @IsOptional() @IsString() @MaxLength(5) page?: string; @IsOptional() @IsString() @MaxLength(5) archived?: string }
type MediaResponse = { setHeader(key: string, value: string): void };
function imageResponse(response: MediaResponse, data: { bytes: Buffer; mimeType: string; name: string }) {
  response.setHeader('Content-Type', data.mimeType); response.setHeader('Content-Disposition', `inline; filename="${data.name}"`); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'private, no-store'); return new StreamableFile(data.bytes);
}
@Controller({ path: 'admin/cms/media', version: '1' }) @UseGuards(JwtAuthGuard, RolesGuard) @Roles('ADMIN', 'SUPER_ADMIN')
export class CmsMediaController {
  constructor(private readonly media: CmsMediaService) {}
  @Get() @Header('Cache-Control', 'private, no-store') list(@Query() input: MediaQuery) { return this.media.list(input); }
  @Post() @Throttle({ default: { limit: 10, ttl: 60000 } }) @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } }))
  upload(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file: { buffer: Buffer; originalname: string }, @Body() input: UploadMediaDto) { return this.media.upload(user, file, input); }
  @Patch(':id') update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() input: UpdateMediaDto) { return this.media.update(user, id, input); }
  @Get(':id/file') async read(@Param('id') id: string, @Res({ passthrough: true }) response: MediaResponse) { return imageResponse(response, await this.media.read(id, false)); }
}
@Controller({ path: 'cms/media', version: '1' })
export class CmsPublicMediaController {
  constructor(private readonly media: CmsMediaService) {}
  @Get(':id') async read(@Param('id') id: string, @Res({ passthrough: true }) response: MediaResponse) { return imageResponse(response, await this.media.read(id, true)); }
}
