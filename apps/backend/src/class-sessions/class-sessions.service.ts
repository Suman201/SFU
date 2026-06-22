import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ChatHistoryResponse, ChatMessageScope, ChatReadState, ChatThreadSummaryResponse, ClassSessionLifecycleEvent } from '@native-sfu/contracts';
import { Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ClassSessionStatus
} from '../database/schemas';
import { RoomsService } from '../rooms/rooms.service';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';
import { classSessionChannelIds, PlannedClassSession, planClassSessions } from './class-session-planner';

export interface ClassroomParticipantPayload {
  id: string;
  userId: string;
  displayName: string;
  role: 'teacher' | 'student' | 'admin';
}

export interface ClassroomPayload {
  sessionId: string;
  batchId: string;
  teacherId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  durationMinutes: number;
  status: ClassSessionStatus;
  roomId: string;
  chatChannelId: string;
  whiteboardChannelId: string;
  channels: {
    chat: string;
    whiteboard: string;
  };
  role: 'teacher' | 'student' | 'admin';
  canJoin: boolean;
  participants: ClassroomParticipantPayload[];
  startedAt?: string;
  completedAt?: string;
}

interface SessionResolution {
  batch: BatchMongoDocument;
  schedules: BatchScheduleMongoDocument[];
  planned: PlannedClassSession;
  persisted?: ClassSessionMongoDocument;
}

@Injectable()
export class ClassSessionsService {
  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    private readonly studentEnrollments: StudentEnrollmentsService,
    private readonly rooms: RoomsService
  ) {}

  async startSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    this.assertCanManageBatch(resolution.batch, user);
    this.assertBatchCanHostSession(resolution.batch);

    if (resolution.persisted?.status === 'completed' || resolution.persisted?.status === 'cancelled') {
      throw new BadRequestException('Completed or cancelled sessions cannot be started.');
    }

    if (resolution.persisted?.status === 'live') {
      const room = await this.rooms.ensureClassSessionRoom({
        sessionId,
        batchId: resolution.batch.id,
        title: resolution.planned.title,
        teacherId: resolution.batch.teacherId
      });
      if (resolution.persisted.roomId === room.id) {
        return this.toPayload(resolution, user);
      }
      const persisted = await this.classSessions.findByIdAndUpdate(sessionId, { $set: { roomId: room.id } }, { new: true });
      return this.toPayload({ ...resolution, persisted: persisted ?? resolution.persisted }, user);
    }

    const otherLiveSession = await this.classSessions.exists({
      _id: { $ne: sessionId },
      batchId: resolution.batch.id,
      status: 'live'
    });
    if (otherLiveSession) {
      throw new ConflictException('Another session for this batch is already live. End it before starting a new one.');
    }

    const now = new Date();
    const channelIds = classSessionChannelIds(sessionId);
    const room = await this.rooms.ensureClassSessionRoom({
      sessionId,
      batchId: resolution.batch.id,
      title: resolution.planned.title,
      teacherId: resolution.batch.teacherId
    });
    let persisted: ClassSessionMongoDocument | null;
    try {
      persisted = await this.classSessions.findOneAndUpdate(
        { _id: sessionId, status: { $nin: ['live', 'completed', 'cancelled'] } },
        {
          $setOnInsert: {
            _id: sessionId,
            batchId: resolution.batch.id,
            teacherId: resolution.batch.teacherId,
            title: resolution.planned.title,
            sessionNumber: resolution.planned.sessionNumber,
            scheduledAt: resolution.planned.scheduledAt,
            durationMinutes: resolution.planned.durationMinutes
          },
          $set: {
            status: 'live',
            roomId: room.id,
            chatChannelId: resolution.persisted?.chatChannelId ?? channelIds.chatChannelId,
            whiteboardChannelId: resolution.persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId,
            startedAt: resolution.persisted?.startedAt ?? now
          },
          $unset: {
            completedAt: '',
            cancelledAt: ''
          }
        },
        { new: true, upsert: true }
      );
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        await this.closeNewlyCreatedStartRoom(room.id, resolution, user);
        throw new ConflictException('Another session for this batch is already live. End it before starting a new one.');
      }
      throw error;
    }

    if (!persisted) {
      const latest = await this.classSessions.findById(sessionId);
      if (latest?.status === 'live') {
        return this.toPayload({ ...resolution, persisted: latest }, user);
      }
      if (latest?.status === 'completed' || latest?.status === 'cancelled') {
        throw new BadRequestException('Completed or cancelled sessions cannot be started.');
      }
      throw new ConflictException('Unable to start this class session. Please refresh and try again.');
    }

    const payload = await this.toPayload({ ...resolution, persisted }, user);
    this.rooms.emitClassSessionLifecycleEvent('session:started', this.toLifecyclePayload(payload));
    return payload;
  }

  async endSession(sessionId: string, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const persisted = await this.classSessions.findById(sessionId);
    if (!persisted) {
      throw new NotFoundException('Class session not found.');
    }
    const resolution = await this.resolveSession(sessionId, persisted.batchId);
    this.assertCanManageBatch(resolution.batch, user);

    if (persisted.status !== 'live') {
      throw new BadRequestException('Only live sessions can be ended.');
    }

    if (persisted.roomId) {
      await this.rooms.closeClassSessionRoom({
        roomId: persisted.roomId,
        actorUserId: user.sub,
        actorLabel: user.email
      });
    }
    const completedAt = new Date();
    const updated = await this.classSessions.findOneAndUpdate(
      { _id: sessionId, status: 'live' },
      {
        $set: {
          status: 'completed',
          completedAt
        }
      },
      { new: true }
    );
    if (!updated) {
      const latest = await this.classSessions.findById(sessionId);
      if (latest?.status === 'completed') {
        return this.toPayload({ ...resolution, persisted: latest }, user);
      }
      throw new ConflictException('Class session could not be completed. Please refresh and try again.');
    }

    const payload = await this.toPayload({ ...resolution, persisted: updated }, user);
    this.rooms.emitClassSessionLifecycleEvent('session:ended', this.toLifecyclePayload(payload));
    return payload;
  }

  async joinSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);

    if (resolution.persisted?.status !== 'live') {
      throw new ConflictException(this.joinBlockedMessage(resolution.persisted?.status ?? 'scheduled'));
    }

    return this.toPayload(resolution, user);
  }

  async getChatHistory(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    options: { participantId?: string; scope?: ChatMessageScope; before?: string; limit?: number } = {}
  ): Promise<ChatHistoryResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    return this.rooms.getClassSessionChatHistory({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted?.roomId ?? channelIds.roomId,
      channelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      requesterRole: this.payloadRole(user, resolution.batch),
      participantId: options.participantId,
      scope: options.scope,
      before: options.before,
      limit: options.limit
    });
  }

  async getChatSummary(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ChatThreadSummaryResponse> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    return this.rooms.getClassSessionChatSummary({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId: persisted?.roomId ?? channelIds.roomId,
      channelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      requesterRole: this.payloadRole(user, resolution.batch)
    });
  }

  async markChatRead(
    sessionId: string,
    batchId: string | undefined,
    user: AuthenticatedUser,
    options: { roomId?: string; participantId?: string; scope?: ChatMessageScope; readAt?: string } = {}
  ): Promise<ChatReadState> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    const roomId = persisted?.roomId ?? channelIds.roomId;
    if (options.roomId && options.roomId !== roomId) {
      throw new BadRequestException('Chat read room does not match this class session.');
    }
    return this.rooms.markClassSessionChatRead({
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      roomId,
      channelId: persisted?.chatChannelId ?? channelIds.chatChannelId,
      teacherId: resolution.batch.teacherId,
      requesterUserId: user.sub,
      requesterRole: this.payloadRole(user, resolution.batch),
      participantId: options.participantId,
      scope: options.scope,
      readAt: options.readAt
    });
  }

  async getSession(sessionId: string, batchId: string | undefined, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const resolution = await this.resolveSession(sessionId, batchId);
    await this.assertCanReadClassSession(resolution.batch, user);
    return this.toPayload(resolution, user);
  }

  async getCurrentForBatch(batchId: string, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const batch = await this.findBatch(batchId);
    await this.assertCanReadClassSession(batch, user);
    const schedules = await this.findSchedules(batch.id);
    const persistedSessions = await this.classSessions.find({ batchId: batch.id }).sort({ scheduledAt: 1 }).exec();
    const sessions = this.mergeSessions(batch, schedules, persistedSessions);
    const live = sessions.find((session) => session.status === 'live');
    const nextScheduled = sessions.find((session) => session.status === 'scheduled');
    const lastFinished = [...sessions].reverse().find((session) => session.status === 'completed' || session.status === 'cancelled');
    const selected = live ?? nextScheduled ?? lastFinished;
    if (!selected) {
      throw new NotFoundException('No class sessions are available for this batch.');
    }
    return this.toPayload(
      {
        batch,
        schedules,
        planned: selected.planned,
        persisted: selected.persisted
      },
      user
    );
  }

  private async resolveSession(sessionId: string, batchId?: string): Promise<SessionResolution> {
    const persisted = await this.classSessions.findById(sessionId);
    const resolvedBatchId = persisted?.batchId ?? batchId;
    if (!resolvedBatchId) {
      throw new NotFoundException('Class session not found.');
    }

    const batch = await this.findBatch(resolvedBatchId);
    const schedules = await this.findSchedules(batch.id);
    const planned =
      planClassSessions(batch, schedules).find((session) => session.id === sessionId) ??
      (persisted
        ? {
            id: persisted.id,
            batchId: persisted.batchId,
            title: persisted.title,
            sessionNumber: persisted.sessionNumber,
            scheduledAt: persisted.scheduledAt,
            durationMinutes: persisted.durationMinutes
          }
        : undefined);

    if (!planned) {
      throw new NotFoundException('Class session not found in this batch schedule.');
    }

    return { batch, schedules, planned, ...(persisted ? { persisted } : {}) };
  }

  private async findBatch(batchId: string): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } }).exec();
    if (!batch) {
      throw new NotFoundException('Batch not found.');
    }
    return batch;
  }

  private findSchedules(batchId: string): Promise<BatchScheduleMongoDocument[]> {
    return this.schedules.find({ batchId }).sort({ dayOfWeek: 1 }).exec();
  }

  private mergeSessions(
    batch: BatchMongoDocument,
    schedules: BatchScheduleMongoDocument[],
    persistedSessions: ClassSessionMongoDocument[]
  ): Array<{ planned: PlannedClassSession; persisted?: ClassSessionMongoDocument; status: ClassSessionStatus }> {
    const persistedById = new Map(persistedSessions.map((session) => [session.id, session]));
    const plannedSessions = planClassSessions(batch, schedules).map((planned) => {
      const persisted = persistedById.get(planned.id);
      return {
        planned,
        ...(persisted ? { persisted } : {}),
        status: persisted?.status ?? 'scheduled'
      };
    });
    const plannedIds = new Set(plannedSessions.map((session) => session.planned.id));
    const orphanedPersistedSessions = persistedSessions
      .filter((session) => !plannedIds.has(session.id))
      .map((session) => ({
        planned: {
          id: session.id,
          batchId: session.batchId,
          title: session.title,
          sessionNumber: session.sessionNumber,
          scheduledAt: session.scheduledAt,
          durationMinutes: session.durationMinutes
        },
        persisted: session,
        status: session.status
      }));
    return [...plannedSessions, ...orphanedPersistedSessions].sort(
      (left, right) => left.planned.scheduledAt.getTime() - right.planned.scheduledAt.getTime()
    );
  }

  private assertCanManageBatch(batch: BatchMongoDocument, user: AuthenticatedUser): void {
    if (this.isAdmin(user)) {
      return;
    }
    if (user.roles.includes('TEACHER') && batch.teacherId === user.sub) {
      return;
    }
    throw new ForbiddenException('You are not allowed to manage this class session.');
  }

  private async assertCanReadClassSession(batch: BatchMongoDocument, user: AuthenticatedUser): Promise<void> {
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) {
      return;
    }
    if (user.roles.includes('STUDENT') && (await this.studentEnrollments.isStudentEnrolledInBatch(user.sub, batch.id))) {
      return;
    }
    throw new ForbiddenException('You are not allowed to open this class session.');
  }

  private assertBatchCanHostSession(batch: BatchMongoDocument): void {
    if (batch.status === 'CANCELLED' || batch.status === 'COMPLETED') {
      throw new BadRequestException('Sessions cannot be started for completed or cancelled batches.');
    }
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN');
  }

  private async toPayload(resolution: SessionResolution, user: AuthenticatedUser): Promise<ClassroomPayload> {
    const channelIds = classSessionChannelIds(resolution.planned.id);
    const persisted = resolution.persisted;
    const status = persisted?.status ?? 'scheduled';
    const roomId = persisted?.roomId ?? channelIds.roomId;
    const chatChannelId = persisted?.chatChannelId ?? channelIds.chatChannelId;
    const whiteboardChannelId = persisted?.whiteboardChannelId ?? channelIds.whiteboardChannelId;
    const role = this.payloadRole(user, resolution.batch);

    return {
      sessionId: resolution.planned.id,
      batchId: resolution.batch.id,
      teacherId: resolution.batch.teacherId,
      title: resolution.planned.title,
      sessionNumber: resolution.planned.sessionNumber,
      scheduledAt: resolution.planned.scheduledAt.toISOString(),
      durationMinutes: resolution.planned.durationMinutes,
      status,
      roomId,
      chatChannelId,
      whiteboardChannelId,
      channels: {
        chat: chatChannelId,
        whiteboard: whiteboardChannelId
      },
      role,
      canJoin: status === 'live',
      participants: await this.payloadParticipants(resolution.batch, user, role),
      ...(persisted?.startedAt ? { startedAt: persisted.startedAt.toISOString() } : {}),
      ...(persisted?.completedAt ? { completedAt: persisted.completedAt.toISOString() } : {})
    };
  }

  private async payloadParticipants(
    batch: BatchMongoDocument,
    user: AuthenticatedUser,
    role: 'teacher' | 'student' | 'admin'
  ): Promise<ClassroomParticipantPayload[]> {
    const current = this.currentParticipant(user, role);
    if (role === 'student') {
      return [current];
    }
    const roster = await this.studentEnrollments.listBatchRoster(batch.id);
    const participants = [current];
    for (const student of roster) {
      if (participants.some((participant) => participant.userId === student.userId)) {
        continue;
      }
      participants.push({
        id: student.userId,
        userId: student.userId,
        displayName: student.displayName,
        role: 'student'
      });
    }
    return participants;
  }

  private toLifecyclePayload(payload: ClassroomPayload): ClassSessionLifecycleEvent {
    if (payload.status !== 'live' && payload.status !== 'completed') {
      throw new Error(`Unsupported class session lifecycle status: ${payload.status}`);
    }
    return {
      sessionId: payload.sessionId,
      batchId: payload.batchId,
      roomId: payload.roomId,
      status: payload.status,
      ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
      ...(payload.completedAt ? { completedAt: payload.completedAt } : {})
    };
  }

  private payloadRole(user: AuthenticatedUser, batch: BatchMongoDocument): 'teacher' | 'student' | 'admin' {
    if (this.isAdmin(user)) {
      return 'admin';
    }
    if (user.roles.includes('TEACHER') && batch.teacherId === user.sub) {
      return 'teacher';
    }
    return 'student';
  }

  private currentParticipant(user: AuthenticatedUser, role: 'teacher' | 'student' | 'admin'): ClassroomParticipantPayload {
    return {
      id: user.sub,
      userId: user.sub,
      displayName: user.email?.split('@')[0] || (role === 'student' ? 'Student' : 'Teacher'),
      role
    };
  }

  private joinBlockedMessage(status: ClassSessionStatus): string {
    if (status === 'completed') {
      return 'This class session has ended.';
    }
    if (status === 'cancelled') {
      return 'This class session was cancelled.';
    }
    return 'The teacher has not started this class session yet.';
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
  }

  private async closeNewlyCreatedStartRoom(roomId: string, resolution: SessionResolution, user: AuthenticatedUser): Promise<void> {
    if (resolution.persisted?.roomId === roomId) {
      return;
    }
    await this.rooms
      .closeClassSessionRoom({
        roomId,
        actorUserId: user.sub,
        actorLabel: user.email ?? 'Class session start rollback'
      })
      .catch(() => undefined);
  }
}
