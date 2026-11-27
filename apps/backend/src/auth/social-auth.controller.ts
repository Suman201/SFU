import { Body, Controller, Get, Header, HttpCode, Ip, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Request, Response } from 'express';
import { SocialAuthService } from './social-auth.service';

class ProviderParams { @IsIn(['google', 'apple']) provider!: 'google' | 'apple'; }
export class StartSocialAuthDto {
  @IsIn(['student', 'teacher']) role!: 'student' | 'teacher';
  @Matches(/^[a-f0-9]{64}$/) challenge!: string;
  @IsOptional() @Matches(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/oauth\/callback\/[A-Za-z0-9_-]{43}$/)
  desktopRedirectUri?: string;
}
export class ExchangeSocialAuthDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/) ticket!: string;
  @Matches(/^[A-Za-z0-9_-]{43}$/) verifier!: string;
  @ValidateIf(o => o.email !== undefined || o.password !== undefined) @IsEmail() @MaxLength(254) email?: string;
  @ValidateIf(o => o.email !== undefined || o.password !== undefined) @IsString() @MinLength(8) @MaxLength(128) password?: string;
}

@ApiTags('auth')
@Controller({ path: 'auth/social', version: '1' })
export class SocialAuthController {
  constructor(private readonly social: SocialAuthService) {}
  @Get('providers') @Header('Cache-Control', 'no-store')
  providers() { return this.social.providers(); }

  @Post(':provider/start') @HttpCode(200) @Header('Cache-Control', 'no-store')
  start(@Param() { provider }: ProviderParams, @Body() input: StartSocialAuthDto) {
    return this.social.start(provider, input.role, input.challenge, undefined, input.desktopRedirectUri);
  }

  @Get(':provider/callback')
  googleCallback(@Param() { provider }: ProviderParams, @Query() input: Record<string, unknown>, @Res() response: Response) {
    return this.callback(provider, input, response);
  }
  @Post(':provider/callback')
  appleCallback(@Param() { provider }: ProviderParams, @Body() input: Record<string, unknown>, @Res() response: Response) {
    return this.callback(provider, input, response);
  }
  @Post('exchange') @HttpCode(200) @Header('Cache-Control', 'no-store')
  exchange(@Body() input: ExchangeSocialAuthDto, @Ip() ipAddress: string, @Req() request: Request) {
    const credentials = input.email && input.password ? { email: input.email, password: input.password } : undefined;
    return this.social.exchange(input.ticket, input.verifier, credentials, { ipAddress, userAgent: request.headers['user-agent'] });
  }
  private async callback(provider: 'google' | 'apple', input: Record<string, unknown>, response: Response) {
    const fields = Object.fromEntries(['state', 'code', 'error', 'user'].filter(key => typeof input[key] === 'string').map(key => [key, input[key]]));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.redirect(303, await this.social.callback(provider, fields));
  }
}
