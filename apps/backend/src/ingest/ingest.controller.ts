import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  IngestJob,
  IngestListQuery,
  IngestListResponse,
  IngestSourceType,
  IngestStatus
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AttachIngestDto } from './dto/attach-ingest.dto';
import { CreateIngestDto } from './dto/create-ingest.dto';
import { UpdateIngestDto } from './dto/update-ingest.dto';
import { IngestService } from './ingest.service';

interface AdminIngestQueryParams {
  page?: string;
  limit?: string;
  status?: IngestStatus | 'all';
  sourceType?: IngestSourceType | 'all';
  roomId?: string;
  nodeId?: string;
  attached?: IngestListQuery['attached'];
  search?: string;
}

@ApiTags('admin ingests')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'admin/ingests', version: '1' })
export class AdminIngestsController {
  constructor(private readonly ingests: IngestService) {}

  @Post()
  @ApiOperation({ summary: 'Create an ingest job' })
  create(@Body() body: CreateIngestDto, @CurrentUser() user: AuthenticatedUser): Promise<IngestJob> {
    return this.ingests.createAdminIngest(user, body);
  }

  @Get()
  @ApiOperation({ summary: 'List ingest jobs' })
  list(@Query() query: AdminIngestQueryParams, @CurrentUser() user: AuthenticatedUser): Promise<IngestListResponse> {
    return this.ingests.listAdminIngests(user, this.toListQuery(query));
  }

  @Get(':ingestId')
  @ApiOperation({ summary: 'Get one ingest job' })
  get(@Param('ingestId') ingestId: string, @CurrentUser() user: AuthenticatedUser): Promise<IngestJob> {
    return this.ingests.getAdminIngest(user, ingestId);
  }

  @Patch(':ingestId')
  @ApiOperation({ summary: 'Update an ingest job' })
  update(
    @Param('ingestId') ingestId: string,
    @Body() body: UpdateIngestDto,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<IngestJob> {
    return this.ingests.updateAdminIngest(user, ingestId, body);
  }

  @Post(':ingestId/start')
  @ApiOperation({ summary: 'Request ingest start' })
  start(@Param('ingestId') ingestId: string, @CurrentUser() user: AuthenticatedUser): Promise<IngestJob> {
    return this.ingests.startAdminIngest(user, ingestId);
  }

  @Post(':ingestId/stop')
  @ApiOperation({ summary: 'Request ingest stop' })
  stop(@Param('ingestId') ingestId: string, @CurrentUser() user: AuthenticatedUser): Promise<IngestJob> {
    return this.ingests.stopAdminIngest(user, ingestId);
  }

  private toListQuery(query: AdminIngestQueryParams): IngestListQuery {
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      ...(Number.isFinite(page) ? { page } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.roomId ? { roomId: query.roomId } : {}),
      ...(query.nodeId ? { nodeId: query.nodeId } : {}),
      ...(query.attached ? { attached: query.attached } : {}),
      ...(query.search ? { search: query.search } : {})
    };
  }
}

@ApiTags('admin room ingests')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'admin/rooms/:roomId/ingests', version: '1' })
export class AdminRoomIngestsController {
  constructor(private readonly ingests: IngestService) {}

  @Post(':ingestId/attach')
  @ApiOperation({ summary: 'Attach an ingest job to a room' })
  attach(
    @Param('roomId') roomId: string,
    @Param('ingestId') ingestId: string,
    @Body() body: AttachIngestDto,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<IngestJob> {
    return this.ingests.attachAdminIngest(user, ingestId, roomId, body);
  }

  @Post(':ingestId/detach')
  @ApiOperation({ summary: 'Detach an ingest job from a room' })
  detach(
    @Param('roomId') roomId: string,
    @Param('ingestId') ingestId: string,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<IngestJob> {
    return this.ingests.detachAdminIngest(user, ingestId, roomId);
  }
}
