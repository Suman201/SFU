import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type {
  AdminWhiteboardReview,
  WhiteboardMemorySnapshot,
  WhiteboardMemoryVersion,
} from '@native-sfu/contracts';
import {
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ClassSessionWhiteboardStateDocument,
  ClassSessionWhiteboardStateMongoDocument,
  ClassSessionWhiteboardVersionDocument,
  ClassSessionWhiteboardVersionMongoDocument,
} from '../database/schemas';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module';
import { ClassSessionsService } from '../class-sessions/class-sessions.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

class RestoreBoardDto {
  @IsInt() @Min(1) expectedSnapshotVersion!: number;
  @IsInt() @Min(0) expectedLastOperationSeq!: number;
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
@Injectable()
export class AdminWhiteboardsService {
  constructor(
    @InjectModel(ClassSessionDocument.name)
    private readonly classes: Model<ClassSessionMongoDocument>,
    @InjectModel(ClassSessionWhiteboardStateDocument.name)
    private readonly states: Model<ClassSessionWhiteboardStateMongoDocument>,
    @InjectModel(ClassSessionWhiteboardVersionDocument.name)
    private readonly versions: Model<ClassSessionWhiteboardVersionMongoDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly classroom: ClassSessionsService,
    private readonly audit: AuditLogsService,
  ) {}
  private assertAdmin(user: AuthenticatedUser) {
    if (!user.roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN'))
      throw new ForbiddenException('Administrator access required.');
  }
  private version(
    item: ClassSessionWhiteboardVersionMongoDocument,
  ): AdminWhiteboardReview['versions'][number] {
    return {
      versionId: item.versionId,
      recoveryBackup: item.recoveryBackup,
      sessionId: item.sessionId,
      batchId: item.batchId,
      createdAt: item.createdAt.toISOString(),
      createdByUserId: item.createdByUserId,
      reason: item.reason as WhiteboardMemoryVersion['reason'],
      snapshotVersion: item.snapshotVersion,
      summary: {
        pageCount: item.pageCount,
        elementCount: item.elementCount,
        pages: item.pages.map((page) => ({
          pageId: page.pageId,
          title: page.title,
          tags: page.tags,
          order: page.order,
          elementCount: page.elementCount,
        })),
      },
    };
  }
  async list(user: AuthenticatedUser, search = '', pageText = '1') {
    this.assertAdmin(user);
    const page = Number(pageText);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      search.length > 150
    )
      throw new BadRequestException('Invalid whiteboard search.');
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pipeline: Record<string, unknown>[] = [
      {
        $lookup: {
          from: 'class_sessions',
          localField: 'sessionId',
          foreignField: '_id',
          as: 'class',
        },
      },
      { $unwind: '$class' },
      ...(escaped
        ? [
            {
              $match: {
                $or: [
                  { 'class.title': { $regex: escaped, $options: 'i' } },
                  { 'pages.title': { $regex: escaped, $options: 'i' } },
                  { 'pages.tags': { $regex: escaped, $options: 'i' } },
                  { sessionId: escaped },
                  { batchId: escaped },
                  { 'class.teacherId': escaped },
                ],
              },
            },
          ]
        : []),
      {
        $facet: {
          items: [
            { $sort: { updatedAt: -1, _id: -1 } },
            { $skip: (page - 1) * 25 },
            { $limit: 25 },
            {
              $project: {
                _id: 0,
                sessionId: 1,
                batchId: 1,
                title: '$class.title',
                teacherId: '$class.teacherId',
                status: '$class.status',
                pageCount: 1,
                elementCount: 1,
                snapshotVersion: 1,
                updatedAt: 1,
              },
            },
          ],
          count: [{ $count: 'total' }],
        },
      },
    ];
    const [result] = await this.states.aggregate(
      pipeline as unknown as Parameters<typeof this.states.aggregate>[0],
    );
    return {
      items: result?.items ?? [],
      total: result?.count?.[0]?.total ?? 0,
      page,
      limit: 25,
    };
  }
  async review(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AdminWhiteboardReview> {
    this.assertAdmin(user);
    const session = await this.classes.findById(id);
    if (!session) throw new NotFoundException('Class session not found.');
    const [board, versions] = await Promise.all([
      this.classroom.getWhiteboardMemory(id, session.batchId, user),
      this.versions
        .find({ sessionId: id, batchId: session.batchId })
        .sort({ createdAt: -1, versionId: -1 })
        .limit(100),
    ]);
    return {
      session: {
        id,
        batchId: session.batchId,
        title: session.title,
        teacherId: session.teacherId,
        status: session.status,
      },
      board,
      versions: versions.map((version) => this.version(version)),
      canRestore: Boolean(
        board &&
          session.status !== 'live' &&
          (user.roles.includes('SUPER_ADMIN') ||
            user.permissions.includes('admin:whiteboards:restore')),
      ),
    };
  }
  async preview(user: AuthenticatedUser, id: string, versionId: string) {
    this.assertAdmin(user);
    const session = await this.classes.findById(id);
    if (!session) throw new NotFoundException('Class session not found.');
    const version = await this.versions.findOne({
      sessionId: id,
      batchId: session.batchId,
      versionId,
    });
    if (!version) throw new NotFoundException('Whiteboard version not found.');
    return {
      version: this.version(version),
      snapshot: version.snapshot as unknown as WhiteboardMemorySnapshot,
    };
  }
  async restore(
    user: AuthenticatedUser,
    id: string,
    versionId: string,
    body: RestoreBoardDto,
  ) {
    this.assertAdmin(user);
    if (body.reason.trim().length < 5)
      throw new BadRequestException('Add a recovery reason.');
    const hello = await this.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw new ServiceUnavailableException(
        'Safe whiteboard recovery is not configured for this deployment.',
      );
    const transaction = await this.connection.startSession();
    const backupId = randomUUID(),
      restoredId = randomUUID();
    try {
      await transaction.withTransaction(async () => {
        // Writing the class document coordinates with a concurrent transition to live.
        const session = await this.classes.findOneAndUpdate(
          { _id: id, status: { $ne: 'live' } },
          { $inc: { adminRecoveryRevision: 1 } },
          { new: true, session: transaction },
        );
        if (!session)
          throw new ConflictException(
            'End the live class before recovering its whiteboard.',
          );
        const state = await this.states
          .findOne({ sessionId: id, batchId: session.batchId })
          .session(transaction);
        const target = await this.versions
          .findOne({ sessionId: id, batchId: session.batchId, versionId })
          .session(transaction);
        if (!state || !target)
          throw new NotFoundException('Saved whiteboard or version not found.');
        if (
          state.snapshotVersion !== body.expectedSnapshotVersion ||
          (state.lastOperationSeq ?? 0) !== body.expectedLastOperationSeq
        )
          throw new ConflictException(
            'The whiteboard changed. Reload and review it before restoring.',
          );
        const common = {
          sessionId: id,
          batchId: state.batchId,
          roomId: state.roomId,
          whiteboardChannelId: state.whiteboardChannelId,
          schemaVersion: 1,
          createdByUserId: user.sub,
        };
        await this.versions.create(
          [
            {
              ...common,
              versionId: backupId,
              recoveryBackup: true,
              reason: 'manual-save',
              snapshotVersion: state.snapshotVersion,
              snapshot: state.currentSnapshot,
              pages: state.pages,
              pageCount: state.pageCount,
              elementCount: state.elementCount,
            },
            {
              ...common,
              versionId: restoredId,
              reason: 'restore',
              snapshotVersion: state.snapshotVersion + 1,
              snapshot: target.snapshot,
              pages: target.pages,
              pageCount: target.pageCount,
              elementCount: target.elementCount,
            },
          ],
          { session: transaction, ordered: true },
        );
        state.currentSnapshot = target.snapshot;
        state.pages = target.pages;
        state.pageCount = target.pageCount;
        state.elementCount = target.elementCount;
        state.snapshotVersion += 1;
        state.latestVersionId = restoredId;
        state.compactedThroughSeq = state.lastOperationSeq ?? 0;
        state.updatedByUserId = user.sub;
        await state.save({ session: transaction });
      });
    } finally {
      await transaction.endSession();
    }
    await this.audit.record({
      actor: user,
      action: 'admin.whiteboard.restored',
      targetType: 'class_session',
      targetId: id,
      metadata: {
        sourceVersionId: versionId,
        backupVersionId: backupId,
        restoredVersionId: restoredId,
        reason: body.reason.trim(),
      },
    });
    return { ...(await this.review(user, id)), backupVersionId: backupId };
  }
  async download(user: AuthenticatedUser, id: string, versionId?: string) {
    const snapshot = versionId
      ? (await this.preview(user, id, versionId)).snapshot
      : (await this.review(user, id)).board?.snapshot;
    if (!snapshot) throw new NotFoundException('Saved whiteboard not found.');
    await this.audit.record({
      actor: user,
      action: 'admin.whiteboard.exported',
      targetType: 'class_session',
      targetId: id,
      metadata: { versionId: versionId ?? 'current', format: 'json' },
    });
    return new StreamableFile(Buffer.from(JSON.stringify(snapshot, null, 2)));
  }
}
@Controller({ path: 'admin/whiteboards', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
class AdminWhiteboardsController {
  constructor(private readonly boards: AdminWhiteboardsService) {}
  @Get() list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
    @Query('page') page?: string,
  ) {
    return this.boards.list(user, search, page);
  }
  @Get(':id') review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.boards.review(user, id);
  }
  @Get(':id/versions/:versionId') preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.boards.preview(user, id, versionId);
  }
  @Post(':id/versions/:versionId/restore') restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: RestoreBoardDto,
  ) {
    return this.boards.restore(user, id, versionId, body);
  }
  @Get(':id/export') export(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('versionId') versionId: string | undefined,
    @Res({ passthrough: true })
    response: { setHeader(key: string, value: string): void },
  ) {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="whiteboard-${id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}.json"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    return this.boards.download(user, id, versionId);
  }
}
@Module({
  imports: [AuthModule, DatabaseModule, ClassSessionsModule, AuditLogsModule],
  controllers: [AdminWhiteboardsController],
  providers: [AdminWhiteboardsService],
})
export class AdminWhiteboardsModule {}
