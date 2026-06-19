import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ConsumerLayerState,
  ConsumerQualityState,
  PlatformEventListResponse,
  PlatformEventQuery,
  RoomIncidentState,
  RoomIncidentTimelineState,
  ProducerLayerState,
  ProducerQualityState,
  Room,
  RoomOwnerLookupResponse,
  RoomQualityState,
  RoomQualitySummaryState,
  RoomRecoveryActionResult,
  RoomRecoveryActionType,
  RoomSnapshotHistoryState,
  TransportQualityState,
  UpdateRoomMediaProfileRequest
} from '@native-sfu/contracts';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RoomAdaptiveDiagnosticsState, RoomDiagnosticsState, RoomsService } from './rooms.service';

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

  @Get(':roomId/quality-summary')
  getRoomQualitySummary(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomQualitySummaryState> {
    return this.rooms.getRoomQualitySummaryStateForUser(roomId, user.sub);
  }

  @Get(':roomId/incident-state')
  getRoomIncidentState(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomIncidentState> {
    return this.rooms.getRoomIncidentStateForUser(roomId, user.sub);
  }

  @Get(':roomId/incident-timeline')
  getRoomIncidentTimeline(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomIncidentTimelineState> {
    return this.rooms.getRoomIncidentTimelineForUser(roomId, user.sub);
  }

  @Get(':roomId/snapshot-history')
  getRoomSnapshotHistory(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomSnapshotHistoryState> {
    return this.rooms.getRoomSnapshotHistoryForUser(roomId, user.sub);
  }

  @Get(':roomId/audit-log')
  getRoomAuditLog(
    @Param('roomId') roomId: string,
    @Query() query: Omit<PlatformEventQuery, 'roomId'>,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<PlatformEventListResponse> {
    return this.rooms.getRoomAuditLogForUser(roomId, user.sub, normalizeAuditQuery(query));
  }

  @Get(':roomId/diagnostics')
  getRoomDiagnostics(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomDiagnosticsState> {
    return this.rooms.getRoomDiagnosticsForUser(roomId, user.sub);
  }

  @Get(':roomId/adaptive-diagnostics')
  getRoomAdaptiveDiagnostics(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<RoomAdaptiveDiagnosticsState> {
    return this.rooms.getRoomAdaptiveDiagnosticsForUser(roomId, user.sub);
  }

  @Get(':roomId/owner')
  getRoomOwner(@Param('roomId') roomId: string): Promise<RoomOwnerLookupResponse> {
    return this.rooms.lookupRoomOwner(roomId);
  }

  @Get(':roomId')
  getRoom(@Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser): Promise<Room> {
    return this.rooms.getRoomForUser(roomId, user.sub);
  }

  @Patch(':roomId/media-profile')
  updateRoomMediaProfile(
    @Param('roomId') roomId: string,
    @Body() request: Omit<UpdateRoomMediaProfileRequest, 'roomId'>,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<Room> {
    return this.rooms.updateRoomMediaProfileForUser(roomId, user.sub, request.profileId);
  }

  @Patch(':roomId/recovery')
  runRoomRecoveryAction(
    @Param('roomId') roomId: string,
    @Body() request: { action: RoomRecoveryActionType; reason?: string },
    @CurrentUser() user: AuthenticatedUser
  ): Promise<RoomRecoveryActionResult> {
    return this.rooms.runRoomRecoveryActionForUser(roomId, user.sub, request.action, request.reason);
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

  @Get('transports/:transportId/quality')
  getTransportQuality(@Param('transportId') transportId: string, @CurrentUser() user: AuthenticatedUser): Promise<TransportQualityState> {
    return this.rooms.getTransportQualityStateForUser(transportId, user.sub);
  }
}

function normalizeAuditQuery(query: Omit<PlatformEventQuery, 'roomId'>): Omit<PlatformEventQuery, 'roomId'> {
  return {
    ...(query.actorUserId ? { actorUserId: String(query.actorUserId) } : {}),
    ...(query.actorParticipantId ? { actorParticipantId: String(query.actorParticipantId) } : {}),
    ...(query.from ? { from: String(query.from) } : {}),
    ...(query.to ? { to: String(query.to) } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    ...(query.eventTypes
      ? {
          eventTypes: (Array.isArray(query.eventTypes) ? query.eventTypes : String(query.eventTypes).split(','))
            .map((value) => value.trim())
            .filter(Boolean) as PlatformEventQuery['eventTypes']
        }
      : {})
  };
}
