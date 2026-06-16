import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConsumerLayerState, ConsumerQualityState, ProducerLayerState, ProducerQualityState, Room, RoomOwnerLookupResponse, RoomQualityState } from '@native-sfu/contracts';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RoomsService } from './rooms.service';

@ApiTags('rooms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'rooms', version: '1' })
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get(':roomId/quality')
  getRoomQuality(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomQualityState> {
    return this.rooms.getRoomQualityStateForUser(roomId, user.sub);
  }

  @Get(':roomId/owner')
  getRoomOwner(@Param('roomId') roomId: string): Promise<RoomOwnerLookupResponse> {
    return this.rooms.lookupRoomOwner(roomId);
  }

  @Get(':roomId')
  getRoom(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<Room> {
    return this.rooms.getRoomForUser(roomId, user.sub);
  }

  @Get('consumers/:consumerId/layers')
  getConsumerLayers(@Param('consumerId') consumerId: string, @CurrentUser() user: AuthenticatedUser): Promise<ConsumerLayerState> {
    return this.rooms.getConsumerLayerStateForUser(consumerId, user.sub);
  }

  @Get('producers/:producerId/layers')
  getProducerLayers(@Param('producerId') producerId: string, @CurrentUser() user: AuthenticatedUser): Promise<ProducerLayerState> {
    return this.rooms.getProducerLayerStateForUser(producerId, user.sub);
  }

  @Get('consumers/:consumerId/quality')
  getConsumerQuality(@Param('consumerId') consumerId: string, @CurrentUser() user: AuthenticatedUser): Promise<ConsumerQualityState> {
    return this.rooms.getConsumerQualityStateForUser(consumerId, user.sub);
  }

  @Get('producers/:producerId/quality')
  getProducerQuality(@Param('producerId') producerId: string, @CurrentUser() user: AuthenticatedUser): Promise<ProducerQualityState> {
    return this.rooms.getProducerQualityStateForUser(producerId, user.sub);
  }
}
