import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ChatAttachment,
  ChatHistoryResponse,
  ChatMessageScope,
  ChatReadState,
  ChatThreadSummaryResponse,
  ClassSessionMaterial,
  CreateWhiteboardMemoryCheckpointRequest,
  CreateClassSessionMaterialLinkRequest,
  PreviousWhiteboardMemoryListResponse,
  Recording,
  RestorePreviousWhiteboardMemoryRequest,
  RestoreWhiteboardMemoryVersionRequest,
  SaveWhiteboardMemoryRequest,
  WhiteboardMemoryPageSearchResponse,
  WhiteboardMemoryState,
  WhiteboardMemoryVersion,
  WhiteboardMemoryVersionListResponse
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import type { ClassSessionChatAttachmentUploadFile } from '../rooms/rooms.service';
import { ClassroomPayload, ClassSessionMaterialUploadFile, ClassSessionsService } from './class-sessions.service';

const CHAT_ATTACHMENT_MAX_COUNT = 3;
const CHAT_ATTACHMENT_MAX_SIZE_BYTES = 2 * 1024 * 1024;
const CLASS_MATERIAL_MAX_COUNT = 5;
const CLASS_MATERIAL_MAX_SIZE_BYTES = 100 * 1024 * 1024;

interface HeaderResponse {
  setHeader(name: string, value: string | number): void;
}

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

interface ClassSessionMaterialActionBody {
  batchId?: string;
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

  @Post(':sessionId/chat/attachments')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @UseInterceptors(
    FilesInterceptor('files', CHAT_ATTACHMENT_MAX_COUNT, {
      limits: {
        files: CHAT_ATTACHMENT_MAX_COUNT,
        fileSize: CHAT_ATTACHMENT_MAX_SIZE_BYTES
      }
    })
  )
  @ApiOperation({ summary: 'Upload server-stored class session chat attachments' })
  uploadChatAttachments(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @UploadedFiles() files: ClassSessionChatAttachmentUploadFile[] | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ChatAttachment[]> {
    return this.classSessions.uploadChatAttachments(sessionId, batchId, user, files ?? []);
  }

  @Get(':sessionId/chat/attachments/:attachmentId')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Download an authorized class session chat attachment' })
  async downloadChatAttachment(
    @Param('sessionId') sessionId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<StreamableFile> {
    const download = await this.classSessions.downloadChatAttachment(sessionId, attachmentId, batchId, user);
    response.setHeader('Content-Type', download.mimeType);
    response.setHeader('Content-Length', download.size);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${this.contentDispositionFileName(download.fileName)}"`);
    return new StreamableFile(download.stream);
  }

  @Get(':sessionId/materials')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List authorized class session materials' })
  listMaterials(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassSessionMaterial[]> {
    return this.classSessions.listMaterials(sessionId, batchId, user);
  }

  @Post(':sessionId/materials/upload')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @UseInterceptors(
    FilesInterceptor('files', CLASS_MATERIAL_MAX_COUNT, {
      limits: {
        files: CLASS_MATERIAL_MAX_COUNT,
        fileSize: CLASS_MATERIAL_MAX_SIZE_BYTES
      }
    })
  )
  @ApiOperation({ summary: 'Upload server-stored class session materials' })
  uploadMaterials(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @UploadedFiles() files: ClassSessionMaterialUploadFile[] | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassSessionMaterial[]> {
    return this.classSessions.uploadMaterials(sessionId, batchId, user, files ?? []);
  }

  @Post(':sessionId/materials/link')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Attach an external link as a class session material' })
  attachMaterialLink(
    @Param('sessionId') sessionId: string,
    @Body() body: CreateClassSessionMaterialLinkRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassSessionMaterial> {
    return this.classSessions.attachMaterialLink(sessionId, body.batchId, user, body);
  }

  @Post(':sessionId/materials/:materialId/share')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Share a class session material live with students' })
  shareMaterial(
    @Param('sessionId') sessionId: string,
    @Param('materialId') materialId: string,
    @Body() body: ClassSessionMaterialActionBody,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassSessionMaterial> {
    return this.classSessions.shareMaterial(sessionId, materialId, body.batchId, user);
  }

  @Post(':sessionId/materials/:materialId/unshare')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Stop sharing a class session material live' })
  unshareMaterial(
    @Param('sessionId') sessionId: string,
    @Param('materialId') materialId: string,
    @Body() body: ClassSessionMaterialActionBody,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<ClassSessionMaterial> {
    return this.classSessions.unshareMaterial(sessionId, materialId, body.batchId, user);
  }

  @Delete(':sessionId/materials/:materialId')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Archive a class session material' })
  deleteMaterial(
    @Param('sessionId') sessionId: string,
    @Param('materialId') materialId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<void> {
    return this.classSessions.deleteMaterial(sessionId, materialId, batchId, user);
  }

  @Get(':sessionId/materials/:materialId/download')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Download an authorized class session material' })
  async downloadMaterial(
    @Param('sessionId') sessionId: string,
    @Param('materialId') materialId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<StreamableFile> {
    const download = await this.classSessions.downloadMaterial(sessionId, materialId, batchId, user);
    response.setHeader('Content-Type', download.mimeType);
    response.setHeader('Content-Length', download.size);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${this.contentDispositionFileName(download.fileName)}"`);
    return new StreamableFile(download.stream);
  }

  @Get(':sessionId/whiteboard')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get persisted class session whiteboard memory' })
  getWhiteboardMemory(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryState | null> {
    return this.classSessions.getWhiteboardMemory(sessionId, batchId, user);
  }

  @Put(':sessionId/whiteboard')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Save persisted class session whiteboard memory' })
  saveWhiteboardMemory(
    @Param('sessionId') sessionId: string,
    @Body() body: SaveWhiteboardMemoryRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryState> {
    return this.classSessions.saveWhiteboardMemory(sessionId, body.batchId, user, body);
  }

  @Post(':sessionId/whiteboard/checkpoints')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Create a class session whiteboard checkpoint' })
  createWhiteboardCheckpoint(
    @Param('sessionId') sessionId: string,
    @Body() body: CreateWhiteboardMemoryCheckpointRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryVersion> {
    return this.classSessions.createWhiteboardCheckpoint(sessionId, body.batchId, user, body);
  }

  @Get(':sessionId/whiteboard/versions')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List class session whiteboard versions' })
  listWhiteboardVersions(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryVersionListResponse> {
    return this.classSessions.listWhiteboardVersions(sessionId, batchId, user);
  }

  @Post(':sessionId/whiteboard/versions/:versionId/restore')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Restore a class session whiteboard version' })
  restoreWhiteboardVersion(
    @Param('sessionId') sessionId: string,
    @Param('versionId') versionId: string,
    @Body() body: RestoreWhiteboardMemoryVersionRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryState> {
    return this.classSessions.restoreWhiteboardVersion(sessionId, versionId, body.batchId, user, body);
  }

  @Get(':sessionId/whiteboard/previous')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List previous whiteboards in the same batch' })
  listPreviousWhiteboardMemories(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<PreviousWhiteboardMemoryListResponse> {
    return this.classSessions.listPreviousWhiteboardMemories(sessionId, batchId, user);
  }

  @Post(':sessionId/whiteboard/previous/restore')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Restore a previous class session whiteboard into this session' })
  restorePreviousWhiteboardMemory(
    @Param('sessionId') sessionId: string,
    @Body() body: RestorePreviousWhiteboardMemoryRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryState> {
    return this.classSessions.restorePreviousWhiteboardMemory(sessionId, body.batchId, user, body);
  }

  @Post(':sessionId/whiteboard/restore-previous')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Restore a previous class session whiteboard into this session' })
  restorePreviousWhiteboardMemoryAlias(
    @Param('sessionId') sessionId: string,
    @Body() body: RestorePreviousWhiteboardMemoryRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryState> {
    return this.classSessions.restorePreviousWhiteboardMemory(sessionId, body.batchId, user, body);
  }

  @Get(':sessionId/whiteboard/pages/search')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Search saved whiteboard pages by title or tags' })
  searchWhiteboardPages(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @Query('q') query: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryPageSearchResponse> {
    return this.classSessions.searchWhiteboardPages(sessionId, batchId, query, user);
  }

  @Get(':sessionId/whiteboard/search')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Search saved whiteboard pages by title or tags' })
  searchWhiteboardPagesAlias(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @Query('q') query: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<WhiteboardMemoryPageSearchResponse> {
    return this.classSessions.searchWhiteboardPages(sessionId, batchId, query, user);
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

  @Get(':sessionId/attendance.csv')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="class-session-attendance.csv"')
  @ApiOperation({ summary: 'Download class session attendance CSV' })
  downloadAttendance(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<string> {
    return this.classSessions.exportAttendanceCsv(sessionId, batchId, user);
  }

  @Get(':sessionId/recordings')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List authorized class session recordings' })
  listRecordings(
    @Param('sessionId') sessionId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<Recording[]> {
    return this.classSessions.listRecordings(sessionId, batchId, user);
  }

  @Get(':sessionId/recordings/:recordingId/download')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @Header('Content-Type', 'application/vnd.native-sfu.recording-manifest+json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="class-session-recording.json"')
  @ApiOperation({ summary: 'Download an authorized class session recording manifest' })
  async downloadRecording(
    @Param('sessionId') sessionId: string,
    @Param('recordingId') recordingId: string,
    @Query('batchId') batchId: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<string> {
    const download = await this.classSessions.downloadRecording(sessionId, recordingId, batchId, user);
    return download.content;
  }

  @Post(':sessionId/recording/start')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Start server-side recording for a live class session' })
  startRecording(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser): Promise<Recording> {
    return this.classSessions.startRecording(sessionId, user);
  }

  @Post(':sessionId/recording/stop')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Stop active server-side recording for a class session' })
  stopRecording(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser): Promise<Recording> {
    return this.classSessions.stopRecording(sessionId, user);
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

  private contentDispositionFileName(fileName: string): string {
    return fileName.replace(/["\r\n\\]/g, '_').slice(0, 180) || 'attachment';
  }
}
