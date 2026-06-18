import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, LogoutDto, RefreshTokenDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';
import { AuthService, TokenPair } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a classroom user' })
  @ApiBody({ type: RegisterDto })
  @ApiOkResponse({
    description: 'JWT token pair',
    schema: { example: { accessToken: 'jwt-access-token', refreshToken: 'jwt-refresh-token', expiresIn: '15m' } }
  })
  register(@Body() body: RegisterDto, @Ip() ipAddress: string, @Req() request: Request): Promise<TokenPair> {
    return this.auth.register(body, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    description: 'JWT token pair',
    schema: { example: { accessToken: 'jwt-access-token', refreshToken: 'jwt-refresh-token', expiresIn: '15m' } }
  })
  login(@Body() body: LoginDto, @Ip() ipAddress: string, @Req() request: Request): Promise<TokenPair> {
    return this.auth.login(body, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token' })
  @ApiBody({ type: RefreshTokenDto })
  refresh(@Body() body: RefreshTokenDto, @Ip() ipAddress: string, @Req() request: Request): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiBody({ type: LogoutDto, required: false })
  logout(@CurrentUser() user: AuthenticatedUser, @Body() body: LogoutDto, @Ip() ipAddress: string, @Req() request: Request): Promise<void> {
    return this.auth.logout(user.sub, body.tokenId ?? user.tokenId, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all active user sessions' })
  logoutAll(@CurrentUser() user: AuthenticatedUser, @Ip() ipAddress: string, @Req() request: Request): Promise<void> {
    return this.auth.logoutAll(user.sub, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.auth.me(user.sub);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change current user password' })
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: ChangePasswordDto, @Ip() ipAddress: string, @Req() request: Request): Promise<void> {
    return this.auth.changePassword(user.sub, body, user.tokenId, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Request password reset instructions' })
  @ApiBody({ type: ForgotPasswordDto })
  forgotPassword(@Body() body: ForgotPasswordDto, @Ip() ipAddress: string, @Req() request: Request): Promise<{ resetToken?: string }> {
    return this.auth.forgotPassword(body.email, { ipAddress, userAgent: request.headers['user-agent'] });
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reset password using a reset token' })
  @ApiBody({ type: ResetPasswordDto })
  resetPassword(@Body() body: ResetPasswordDto, @Ip() ipAddress: string, @Req() request: Request): Promise<void> {
    return this.auth.resetPassword(body, { ipAddress, userAgent: request.headers['user-agent'] });
  }
}
