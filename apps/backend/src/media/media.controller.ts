import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DtlsTransportUnavailableError, IceService, TurnCredentials } from '@native-sfu/nest-sfu';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'media', version: '1' })
export class MediaController {
  constructor(private readonly ice: IceService) {}

  @Get('turn-credentials')
  turnCredentials(@CurrentUser() user: AuthenticatedUser): TurnCredentials {
    return this.ice.createTurnCredentials(user.sub);
  }

  @Get('transport-capabilities')
  capabilities(): { dtlsSrtpReady: boolean; reason: string } {
    const error = new DtlsTransportUnavailableError();
    return {
      dtlsSrtpReady: false,
      reason: error.message
    };
  }
}
