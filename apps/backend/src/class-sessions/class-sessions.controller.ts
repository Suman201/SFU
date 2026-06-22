import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ChatHistoryResponse, ChatMessageScope, ChatReadState, ChatThreadSummaryResponse } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassroomPayload, ClassSessionsService } from './class-sessions.service';

interface StartClassSessionBody {
  batchId?: string;
}

interface MarkChatReadBody {
  batchId?: string;
  roomId?: string;
  participantId?: string;
  scope?: ChatMessageScope;
  readAt?: string;
}

@ApiTags('class sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('class-sessions')
export class ClassSessionsController {
  constructor(private readonly classSessions: ClassSessionsService) {}

  @Get('batches/:batchId/current')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get the current or next manually controlled class session for a batch' })
  getCurrentForBatch(@Param('batchId') batchId: string, @CurrentUser() user: AuthenticatedUser): Promise<ClassroomPayload> {
    return this.classSessions.getCurrentForBatch(batchId, user);
  }

  @Get(':sessionId')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get class session metadata' })
  getSession(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassroomPayload> {
    return this.classSessions.getSession(sessionId, batchId, user);
  }

  @Get(':sessionId/chat')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get class session chat history' })
  getChatHistory(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @Query('participantId') participantId: string | undefined,
    @Query('scope') scope: ChatMessageScope | undefined,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ChatHistoryResponse> {
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.classSessions.getChatHistory(sessionId, batchId, user, {
      participantId,
      scope,
      before,
      ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {})
    });
  }

  @Get(':sessionId/chat/summary')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get class session private chat thread summaries and unread counts' })
  getChatSummary(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ChatThreadSummaryResponse> {
    return this.classSessions.getChatSummary(sessionId, batchId, user);
  }

  @Post(':sessionId/chat/read')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Mark a class session chat thread as read' })
  markChatRead(
    @Param('sessionId') sessionId: string,
    @Body() body: MarkChatReadBody,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ChatReadState> {
    return this.classSessions.markChatRead(sessionId, body.batchId, user, {
      roomId: body.roomId,
      participantId: body.participantId,
      scope: body.scope,
      readAt: body.readAt
    });
  }

  @Post(':sessionId/start')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Manually start a scheduled class session' })
  startSession(
    @Param('sessionId') sessionId: string,
    @Body() body: StartClassSessionBody,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassroomPayload> {
    return this.classSessions.startSession(sessionId, body.batchId, user);
  }

  @Post(':sessionId/end')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Manually end a live class session' })
  endSession(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser): Promise<ClassroomPayload> {
    return this.classSessions.endSession(sessionId, user);
  }

  @Post(':sessionId/join')
  @Roles('STUDENT', 'TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Join a manually started class session' })
  joinSession(
    @Param('sessionId') sessionId: string,
    @Body() body: StartClassSessionBody,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassroomPayload> {
    return this.classSessions.joinSession(sessionId, body.batchId, user);
  }
}
