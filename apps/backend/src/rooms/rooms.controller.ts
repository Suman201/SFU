import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Room } from '@native-sfu/contracts';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RoomsService } from './rooms.service';

@ApiTags('rooms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'rooms', version: '1' })
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get(':roomId')
  getRoom(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<Room> {
    return this.rooms.getRoomForUser(roomId, user.sub);
  }
}
