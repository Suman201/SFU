import { Body, Controller, Get, Header, HttpCode, Ip, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ForbiddenException } from '@nestjs/common';
import { SocialAuthService } from '../auth/social-auth.service';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ProfilesService } from '../profiles/profiles.service';
import { UpdateMySettingsDto } from '../profiles/dto/profile.dto';
import { AccountService } from './account.service';
import { AccountEmailService } from './account-email.service';
import { AccountProfileDto, AccountEmailDto, AccountEmailTokenDto, AccountProviderStartDto, AccountProviderCompleteDto, AccountPasswordDto, AccountPasswordProofDto } from './account.dto';
class ProviderParam { @IsIn(['google', 'apple']) provider!: 'google' | 'apple' }
@Controller({ path: 'account', version: '1' })
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly accounts: AccountService, private readonly profiles: ProfilesService, private readonly auth: AuthService, private readonly emails: AccountEmailService, private readonly social: SocialAuthService) {}
  @Get() @Header('Cache-Control', 'private, no-store')
  async overview(@CurrentUser() user: AuthenticatedUser) { return { profile: await this.profiles.getMyProfile(user), security: await this.accounts.security(user) }; }
  @Patch('profile')
  profile(@CurrentUser() user: AuthenticatedUser, @Body() input: AccountProfileDto) { return this.profiles.updateMyProfile(user, input); }
  @Patch('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser, @Body() input: UpdateMySettingsDto) { return this.profiles.updateMySettings(user, input); }
  @Get('sessions') @Header('Cache-Control', 'private, no-store')
  sessions(@CurrentUser() user: AuthenticatedUser, @Query('page') page?: string) { return this.accounts.listSessions(user, Number(page)); }
  @Post('sessions/others/revoke') @HttpCode(204)
  revokeOthers(@CurrentUser() user: AuthenticatedUser) { return this.accounts.revokeOthers(user); }
  @Post('sessions/:id/revoke') @HttpCode(200)
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.accounts.revokeSession(user, id); }
  @Post('password') @HttpCode(204) @Throttle({ default: { limit: 5, ttl: 60000 } })
  password(@CurrentUser() user: AuthenticatedUser, @Body() input: AccountPasswordDto, @Ip() ipAddress: string, @Req() req: Request) { return this.auth.changePassword(user.sub, input, user.tokenId, { ipAddress, userAgent: req.headers['user-agent'] }, true); }
  @Post('email/request') @HttpCode(202) @Throttle({ default: { limit: 5, ttl: 60000 } })
  requestEmail(@CurrentUser() user: AuthenticatedUser, @Body() input: AccountEmailDto) { return this.emails.request(user, input.email, input.currentPassword); }
  @Post('email/cancel') @HttpCode(204)
  cancelEmail(@CurrentUser() user: AuthenticatedUser) { return this.emails.cancel(user); }
  @Post('providers/:provider/start') @HttpCode(200) @Throttle({ default: { limit: 5, ttl: 60000 } })
  async startLink(@CurrentUser() user: AuthenticatedUser, @Param() param: ProviderParam, @Body() input: AccountProviderStartDto) {
    if (user.roles.some(role => role === 'ADMIN' || role === 'SUPER_ADMIN')) throw new ForbiddenException('Social sign-in is available for student and teacher accounts.');
    const account = await this.accounts.proof(user.sub, input.currentPassword);
    return this.social.start(param.provider, user.roles.includes('TEACHER') ? 'teacher' : 'student', input.challenge, { userId: user.sub, tokenId: user.tokenId, authVersion: account.authVersion ?? 0 });
  }
  @Post('providers/complete') @HttpCode(204)
  completeLink(@CurrentUser() user: AuthenticatedUser, @Body() input: AccountProviderCompleteDto, @Ip() ipAddress: string, @Req() req: Request) { return this.social.completeLink(input.ticket, input.verifier, user, { ipAddress, userAgent: req.headers['user-agent'] }); }
  @Post('providers/:provider/unlink') @HttpCode(204) @Throttle({ default: { limit: 5, ttl: 60000 } })
  unlink(@CurrentUser() user: AuthenticatedUser, @Param() param: ProviderParam, @Body() input: AccountPasswordProofDto) { return this.accounts.unlink(user, param.provider, input.currentPassword); }
}
@Controller({ path: 'account/email', version: '1' })
export class AccountEmailConfirmationController {
  constructor(private readonly emails: AccountEmailService) {}
  @Post('confirm') @HttpCode(200) @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 20, ttl: 60000 } })
  confirm(@Body() input: AccountEmailTokenDto) { return this.emails.confirm(input.token); }
}
