import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  CreateRedisStreamEndpointRequest,
  CreateWebhookEndpointRequest,
  PlatformEventActor,
  PlatformEventListResponse,
  PlatformEventQuery,
  RedisStreamEndpoint,
  RedisStreamEndpointListResponse,
  ReplayWebhookDeliveryRequest,
  ReplayWebhookDeliveryResponse,
  ReplayWebhookEventRequest,
  UpdateRedisStreamEndpointRequest,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  WebhookDeliveryListResponse,
  WebhookDeliveryQuery,
  WebhookEndpoint,
  WebhookEndpointListResponse,
  WebhookEndpointSecretResponse
} from '@native-sfu/contracts';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { PlatformEventsService } from './platform-events.service';

@Controller({ path: 'events', version: '1' })
@UseGuards(OperationsTokenGuard)
export class EventsController {
  constructor(private readonly events: PlatformEventsService) {}

  @Post('webhooks')
  createWebhookEndpoint(@Body() request: CreateWebhookEndpointRequest): Promise<WebhookEndpointSecretResponse> {
    return this.events.createWebhookEndpoint(request, operatorActor());
  }

  @Post('redis-streams')
  createRedisStreamEndpoint(@Body() request: CreateRedisStreamEndpointRequest): Promise<RedisStreamEndpoint> {
    return this.events.createRedisStreamEndpoint(request, operatorActor());
  }

  @Get('webhooks')
  listWebhookEndpoints(): Promise<WebhookEndpointListResponse> {
    return this.events.listWebhookEndpoints();
  }

  @Get('redis-streams')
  listRedisStreamEndpoints(): Promise<RedisStreamEndpointListResponse> {
    return this.events.listRedisStreamEndpoints();
  }

  @Get('webhooks/:endpointId')
  getWebhookEndpoint(@Param('endpointId') endpointId: string): Promise<WebhookEndpoint> {
    return this.events.getWebhookEndpoint(endpointId);
  }

  @Get('redis-streams/:endpointId')
  getRedisStreamEndpoint(@Param('endpointId') endpointId: string): Promise<RedisStreamEndpoint> {
    return this.events.getRedisStreamEndpoint(endpointId);
  }

  @Patch('webhooks/:endpointId')
  updateWebhookEndpoint(
    @Param('endpointId') endpointId: string,
    @Body() request: UpdateWebhookEndpointRequest
  ): Promise<WebhookEndpoint> {
    return this.events.updateWebhookEndpoint(endpointId, request, operatorActor());
  }

  @Patch('redis-streams/:endpointId')
  updateRedisStreamEndpoint(
    @Param('endpointId') endpointId: string,
    @Body() request: UpdateRedisStreamEndpointRequest
  ): Promise<RedisStreamEndpoint> {
    return this.events.updateRedisStreamEndpoint(endpointId, request, operatorActor());
  }

  @Post('webhooks/:endpointId/rotate-secret')
  rotateWebhookEndpointSecret(
    @Param('endpointId') endpointId: string,
    @Body() request: { signingSecret?: string }
  ): Promise<WebhookEndpointSecretResponse> {
    return this.events.rotateWebhookEndpointSecret(endpointId, request.signingSecret, operatorActor());
  }

  @Get('log')
  listEvents(@Query() query: PlatformEventQuery): Promise<PlatformEventListResponse> {
    return this.events.listEvents(normalizeEventQuery(query));
  }

  @Get('rooms/:roomId/log')
  listRoomEvents(@Param('roomId') roomId: string, @Query() query: Omit<PlatformEventQuery, 'roomId'>): Promise<PlatformEventListResponse> {
    return this.events.listEvents({ ...normalizeEventQuery(query), roomId });
  }

  @Get('deliveries')
  listDeliveries(@Query() query: WebhookDeliveryQuery): Promise<WebhookDeliveryListResponse> {
    return this.events.listWebhookDeliveries(normalizeDeliveryQuery(query));
  }

  @Get('deliveries/exhausted')
  listExhaustedDeliveries(@Query() query: Omit<WebhookDeliveryQuery, 'status'>): Promise<WebhookDeliveryListResponse> {
    return this.events.listWebhookDeliveries({ ...normalizeDeliveryQuery(query), status: 'exhausted' });
  }

  @Get('deliveries/:deliveryId')
  getDelivery(@Param('deliveryId') deliveryId: string): Promise<WebhookDelivery> {
    return this.events.getWebhookDelivery(deliveryId);
  }

  @Post('deliveries/:deliveryId/replay')
  replayDelivery(
    @Param('deliveryId') deliveryId: string,
    @Body() request: ReplayWebhookDeliveryRequest
  ): Promise<ReplayWebhookDeliveryResponse> {
    return this.events.replayWebhookDelivery(deliveryId, operatorActor(request.reason));
  }

  @Post('log/:eventId/endpoints/:endpointId/replay')
  replayEventToEndpoint(
    @Param('eventId') eventId: string,
    @Param('endpointId') endpointId: string,
    @Body() request: ReplayWebhookEventRequest
  ): Promise<ReplayWebhookDeliveryResponse> {
    return this.events.replayEventToEndpoint(eventId, endpointId, operatorActor(request.reason));
  }

  @Get('diagnostics/summary')
  diagnosticsSummary() {
    return this.events.diagnosticsSummary();
  }
}

function operatorActor(reason?: string): PlatformEventActor {
  return {
    type: 'operator',
    label: reason ? `operations-token:${reason}` : 'operations-token'
  };
}

function normalizeEventQuery(query: Partial<PlatformEventQuery>): PlatformEventQuery {
  return {
    ...(query.roomId ? { roomId: String(query.roomId) } : {}),
    ...(query.actorUserId ? { actorUserId: String(query.actorUserId) } : {}),
    ...(query.actorParticipantId ? { actorParticipantId: String(query.actorParticipantId) } : {}),
    ...(query.from ? { from: String(query.from) } : {}),
    ...(query.to ? { to: String(query.to) } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    ...(query.eventTypes ? { eventTypes: normalizeList(query.eventTypes) as PlatformEventQuery['eventTypes'] } : {})
  };
}

function normalizeDeliveryQuery(query: Partial<WebhookDeliveryQuery>): WebhookDeliveryQuery {
  return {
    ...(query.endpointId ? { endpointId: String(query.endpointId) } : {}),
    ...(query.eventId ? { eventId: String(query.eventId) } : {}),
    ...(query.roomId ? { roomId: String(query.roomId) } : {}),
    ...(query.status ? { status: String(query.status) as WebhookDeliveryQuery['status'] } : {}),
    ...(query.from ? { from: String(query.from) } : {}),
    ...(query.to ? { to: String(query.to) } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    ...(query.eventTypes ? { eventTypes: normalizeList(query.eventTypes) as WebhookDeliveryQuery['eventTypes'] } : {})
  };
}

function normalizeList(value: string | string[]): string[] {
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((entry) => entry.trim()).filter(Boolean);
}
