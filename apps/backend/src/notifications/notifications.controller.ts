import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RegisterPushSubscriptionDto } from './dto/notifications.dto';
import { PushNotificationService } from './push-notification.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly push: PushNotificationService) {}

  @Get('push/public-key')
  @ApiOperation({ summary: 'Get browser push VAPID public key' })
  getPushPublicKey(): { enabled: boolean; publicKey: string | null } {
    return this.push.getPublicKey();
  }

  @Post('push/subscriptions')
  @ApiOperation({ summary: 'Register or update current user browser push subscription' })
  registerPushSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RegisterPushSubscriptionDto,
    @Headers('user-agent') userAgent?: string
  ): Promise<Record<string, unknown>> {
    return this.push.registerSubscription(user.sub, body, userAgent);
  }

  @Delete('push/subscriptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke current user browser push subscription' })
  revokePushSubscription(@CurrentUser() user: AuthenticatedUser, @Param('id') subscriptionId: string): Promise<void> {
    return this.push.revokeSubscription(user.sub, subscriptionId);
  }
}
