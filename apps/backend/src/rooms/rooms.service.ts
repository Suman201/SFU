import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Model, Types } from 'mongoose';
import {
  ChatMessage,
  ChatAttachment,
  type ChatDeliveryState,
  type ChatMessageScope,
  type ChatReadReceiptEvent,
  ChatReadState,
  ChatThreadSummary,
  ChatThreadSummaryResponse,
  ChatHistoryResponse,
  type ClassSessionActivityRequest,
  type ClassSessionMaterialEvent,
  type ClassSessionLifecycleEvent,
  Consumer,
  ConsumerQualityState,
  ConsumerLayerEvent,
  ConsumerLayerState,
  ConsumerLayerSwitchReason,
  CreateConsumerRequest,
  CreateProducerRequest,
  CreateRoomRequest,
  DEFAULT_PARTICIPANT_PERMISSIONS,
  GetRoomIncidentTimelineRequest,
  GetRoomSnapshotHistoryRequest,
  IceCandidate,
  RoomIncidentActor,
  RoomIncidentState,
  RoomIncidentSnapshotBundle,
  RoomIncidentTimelineEvent,
  RoomIncidentTimelineState,
  RoomRecoveryActionResult,
  RoomRecoveryActionType,
  RoomRecoveryWorkflow,
  RoomSnapshotBundleSummary,
  RoomSnapshotHistoryState,
  RoomSnapshotTriggerReason,
  JoinRoomRequest,
  JoinRoomResponse,
  IncidentConsumerSummary,
  IncidentProducerSummary,
  type LiveClassSettings,
  IncidentTransportSummary,
  Participant,
  ParticipantPatch,
  Permissions,
  Producer,
  ProducerQualityState,
  ProducerDynacastControlFailureReport,
  ProducerDynacastEvent,
  ProducerDynacastState,
  ProducerSvcState,
  ProducerLayerState,
  PlatformEventActor,
  PlatformEventListResponse,
  PlatformEventQuery,
  RoomQualityState,
  RoomQualitySummaryState,
  RoomOperatorAlert,
  RoomIncidentSnapshot,
  RoomFailureEvent,
  RoomHealthState,
  RoomMediaProfile,
  RoomMediaProfileId,
  RoomAutopilotDecision,
  Role,
  RtpLayerSelection,
  RtpParameters,
  TransportIncidentSnapshot,
  SvcLayerSelection,
  StudentMediaModerationEvent,
  StudentMediaModerationAction,
  ClassStudentSpeakEvent,
  TransportQualityState,
  Room,
  SendChatAttachment,
  TransportOptions,
  UpdateRoomMediaProfileRequest,
  WhiteboardCommand,
  WhiteboardCommandEvent,
  WhiteboardControlEvent,
  WhiteboardCursor,
  WhiteboardCursorEvent,
  WhiteboardLockEvent,
  WhiteboardPermissionLevel,
  WHITEBOARD_PERMISSION_LEVELS,
  VIEWER_PERMISSIONS
} from '@native-sfu/contracts';
import type { RoomOwnerLookupResponse } from '@native-sfu/contracts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ChatMessageDocument,
  ChatAttachmentFileDocument,
  ChatAttachmentFileMongoDocument,
  ChatMessageMongoDocument,
  ChatReadStateDocument,
  ChatReadStateMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ConsumerDocument,
  ConsumerMongoDocument,
  ModerationDocument,
  ModerationMongoDocument,
  ParticipantDocument,
  ParticipantMongoDocument,
  PermissionDocument,
  PermissionMongoDocument,
  ProducerDocument,
  ProducerMongoDocument,
  RoomDocument,
  RoomIncidentEventDocument,
  RoomIncidentEventMongoDocument,
  RoomIncidentStateDocument,
  RoomMongoDocument,
  RoomOperatorAlertDocument,
  RoomSnapshotBundleDocument,
  RoomSnapshotBundleMongoDocument
} from '../database/schemas';
import { StudentEnrollmentsService, type StudentEnrollmentRosterItem } from '../student-enrollments/student-enrollments.service';

const CHAT_MESSAGE_MAX_LENGTH = 2000;
const CHAT_ATTACHMENT_MAX_COUNT = 3;
const CHAT_ATTACHMENT_MAX_SIZE_BYTES = 2 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CHAT_ATTACHMENT_FILE_MIME_TYPES = new Set([...CHAT_ATTACHMENT_IMAGE_MIME_TYPES, 'application/pdf']);
import { NodeRegistryService } from '../cluster/node-registry.service';
import { PipeCoordinatorService } from '../cluster/pipe-coordinator.service';
import { MediaService, type MediaWorkerRoomFailureEvent } from '@native-sfu/nest-sfu';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService, type RoomSocketPresence } from '../redis/redis.service';
import { PlatformEventsService } from '../events/platform-events.service';
import { RecordingsService } from '../recordings/recordings.service';
import { SYSTEM_LIVE_CLASS_SETTINGS } from '../profiles/profiles.service';
import { RoomSignalService, type RoomSignalEnvelope } from './room-signal.service';
import { planClassSessions } from '../class-sessions/class-session-planner';
import {
  applyProfileBitratePolicy,
  buildRoomQualitySummary,
  defaultConsumerLayers,
  defaultConsumerPriority,
  defaultProducerPriority,
  resolveRoomMediaProfile
} from './room-policy';

export interface SocketUser {
  id: string;
  email: string;
  roles: string[];
}

export interface ChatDeliveryResult {
  message: ChatMessage;
  deliveryState: ChatDeliveryState;
  broadcastRoomId?: string;
  targetSocketIds?: string[];
  targets?: SocketDeliveryTarget[];
}

export interface ChatReadDeliveryResult {
  state: ChatReadState;
  receipt: ChatReadReceiptEvent;
  targets?: SocketDeliveryTarget[];
  targetSocketIds?: string[];
}

export interface SocketDeliveryTarget {
  roomId: string;
  participantId: string;
  socketId: string;
  userId?: string;
  nodeId?: string;
}

interface WhiteboardControlState {
  roomId: string;
  participantId: string;
  userId: string;
  displayName: string;
  permissionLevel: WhiteboardPermissionLevel;
  pageId?: string;
  grantedByParticipantId: string;
  grantedAt: Date;
}

interface WhiteboardLockState {
  roomId: string;
  locked: boolean;
  changedAt: Date;
  changedByParticipantId: string;
}

export interface WhiteboardControlDelivery {
  event: WhiteboardControlEvent;
  targets: SocketDeliveryTarget[];
  revoked?: {
    event: WhiteboardControlEvent;
    targets: SocketDeliveryTarget[];
  };
}

export interface WhiteboardRealtimeDelivery<TEvent> {
  event: TEvent;
  targets: SocketDeliveryTarget[];
}

const DEFAULT_WHITEBOARD_PERMISSION_LEVEL: WhiteboardPermissionLevel = 'annotate';
const MAX_STUDENT_WHITEBOARD_COMMAND_BYTES = 250_000;
const DRAW_ONLY_WHITEBOARD_ELEMENT_TYPES = new Set(['stroke']);
const ANNOTATION_WHITEBOARD_ELEMENT_TYPES = new Set([
  'stroke',
  'shape',
  'text',
  'equation',
  'graph',
  'geometry',
  'diagram'
]);

interface ClassSessionChatContext {
  sessionId: string;
  batchId: string;
  roomId: string;
  channelId: string;
  teacherId: string;
  requesterUserId: string;
  requesterRole: 'teacher' | 'student' | 'admin';
  participantId?: string;
  scope?: ChatMessageScope;
}

interface ClassSessionReadTarget {
  scope: ChatMessageScope;
  threadKey?: string;
  participantId?: string;
  student?: ParticipantMongoDocument;
  rosterStudentId?: string;
}

interface ClassSessionChatDelivery {
  scope: ChatMessageScope;
  recipient?: ParticipantMongoDocument;
  recipientId?: string;
  threadKey?: string;
  targets?: SocketDeliveryTarget[];
  broadcastRoomId?: string;
}

interface PreparedChatAttachments {
  attachments: ChatAttachment[];
  fileAttachments: ChatAttachmentFileMongoDocument[];
}

export interface ClassSessionChatAttachmentUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ClassSessionChatAttachmentDownload {
  stream: ReadStream;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface EnsureClassSessionRoomRequest {
  sessionId: string;
  batchId: string;
  title: string;
  teacherId: string;
  liveSettings?: LiveClassSettings;
}

export interface CloseClassSessionRoomRequest {
  roomId: string;
  actorUserId: string;
  actorLabel?: string;
}

export interface ClassSessionAttendanceExportRequest {
  sessionId: string;
  batchId: string;
  roomId: string;
  completedAt?: Date;
  sessionDurationMinutes?: number;
  presentThresholdMinutes?: number;
  presentThresholdPercentage?: number;
  countReconnects?: boolean;
  anonymizeStudentExports?: boolean;
}

export interface ClassSessionAttendanceSummary {
  enrolled: number;
  present: number;
  absent: number;
  reconnects: number;
  averageDurationSeconds: number;
}

export interface ClassSessionAttendanceRow {
  studentId: string;
  displayName: string;
  email: string;
  enrolledAt?: Date;
  rosterSource?: 'roster' | 'participant';
  firstJoinAt?: Date;
  lastLeaveAt?: Date;
  totalDurationSeconds: number;
  reconnectCount: number;
  status: 'present' | 'absent';
}

export type ClassSessionLifecycleEventName = 'session:started' | 'session:ended';
export type ClassSessionMaterialEventName = 'material:shared' | 'material:unshared' | 'material:updated';

export const CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS = 5 * 60 * 1000;
const CLASS_SESSION_TEACHER_RECONNECT_SWEEP_MS = 60 * 1000;

export interface StudentMediaModerationResult {
  event: StudentMediaModerationEvent;
  permissions: Permissions;
  producer?: Producer;
  targetSocketId?: string;
  targetSocketIds?: string[];
  targets?: SocketDeliveryTarget[];
}

export interface ClassStudentSpeakResult {
  event: ClassStudentSpeakEvent;
  participantPatch: ParticipantPatch;
  moderation: StudentMediaModerationResult;
}

export interface ProducerDynacastSignalTarget {
  socketId: string;
  roomSocketCount: number;
  suppressedSubscribers: number;
}

export interface LeaveRoomForSocketResult {
  closed: boolean;
  left: boolean;
  reconnecting?: boolean;
  participantPatch?: ParticipantPatch;
  room?: Room;
}

const ROOM_QUALITY_SIGNAL_STALE_MS = 15_000;
const DISTRIBUTED_QUALITY_STALE_MS = 15_000;
const OBSERVABILITY_TOMBSTONE_TTL_MS = 60_000;
const CLASS_SESSION_STUDENT_PERMISSIONS: Permissions = {
  canPublishAudio: true,
  canPublishVideo: true,
  canShareScreen: false,
  canChat: true
};

class RoomPolicyViolationError extends ForbiddenException {
  constructor(message: string, readonly details: RoomAutopilotDecision) {
    super(message);
  }
}

export interface RoomDiagnosticsState {
  room: Room;
  owner: RoomOwnerLookupResponse;
  quality: RoomQualityState;
  incidentState: RoomIncidentState;
  recentTimeline: RoomIncidentTimelineEvent[];
  snapshotHistory: RoomSnapshotBundleSummary[];
  qualitySource: 'local-owner' | 'remote-signal-cache' | 'local-fallback';
  ownerAuthoritativeQuality: boolean;
  qualityAgeMs: number;
  distributedSignalAgeMs?: number;
  crossNode: boolean;
  localNodeId: string;
  observedAt: string;
  warnings: string[];
}

export interface RoomAdaptiveDiagnosticsState {
  roomId: string;
  owner: RoomOwnerLookupResponse;
  qualitySource: 'local-owner' | 'remote-signal-cache' | 'local-fallback';
  ownerAuthoritativeQuality: boolean;
  observedAt: string;
  congestionState: RoomQualityState['congestionState'];
  score: number;
  participantCount: number;
  bitrate: {
    target: number;
    allocated: number;
    actual: number;
    maxAvailable: number;
    avgAvailable: number;
    maxRecommended: number;
    avgRecommended: number;
  };
  consumers: {
    total: number;
    degraded: number;
    recovering: number;
    withPendingLayerSwitch: number;
  };
  transports: {
    total: number;
    degraded: number;
    maxPacketLoss: number;
    maxRtt: number;
    maxJitter: number;
    maxPacingQueueDepth: number;
  };
  producers: {
    total: number;
    degraded: number;
    dynacastEnabled: number;
    activeLayerCount: number;
    suspendedLayerCount: number;
  };
  adaptiveDecisions: Array<{
    consumerId: string;
    participantId: string;
    producerId: string;
    score: number;
    reasons: ConsumerQualityState['score']['reasons'];
    currentLayers?: ConsumerQualityState['currentLayers'];
    targetLayers?: ConsumerQualityState['targetLayers'];
    currentSvcLayers?: ConsumerQualityState['currentSvcLayers'];
    targetSvcLayers?: ConsumerQualityState['targetSvcLayers'];
    availableBitrate: number;
    allocatedBitrate: number;
    pacingQueueDepth: number;
  }>;
  warnings: string[];
}

interface RoomPolicyContext {
  room: Room;
  summary: RoomQualitySummaryState;
}

interface DistributedStateEntry<T extends { roomId: string; updatedAt: string }> {
  state: T;
  observedAt: number;
}

interface ResolvedRoomQualityState {
  owner: RoomOwnerLookupResponse;
  quality: RoomQualityState;
  qualitySource: 'local-owner' | 'remote-signal-cache' | 'local-fallback';
  ownerAuthoritativeQuality: boolean;
  distributedSignalAgeMs?: number;
  warnings: string[];
}

interface LocalRoomCleanupMetrics {
  participantIds: string[];
  transportCount: number;
  consumerCount: number;
  producerCounts: Record<string, number>;
  pipeTransportCount: number;
}

@Injectable()
export class RoomsService implements OnModuleInit, OnModuleDestroy {
  private readonly layerEventListeners = new Set<(event: ConsumerLayerEvent) => void>();
  private readonly producerDynacastEventListeners = new Set<(event: ProducerDynacastEvent) => void>();
  private readonly consumerQualityEventListeners = new Set<(state: ConsumerQualityState) => void>();
  private readonly producerQualityEventListeners = new Set<(state: ProducerQualityState) => void>();
  private readonly transportQualityEventListeners = new Set<(state: TransportQualityState) => void>();
  private readonly roomQualityEventListeners = new Set<(state: RoomQualityState) => void>();
  private readonly roomQualitySummaryEventListeners = new Set<(state: RoomQualitySummaryState) => void>();
  private readonly roomFailureEventListeners = new Set<(event: RoomFailureEvent) => void>();
  private readonly roomIncidentStateEventListeners = new Set<(state: RoomIncidentState) => void>();
  private readonly roomIncidentTimelineEventListeners = new Set<(event: RoomIncidentTimelineEvent) => void>();
  private readonly roomSnapshotGeneratedEventListeners = new Set<(summary: RoomSnapshotBundleSummary) => void>();
  private readonly roomClosedEventListeners = new Set<(roomId: string) => void>();
  private readonly chatReadReceiptEventListeners = new Set<(delivery: ChatReadDeliveryResult) => void>();
  private readonly whiteboardControlByRoomId = new Map<string, WhiteboardControlState>();
  private readonly whiteboardLockByRoomId = new Map<string, WhiteboardLockState>();
  private readonly classSessionLifecycleEventListeners = new Set<
    (event: ClassSessionLifecycleEventName, payload: ClassSessionLifecycleEvent) => void
  >();
  private readonly classSessionMaterialEventListeners = new Set<
    (event: ClassSessionMaterialEventName, payload: ClassSessionMaterialEvent) => void
  >();
  private readonly roomQualitySummaryStates = new Map<string, RoomQualitySummaryState>();
  private readonly distributedRoomQualityStates = new Map<string, RoomQualityState>();
  private readonly distributedRoomQualityObservedAt = new Map<string, number>();
  private readonly distributedRoomQualitySummaryStates = new Map<string, RoomQualitySummaryState>();
  private readonly distributedRoomQualitySummaryObservedAt = new Map<string, number>();
  private readonly distributedConsumerQualityStates = new Map<string, DistributedStateEntry<ConsumerQualityState>>();
  private readonly distributedProducerQualityStates = new Map<string, DistributedStateEntry<ProducerQualityState>>();
  private readonly distributedTransportQualityStates = new Map<string, DistributedStateEntry<TransportQualityState>>();
  private readonly distributedRoomTombstones = new Map<string, number>();
  private readonly distributedParticipantTombstones = new Map<string, number>();
  private readonly distributedConsumerTombstones = new Map<string, number>();
  private readonly distributedProducerTombstones = new Map<string, number>();
  private readonly appliedRoomProfileSignatures = new Map<string, string>();
  private readonly classSessionTeacherReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private classSessionTeacherReconnectSweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectModel(RoomDocument.name) private readonly rooms: Model<RoomMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly batchSchedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(RoomIncidentEventDocument.name) private readonly roomIncidentEvents: Model<RoomIncidentEventMongoDocument>,
    @InjectModel(RoomSnapshotBundleDocument.name) private readonly roomSnapshotBundles: Model<RoomSnapshotBundleMongoDocument>,
    @InjectModel(ParticipantDocument.name) private readonly participants: Model<ParticipantMongoDocument>,
    @InjectModel(PermissionDocument.name) private readonly permissions: Model<PermissionMongoDocument>,
    @InjectModel(ProducerDocument.name) private readonly producers: Model<ProducerMongoDocument>,
    @InjectModel(ConsumerDocument.name) private readonly consumers: Model<ConsumerMongoDocument>,
    @InjectModel(ModerationDocument.name) private readonly moderation: Model<ModerationMongoDocument>,
    @InjectModel(ChatAttachmentFileDocument.name) private readonly chatAttachments: Model<ChatAttachmentFileMongoDocument>,
    @InjectModel(ChatMessageDocument.name) private readonly chat: Model<ChatMessageMongoDocument>,
    @InjectModel(ChatReadStateDocument.name) private readonly chatReadStates: Model<ChatReadStateMongoDocument>,
    private readonly redis: RedisService,
    private readonly media: MediaService,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly pipeCoordinator: PipeCoordinatorService,
    private readonly metrics: MetricsService,
    private readonly signals: RoomSignalService,
    private readonly platformEvents: PlatformEventsService,
    private readonly studentEnrollments: StudentEnrollmentsService,
    private readonly recordings: RecordingsService,
    private readonly config: ConfigService,
    @Optional() private readonly auditLogs?: AuditLogsService
  ) {
    this.media.onConsumerLayerEvent((event) => {
      void this.handleConsumerLayerEvent(event);
    });
    this.media.onProducerDynacastEvent((event) => {
      void this.handleProducerDynacastEvent(event);
    });
    this.media.onConsumerScoreUpdated((state) => this.handleConsumerQualityState(state));
    this.media.onProducerScoreUpdated((state) => this.handleProducerQualityState(state));
    this.media.onTransportQualityUpdated((state) => this.handleTransportQualityState(state));
    this.media.onRoomQualityUpdated((state) => this.handleRoomQualityState(state));
    this.media.onMediaWorkerRoomFailed((event) => {
      void this.handleMediaRoomFailure(event);
    });
    this.signals.onSignal((signal) => {
      this.handleDistributedRoomSignal(signal);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.restoreClassSessionTeacherReconnectGrace();
    this.classSessionTeacherReconnectSweepTimer = setInterval(() => {
      void this.processExpiredClassSessionTeacherReconnectGrace();
    }, CLASS_SESSION_TEACHER_RECONNECT_SWEEP_MS);
    this.unrefTimer(this.classSessionTeacherReconnectSweepTimer);
  }

  onModuleDestroy(): void {
    if (this.classSessionTeacherReconnectSweepTimer) {
      clearInterval(this.classSessionTeacherReconnectSweepTimer);
      this.classSessionTeacherReconnectSweepTimer = undefined;
    }
    for (const timer of this.classSessionTeacherReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.classSessionTeacherReconnectTimers.clear();
  }

  onConsumerLayerEvent(listener: (event: ConsumerLayerEvent) => void): () => void {
    this.layerEventListeners.add(listener);
    return () => this.layerEventListeners.delete(listener);
  }

  onProducerDynacastEvent(listener: (event: ProducerDynacastEvent) => void): () => void {
    this.producerDynacastEventListeners.add(listener);
    return () => this.producerDynacastEventListeners.delete(listener);
  }

  onConsumerScoreUpdated(listener: (state: ConsumerQualityState) => void): () => void {
    this.consumerQualityEventListeners.add(listener);
    return () => this.consumerQualityEventListeners.delete(listener);
  }

  onProducerScoreUpdated(listener: (state: ProducerQualityState) => void): () => void {
    this.producerQualityEventListeners.add(listener);
    return () => this.producerQualityEventListeners.delete(listener);
  }

  onTransportQualityUpdated(listener: (state: TransportQualityState) => void): () => void {
    this.transportQualityEventListeners.add(listener);
    return () => this.transportQualityEventListeners.delete(listener);
  }

  onRoomQualityUpdated(listener: (state: RoomQualityState) => void): () => void {
    this.roomQualityEventListeners.add(listener);
    return () => this.roomQualityEventListeners.delete(listener);
  }

  onRoomQualitySummaryUpdated(listener: (state: RoomQualitySummaryState) => void): () => void {
    this.roomQualitySummaryEventListeners.add(listener);
    return () => this.roomQualitySummaryEventListeners.delete(listener);
  }

  onRoomFailed(listener: (event: RoomFailureEvent) => void): () => void {
    this.roomFailureEventListeners.add(listener);
    return () => this.roomFailureEventListeners.delete(listener);
  }

  onRoomClosed(listener: (roomId: string) => void): () => void {
    this.roomClosedEventListeners.add(listener);
    return () => this.roomClosedEventListeners.delete(listener);
  }

  onChatReadReceipt(listener: (delivery: ChatReadDeliveryResult) => void): () => void {
    this.chatReadReceiptEventListeners.add(listener);
    return () => this.chatReadReceiptEventListeners.delete(listener);
  }

  onClassSessionLifecycleEvent(
    listener: (event: ClassSessionLifecycleEventName, payload: ClassSessionLifecycleEvent) => void
  ): () => void {
    this.classSessionLifecycleEventListeners.add(listener);
    return () => this.classSessionLifecycleEventListeners.delete(listener);
  }

  emitClassSessionLifecycleEvent(event: ClassSessionLifecycleEventName, payload: ClassSessionLifecycleEvent): void {
    for (const listener of this.classSessionLifecycleEventListeners) {
      listener(event, payload);
    }
  }

  onClassSessionMaterialEvent(
    listener: (event: ClassSessionMaterialEventName, payload: ClassSessionMaterialEvent) => void
  ): () => void {
    this.classSessionMaterialEventListeners.add(listener);
    return () => this.classSessionMaterialEventListeners.delete(listener);
  }

  emitClassSessionMaterialEvent(event: ClassSessionMaterialEventName, payload: ClassSessionMaterialEvent): void {
    for (const listener of this.classSessionMaterialEventListeners) {
      listener(event, payload);
    }
  }

  private emitChatReadReceipt(delivery: ChatReadDeliveryResult): void {
    for (const listener of this.chatReadReceiptEventListeners) {
      listener(delivery);
    }
  }

  onRoomIncidentStateUpdated(listener: (state: RoomIncidentState) => void): () => void {
    this.roomIncidentStateEventListeners.add(listener);
    return () => this.roomIncidentStateEventListeners.delete(listener);
  }

  onRoomIncidentTimelineEvent(listener: (event: RoomIncidentTimelineEvent) => void): () => void {
    this.roomIncidentTimelineEventListeners.add(listener);
    return () => this.roomIncidentTimelineEventListeners.delete(listener);
  }

  onRoomSnapshotGenerated(listener: (summary: RoomSnapshotBundleSummary) => void): () => void {
    this.roomSnapshotGeneratedEventListeners.add(listener);
    return () => this.roomSnapshotGeneratedEventListeners.delete(listener);
  }

  async createRoom(user: SocketUser, socketId: string, request: CreateRoomRequest): Promise<Room> {
    if (!user.roles.includes(Role.HOST)) {
      throw new ForbiddenException('Host role required');
    }
    await this.nodeRegistry.assertLocalCanOwnNewRoom();
    const hostParticipantId = new Types.ObjectId().toHexString();
    const roomDoc = await this.rooms.create({
      name: request.name,
      hostId: hostParticipantId,
      settings: {
        locked: false,
        waitingRoomEnabled: request.waitingRoomEnabled ?? false,
        joinApprovalRequired: request.joinApprovalRequired ?? false,
        visibility: request.visibility ?? 'public',
        maxParticipants: request.maxParticipants ?? 100,
        recordingEnabled: false,
        chatEnabled: true
      },
      mediaProfile: {
        id: request.mediaProfileId ?? 'meeting',
        updatedAt: new Date(),
        updatedByParticipantId: hostParticipantId
      },
      mediaState: { status: 'active' }
    });
    try {
      await this.nodeRegistry.claimRoom(roomDoc.id);
    } catch (error) {
      roomDoc.closedAt = new Date();
      await roomDoc.save();
      throw error;
    }
    const participant = await this.createParticipant(
      roomDoc.id,
      user,
      socketId,
      Role.HOST,
      DEFAULT_PARTICIPANT_PERMISSIONS,
      true,
      undefined,
      hostParticipantId
    );
    roomDoc.hostId = participant.id;
    await roomDoc.save();
    await this.redis.markPresence(roomDoc.id, participant.id, socketId, {
      userId: participant.userId,
      nodeId: this.nodeRegistry.localNodeId()
    });
    this.metrics.activeRooms.inc();
    this.metrics.roomProfileDistribution.labels(roomDoc.mediaProfile?.id ?? 'meeting').inc();
    await this.platformEvents.appendEvent({
      type: 'room.created',
      roomId: roomDoc.id,
      actor: this.platformActorFromParticipant(participant),
      payload: {
        room: this.platformRoomReference(roomDoc),
        host: this.platformParticipantReference(participant)
      }
    });
    return this.getRoom(roomDoc.id);
  }

  async ensureClassSessionRoom(request: EnsureClassSessionRoomRequest): Promise<Room> {
    const session = await this.classSessions.findById(request.sessionId);
    if (session?.roomId) {
      const existingRoom = await this.findRoomDocumentById(session.roomId);
      if (existingRoom && !existingRoom.closedAt) {
        if (request.liveSettings) {
          await this.rooms.updateOne(
            { _id: existingRoom.id },
            {
              $set: {
                'settings.waitingRoomEnabled': request.liveSettings.access.waitingRoomEnabled,
                'settings.locked': request.liveSettings.access.lockClassAfterTeacherStarts,
                'settings.recordingEnabled': request.liveSettings.recording.recordingEnabled,
                'settings.chatEnabled': request.liveSettings.chat.privateTeacherStudentChatEnabled || request.liveSettings.chat.teacherBroadcastEnabled
              }
            }
          );
        }
        await this.nodeRegistry.claimRoom(existingRoom.id);
        return this.getRoom(existingRoom.id);
      }
    }

    await this.nodeRegistry.assertLocalCanOwnNewRoom();
    const liveSettings = request.liveSettings ?? SYSTEM_LIVE_CLASS_SETTINGS;
    const roomDoc = await this.rooms.create({
      name: request.title,
      hostId: new Types.ObjectId().toHexString(),
      settings: {
        locked: liveSettings.access.lockClassAfterTeacherStarts,
        waitingRoomEnabled: liveSettings.access.waitingRoomEnabled,
        joinApprovalRequired: false,
        visibility: 'private',
        maxParticipants: 100,
        recordingEnabled: liveSettings.recording.recordingEnabled,
        chatEnabled: liveSettings.chat.privateTeacherStudentChatEnabled || liveSettings.chat.teacherBroadcastEnabled
      },
      mediaProfile: {
        id: 'classroom',
        updatedAt: new Date()
      },
      mediaState: { status: 'active' }
    });
    try {
      await this.nodeRegistry.claimRoom(roomDoc.id);
    } catch (error) {
      roomDoc.closedAt = new Date();
      await roomDoc.save();
      throw error;
    }
    this.metrics.activeRooms.inc();
    this.metrics.roomProfileDistribution.labels(roomDoc.mediaProfile?.id ?? 'classroom').inc();
    return this.getRoom(roomDoc.id);
  }

  async joinRoom(user: SocketUser, socketId: string, request: JoinRoomRequest): Promise<JoinRoomResponse> {
    const startedAt = performance.now();
    const classSession: ClassSessionMongoDocument | null = await this.classSessions.findOne({ roomId: request.roomId });
    try {
    if (classSession) {
      this.assertClassSessionRoomIsLive(classSession);
      await this.assertSocketCanAccessClassSessionBatch(classSession.batchId, classSession.teacherId, user);
    }
    const room = await this.findRoomDocumentById(request.roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException('Room not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(room.id);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(room.id);
    } else if (!ownerLookup.local) {
      this.metrics.pipeSignalingReroutes.labels('remote_join').inc();
    }
    await this.assertNotBanned(room.id, user.id);
    const existingParticipant = await this.participants.findOne({ roomId: room.id, userId: user.id, leftAt: { $exists: false } });
    const classSessionEntitlements = classSession ? this.classSessionEntitlements(classSession, user) : undefined;
    if (existingParticipant) {
      if (classSessionEntitlements) {
        await this.applyClassSessionEntitlements(room, existingParticipant, classSessionEntitlements);
      }
      await this.replaceParticipantSocket(room.id, existingParticipant.id, socketId);
      if (classSession && this.isClassSessionTeacherUser(classSession, user)) {
        const hadReconnectGrace = Boolean(classSession.teacherReconnectDeadlineAt || this.classSessionTeacherReconnectTimers.has(classSession.id));
        await this.clearClassSessionTeacherReconnectGrace(classSession.id);
        if (hadReconnectGrace) {
          this.metrics.classSessionReconnectGraceEvents.labels('teacher_reconnected').inc();
          await this.recordClassSessionTeacherConnectionAudit('reconnected', classSession, existingParticipant);
        }
      }
      this.metrics.roomJoinDuration.observe(performance.now() - startedAt);
      await this.recordClassSessionRoomJoinAudit(classSession, user, existingParticipant, 'admitted', 'rejoin');
      return {
        room: await this.getRoom(room.id),
        participantId: existingParticipant.id,
        admitted: existingParticipant.admitted,
        rejoined: true
      };
    }
    const activeCount = await this.participants.countDocuments({ roomId: room.id, admitted: true, leftAt: { $exists: false } });
    if (room.settings.locked && !(classSession && (this.isClassSessionTeacherUser(classSession, user) || this.isAdminSocketUser(user)))) {
      this.metrics.roomAdmissionRejections.labels('room_locked').inc();
      throw new ForbiddenException('Room is locked');
    }
    if (activeCount >= room.settings.maxParticipants) {
      this.metrics.roomAdmissionRejections.labels('room_full').inc();
      throw new ForbiddenException('Room is full');
    }
    if (room.settings.visibility === 'invite-only' && !room.invitedUserIds.includes(user.id)) {
      this.metrics.roomAdmissionRejections.labels('invite_required').inc();
      throw new ForbiddenException('Invite required');
    }
    const policyContext = await this.getRoomPolicyContext(room.id, room);
    const joinDecision = policyContext.summary.protections.join;
    this.recordProtectionDecision(room.mediaProfile?.id ?? 'meeting', joinDecision);
    if (joinDecision.action === 'reject') {
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: 'join_rejected',
        severity: 'critical',
        summary: joinDecision.message,
        actor: {
          type: 'participant',
          userId: user.id,
          label: request.displayName
        }
      });
      this.metrics.roomAdmissionRejections.labels(`policy_${joinDecision.code}`).inc();
      throw new RoomPolicyViolationError(joinDecision.message, joinDecision);
    }
    const role = classSessionEntitlements?.role ?? (request.asViewer ? Role.VIEWER : Role.PARTICIPANT);
    const basePermissions = classSessionEntitlements?.permissions ?? (role === Role.VIEWER ? VIEWER_PERMISSIONS : DEFAULT_PARTICIPANT_PERMISSIONS);
    const admitted = !(room.settings.waitingRoomEnabled || room.settings.joinApprovalRequired || joinDecision.action === 'soft-throttle');
    if (classSession) {
      const latestSession = await this.requireLiveClassSessionForRoom(classSession.roomId);
      await this.assertClassSessionRoomJoinAllowed(latestSession.roomId, latestSession.teacherId, {
        id: user.id,
        roles: user.roles
      });
    }
    const participant = await this.createParticipant(room.id, user, socketId, role, basePermissions, admitted, request.displayName);
    if (classSessionEntitlements?.role === Role.HOST && room.hostId !== participant.id) {
      await this.rooms.updateOne({ _id: room.id }, { $set: { hostId: participant.id } });
      room.hostId = participant.id;
    }
    if (!admitted || joinDecision.action === 'soft-throttle') {
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: 'join_throttled',
        severity: 'warn',
        summary: joinDecision.message,
        actor: {
          type: 'participant',
          participantId: participant.id,
          userId: user.id,
          label: request.displayName
        },
        relatedParticipantId: participant.id
      });
    }
    await this.redis.markPresence(room.id, participant.id, socketId, {
      userId: participant.userId,
      nodeId: this.nodeRegistry.localNodeId()
    });
    if (classSession && this.isClassSessionTeacherUser(classSession, user)) {
      const hadReconnectGrace = Boolean(classSession.teacherReconnectDeadlineAt || this.classSessionTeacherReconnectTimers.has(classSession.id));
      await this.clearClassSessionTeacherReconnectGrace(classSession.id);
      if (hadReconnectGrace) {
        this.metrics.classSessionReconnectGraceEvents.labels('teacher_reconnected').inc();
        await this.recordClassSessionTeacherConnectionAudit('reconnected', classSession, participant);
      }
    }
    this.metrics.roomJoinDuration.observe(performance.now() - startedAt);
    const updatedRoom = await this.getRoom(room.id);
    await this.platformEvents.appendEvent({
      type: 'room.joined',
      roomId: room.id,
      actor: this.platformActorFromParticipant(participant),
      payload: {
        room: {
          roomId: room.id,
          ...(room.name ? { name: room.name } : {})
        },
        participant: this.platformParticipantReference(participant),
        admitted,
        asViewer: role === Role.VIEWER
      }
    });
    await this.recordClassSessionRoomJoinAudit(classSession, user, participant, 'admitted', admitted ? 'live' : 'pending');
    return {
      room: updatedRoom,
      participantId: participant.id,
      admitted,
      rejoined: false,
      admissionDecision: joinDecision
    };
    } catch (error) {
      await this.recordClassSessionRoomJoinAudit(classSession, user, undefined, 'denied', this.auditErrorReason(error));
      throw error;
    }
  }

  async replaceParticipantSocket(roomId: string, participantId: string, socketId: string): Promise<void> {
    const participant = await this.participants.findOne({ _id: participantId, roomId, leftAt: { $exists: false } });
    if (!participant) {
      throw new NotFoundException('Participant not found');
    }
    participant.socketId = socketId;
    participant.nodeId = this.nodeRegistry.localNodeId();
    participant.lastSeenAt = new Date();
    participant.lastActiveAt = new Date();
    participant.inactiveSince = undefined;
    await participant.save();
    await this.redis.markPresence(roomId, participant.id, socketId, {
      userId: participant.userId,
      nodeId: this.nodeRegistry.localNodeId()
    });
  }

  async updateClassSessionParticipantActivity(
    roomId: string,
    participantId: string,
    socketId: string,
    user: SocketUser,
    request: ClassSessionActivityRequest
  ): Promise<ParticipantPatch> {
    const classSession = await this.classSessions.findOne({ roomId });
    if (!classSession) {
      throw new NotFoundException('Class session not found.');
    }
    this.assertClassSessionRoomIsLive(classSession);
    await this.assertSocketCanAccessClassSessionBatch(classSession.batchId, classSession.teacherId, user);

    const participant = await this.participants.findOne({ _id: participantId, roomId, leftAt: { $exists: false } });
    if (!participant) {
      throw new NotFoundException('Participant not found');
    }
    if (participant.socketId && participant.socketId !== socketId) {
      throw new ForbiddenException('This socket is not active for the participant.');
    }
    if (participant.userId && participant.userId !== user.id && !this.isAdminSocketUser(user)) {
      throw new ForbiddenException('You cannot update another participant activity state.');
    }

    const now = new Date();
    const settings = this.classSessionLiveSettings(classSession).inactiveDetection;
    const patch: ParticipantPatch = { lastSeenAt: now.toISOString() };
    const update: Record<string, unknown> = { $set: { lastSeenAt: now }, $unset: {} };
    const isStudentParticipant = participant.role === Role.PARTICIPANT;

    if (!settings.inactiveDetectionEnabled || !isStudentParticipant) {
      update.$set = { ...(update.$set as Record<string, unknown>), lastActiveAt: now };
      update.$unset = { inactiveSince: '' };
      patch.lastActiveAt = now.toISOString();
      patch.inactiveSince = null;
      patch.inactive = false;
      await this.participants.updateOne({ _id: participant.id, roomId }, update);
      return patch;
    }

    const previousActiveAt = participant.lastActiveAt ?? participant.lastSeenAt ?? participant.joinedAt ?? now;
    const thresholdMs = Math.max(1, settings.inactiveAfterMinutes) * 60 * 1000;
    const hiddenByPolicy = settings.countBackgroundTabAsInactive && request.visible === false;
    const noMediaByPolicy = settings.countMutedNoCameraAsInactive && !participant.audioEnabled && !participant.videoEnabled;
    const thresholdReached = request.active === false && now.getTime() - previousActiveAt.getTime() >= thresholdMs;
    const inactive = hiddenByPolicy || noMediaByPolicy || thresholdReached;

    if (!inactive && request.active !== false) {
      update.$set = { ...(update.$set as Record<string, unknown>), lastActiveAt: now };
      update.$unset = { inactiveSince: '' };
      patch.lastActiveAt = now.toISOString();
      patch.inactiveSince = null;
      patch.inactive = false;
      await this.participants.updateOne({ _id: participant.id, roomId }, update);
      return patch;
    }

    if (inactive) {
      const inactiveSince = participant.inactiveSince ?? (thresholdReached ? previousActiveAt : now);
      update.$set = { ...(update.$set as Record<string, unknown>), inactiveSince };
      patch.inactiveSince = inactiveSince.toISOString();
      patch.inactive = true;
    }

    await this.participants.updateOne({ _id: participant.id, roomId }, update);
    return patch;
  }

  async leaveRoomForSocket(roomId: string, participantId: string, socketId: string): Promise<LeaveRoomForSocketResult> {
    const participant = await this.participants.findOne({ _id: participantId, roomId, leftAt: { $exists: false } });
    if (!participant) {
      return { closed: false, left: false };
    }
    await this.redis.removePresence(roomId, participantId, socketId);
    const remainingPresence = await this.redis.participantPresence(roomId, participantId);
    if (remainingPresence.length) {
      const [latest] = remainingPresence.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
      await this.participants.updateOne(
        { _id: participantId, roomId },
        {
          $set: {
            socketId: latest!.socketId,
            nodeId: latest!.nodeId ?? participant.nodeId,
            lastSeenAt: new Date()
          }
        }
      );
      return { closed: false, left: false };
    }
    if (participant.socketId !== socketId) {
      return { closed: false, left: false };
    }
    const classSession = await this.classSessions.findOne({ roomId });
    if (classSession?.status === 'live' && this.isClassSessionTeacherParticipant(classSession, participant)) {
      return this.deferClassSessionTeacherDisconnect(classSession, participant);
    }
    const result = await this.leaveRoom(roomId, participantId);
    return { ...result, left: true };
  }

  async leaveRoom(roomId: string, participantId: string): Promise<{ closed: boolean }> {
    const ownerLookup = await this.requireRoomOwnerLookup(roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(roomId);
    }
    const participant = await this.participants.findById(participantId);
    if (!participant || participant.roomId !== roomId) {
      return { closed: false };
    }
    const participantProducers = await this.producers.find({ roomId, participantId, status: { $ne: 'closed' } });
    const participantProducerIds = participantProducers.map((producer) => producer.id);
    const participantConsumers = await this.consumers.find({ roomId, participantId, status: { $ne: 'closed' } });
    const producerConsumers = participantProducerIds.length
      ? await this.consumers.find({ roomId, producerId: { $in: participantProducerIds }, status: { $ne: 'closed' } })
      : [];
    const producerHosting = new Map<string, boolean>();
    if (this.pipeCoordinator.isEnabled()) {
      for (const producer of participantProducers) {
        producerHosting.set(producer.id, await this.isProducerHostedLocally(producer, ownerLookup));
      }
    }
    await this.participants.updateOne({ _id: participantId }, { leftAt: new Date(), lastSeenAt: new Date() });
    await this.producers.updateMany({ roomId, participantId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.consumers.updateMany(
      {
        roomId,
        status: { $ne: 'closed' },
        $or: [
          { participantId },
          ...(participantProducerIds.length ? [{ producerId: { $in: participantProducerIds } }] : [])
        ]
      },
      { status: 'closed', closedAt: new Date() }
    );
    if (this.pipeCoordinator.isEnabled()) {
      const affectedProducerIds = new Set(participantConsumers.map((consumer) => consumer.producerId));
      for (const producerId of affectedProducerIds) {
        await this.syncDistributedConsumerDemandByProducer(roomId, producerId, { ownerLookup }).catch(() => undefined);
      }
    }
    await this.redis.removePresence(roomId, participantId);
    await this.media.closeParticipantTransports(participantId);
    if (this.pipeCoordinator.isEnabled()) {
      for (const consumer of uniqueConsumerDocs([...participantConsumers, ...producerConsumers])) {
        await this.releaseRemoteConsumerFeedSafely(consumer.id, 'participant_left', 'participant_left_consumer');
      }
      for (const producer of participantProducers) {
        if (producerHosting.get(producer.id)) {
          await this.releaseRemoteProducerPublicationSafely(producer.id, 'participant_left', 'participant_left_producer');
        }
      }
    }
    this.metrics.activeParticipants.labels(roomId).dec();
    const room = await this.rooms.findById(roomId);
    const roomReference = room
      ? {
          roomId: room.id,
          ...(room.name ? { name: room.name } : {})
        }
      : { roomId };
    const actor = this.platformActorFromParticipant(participant);
    const participantReference = this.platformParticipantReference(participant);
    if (ownerLookup.local && room?.hostId === participantId) {
      await this.rooms.updateOne({ _id: roomId }, { closedAt: new Date() });
      this.cleanupRoomAutopilotState(roomId);
      this.metrics.roomProfileDistribution.labels(room.mediaProfile?.id ?? 'meeting').dec();
      this.clearDistributedRoomObservability(roomId);
      await this.nodeRegistry.releaseRoom(roomId);
      this.metrics.activeRooms.dec();
      await this.platformEvents.appendEvent({
        type: 'room.left',
        roomId,
        actor,
        payload: {
          room: roomReference,
          participant: participantReference,
          closedRoom: true
        }
      });
      await this.platformEvents.appendEvent({
        type: 'room.closed',
        roomId,
        actor,
        payload: {
          room: roomReference,
          participantCount: 0
        }
      });
      return { closed: true };
    }
    await this.platformEvents.appendEvent({
      type: 'room.left',
      roomId,
      actor,
      payload: {
        room: roomReference,
        participant: participantReference,
        closedRoom: false
      }
    });
    return { closed: false };
  }

  async closeRoom(roomId: string, actorParticipantId: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.classSessions.findOne({ roomId });
    if (classSession?.status === 'live') {
      throw new BadRequestException('End the class session to close this classroom room.');
    }
    const actor = await this.assertModerator(roomId, actorParticipantId, true);
    await this.closeRoomWithActor(
      roomId,
      this.platformActorFromParticipantContext(actor, actorParticipantId, 'operator')
    );
  }

  async closeClassSessionRoom(request: CloseClassSessionRoomRequest): Promise<boolean> {
    const classSession = await this.classSessions.findOne({ roomId: request.roomId });
    if (classSession) {
      await this.clearClassSessionTeacherReconnectGrace(classSession.id);
      await this.recordings
        .stopActiveClassSessionRecording({
          sessionId: classSession.id,
          actorUserId: request.actorUserId,
          actorLabel: request.actorLabel ?? 'Class session end',
          reason: 'room_closed'
        })
        .catch(() => undefined);
    }
    const room = await this.findRoomDocumentById(request.roomId);
    if (!room || room.closedAt) {
      return false;
    }
    await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    await this.closeRoomWithActor(request.roomId, {
      type: 'operator',
      userId: request.actorUserId,
      label: request.actorLabel ?? 'Class session end'
    });
    for (const listener of this.roomClosedEventListeners) {
      listener(request.roomId);
    }
    return true;
  }

  cancelClassSessionTeacherReconnectGrace(sessionId: string): void {
    const timer = this.classSessionTeacherReconnectTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.classSessionTeacherReconnectTimers.delete(sessionId);
    this.metrics.activeClassSessionReconnectGraceTimers.set(this.classSessionTeacherReconnectTimers.size);
  }

  private async closeRoomWithActor(roomId: string, actor: PlatformEventActor): Promise<void> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    const activeParticipants = await this.participants.find({ roomId, leftAt: { $exists: false } });
    const localNodeId = this.nodeRegistry.localNodeId();
    await this.rooms.updateOne({ _id: roomId }, { closedAt: new Date() });
    await this.participants.updateMany({ roomId, leftAt: { $exists: false } }, { leftAt: new Date() });
    await this.producers.updateMany({ roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    await this.consumers.updateMany({ roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() });
    if (this.pipeCoordinator.isEnabled()) {
      await this.pipeCoordinator.closeRoomBindings(roomId);
    }
    const cleanup = normalizeMediaRoomCleanupSummary(await this.media.closeRoom(roomId));
    this.cleanupRoomAutopilotState(roomId);
    this.whiteboardControlByRoomId.delete(roomId);
    this.whiteboardLockByRoomId.delete(roomId);
    this.metrics.roomProfileDistribution.labels(room.mediaProfile?.id ?? 'meeting').dec();
    this.clearDistributedRoomObservability(roomId);
    await this.nodeRegistry.releaseRoom(roomId);
    for (const participant of activeParticipants) {
      if (participant.nodeId !== undefined && participant.nodeId !== localNodeId) {
        continue;
      }
      this.metrics.activeParticipants.labels(roomId).dec();
    }
    this.applyLocalRoomCleanupMetrics(roomId, cleanup, { includeParticipants: false });
    this.metrics.activeRooms.dec();
    await this.platformEvents.appendEvent({
      type: 'room.closed',
      roomId,
      actor,
      payload: {
        room: {
          roomId: room.id,
          ...(room.name ? { name: room.name } : {})
        },
        participantCount: 0
      }
    });
  }

  async setLocked(roomId: string, actorParticipantId: string, locked: boolean): Promise<Room> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, true);
    await this.rooms.updateOne({ _id: roomId }, { 'settings.locked': locked });
    const room = await this.getRoom(roomId);
    await this.platformEvents.appendEvent({
      type: locked ? 'room.locked' : 'room.unlocked',
      roomId,
      actor: this.platformActorFromParticipantContext(actor, actorParticipantId, 'operator'),
      payload: {
        room: {
          roomId,
          ...(room.name ? { name: room.name } : {})
        },
        locked
      }
    });
    return room;
  }

  async assertClassSessionRoomJoinAllowed(
    roomId: string,
    teacherId: string,
    user: { id: string; roles: readonly string[] }
  ): Promise<void> {
    const room = await this.findRoomDocumentById(roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException('Room not found');
    }
    if (!room.settings.locked || this.isAdminSocketUser({ id: user.id, email: '', roles: [...user.roles] })) {
      return;
    }
    if (user.roles.includes('TEACHER') && teacherId === user.id) {
      return;
    }
    const existingParticipant = await this.participants.findOne({
      roomId,
      userId: user.id,
      admitted: true,
      leftAt: { $exists: false }
    });
    if (existingParticipant) {
      return;
    }
    throw new ForbiddenException('Class is locked. Ask the teacher to unlock it before joining.');
  }

  async admit(roomId: string, actorParticipantId: string, participantId: string): Promise<Room> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const activeCount = await this.participants.countDocuments({ roomId, admitted: true, leftAt: { $exists: false } });
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    if (activeCount >= room.settings.maxParticipants) {
      this.metrics.roomAdmissionRejections.labels('room_full').inc();
      throw new ForbiddenException('Room is full');
    }
    const policyContext = await this.getRoomPolicyContext(roomId, room);
    const joinDecision = policyContext.summary.protections.join;
    this.recordProtectionDecision(room.mediaProfile?.id ?? 'meeting', joinDecision);
    if (joinDecision.action === 'reject') {
      await this.recordRoomIncidentEvent({
        roomId,
        type: 'approval_action',
        severity: 'critical',
        summary: 'A pending participant could not be admitted because room protections still reject new joins.',
        actor: {
          type: 'operator',
          participantId: actorParticipantId
        },
        relatedParticipantId: participantId
      });
      this.metrics.roomAdmissionRejections.labels(`policy_${joinDecision.code}`).inc();
      throw new RoomPolicyViolationError(joinDecision.message, joinDecision);
    }
    await this.participants.updateOne({ _id: participantId, roomId }, { admitted: true, $unset: { leftAt: '' } });
    await this.recordRoomIncidentEvent({
      roomId,
      type: 'approval_action',
      severity: 'info',
      summary: 'A pending participant was admitted to the room.',
      actor: {
        type: 'operator',
        participantId: actorParticipantId
      },
      relatedParticipantId: participantId
    });
    const [updatedRoom, admittedParticipant] = await Promise.all([
      this.getRoom(roomId),
      this.participants.findById(participantId)
    ]);
    if (admittedParticipant) {
      await this.platformEvents.appendEvent({
        type: 'participant.admitted',
        roomId,
        actor: this.platformActorFromParticipant(actor, 'operator'),
        payload: {
          room: {
            roomId,
            ...(updatedRoom.name ? { name: updatedRoom.name } : {})
          },
          participant: this.platformParticipantReference(admittedParticipant)
        }
      });
    }
    return updatedRoom;
  }

  async reject(roomId: string, actorParticipantId: string, participantId: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const participant = await this.participants.findById(participantId);
    await this.participants.updateOne({ _id: participantId, roomId }, { leftAt: new Date() });
    await this.recordRoomIncidentEvent({
      roomId,
      type: 'approval_action',
      severity: 'warn',
      summary: 'A pending participant was rejected from the room.',
      actor: {
        type: 'operator',
        participantId: actorParticipantId
      },
      relatedParticipantId: participantId
    });
    if (participant) {
      const room = await this.rooms.findById(roomId);
      await this.platformEvents.appendEvent({
        type: 'participant.rejected',
        roomId,
        actor: this.platformActorFromParticipant(actor, 'operator'),
        payload: {
          room: {
            roomId,
            ...(room?.name ? { name: room.name } : {})
          },
          participant: this.platformParticipantReference(participant)
        }
      });
    }
  }

  async createTransport(roomId: string, participantId: string): Promise<TransportOptions> {
    const ownerLookup = await this.requireRoomOwnerLookup(roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(roomId);
    } else if (!ownerLookup.local) {
      this.metrics.pipeSignalingReroutes.labels('remote_transport').inc();
    }
    await this.assertParticipant(roomId, participantId);
    try {
      const options = await this.media.createWebRtcTransport(roomId, participantId);
      this.metrics.activeTransports.inc();
      return options;
    } catch (error) {
      this.metrics.roomAdmissionRejections.labels('media_worker_capacity').inc();
      throw error;
    }
  }

  async addIceCandidate(transportId: string, participantId: string, candidate: IceCandidate): Promise<void> {
    await this.media.addRemoteCandidate(transportId, participantId, candidate);
  }

  async setRemoteIceParameters(transportId: string, participantId: string, parameters: TransportOptions['iceParameters']): Promise<void> {
    await this.media.setRemoteIceParameters(transportId, participantId, parameters);
  }

  async setRemoteDtlsParameters(transportId: string, participantId: string, parameters: TransportOptions['dtlsParameters']): Promise<void> {
    await this.media.setRemoteDtlsParameters(transportId, participantId, parameters);
  }

  async restartIce(transportId: string, participantId: string): Promise<TransportOptions> {
    return this.media.restartIce(transportId, participantId);
  }

  async createProducer(request: CreateProducerRequest, participantId: string): Promise<Producer & { closedProducerIds?: string[] }> {
    const ownerLookup = await this.requireRoomOwnerLookup(request.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    } else if (!ownerLookup.local) {
      this.metrics.pipeSignalingReroutes.labels('remote_publish').inc();
    }
    const participant = await this.assertParticipant(request.roomId, participantId);
    const permission = await this.getPermissions(request.roomId, participantId);
    const policyContext = await this.getRoomPolicyContext(request.roomId);
    const profile = policyContext.room.mediaProfile;
    const rtpParameters = applyProfileBitratePolicy(profile, request.kind, request.rtpParameters);
    const publishDecision = request.kind === 'screen'
      ? policyContext.summary.protections.screenShare
      : policyContext.summary.protections.publish;
    const source = request.kind === 'screen' && (request.source === 'whiteboard' || request.source === 'screen') ? request.source : undefined;
    const classSession = await this.classSessions.findOne({ roomId: request.roomId });
    this.recordProtectionDecision(profile.id, publishDecision);
    if (request.kind === 'audio' && !permission.canPublishAudio) {
      this.metrics.roomAdmissionRejections.labels('publish_audio_denied').inc();
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, 'publish_audio_denied', participant);
      throw new ForbiddenException('Audio publishing denied');
    }
    if (request.kind === 'video' && !permission.canPublishVideo) {
      this.metrics.roomAdmissionRejections.labels('publish_video_denied').inc();
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, 'publish_video_denied', participant);
      throw new ForbiddenException('Video publishing denied');
    }
    if (request.kind === 'audio' || request.kind === 'video') {
      try {
        await this.assertNoActiveStudentMediaModeration(request.roomId, participantId, request.kind);
      } catch (error) {
        await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, this.auditErrorReason(error), participant);
        throw error;
      }
    }
    if (request.kind === 'screen' && !permission.canShareScreen) {
      this.metrics.roomAdmissionRejections.labels('publish_screen_denied').inc();
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, 'publish_screen_denied', participant);
      throw new ForbiddenException('Screen sharing denied');
    }
    if (classSession && request.kind === 'screen') {
      try {
        await this.assertClassSessionStudentScreenShareAllowed(classSession, participant, permission, source);
      } catch (error) {
        await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, this.auditErrorReason(error), participant);
        throw error;
      }
      if (classSession && !this.classSessionLiveSettings(classSession).whiteboard.whiteboardSharingEnabled) {
        if (source === 'whiteboard') {
          await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, 'whiteboard_sharing_disabled', participant);
          throw new ForbiddenException('Whiteboard sharing is disabled for this class.');
        }
      }
    }
    if (source === 'whiteboard') {
      if (classSession && participant.role !== Role.HOST && participant.role !== Role.CO_HOST) {
        await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, 'whiteboard_share_not_teacher', participant);
        throw new ForbiddenException('Only the teacher can share the class whiteboard.');
      }
      if (classSession && !this.classSessionLiveSettings(classSession).whiteboard.whiteboardSharingEnabled) {
        await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, 'whiteboard_sharing_disabled', participant);
        throw new ForbiddenException('Whiteboard sharing is disabled for this class.');
      }
    }
    if (request.kind === 'screen' && publishDecision.action === 'reject') {
      await this.recordRoomIncidentEvent({
        roomId: request.roomId,
        type: 'screen_share_rejected',
        severity: 'critical',
        summary: publishDecision.message,
        actor: {
          type: 'participant',
          participantId,
          userId: participant.userId,
          label: participant.displayName
        },
        relatedParticipantId: participantId
      });
      this.metrics.roomAdmissionRejections.labels(`policy_${publishDecision.code}`).inc();
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, `policy_${publishDecision.code}`, participant);
      throw new RoomPolicyViolationError(publishDecision.message, publishDecision);
    }
    if (request.kind !== 'screen' && publishDecision.action === 'reject') {
      await this.recordRoomIncidentEvent({
        roomId: request.roomId,
        type: 'publish_rejected',
        severity: 'critical',
        summary: publishDecision.message,
        actor: {
          type: 'participant',
          participantId,
          userId: participant.userId,
          label: participant.displayName
        },
        relatedParticipantId: participantId
      });
      this.metrics.roomAdmissionRejections.labels(`policy_${publishDecision.code}`).inc();
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, `policy_${publishDecision.code}`, participant);
      throw new RoomPolicyViolationError(publishDecision.message, publishDecision);
    }
    const status = publishDecision.action === 'soft-throttle' ? 'paused' : 'live';
    const closedProducerIds = request.kind === 'screen' ? await this.closeExistingParticipantScreenProducers(request.roomId, participantId) : [];
    try {
      await this.media.bindProducer(request.transportId, participantId, rtpParameters);
    } catch (error) {
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, this.auditErrorReason(error), participant);
      throw error;
    }
    const priority = normalizeConsumerPriority(request.priority ?? defaultProducerPriority(profile, request.kind));
    const producerDoc = new this.producers({
      roomId: request.roomId,
      participantId,
      kind: request.kind,
      source,
      transportId: request.transportId,
      nodeId: this.nodeRegistry.localNodeId(),
      priority,
      rtpParameters,
      status
    });
    const producer: Producer = {
      id: producerDoc.id,
      roomId: request.roomId,
      participantId,
      kind: request.kind,
      ...(source ? { source } : {}),
      transportId: request.transportId,
      priority,
      rtpParameters,
      ...(publishDecision.action === 'allow' ? {} : { policyDecision: publishDecision }),
      status,
      createdAt: new Date().toISOString()
    };
    let registered = false;
    try {
      await this.media.registerProducer(producer);
      registered = true;
      if (!ownerLookup.local && this.pipeCoordinator.isEnabled()) {
        await this.pipeCoordinator.ensureRemoteProducerPublication({ roomId: request.roomId, producer });
      }
      if (producer.dynacast) {
        producerDoc.dynacastState = producer.dynacast as unknown as Record<string, unknown>;
      }
      if (producer.svc) {
        producerDoc.svcState = producer.svc as unknown as Record<string, unknown>;
      }
      await producerDoc.save();
      if (request.kind === 'screen') {
        closedProducerIds.push(...await this.closeExistingParticipantScreenProducers(request.roomId, participantId, producerDoc.id));
      }
      if (publishDecision.action === 'soft-throttle') {
        await this.recordRoomIncidentEvent({
          roomId: request.roomId,
          type: request.kind === 'screen' ? 'screen_share_throttled' : 'publish_throttled',
          severity: 'warn',
          summary: publishDecision.message,
          actor: {
            type: 'participant',
            participantId,
            userId: participant.userId,
            label: participant.displayName
          },
          relatedParticipantId: participantId,
          relatedProducerId: producerDoc.id
        });
      }
      if (request.kind === 'screen' && status === 'live') {
        participant.screenSharing = true;
        await participant.save();
      }
      this.metrics.activeProducers.labels(request.kind).inc();
      await this.platformEvents.appendEvent({
        type: 'producer.created',
        roomId: request.roomId,
        actor: this.platformActorFromParticipant(participant),
        payload: {
          room: {
            roomId: request.roomId,
            mediaProfileId: profile.id
          },
          producer: this.platformProducerReference(producerDoc),
          policyAction: publishDecision.action
        }
      });
      return {
        ...this.toProducer(producerDoc),
        ...(closedProducerIds.length ? { closedProducerIds } : {})
      };
    } catch (error) {
      if (!ownerLookup.local && this.pipeCoordinator.isEnabled()) {
        await this.releaseRemoteProducerPublicationSafely(producer.id, 'error', 'create_producer_error');
      }
      if (registered) {
        await this.media.unregisterProducer(producer.id).catch(() => undefined);
      }
      await this.recordClassSessionMediaFailure(classSession, 'publish', request.kind, this.auditErrorReason(error), participant);
      throw error;
    }
  }

  async setProducerStatus(producerId: string, participantId: string, status: 'live' | 'paused'): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    const producerHostedLocally = await this.isProducerHostedLocally(producer, ownerLookup);
    if (!ownerLookup.local && (!this.pipeCoordinator.isEnabled() || !producerHostedLocally)) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    const actor = await this.assertCanControlProducer(producer, participantId);
    if (status === 'live' && actor.id === producer.participantId) {
      const permissions = await this.getPermissions(producer.roomId, producer.participantId);
      if (producer.kind === 'audio' && !permissions.canPublishAudio) {
        throw new ForbiddenException('Audio publishing denied');
      }
      if (producer.kind === 'video' && !permissions.canPublishVideo) {
        throw new ForbiddenException('Video publishing denied');
      }
      if (producer.kind === 'audio' || producer.kind === 'video') {
        await this.assertNoActiveStudentMediaModeration(producer.roomId, producer.participantId, producer.kind);
      }
      if (producer.kind === 'screen' && !permissions.canShareScreen) {
        throw new ForbiddenException('Screen sharing denied');
      }
    }
    producer.status = status;
    await producer.save();
    await this.media.setProducerPaused(producerId, status === 'paused');
    if (producer.kind === 'screen') {
      await this.participants.updateOne(
        { _id: producer.participantId, roomId: producer.roomId },
        { screenSharing: status === 'live' }
      );
    }
    if (ownerLookup.local && this.pipeCoordinator.isEnabled() && !producerHostedLocally) {
      await this.pipeCoordinator.syncOriginProducerState({ roomId: producer.roomId, producerId, status });
    } else if (!ownerLookup.local && this.pipeCoordinator.isEnabled() && producerHostedLocally) {
      await this.pipeCoordinator.syncRemoteProducerState({ roomId: producer.roomId, producerId, status }).catch(() => undefined);
    }
    await this.platformEvents.appendEvent({
      type: status === 'paused' ? 'producer.paused' : 'producer.resumed',
      roomId: producer.roomId,
      actor: this.platformActorFromParticipantContext(
        actor,
        participantId,
        actor?.id === producer.participantId ? 'participant' : 'operator'
      ),
      payload: {
        room: {
          roomId: producer.roomId
        },
        producer: this.platformProducerReference(producer)
      }
    });
    return this.toProducer(producer);
  }

  async moderateStudentMedia(
    roomId: string,
    actorParticipantId: string,
    targetParticipantId: string,
    action: StudentMediaModerationAction
  ): Promise<StudentMediaModerationResult> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.classSessions.findOne({ roomId });
    if (!classSession) {
      throw new NotFoundException('Class session room not found');
    }
    this.assertClassSessionRoomIsLive(classSession);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const target = await this.assertParticipant(roomId, targetParticipantId);
    if (target.role !== Role.PARTICIPANT) {
      throw new ForbiddenException('Only student participant media can be moderated.');
    }

    const kind = action === 'mute-mic' || action === 'unmute-mic' ? 'audio' : 'video';
    const disabling = action === 'mute-mic' || action === 'stop-camera';
    const producer = disabling
      ? await this.producers
          .findOne({
            roomId,
            participantId: targetParticipantId,
            kind,
            status: { $ne: 'closed' }
          })
          .sort({ createdAt: -1 })
      : null;
    const producerPayload =
      disabling && producer && producer.status !== 'paused'
        ? await this.setProducerStatus(producer.id, actorParticipantId, 'paused')
        : disabling && producer
          ? this.toProducer(producer)
          : undefined;
    const currentPermissions = await this.getPermissions(roomId, targetParticipantId);
    const nextPermissions =
      kind === 'audio'
        ? { ...currentPermissions, canPublishAudio: !disabling }
        : { ...currentPermissions, canPublishVideo: !disabling };

    if (disabling) {
      await this.participants.updateOne(
        { _id: targetParticipantId, roomId },
        kind === 'audio' ? { audioEnabled: false } : { videoEnabled: false }
      );
    }
    await this.permissions.updateOne(
      { roomId, participantId: targetParticipantId },
      { $set: nextPermissions },
      { upsert: true }
    );
    const moderationAction = kind === 'audio' ? 'force-mute' : 'disable-camera';
    if (disabling) {
      await this.addModeration(roomId, actorParticipantId, targetParticipantId, moderationAction);
    } else {
      await this.moderation.updateMany({ roomId, participantId: targetParticipantId, action: moderationAction, active: true }, { active: false });
    }
    const targets = await this.participantSocketTargets(roomId, [target]);
    await this.recordClassSessionModerationAudit(classSession, actor, target, action, 'success');

    return {
      event: {
        roomId,
        participantId: targetParticipantId,
        ...(producerPayload ? { producerId: producerPayload.id } : {}),
        kind,
        action,
        moderatedByParticipantId: actor.id,
        permissions: nextPermissions,
        message: this.studentMediaModerationMessage(action)
      },
      permissions: nextPermissions,
      ...(producerPayload ? { producer: producerPayload } : {}),
      ...(targets[0]?.socketId ? { targetSocketId: targets[0].socketId } : {}),
      ...(targets.length ? { targetSocketIds: targets.map((socketTarget) => socketTarget.socketId), targets } : {})
    };
  }

  async moderateAllStudentMedia(
    roomId: string,
    actorParticipantId: string,
    action: Extract<StudentMediaModerationAction, 'mute-mic' | 'stop-camera'>
  ): Promise<StudentMediaModerationResult[]> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.classSessions.findOne({ roomId });
    if (!classSession) {
      throw new NotFoundException('Class session room not found');
    }
    this.assertClassSessionRoomIsLive(classSession);
    await this.assertModerator(roomId, actorParticipantId, false);
    const students = await this.participants.find({
      roomId,
      role: Role.PARTICIPANT,
      admitted: true,
      leftAt: { $exists: false }
    });
    const results: StudentMediaModerationResult[] = [];
    for (const student of students) {
      results.push(await this.moderateStudentMedia(roomId, actorParticipantId, student.id, action));
    }
    return results;
  }

  async exportClassSessionAttendanceCsv(request: ClassSessionAttendanceExportRequest): Promise<string> {
    const attendanceRows = await this.classSessionAttendanceRows(request);
    const rows: string[][] = [
      ['Student Name', 'Email', 'Student ID', 'First Join Time', 'Last Leave Time', 'Total Duration', 'Reconnect Count', 'Status']
    ];
    attendanceRows.forEach((row, index) => {
      const studentLabel = `Student ${index + 1}`;
      rows.push([
        request.anonymizeStudentExports ? studentLabel : row.displayName || 'Student',
        request.anonymizeStudentExports ? '' : row.email,
        request.anonymizeStudentExports ? `student-${index + 1}` : row.studentId,
        row.firstJoinAt ? row.firstJoinAt.toISOString() : '',
        row.lastLeaveAt ? row.lastLeaveAt.toISOString() : '',
        this.formatAttendanceDuration(row.totalDurationSeconds * 1000),
        String(row.reconnectCount),
        row.status
      ]);
    });

    return `${rows.map((row) => row.map((value) => this.csvEscape(value)).join(',')).join('\n')}\n`;
  }

  async summarizeClassSessionAttendance(request: ClassSessionAttendanceExportRequest): Promise<ClassSessionAttendanceSummary> {
    const attendanceRows = await this.classSessionAttendanceRows(request);
    const enrolled = attendanceRows.length;
    const present = attendanceRows.filter((row) => row.status === 'present').length;
    const totalDurationSeconds = attendanceRows.reduce((total, row) => total + row.totalDurationSeconds, 0);
    const reconnects = attendanceRows.reduce((total, row) => total + row.reconnectCount, 0);
    return {
      enrolled,
      present,
      absent: Math.max(0, enrolled - present),
      reconnects,
      averageDurationSeconds: present ? Math.round(totalDurationSeconds / present) : 0
    };
  }

  async classSessionAttendanceRows(request: ClassSessionAttendanceExportRequest): Promise<ClassSessionAttendanceRow[]> {
    const [roster, participantDocs] = await Promise.all([
      this.studentEnrollments.listBatchRoster(request.batchId, { includeInactive: true }),
      this.participants.find({ roomId: request.roomId, role: Role.PARTICIPANT, admitted: true }).sort({ joinedAt: 1 }).exec()
    ]);
    const participantsByStudentId = new Map<string, ParticipantMongoDocument[]>();
    for (const participant of participantDocs) {
      const studentId = this.participantChatIdentity(participant);
      const items = participantsByStudentId.get(studentId) ?? [];
      items.push(participant);
      participantsByStudentId.set(studentId, items);
    }

    const rows: ClassSessionAttendanceRow[] = [];
    const includedStudentIds = new Set<string>();
    const fallbackLeaveAt = request.completedAt ?? new Date();
    for (const student of roster) {
      includedStudentIds.add(student.userId);
      rows.push(
        this.classSessionAttendanceRow(
          student.userId,
          student.displayName,
          student.email,
          participantsByStudentId.get(student.userId) ?? [],
          fallbackLeaveAt,
          {
            enrolledAt: student.joinedAt ? new Date(student.joinedAt) : undefined,
            rosterSource: 'roster',
            presentThresholdMinutes: request.presentThresholdMinutes,
            presentThresholdPercentage: request.presentThresholdPercentage,
            sessionDurationMinutes: request.sessionDurationMinutes,
            countReconnects: request.countReconnects
          }
        )
      );
    }
    for (const [studentId, participants] of participantsByStudentId) {
      if (includedStudentIds.has(studentId)) {
        continue;
      }
      const latest = participants[participants.length - 1];
      rows.push(
        this.classSessionAttendanceRow(studentId, latest?.displayName ?? 'Student', '', participants, fallbackLeaveAt, {
          rosterSource: 'participant',
          presentThresholdMinutes: request.presentThresholdMinutes,
          presentThresholdPercentage: request.presentThresholdPercentage,
          sessionDurationMinutes: request.sessionDurationMinutes,
          countReconnects: request.countReconnects
        })
      );
    }
    return rows;
  }

  async setProducerPriority(producerId: string, participantId: string, priority: number): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    const producerHostedLocally = await this.isProducerHostedLocally(producer, ownerLookup);
    if (!ownerLookup.local && (!this.pipeCoordinator.isEnabled() || !producerHostedLocally)) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    await this.assertCanControlProducer(producer, participantId);
    producer.priority = normalizeConsumerPriority(priority);
    await producer.save();
    this.media.setProducerPriority(producerId, producer.priority);
    if (ownerLookup.local && this.pipeCoordinator.isEnabled() && !producerHostedLocally) {
      await this.pipeCoordinator.syncOriginProducerState({ roomId: producer.roomId, producerId, priority: producer.priority });
    } else if (!ownerLookup.local && this.pipeCoordinator.isEnabled() && producerHostedLocally) {
      await this.pipeCoordinator.syncRemoteProducerState({ roomId: producer.roomId, producerId, priority: producer.priority }).catch(() => undefined);
    }
    this.metrics.producerPriorityUpdates.labels(producer.kind).inc();
    return this.toProducer(producer);
  }

  private async closeExistingParticipantScreenProducers(roomId: string, participantId: string, exceptProducerId?: string): Promise<string[]> {
    const existingScreens = await this.producers.find({
      roomId,
      participantId,
      kind: 'screen',
      status: { $ne: 'closed' },
      ...(exceptProducerId ? { _id: { $ne: exceptProducerId } } : {})
    });
    const closedProducerIds: string[] = [];
    for (const producer of existingScreens) {
      const closed = await this.closeProducer(producer.id, participantId);
      closedProducerIds.push(closed.id);
    }
    return closedProducerIds;
  }

  async closeProducer(producerId: string, participantId: string): Promise<Producer> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    const producerHostedLocally = await this.isProducerHostedLocally(producer, ownerLookup);
    if (!ownerLookup.local && (!this.pipeCoordinator.isEnabled() || !producerHostedLocally)) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    const actor = await this.assertCanControlProducer(producer, participantId);
    producer.status = 'closed';
    producer.closedAt = new Date();
    await producer.save();
    if (ownerLookup.local && this.pipeCoordinator.isEnabled() && !producerHostedLocally) {
      const coordinated = await this.pipeCoordinator.closeOriginProducer({
        roomId: producer.roomId,
        producerId,
        reason: 'producer_closed'
      });
      if (!coordinated) {
        await this.media.unregisterProducer(producerId);
      }
    } else {
      await this.media.unregisterProducer(producerId);
    }
    if (!ownerLookup.local && this.pipeCoordinator.isEnabled() && producerHostedLocally) {
      await this.releaseRemoteProducerPublicationSafely(producerId, 'producer_closed', 'close_producer');
    }
    const dependentConsumers = await this.consumers.find({ roomId: producer.roomId, producerId, status: { $ne: 'closed' } });
    if (dependentConsumers.length) {
      await this.consumers.updateMany(
        { roomId: producer.roomId, producerId, status: { $ne: 'closed' } },
        { status: 'closed', closedAt: producer.closedAt ?? new Date() }
      );
      if (this.pipeCoordinator.isEnabled()) {
        for (const consumer of dependentConsumers) {
          await this.releaseRemoteConsumerFeedSafely(consumer.id, 'consumer_closed', 'close_producer_consumer');
        }
      }
    }
    if (producer.kind === 'screen') {
      const remainingScreens = await this.producers.countDocuments({
        roomId: producer.roomId,
        participantId: producer.participantId,
        kind: 'screen',
        status: { $ne: 'closed' }
      });
      if (remainingScreens === 0) {
        await this.participants.updateOne({ _id: producer.participantId, roomId: producer.roomId }, { screenSharing: false });
      }
    }
    this.metrics.activeProducers.labels(producer.kind).dec();
    await this.platformEvents.appendEvent({
      type: 'producer.closed',
      roomId: producer.roomId,
      actor: this.platformActorFromParticipantContext(
        actor,
        participantId,
        actor?.id === producer.participantId ? 'participant' : 'operator'
      ),
      payload: {
        room: {
          roomId: producer.roomId
        },
        producer: this.platformProducerReference(producer)
      }
    });
    return this.toProducer(producer);
  }

  async createConsumer(request: CreateConsumerRequest, participantId: string): Promise<Consumer> {
    const ownerLookup = await this.requireRoomOwnerLookup(request.roomId);
    const classSession = await this.classSessions.findOne({ roomId: request.roomId });
    const producer = await this.producers.findById(request.producerId);
    if (!producer || producer.status === 'closed') {
      await this.recordClassSessionMediaFailure(classSession, 'consume', 'unknown', 'producer_not_found');
      throw new NotFoundException('Producer not found');
    }
    const participant = await this.assertParticipant(request.roomId, participantId);
    await this.media.assertTransportOwner(request.transportId, participantId);
    const room = await this.getRoom(request.roomId);
    const preferredLayers = normalizeLayerSelection(
      request.preferredLayers
      ?? defaultConsumerLayers(room.mediaProfile, producer.kind, { viewer: participant.role === Role.VIEWER })
      ?? preferredLayerNameToSelection(request.preferredLayer ?? 'high')
    );
    const preferredSvcLayers = normalizeSvcLayerSelection(request.preferredSvcLayers);
    const consumerDoc = new this.consumers({
      roomId: request.roomId,
      producerId: producer.id,
      participantId,
      transportId: request.transportId,
      priority: normalizeConsumerPriority(request.priority ?? defaultConsumerPriority(room.mediaProfile, producer.kind)),
      preferredLayer: request.preferredLayer ?? selectionToPreferredLayerName(preferredLayers) ?? 'high',
      preferredLayers,
      preferredSvcLayers,
      rtpParameters: consumerRtpParametersForProducer(producer.rtpParameters as unknown as RtpParameters),
      status: 'live'
    });
    const producerHostedLocally = await this.isProducerHostedLocally(producer, ownerLookup);
    const remoteFeed = !ownerLookup.local && this.pipeCoordinator.isEnabled() && !producerHostedLocally
      ? await this.pipeCoordinator.ensureRemoteConsumerFeed({
          roomId: request.roomId,
          producerId: producer.id,
          consumerId: consumerDoc.id,
          status: 'live',
          priority: consumerDoc.priority,
          preferredLayers,
          preferredSvcLayers
        })
      : undefined;
    try {
      await consumerDoc.save();
      const consumer = this.toConsumer(consumerDoc);
      await this.media.registerConsumer(remoteFeed ? { ...consumer, producerId: remoteFeed.proxyProducerId } : consumer);
      try {
        await this.syncDistributedConsumerDemandByProducer(request.roomId, producer.id, { ownerLookup, consumerId: consumer.id });
      } catch (error) {
        consumerDoc.status = 'closed';
        consumerDoc.closedAt = new Date();
        await consumerDoc.save().catch(() => undefined);
        await this.media.unregisterConsumer(consumer.id).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (remoteFeed) {
        await this.releaseRemoteConsumerFeedSafely(consumerDoc.id, 'error', 'create_consumer_error');
      }
      await this.recordClassSessionMediaFailure(classSession, 'consume', producer.kind, this.auditErrorReason(error), participant);
      throw error;
    }
    this.metrics.activeConsumers.inc();
    await this.platformEvents.appendEvent({
      type: 'consumer.created',
      roomId: request.roomId,
      actor: this.platformActorFromParticipant(participant),
      payload: {
        room: {
          roomId: request.roomId,
          mediaProfileId: room.mediaProfile.id
        },
        consumer: this.platformConsumerReference(consumerDoc)
      }
    });
    return this.toConsumer(consumerDoc);
  }

  async setConsumerPriority(consumerId: string, participantId: string, priority: number): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    consumer.priority = normalizeConsumerPriority(priority);
    await consumer.save();
    this.media.setConsumerPriority(consumerId, consumer.priority);
    await this.syncDistributedConsumerDemandByProducer(consumer.roomId, consumer.producerId, { ownerLookup, consumerId });
    this.metrics.consumerPriorityUpdates.inc();
    return this.toConsumer(consumer);
  }

  async setConsumerStatus(consumerId: string, participantId: string, status: 'live' | 'paused'): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    consumer.status = status;
    await consumer.save();
    await this.media.setConsumerPaused(consumerId, status === 'paused');
    await this.syncDistributedConsumerDemandByProducer(consumer.roomId, consumer.producerId, { ownerLookup, consumerId });
    const actor = await this.participants.findOne({ _id: participantId, roomId: consumer.roomId, leftAt: { $exists: false } });
    await this.platformEvents.appendEvent({
      type: status === 'paused' ? 'consumer.paused' : 'consumer.resumed',
      roomId: consumer.roomId,
      actor: this.platformActorFromParticipantContext(actor ?? undefined, participantId),
      payload: {
        room: {
          roomId: consumer.roomId
        },
        consumer: this.platformConsumerReference(consumer)
      }
    });
    return this.toConsumer(consumer);
  }

  async setConsumerPreferredLayers(consumerId: string, participantId: string, preferredLayers: RtpLayerSelection): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    consumer.preferredLayers = normalizeLayerSelection(preferredLayers) as Record<string, unknown>;
    const snapshot = await this.media.setConsumerPreferredLayers(consumerId, normalizeLayerSelection(preferredLayers) ?? {});
    consumer.currentLayers = snapshot?.currentLayers as Record<string, unknown> | undefined;
    consumer.targetLayers = snapshot?.targetLayers as Record<string, unknown> | undefined;
    consumer.layerSwitchReason = snapshot?.switchReason;
    consumer.layerSwitchedAt = snapshot?.switchedAt ? new Date(snapshot.switchedAt) : consumer.layerSwitchedAt;
    await consumer.save();
    await this.syncDistributedConsumerDemandByProducer(consumer.roomId, consumer.producerId, { ownerLookup, consumerId });
    return this.toConsumer(consumer);
  }

  async setConsumerPreferredSvcLayers(consumerId: string, participantId: string, preferredSvcLayers: SvcLayerSelection): Promise<Consumer> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    consumer.preferredSvcLayers = normalizeSvcLayerSelection(preferredSvcLayers) as Record<string, unknown>;
    const snapshot = await this.media.setConsumerPreferredSvcLayers(consumerId, normalizeSvcLayerSelection(preferredSvcLayers) ?? {});
    consumer.currentSvcLayers = snapshot?.currentSvcLayers as Record<string, unknown> | undefined;
    consumer.targetSvcLayers = snapshot?.targetSvcLayers as Record<string, unknown> | undefined;
    consumer.currentLayers = snapshot?.currentLayers as Record<string, unknown> | undefined;
    consumer.targetLayers = snapshot?.targetLayers as Record<string, unknown> | undefined;
    consumer.layerSwitchReason = snapshot?.switchReason;
    consumer.layerSwitchedAt = snapshot?.switchedAt ? new Date(snapshot.switchedAt) : consumer.layerSwitchedAt;
    await consumer.save();
    await this.syncDistributedConsumerDemandByProducer(consumer.roomId, consumer.producerId, { ownerLookup, consumerId });
    return this.toConsumer(consumer);
  }

  async getConsumerLayerState(consumerId: string, participantId: string): Promise<ConsumerLayerState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    await this.assertParticipant(consumer.roomId, participantId);
    return this.consumerLayerState(consumer);
  }

  async getProducerLayerState(producerId: string, participantId: string): Promise<ProducerLayerState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    await this.assertParticipant(producer.roomId, participantId);
    const state = this.media.producerLayerState(producerId);
    if (state) {
      return state;
    }
    return {
      producerId,
      roomId: producer.roomId,
      participantId: producer.participantId,
      availableLayers: [],
      svc: producer.svcState as unknown as ProducerSvcState | undefined,
      dynacast: producer.dynacastState as unknown as ProducerDynacastState | undefined,
      updatedAt: new Date().toISOString()
    };
  }

  async getConsumerQualityState(consumerId: string, participantId: string): Promise<ConsumerQualityState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.status === 'closed') {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    await this.assertParticipant(consumer.roomId, participantId);
    const state = ownerLookup.local
      ? this.readLocalConsumerQualityState(consumerId)
      : this.readFreshDistributedState(this.distributedConsumerQualityStates, consumerId) ?? this.readLocalConsumerQualityState(consumerId);
    if (!state) {
      throw new NotFoundException('Consumer quality state not available');
    }
    return state;
  }

  async getProducerQualityState(producerId: string, participantId: string): Promise<ProducerQualityState> {
    const producer = await this.producers.findById(producerId);
    if (!producer || producer.status === 'closed') {
      throw new NotFoundException('Producer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(producer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(producer.roomId);
    }
    await this.assertParticipant(producer.roomId, participantId);
    const state = ownerLookup.local
      ? this.media.producerQualityState(producerId)
      : this.readFreshDistributedState(this.distributedProducerQualityStates, producerId) ?? this.media.producerQualityState(producerId);
    if (!state) {
      throw new NotFoundException('Producer quality state not available');
    }
    return state;
  }

  async getRoomQualityState(roomId: string, participantId: string): Promise<RoomQualityState> {
    await this.assertParticipant(roomId, participantId);
    return (await this.resolveRoomQualityState(roomId)).quality;
  }

  async getTransportQualityState(transportId: string, participantId: string): Promise<TransportQualityState> {
    const state = this.media.transportQualityState(transportId) ?? this.readFreshDistributedState(this.distributedTransportQualityStates, transportId);
    if (!state) {
      throw new NotFoundException('Transport quality state not available');
    }
    await this.assertParticipant(state.roomId, participantId);
    return state;
  }

  async getRoomQualitySummaryState(roomId: string, participantId: string): Promise<RoomQualitySummaryState> {
    await this.assertParticipant(roomId, participantId);
    return this.computeRoomQualitySummary(roomId);
  }

  async getRoomIncidentState(roomId: string, participantId: string): Promise<RoomIncidentState> {
    await this.assertModerator(roomId, participantId, false);
    const summary = await this.computeRoomQualitySummary(roomId);
    return this.buildRoomIncidentState(roomId, summary);
  }

  async getRoomIncidentTimeline(request: GetRoomIncidentTimelineRequest, participantId: string): Promise<RoomIncidentTimelineState> {
    await this.assertModerator(request.roomId, participantId, false);
    return this.listRoomIncidentTimeline(request.roomId, request.limit);
  }

  async getRoomSnapshotHistory(request: GetRoomSnapshotHistoryRequest, participantId: string): Promise<RoomSnapshotHistoryState> {
    await this.assertModerator(request.roomId, participantId, false);
    return this.listRoomSnapshotHistory(request.roomId, request.limit);
  }

  async runRoomRecoveryAction(request: {
    roomId: string;
    action: RoomRecoveryActionType;
    reason?: string;
  }, actorParticipantId: string): Promise<RoomRecoveryActionResult> {
    await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    const actor = await this.assertModerator(request.roomId, actorParticipantId, false);
    const roomDoc = await this.rooms.findById(request.roomId);
    if (!roomDoc) {
      throw new NotFoundException('Room not found');
    }
    const summary = await this.computeRoomQualitySummary(request.roomId);
    const now = new Date();
    const state = roomDoc.incidentState ?? defaultIncidentStateDocument(request.roomId, now);
    let executed = true;
    let blockedReason: string | undefined;
    let generatedSnapshotId: string | undefined;
    let shouldPersist = false;
    const reason = sanitizeOperatorReason(request.reason);

    switch (request.action) {
      case 'protect_room':
        if (roomDoc.mediaState?.status === 'failed') {
          executed = false;
          blockedReason = 'The room is already failed. Capture a snapshot or mark operator recovery instead.';
          break;
        }
        if (state.protected) {
          executed = false;
          blockedReason = 'The room is already protected.';
          break;
        }
        state.protected = true;
        state.protectedAt = now;
        state.protectedByParticipantId = actor.id;
        state.protectedReason = reason ?? 'Operator protected the room while quality or infrastructure recovered.';
        if (state.admissionsState === 'default') {
          state.admissionsState = 'protected';
        }
        if (state.publishingState === 'default') {
          state.publishingState = 'protected';
        }
        shouldPersist = true;
        break;
      case 'unprotect_room':
        if (!state.protected) {
          executed = false;
          blockedReason = 'The room is not currently protected.';
          break;
        }
        state.protected = false;
        state.protectedReason = undefined;
        state.protectedByParticipantId = undefined;
        if (state.admissionsState !== 'default') {
          state.admissionsState = 'default';
        }
        if (state.publishingState !== 'default') {
          state.publishingState = 'default';
        }
        shouldPersist = true;
        break;
      case 'reopen_admissions':
        if (roomDoc.settings.locked) {
          executed = false;
          blockedReason = 'Unlock the room before reopening admissions.';
          break;
        }
        if (roomDoc.mediaState?.status === 'failed') {
          executed = false;
          blockedReason = 'The room media is failed and cannot admit new participants yet.';
          break;
        }
        if (state.admissionsState === 'reopened') {
          executed = false;
          blockedReason = 'Admissions are already reopened.';
          break;
        }
        state.admissionsState = 'reopened';
        shouldPersist = true;
        break;
      case 'pause_new_publishing':
        if (roomDoc.mediaState?.status === 'failed') {
          executed = false;
          blockedReason = 'The room media is failed and publishing is already unavailable.';
          break;
        }
        if (state.publishingState === 'paused') {
          executed = false;
          blockedReason = 'New publishing is already paused.';
          break;
        }
        if (state.protected) {
          state.publishingState = 'protected';
        } else {
          state.publishingState = 'paused';
        }
        shouldPersist = true;
        break;
      case 'resume_new_publishing':
        if (state.protected && state.publishingState === 'protected') {
          executed = false;
          blockedReason = 'Remove room protection before resuming new publishing.';
          break;
        }
        if (state.publishingState === 'default') {
          executed = false;
          blockedReason = 'New publishing is already allowed.';
          break;
        }
        state.publishingState = 'default';
        shouldPersist = true;
        break;
      case 'force_incident_snapshot':
        break;
      case 'mark_operator_recovery':
        if (state.underRecovery) {
          executed = false;
          blockedReason = 'The room is already marked under operator recovery.';
          break;
        }
        state.underRecovery = true;
        state.recoveryStartedAt = now;
        state.recoveryStartedByParticipantId = actor.id;
        state.recoveryReason = reason ?? 'Operator acknowledged the incident and began a guided recovery workflow.';
        shouldPersist = true;
        break;
      case 'clear_recovery':
        if (!state.underRecovery) {
          executed = false;
          blockedReason = 'The room is not marked under operator recovery.';
          break;
        }
        if (summary.health !== 'stable') {
          executed = false;
          blockedReason = 'Wait for the room to return to a stable health state before clearing recovery.';
          break;
        }
        if (roomDoc.mediaState?.status === 'failed') {
          executed = false;
          blockedReason = 'The room is still failed and cannot exit recovery yet.';
          break;
        }
        state.underRecovery = false;
        state.recoveryClearedAt = now;
        state.recoveryClearedByParticipantId = actor.id;
        state.recoveryReason = reason ?? state.recoveryReason;
        shouldPersist = true;
        break;
    }

    if (!executed) {
      this.metrics.roomRecoveryActions.labels(request.action, 'blocked').inc();
      const room = await this.getRoom(request.roomId);
      await this.platformEvents.appendEvent({
        type: 'recovery.action.executed',
        roomId: request.roomId,
        actor: this.platformActorFromParticipant(actor, 'operator'),
        payload: {
          room: {
            roomId: request.roomId,
            ...(room.name ? { name: room.name } : {}),
            mediaProfileId: room.mediaProfile.id
          },
          action: request.action,
          executed: false,
          blockedReason,
          protected: state.protected,
          underRecovery: state.underRecovery,
          status: state.status
        }
      });
      return {
        roomId: request.roomId,
        action: request.action,
        executed: false,
        blockedReason,
        room,
        incidentState: await this.buildRoomIncidentState(request.roomId, summary)
      };
    }

    if (shouldPersist) {
      state.lastRecoveryAction = request.action;
      state.lastRecoveryActionAt = now;
      state.updatedAt = now;
      roomDoc.incidentState = state as RoomMongoDocument['incidentState'];
      await roomDoc.save();
    }

    this.metrics.roomRecoveryActions.labels(request.action, 'executed').inc();
    if (request.action === 'reopen_admissions') {
      this.metrics.reopenedRooms.inc();
    }
    if (request.action === 'mark_operator_recovery') {
      this.metrics.roomsUnderRecovery.inc();
    }
    if (request.action === 'clear_recovery' && state.recoveryStartedAt) {
      this.metrics.roomsUnderRecovery.dec();
      this.metrics.roomRecoveryDuration.observe(Math.max(0, now.getTime() - state.recoveryStartedAt.getTime()));
    }

    if (request.action === 'force_incident_snapshot') {
      const bundle = await this.generateRoomSnapshotBundle(request.roomId, 'manual_operator', {
        automatic: false,
        actor: incidentActorFromParticipant(actor, 'operator')
      });
      generatedSnapshotId = bundle.bundleId;
    } else {
      await this.recordRoomIncidentEvent({
        roomId: request.roomId,
        type: 'manual_action',
        severity: 'warn',
        summary: recoveryActionSummary(request.action),
        detail: reason,
        actor: incidentActorFromParticipant(actor, 'operator')
      });
    }

    const room = await this.getRoom(request.roomId);
    await this.emitRoomQualitySummaryUpdate(request.roomId, room);
    const incidentState = await this.getRoomIncidentState(request.roomId, actorParticipantId);
    await this.platformEvents.appendEvent({
      type: 'recovery.action.executed',
      roomId: request.roomId,
      actor: this.platformActorFromParticipant(actor, 'operator'),
      payload: {
        room: {
          roomId: request.roomId,
          ...(room.name ? { name: room.name } : {}),
          mediaProfileId: room.mediaProfile.id
        },
        action: request.action,
        executed: true,
        ...(generatedSnapshotId ? { generatedSnapshotId } : {}),
        protected: incidentState.protected,
        underRecovery: incidentState.underRecovery,
        status: incidentState.status
      }
    });
    return {
      roomId: request.roomId,
      action: request.action,
      executed: true,
      room,
      incidentState,
      ...(generatedSnapshotId ? { generatedSnapshotId } : {})
    };
  }

  async updateRoomMediaProfile(request: UpdateRoomMediaProfileRequest, actorParticipantId: string): Promise<Room> {
    await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    const actor = await this.assertModerator(request.roomId, actorParticipantId, false);
    const room = await this.rooms.findById(request.roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    const previousProfileId = room.mediaProfile?.id ?? 'meeting';
    room.mediaProfile = {
      id: request.profileId,
      updatedAt: new Date(),
      updatedByParticipantId: actorParticipantId
    } as RoomMongoDocument['mediaProfile'];
    await room.save();
    await this.recordRoomIncidentEvent({
      roomId: request.roomId,
      type: 'profile_changed',
      severity: 'info',
      summary: `Room media profile changed from ${previousProfileId} to ${request.profileId}.`,
      actor: {
        type: 'operator',
        participantId: actorParticipantId
      }
    });
    await this.applyRoomMediaProfile(room.id, request.profileId);
    if (previousProfileId !== request.profileId) {
      this.metrics.roomProfileDistribution.labels(previousProfileId).dec();
      this.metrics.roomProfileDistribution.labels(request.profileId).inc();
      this.metrics.roomProfileChanges.labels(previousProfileId, request.profileId).inc();
    }
    const updatedRoom = await this.getRoom(request.roomId);
    await this.emitRoomQualitySummaryUpdate(request.roomId, updatedRoom).catch(() => undefined);
    await this.platformEvents.appendEvent({
      type: 'room.media_profile.changed',
      roomId: request.roomId,
      actor: this.platformActorFromParticipantContext(actor, actorParticipantId, 'operator'),
      payload: {
        room: {
          roomId: request.roomId,
          ...(updatedRoom.name ? { name: updatedRoom.name } : {})
        },
        previousProfileId,
        nextProfileId: request.profileId
      }
    });
    return updatedRoom;
  }

  async updateRoomMediaProfileForUser(roomId: string, userId: string, profileId: RoomMediaProfileId): Promise<Room> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.updateRoomMediaProfile({ roomId, profileId }, participant.id);
  }

  async getRoomIncidentStateForUser(roomId: string, userId: string): Promise<RoomIncidentState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoomIncidentState(roomId, participant.id);
  }

  async getRoomIncidentTimelineForUser(roomId: string, userId: string, limit?: number): Promise<RoomIncidentTimelineState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoomIncidentTimeline({ roomId, limit }, participant.id);
  }

  async getRoomSnapshotHistoryForUser(roomId: string, userId: string, limit?: number): Promise<RoomSnapshotHistoryState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoomSnapshotHistory({ roomId, limit }, participant.id);
  }

  async getRoomAuditLogForUser(
    roomId: string,
    userId: string,
    query: Omit<PlatformEventQuery, 'roomId'> = {}
  ): Promise<PlatformEventListResponse> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    await this.assertModerator(roomId, participant.id, false);
    return this.platformEvents.listEvents({ ...query, roomId });
  }

  async runRoomRecoveryActionForUser(
    roomId: string,
    userId: string,
    action: RoomRecoveryActionType,
    reason?: string
  ): Promise<RoomRecoveryActionResult> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.runRoomRecoveryAction({ roomId, action, reason }, participant.id);
  }

  async getTransportQualityStateForUser(transportId: string, userId: string): Promise<TransportQualityState> {
    const state = this.media.transportQualityState(transportId) ?? this.readFreshDistributedState(this.distributedTransportQualityStates, transportId);
    if (!state) {
      throw new NotFoundException('Transport quality state not available');
    }
    const participant = await this.participants.findOne({ roomId: state.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getTransportQualityState(transportId, participant.id);
  }

  async producerDynacastSignalTarget(event: ProducerDynacastEvent, roomSocketCount = 1): Promise<ProducerDynacastSignalTarget | undefined> {
    const producer = await this.producers.findOne({ _id: event.producerId, status: { $ne: 'closed' } });
    if (!producer) {
      return undefined;
    }
    const participant = await this.participants.findOne({ _id: producer.participantId, roomId: event.roomId, leftAt: { $exists: false } });
    if (!participant?.socketId) {
      return undefined;
    }
    return {
      socketId: participant.socketId,
      roomSocketCount,
      suppressedSubscribers: Math.max(0, roomSocketCount - 1)
    };
  }

  recordDynacastSignalDelivery(event: ProducerDynacastEvent, suppressedSubscribers: number): void {
    this.metrics.dynacastPublisherTargetedEvents.labels(producerDynacastMetricEventName(event)).inc();
    if (suppressedSubscribers > 0) {
      this.metrics.dynacastSubscriberSuppressedEvents.labels(producerDynacastMetricEventName(event)).inc(suppressedSubscribers);
    }
  }

  recordDynacastSignalFailure(event: ProducerDynacastEvent, reason: string): void {
    const label = sanitizeMetricLabel(reason);
    this.metrics.dynacastControlFailures.labels(label).inc();
    this.metrics.dynacastPublisherTargetFailures.labels(producerDynacastMetricEventName(event), label).inc();
  }

  async recordProducerDynacastControlFailure(report: ProducerDynacastControlFailureReport, participantId: string): Promise<void> {
    const producer = await this.producers.findById(report.producerId);
    if (!producer || producer.participantId !== participantId || producer.status === 'closed') {
      throw new NotFoundException('Producer not found');
    }
    this.metrics.dynacastSenderControlApplyFailures.labels(sanitizeMetricLabel(report.reason)).inc();
    this.metrics.dynacastControlFailures.labels('sender_apply_failed').inc();
  }

  async handleMediaRoomFailure(failure: MediaWorkerRoomFailureEvent): Promise<void> {
    const room = await this.rooms.findById(failure.roomId);
    if (!room || room.mediaState?.status === 'failed') {
      this.media.acknowledgeRoomFailure(failure.roomId);
      this.metrics.mediaWorkerFailedRooms.set(this.media.workerPoolSnapshot().failedRooms.length);
      return;
    }
    const now = new Date(failure.failedAt);
    const [participants, producers, consumers] = await Promise.all([
      this.participants.find({ roomId: failure.roomId, leftAt: { $exists: false } }),
      this.producers.find({ roomId: failure.roomId, status: { $ne: 'closed' } }),
      this.consumers.find({ roomId: failure.roomId, status: { $ne: 'closed' } })
    ]);
    const localNodeId = this.nodeRegistry.localNodeId();
    room.set('mediaState', {
      status: 'failed',
      failedAt: now,
      failureReason: failure.reason,
      failureMessage: failure.message,
      workerId: failure.workerId
    });
    room.closedAt = room.closedAt ?? now;
    const incidentState = room.incidentState ?? defaultIncidentStateDocument(failure.roomId, now);
    incidentState.status = 'failed';
    incidentState.health = 'critical';
    incidentState.healthChangedAt = now;
    incidentState.lastFailureAt = now;
    incidentState.lastFailureReason = failure.reason;
    incidentState.lastFailureMessage = failure.message;
    incidentState.underRecovery = true;
    incidentState.recoveryStartedAt = incidentState.recoveryStartedAt ?? now;
    incidentState.recoveryReason = incidentState.recoveryReason ?? failure.message;
    incidentState.updatedAt = now;
    room.incidentState = incidentState as RoomMongoDocument['incidentState'];
    await room.save();
    await this.generateRoomSnapshotBundle(failure.roomId, 'room_failure', {
      automatic: true,
      actor: {
        type: 'worker',
        workerId: failure.workerId,
        label: failure.reason
      },
      reason: failure.message
    }).catch(() => undefined);
    await this.recordRoomIncidentEvent({
      roomId: failure.roomId,
      type: 'room_failed',
      severity: 'critical',
      summary: failure.message,
      actor: {
        type: 'worker',
        workerId: failure.workerId,
        label: failure.reason
      },
      workerId: failure.workerId
    });
    await Promise.all([
      this.participants.updateMany({ roomId: failure.roomId, leftAt: { $exists: false } }, { leftAt: now }),
      this.producers.updateMany({ roomId: failure.roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: now }),
      this.consumers.updateMany({ roomId: failure.roomId, status: { $ne: 'closed' } }, { status: 'closed', closedAt: now })
    ]);
    for (const participant of participants) {
      await this.redis.removePresence(failure.roomId, participant.id);
    }
    if (this.pipeCoordinator.isEnabled()) {
      try {
        await this.pipeCoordinator.closeRoomBindings(failure.roomId);
      } catch {
        this.metrics.pipeCleanupFailures.labels('media_room_failed_bindings').inc();
      }
    }
    this.cleanupRoomAutopilotState(failure.roomId);
    this.metrics.roomProfileDistribution.labels(room.mediaProfile?.id ?? 'meeting').dec();
    this.clearDistributedRoomObservability(failure.roomId);
    await this.nodeRegistry.releaseRoom(failure.roomId);
    this.media.acknowledgeRoomFailure(failure.roomId);
    this.metrics.mediaWorkerRoomFailures.labels(failure.reason).inc();
    this.metrics.mediaWorkerFailedRooms.set(this.media.workerPoolSnapshot().failedRooms.length);
    this.metrics.activeRooms.dec();
    const affectedProducerIds = new Set(failure.affectedProducers);
    const locallyAffectedParticipantIds = new Set(
      consumers
        .filter((consumer) => failure.affectedConsumers.includes(consumer.id))
        .map((consumer) => consumer.participantId)
    );
    for (const producer of producers) {
      if (!affectedProducerIds.has(producer.id) || producer.nodeId !== localNodeId) {
        continue;
      }
      locallyAffectedParticipantIds.add(producer.participantId);
      this.metrics.activeProducers.labels(producer.kind).dec();
    }
    for (const participant of participants) {
      if (participant.nodeId !== localNodeId && !locallyAffectedParticipantIds.has(participant.id)) {
        continue;
      }
      this.metrics.activeParticipants.labels(failure.roomId).dec();
    }
    for (let index = 0; index < failure.affectedConsumers.length; index += 1) {
      this.metrics.activeConsumers.dec();
    }
    for (let index = 0; index < failure.affectedTransports.length; index += 1) {
      this.metrics.activeTransports.dec();
    }
    const event: RoomFailureEvent = {
      roomId: failure.roomId,
      reason: failure.reason,
      message: failure.message,
      failedAt: failure.failedAt,
      recoverable: failure.recoverable,
      affectedParticipants: participants.map((participant) => participant.id),
      affectedTransports: failure.affectedTransports,
      affectedProducers: failure.affectedProducers,
      affectedConsumers: failure.affectedConsumers,
      workerId: failure.workerId
    };
    await this.platformEvents.appendEvent({
      type: 'room.failed',
      roomId: failure.roomId,
      actor: {
        type: 'worker',
        workerId: failure.workerId,
        label: failure.reason
      },
      payload: {
        room: {
          roomId: failure.roomId,
          ...(room.name ? { name: room.name } : {}),
          mediaProfileId: room.mediaProfile?.id
        },
        reason: failure.reason,
        message: failure.message,
        recoverable: failure.recoverable,
        workerId: failure.workerId,
        affectedParticipantIds: event.affectedParticipants,
        affectedProducerIds: failure.affectedProducers,
        affectedConsumerIds: failure.affectedConsumers,
        affectedTransportIds: failure.affectedTransports
      }
    });
    for (const listener of this.roomFailureEventListeners) {
      listener(event);
    }
    for (const listener of this.roomIncidentStateEventListeners) {
      listener(enrichIncidentStateWithDerivedFields(
        {
          ...toRoomIncidentState(failure.roomId, room.incidentState),
          activeAlerts: [
            nextAlert(undefined, {
              code: 'room_failed',
              severity: 'critical',
              title: 'Room media failed',
              detail: failure.message
            })
          ]
        },
        {
          mediaState: {
            status: 'failed',
            failedAt: failure.failedAt,
            failureReason: failure.reason,
            failureMessage: failure.message,
            workerId: failure.workerId
          },
          settings: room.settings,
          owner: undefined,
          id: failure.roomId
        } as Pick<Room, 'id' | 'settings' | 'mediaState' | 'owner'>,
        {
          roomId: failure.roomId,
          health: 'critical',
          protections: {
            join: overrideAutopilotDecision(defaultDecision('join'), 'reject', 'room_failed', 'Room media is unavailable while operators recover the room.'),
            publish: overrideAutopilotDecision(defaultDecision('publish'), 'reject', 'room_failed', 'Room media is unavailable while operators recover the room.'),
            screenShare: overrideAutopilotDecision(defaultDecision('screen-share'), 'reject', 'room_failed', 'Room media is unavailable while operators recover the room.')
          }
        } as Pick<RoomQualitySummaryState, 'roomId' | 'health' | 'protections'>,
        { local: true, available: true }
      ));
    }
  }

  async closeConsumer(consumerId: string, participantId: string): Promise<void> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer || consumer.participantId !== participantId) {
      throw new NotFoundException('Consumer not found');
    }
    const ownerLookup = await this.requireRoomOwnerLookup(consumer.roomId);
    if (!ownerLookup.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(consumer.roomId);
    }
    consumer.status = 'closed';
    consumer.closedAt = new Date();
    await consumer.save();
    let syncError: unknown;
    if (this.pipeCoordinator.isEnabled()) {
      try {
        await this.syncDistributedConsumerDemandByProducer(consumer.roomId, consumer.producerId, { ownerLookup, consumerId });
      } catch (error) {
        syncError = error;
      }
    }
    await this.media.unregisterConsumer(consumerId);
    if (this.pipeCoordinator.isEnabled()) {
      await this.releaseRemoteConsumerFeedSafely(consumerId, 'consumer_closed', 'close_consumer');
    }
    this.metrics.activeConsumers.dec();
    const actor = await this.participants.findOne({ _id: participantId, roomId: consumer.roomId, leftAt: { $exists: false } });
    await this.platformEvents.appendEvent({
      type: 'consumer.closed',
      roomId: consumer.roomId,
      actor: this.platformActorFromParticipantContext(actor ?? undefined, participantId),
      payload: {
        room: {
          roomId: consumer.roomId
        },
        consumer: this.platformConsumerReference(consumer)
      }
    });
    if (syncError) {
      throw syncError;
    }
  }

  async updatePermissions(roomId: string, actorParticipantId: string, participantId: string, patch: Partial<Permissions>): Promise<Permissions> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.assertModerator(roomId, actorParticipantId, false);
    const current = await this.getPermissions(roomId, participantId);
    const next = { ...current, ...patch };
    await this.permissions.updateOne({ roomId, participantId }, { $set: next }, { upsert: true });
    return next;
  }

  async kick(roomId: string, actorParticipantId: string, participantId: string, reason?: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const moderation = await this.addModeration(roomId, actorParticipantId, participantId, 'kick', reason);
    await this.platformEvents.appendEvent({
      type: 'participant.kicked',
      roomId,
      actor: this.platformActorFromParticipant(moderation.actor, 'operator'),
      payload: {
        room: {
          roomId
        },
        participant: this.platformParticipantReference(moderation.participant),
        ...(reason ? { reason } : {})
      }
    });
    await this.leaveRoom(roomId, participantId);
  }

  async ban(roomId: string, actorParticipantId: string, participantId: string, reason?: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const moderation = await this.addModeration(roomId, actorParticipantId, participantId, 'ban', reason);
    await this.platformEvents.appendEvent({
      type: 'participant.banned',
      roomId,
      actor: this.platformActorFromParticipant(moderation.actor, 'operator'),
      payload: {
        room: {
          roomId
        },
        participant: this.platformParticipantReference(moderation.participant),
        ...(reason ? { reason } : {})
      }
    });
    await this.leaveRoom(roomId, participantId);
  }

  async unban(roomId: string, actorParticipantId: string, participantId: string): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const participant = await this.participants.findById(participantId);
    await this.moderation.updateMany({ roomId, participantId, action: 'ban', active: true }, { active: false });
    if (participant) {
      await this.platformEvents.appendEvent({
        type: 'participant.unbanned',
        roomId,
        actor: this.platformActorFromParticipant(actor, 'operator'),
        payload: {
          room: {
            roomId
          },
          participant: this.platformParticipantReference(participant)
        }
      });
    }
  }

  async mute(roomId: string, actorParticipantId: string, participantId: string, force = false): Promise<void> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const participant = await this.participants.findById(participantId);
    await this.participants.updateOne({ _id: participantId, roomId }, { audioEnabled: false });
    if (force) {
      await this.addModeration(roomId, actorParticipantId, participantId, 'force-mute');
    }
    if (participant) {
      await this.platformEvents.appendEvent({
        type: 'participant.muted',
        roomId,
        actor: this.platformActorFromParticipant(actor, 'operator'),
        payload: {
          room: {
            roomId
          },
          participant: this.platformParticipantReference(participant),
          forced: force
        }
      });
    }
  }

  async sendChat(
    request: { roomId: string; message: string; recipientId?: string; scope?: ChatMessageScope; attachments?: SendChatAttachment[] },
    senderId: string
  ): Promise<ChatDeliveryResult> {
    try {
    await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    const sender = await this.assertParticipant(request.roomId, senderId);
    const messageBody = request.message.trim();
    const requestedAttachments = request.attachments ?? [];
    if (!messageBody && !requestedAttachments.length) {
      throw new BadRequestException('Chat message or attachment is required.');
    }
    if (requestedAttachments.length > CHAT_ATTACHMENT_MAX_COUNT) {
      throw new BadRequestException(`Chat messages can include up to ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`);
    }
    const classSession = await this.classSessions.findOne({ roomId: request.roomId });
    if (classSession) {
      this.assertClassSessionRoomIsLive(classSession);
      const liveSettings = this.classSessionLiveSettings(classSession);
      if (!liveSettings.chat.privateTeacherStudentChatEnabled && !liveSettings.chat.teacherBroadcastEnabled) {
        throw new ForbiddenException('Chat is disabled for this class.');
      }
      if (messageBody.length > liveSettings.chat.messageLengthLimit) {
        throw new BadRequestException(`Chat message cannot exceed ${liveSettings.chat.messageLengthLimit} characters.`);
      }
      if (requestedAttachments.length && !liveSettings.chat.chatAttachmentsEnabled) {
        throw new ForbiddenException('Chat attachments are disabled for this class.');
      }
      if (!this.isTeacherChatParticipant(sender)) {
        if (request.scope === 'broadcast') {
          throw new ForbiddenException('Students cannot send broadcast chat messages.');
        }
        if (!liveSettings.chat.privateTeacherStudentChatEnabled) {
          throw new ForbiddenException('Private class chat is disabled for this class.');
        }
      }
      if (request.scope === 'broadcast' && !liveSettings.chat.teacherBroadcastEnabled) {
        throw new ForbiddenException('Teacher broadcast chat is disabled for this class.');
      }
      if ((request.scope === 'private' || !request.scope) && !liveSettings.chat.privateTeacherStudentChatEnabled) {
        throw new ForbiddenException('Private class chat is disabled for this class.');
      }
      await this.assertSocketCanAccessClassSessionBatch(classSession.batchId, classSession.teacherId, {
        id: sender.userId ?? sender.id,
        email: sender.displayName,
        roles: sender.role === Role.HOST ? ['TEACHER'] : sender.role === Role.CO_HOST ? ['ADMIN'] : ['STUDENT']
      });
    } else if (messageBody.length > CHAT_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException(`Chat message cannot exceed ${CHAT_MESSAGE_MAX_LENGTH} characters.`);
    }

    const permissions = await this.getPermissions(request.roomId, senderId);
    if (!permissions.canChat) {
      throw new ForbiddenException('Chat permission denied');
    }
    const shadowMuted = await this.moderation.exists({ roomId: request.roomId, participantId: senderId, action: 'shadow-mute', active: true });
    const delivery: ClassSessionChatDelivery = classSession
      ? await this.resolveClassSessionChatDelivery(classSession, sender, request)
      : {
          scope: 'broadcast' as ChatMessageScope,
          recipient: undefined,
          threadKey: undefined,
          broadcastRoomId: request.roomId
        };
    const preparedAttachments = classSession
      ? await this.prepareClassSessionChatAttachments(classSession, sender, delivery, requestedAttachments)
      : { attachments: this.normalizeChatAttachments(requestedAttachments), fileAttachments: [] };
    let liveClassSession: ClassSessionMongoDocument | null = classSession;
    if (classSession) {
      try {
        liveClassSession = await this.requireLiveClassSessionForRoom(request.roomId);
      } catch (error) {
        await this.releasePendingClassSessionChatAttachments(preparedAttachments.fileAttachments);
        throw error;
      }
    }
    const doc = await this.chat.create({
      ...(liveClassSession
        ? {
            sessionId: liveClassSession.id,
            batchId: liveClassSession.batchId,
            channelId: liveClassSession.chatChannelId,
            chatChannelId: liveClassSession.chatChannelId
          }
        : {}),
      roomId: request.roomId,
      senderId: sender.id,
      senderName: sender.displayName,
      senderRole: this.chatSenderRole(sender.role),
      recipientId: delivery.recipientId ?? delivery.recipient?.id,
      scope: delivery.scope,
      ...(delivery.threadKey ? { threadKey: delivery.threadKey } : {}),
      message: messageBody,
      ...(preparedAttachments.attachments.length ? { attachments: preparedAttachments.attachments } : {}),
      shadowMuted: Boolean(shadowMuted)
    });
    if (classSession && preparedAttachments.fileAttachments.length) {
      await this.bindClassSessionChatAttachments(classSession, doc, delivery, preparedAttachments.fileAttachments);
    }
    const deliveryState = this.chatDeliveryState(delivery);
    const deliveryTimestamp = deliveryState === 'delivered' ? this.dateToIso(new Date()) : undefined;
    const message = {
      ...this.toChatMessage(doc),
      deliveryState,
      ...(deliveryTimestamp ? { deliveredAt: deliveryTimestamp } : {})
    };
    return {
      message,
      deliveryState,
      ...(delivery.broadcastRoomId ? { broadcastRoomId: delivery.broadcastRoomId } : {}),
      ...(delivery.targets?.length ? { targets: delivery.targets, targetSocketIds: delivery.targets.map((target) => target.socketId) } : {})
    };
    } catch (error) {
      await this.recordClassSessionChatFailure(request.roomId, 'send', request.scope, error);
      throw error;
    }
  }

  async getChatHistory(request: { sessionId?: string; roomId?: string; channelId?: string; threadKey?: string; scope?: ChatMessageScope; before?: string; limit?: number }): Promise<ChatHistoryResponse> {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (request.sessionId) {
      filter.sessionId = request.sessionId;
    } else if (request.channelId) {
      filter.$or = [{ channelId: request.channelId }, { chatChannelId: request.channelId }];
    } else if (request.roomId) {
      filter.roomId = request.roomId;
    } else {
      throw new BadRequestException('Session, room, or chat channel is required.');
    }

    if (request.threadKey) {
      filter.threadKey = request.threadKey;
    }
    if (request.scope) {
      filter.scope = request.scope;
    }

    if (request.before) {
      const before = new Date(request.before);
      if (Number.isNaN(before.getTime())) {
        throw new BadRequestException('Invalid chat history cursor.');
      }
      filter.createdAt = { $lt: before };
    }

    const limit = Math.min(100, Math.max(1, Math.trunc(request.limit ?? 50)));
    const docs = await this.chat.find(filter).sort({ createdAt: -1 }).limit(limit + 1).exec();
    const visibleDocs = docs.slice(0, limit);
    const messages = visibleDocs.reverse().map((doc) => this.toChatMessage(doc));
    const nextBefore = docs.length > limit ? messages[0]?.createdAt : undefined;
    return {
      messages,
      ...(nextBefore ? { nextBefore } : {})
    };
  }

  async getClassSessionChatHistory(request: {
    sessionId: string;
    batchId: string;
    roomId: string;
    channelId: string;
    teacherId: string;
    requesterUserId: string;
    requesterRole: 'teacher' | 'student' | 'admin';
    participantId?: string;
    scope?: ChatMessageScope;
    before?: string;
    limit?: number;
  }): Promise<ChatHistoryResponse> {
    const scope = request.requesterRole === 'student' ? undefined : request.scope ?? (request.participantId ? 'private' : 'broadcast');

    if (request.requesterRole === 'student') {
      const student = await this.findActiveParticipantByUserId(request.roomId, request.requesterUserId);
      if (!student || student.role !== Role.PARTICIPANT) {
        throw new ForbiddenException('Join the classroom before loading chat history.');
      }
      const threadKey = this.privateClassSessionThreadKey(request.sessionId, request.teacherId, student);
      return this.getChatHistoryByFilter({
        sessionId: request.sessionId,
        before: request.before,
        limit: request.limit,
        filter: {
          $or: [{ scope: 'broadcast' }, { scope: 'private', threadKey }]
        }
      });
    }

    if (scope === 'broadcast') {
      if (request.participantId) {
        throw new BadRequestException('Broadcast history does not accept a participant id.');
      }
      return this.getChatHistory({
        sessionId: request.sessionId,
        scope: 'broadcast',
        before: request.before,
        limit: request.limit
      });
    }

    if (scope !== 'private') {
      throw new BadRequestException('Unsupported chat history scope.');
    }
    if (!request.participantId) {
      throw new BadRequestException('Student participant id is required for private chat history.');
    }

    const target = await this.resolveClassSessionStudentThreadTarget({
      roomId: request.roomId,
      batchId: request.batchId,
      sessionId: request.sessionId,
      teacherId: request.teacherId,
      participantId: request.participantId
    });
    return this.getChatHistory({
      sessionId: request.sessionId,
      threadKey: target.threadKey,
      scope: 'private',
      before: request.before,
      limit: request.limit
    });
  }

  async createClassSessionChatAttachments(request: {
    sessionId: string;
    batchId: string;
    roomId: string;
    channelId: string;
    teacherId: string;
    requesterUserId: string;
    files: ClassSessionChatAttachmentUploadFile[];
  }): Promise<ChatAttachment[]> {
    if (!request.files.length) {
      throw new BadRequestException('At least one attachment file is required.');
    }
    if (request.files.length > CHAT_ATTACHMENT_MAX_COUNT) {
      throw new BadRequestException(`You can upload up to ${CHAT_ATTACHMENT_MAX_COUNT} attachments at once.`);
    }

    const participant = await this.findActiveParticipantByUserId(request.roomId, request.requesterUserId);
    if (!participant) {
      throw new ForbiddenException('Join the classroom before uploading chat attachments.');
    }
    const permissions = await this.getPermissions(request.roomId, participant.id);
    if (!permissions.canChat) {
      throw new ForbiddenException('Chat permission denied');
    }

    const directory = join(this.chatAttachmentStorageRoot(), 'class-sessions', this.safeStorageSegment(request.sessionId));
    await mkdir(directory, { recursive: true });
    const created: ChatAttachmentFileMongoDocument[] = [];
    for (const file of request.files) {
      const mimeType = this.normalizeUploadedChatAttachmentMimeType(file.mimetype);
      const type = this.chatAttachmentTypeForMimeType(mimeType);
      if (file.size > this.chatAttachmentMaxFileSizeBytes()) {
        throw new BadRequestException('Chat attachments cannot exceed 2 MB.');
      }
      if (!file.buffer?.length) {
        throw new BadRequestException('Attachment upload is empty.');
      }
      const attachmentId = randomUUID();
      const fileName = this.safeAttachmentFileName(file.originalname, type);
      const storageKey = `class-sessions/${this.safeStorageSegment(request.sessionId)}/${attachmentId}/${fileName}`;
      const storagePath = join(directory, `${attachmentId}-${fileName}`);
      await writeFile(storagePath, file.buffer);
      const doc = await this.chatAttachments.create({
        attachmentId,
        sessionId: request.sessionId,
        batchId: request.batchId,
        roomId: request.roomId,
        channelId: request.channelId,
        chatChannelId: request.channelId,
        uploadedByUserId: this.participantChatIdentity(participant),
        uploadedByParticipantId: participant.id,
        scope: 'pending',
        type,
        fileName,
        title: fileName,
        mimeType,
        size: file.size,
        storageProvider: 'local',
        storageKey,
        path: storagePath
      });
      created.push(doc);
    }
    return created.map((doc) => this.toChatAttachmentFromFile(doc));
  }

  async readClassSessionChatAttachment(request: {
    sessionId: string;
    batchId: string;
    roomId: string;
    teacherId: string;
    requesterUserId: string;
    requesterRole: 'teacher' | 'student' | 'admin';
    attachmentId: string;
  }): Promise<ClassSessionChatAttachmentDownload> {
    const doc = await this.chatAttachments.findOne({
      attachmentId: request.attachmentId,
      sessionId: request.sessionId,
      roomId: request.roomId,
      deletedAt: { $exists: false }
    });
    if (!doc) {
      throw new NotFoundException('Attachment not found.');
    }

    if (!this.canReadClassSessionChatAttachment(doc, request)) {
      throw new ForbiddenException('You are not allowed to open this attachment.');
    }

    return {
      stream: createReadStream(doc.path),
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      size: doc.size
    };
  }

  async markClassSessionChatRead(request: ClassSessionChatContext & { readAt?: string }): Promise<ChatReadState> {
    const detailed = await this.markClassSessionChatReadDetailed(request);
    const reader = await this.findActiveParticipantByUserId(request.roomId, request.requesterUserId);
    if (reader) {
      const targets = await this.chatReadReceiptTargets(
        {
          id: request.sessionId,
          batchId: request.batchId,
          roomId: request.roomId,
          teacherId: request.teacherId,
          chatChannelId: request.channelId
        } as ClassSessionMongoDocument,
        reader,
        detailed.target
      );
      this.emitChatReadReceipt({
        state: detailed.state,
        receipt: this.toChatReadReceiptEvent(detailed.state),
        ...(targets.length ? { targets, targetSocketIds: targets.map((target) => target.socketId) } : {})
      });
    }
    return detailed.state;
  }

  private async markClassSessionChatReadDetailed(request: ClassSessionChatContext & { readAt?: string }): Promise<{ state: ChatReadState; target: ClassSessionReadTarget }> {
    const target = await this.resolveClassSessionReadTarget(request);
    const lastReadAt = this.parseChatReadAt(request.readAt);
    const readStateKey = this.chatReadStateKey(request.sessionId, request.requesterUserId, target.scope, target.threadKey);
    const readStatePayload = {
      readStateKey,
      sessionId: request.sessionId,
      batchId: request.batchId,
      roomId: request.roomId,
      channelId: request.channelId,
      chatChannelId: request.channelId,
      userId: request.requesterUserId,
      participantId: target.participantId,
      scope: target.scope,
      lastReadAt,
      ...(target.threadKey ? { threadKey: target.threadKey } : {})
    };
    const doc = await this.chatReadStates.findOneAndUpdate(
      { readStateKey },
      {
        $set: readStatePayload,
        ...(target.threadKey ? {} : { $unset: { threadKey: '' } })
      },
      { new: true, upsert: true }
    );
    if (!doc) {
      throw new ServiceUnavailableException('Unable to update chat read state.');
    }
    return {
      state: this.toChatReadState(doc),
      target
    };
  }

  async markChatRead(
    request: { sessionId: string; roomId: string; participantId?: string; scope?: ChatMessageScope; readAt?: string },
    user: SocketUser,
    participantId: string | undefined
  ): Promise<ChatReadDeliveryResult> {
    try {
    await this.nodeRegistry.assertLocalRoomOwner(request.roomId);
    const classSession = await this.classSessions.findOne({ _id: request.sessionId, roomId: request.roomId });
    if (!classSession) {
      throw new NotFoundException('Class session chat not found.');
    }
    await this.assertSocketCanAccessClassSessionBatch(classSession.batchId, classSession.teacherId, user);
    const participant = participantId
      ? await this.assertParticipant(request.roomId, participantId)
      : await this.findActiveParticipantByUserId(request.roomId, user.id);
    if (!participant) {
      throw new ForbiddenException('Join the classroom before updating chat read state.');
    }

    const detailed = await this.markClassSessionChatReadDetailed({
      sessionId: classSession.id,
      batchId: classSession.batchId,
      roomId: classSession.roomId,
      channelId: classSession.chatChannelId,
      teacherId: classSession.teacherId,
      requesterUserId: user.id,
      requesterRole: this.chatRequesterRole(participant, user),
      participantId: request.participantId,
      scope: request.scope,
      readAt: request.readAt
    });
    const targets = await this.chatReadReceiptTargets(classSession, participant, detailed.target);
    return {
      state: detailed.state,
      receipt: this.toChatReadReceiptEvent(detailed.state),
      ...(targets.length ? { targets, targetSocketIds: targets.map((target) => target.socketId) } : {})
    };
    } catch (error) {
      await this.recordClassSessionChatFailure(request.roomId, 'read', request.scope, error);
      throw error;
    }
  }

  async assertCanWatchClassSession(sessionId: string, user: SocketUser, batchId?: string): Promise<void> {
    const access = await this.resolveClassSessionAccessBySessionId(sessionId, batchId);
    await this.assertSocketCanAccessClassSessionBatch(access.batchId, access.teacherId, user);
  }

  async getClassSessionChatSummary(request: ClassSessionChatContext): Promise<ChatThreadSummaryResponse> {
    if (request.requesterRole === 'student') {
      const student = await this.findActiveParticipantByUserId(request.roomId, request.requesterUserId);
      if (!student || student.role !== Role.PARTICIPANT) {
        throw new ForbiddenException('Join the classroom before loading chat summary.');
      }
      const privateThreadKey = this.privateClassSessionThreadKey(request.sessionId, request.teacherId, student);
      const readStates = await this.chatReadStates.find({ sessionId: request.sessionId, userId: request.requesterUserId });
      const privateReadState = this.readStateFor(readStates, 'private', privateThreadKey);
      const broadcastReadState = this.readStateFor(readStates, 'broadcast');
      const studentThread = await this.buildChatThreadSummary({
        sessionId: request.sessionId,
        scope: 'private',
        threadKey: privateThreadKey,
        participant: student,
        readState: privateReadState,
        unreadFilter: { senderRole: { $ne: 'student' } }
      });
      const broadcast = await this.buildChatThreadSummary({
        sessionId: request.sessionId,
        scope: 'broadcast',
        readState: broadcastReadState,
        unreadFilter: { senderRole: { $ne: 'student' } }
      });
      return {
        sessionId: request.sessionId,
        roomId: request.roomId,
        threads: [studentThread, broadcast],
        studentThread,
        broadcast
      };
    }

    const activeStudents = (await this.participants.find({
      roomId: request.roomId,
      admitted: true,
      leftAt: { $exists: false },
      role: Role.PARTICIPANT
    })) as ParticipantMongoDocument[];
    const activeByUserId = new Map(activeStudents.map((student) => [this.participantChatIdentity(student), student]));
    const roster = await this.studentEnrollments.listBatchRoster(request.batchId);
    const readStates = await this.chatReadStates.find({ sessionId: request.sessionId, userId: request.requesterUserId });
    const privateThreads = await Promise.all(
      roster.map((student) => {
        const activeParticipant = activeByUserId.get(student.userId);
        const threadKey = this.privateClassSessionThreadKeyForStudentId(request.sessionId, request.teacherId, student.userId);
        return this.buildChatThreadSummary({
          sessionId: request.sessionId,
          scope: 'private',
          threadKey,
          participant: activeParticipant,
          rosterItem: student,
          readState: this.readStateFor(readStates, 'private', threadKey),
          unreadFilter: { senderRole: 'student' }
        });
      })
    );
    const broadcast = await this.buildChatThreadSummary({
      sessionId: request.sessionId,
      scope: 'broadcast',
      readState: this.readStateFor(readStates, 'broadcast'),
      unreadFilter: { senderId: '__teacher_broadcast_unread_disabled__' }
    });
    return {
      sessionId: request.sessionId,
      roomId: request.roomId,
      threads: [...privateThreads, broadcast],
      broadcast
    };
  }

  private async buildChatThreadSummary(request: {
    sessionId: string;
    scope: ChatMessageScope;
    threadKey?: string;
    participant?: ParticipantMongoDocument;
    rosterItem?: StudentEnrollmentRosterItem;
    readState?: ChatReadStateMongoDocument;
    unreadFilter: Record<string, unknown>;
  }): Promise<ChatThreadSummary> {
    const messageFilter: Record<string, unknown> = {
      deletedAt: { $exists: false },
      sessionId: request.sessionId,
      scope: request.scope
    };
    if (request.threadKey) {
      messageFilter.threadKey = request.threadKey;
    }
    const latestDocs = await this.chat.find(messageFilter).sort({ createdAt: -1 }).limit(1).exec();
    const latestMessage = latestDocs[0] ? this.toChatMessage(latestDocs[0]) : undefined;
    const unreadFilter: Record<string, unknown> = {
      ...messageFilter,
      ...request.unreadFilter
    };
    if (request.readState?.lastReadAt) {
      unreadFilter.createdAt = { $gt: request.readState.lastReadAt };
    }
    const unreadCount = await this.chat.countDocuments(unreadFilter);
    const threadParticipantId = request.participant?.id ?? request.rosterItem?.userId;
    const id = request.scope === 'broadcast' ? 'broadcast' : `private:${request.threadKey ?? threadParticipantId ?? 'unknown'}`;
    return {
      id,
      scope: request.scope,
      ...(request.participant || request.rosterItem
        ? {
            participantId: threadParticipantId,
            participantName: request.participant?.displayName ?? request.rosterItem?.displayName,
            participantRole: request.participant ? this.chatSenderRole(request.participant.role) : 'student',
            online: request.participant ? !request.participant.leftAt : false
          }
        : {}),
      ...(request.threadKey ? { threadKey: request.threadKey } : {}),
      ...(request.readState?.lastReadAt ? { lastReadAt: this.dateToIso(request.readState.lastReadAt) } : {}),
      ...(latestMessage
        ? {
            lastMessage: latestMessage,
            lastMessagePreview: latestMessage.message,
            lastMessageAt: latestMessage.createdAt
          }
        : {}),
      unreadCount
    };
  }

  private async resolveClassSessionReadTarget(request: ClassSessionChatContext): Promise<ClassSessionReadTarget> {
    const scope = request.requesterRole === 'student' ? request.scope ?? 'private' : request.scope ?? (request.participantId ? 'private' : 'broadcast');
    if (scope !== 'private' && scope !== 'broadcast') {
      throw new BadRequestException('Unsupported chat read scope.');
    }

    if (request.requesterRole === 'student') {
      const student = await this.findActiveParticipantByUserId(request.roomId, request.requesterUserId);
      if (!student || student.role !== Role.PARTICIPANT) {
        throw new ForbiddenException('Join the classroom before updating chat read state.');
      }
      if (scope === 'broadcast') {
        return { scope: 'broadcast', participantId: student.id, student };
      }
      return {
        scope: 'private',
        participantId: student.id,
        student,
        threadKey: this.privateClassSessionThreadKey(request.sessionId, request.teacherId, student)
      };
    }

    if (scope === 'broadcast') {
      if (request.participantId) {
        throw new BadRequestException('Broadcast read state does not accept a participant id.');
      }
      return { scope: 'broadcast' };
    }

    if (!request.participantId) {
      throw new BadRequestException('Student participant id is required for private read state.');
    }
    const target = await this.resolveClassSessionStudentThreadTarget({
      roomId: request.roomId,
      batchId: request.batchId,
      sessionId: request.sessionId,
      teacherId: request.teacherId,
      participantId: request.participantId
    });
    return {
      scope: 'private',
      participantId: target.participant?.id ?? target.studentId,
      ...(target.participant ? { student: target.participant } : {}),
      threadKey: target.threadKey
    };
  }

  private readStateFor(readStates: readonly ChatReadStateMongoDocument[], scope: ChatMessageScope, threadKey?: string): ChatReadStateMongoDocument | undefined {
    return readStates.find((state) => state.scope === scope && (threadKey ? state.threadKey === threadKey : !state.threadKey));
  }

  private parseChatReadAt(value: string | undefined): Date {
    const now = new Date();
    if (!value) {
      return now;
    }
    const readAt = new Date(value);
    if (Number.isNaN(readAt.getTime())) {
      throw new BadRequestException('Invalid chat read timestamp.');
    }
    if (readAt.getTime() > now.getTime()) {
      return now;
    }
    return readAt;
  }

  private async getChatHistoryByFilter(request: {
    sessionId?: string;
    filter: Record<string, unknown>;
    before?: string;
    limit?: number;
  }): Promise<ChatHistoryResponse> {
    const filter: Record<string, unknown> = {
      deletedAt: { $exists: false },
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...request.filter
    };

    if (request.before) {
      const before = new Date(request.before);
      if (Number.isNaN(before.getTime())) {
        throw new BadRequestException('Invalid chat history cursor.');
      }
      filter.createdAt = { $lt: before };
    }

    const limit = Math.min(100, Math.max(1, Math.trunc(request.limit ?? 50)));
    const docs = await this.chat.find(filter).sort({ createdAt: -1 }).limit(limit + 1).exec();
    const visibleDocs = docs.slice(0, limit);
    const messages = visibleDocs.reverse().map((doc) => this.toChatMessage(doc));
    const nextBefore = docs.length > limit ? messages[0]?.createdAt : undefined;
    return {
      messages,
      ...(nextBefore ? { nextBefore } : {})
    };
  }

  private normalizeChatAttachments(attachments: readonly SendChatAttachment[] | undefined): ChatAttachment[] {
    if (!attachments?.length) {
      return [];
    }
    if (attachments.length > CHAT_ATTACHMENT_MAX_COUNT) {
      throw new BadRequestException(`Chat messages can include up to ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`);
    }
    return attachments.map((attachment) => this.normalizeChatAttachment(attachment));
  }

  private async prepareClassSessionChatAttachments(
    classSession: ClassSessionMongoDocument,
    sender: ParticipantMongoDocument,
    delivery: ClassSessionChatDelivery,
    attachments: readonly SendChatAttachment[]
  ): Promise<PreparedChatAttachments> {
    if (!attachments.length) {
      return { attachments: [], fileAttachments: [] };
    }
    if (attachments.length > CHAT_ATTACHMENT_MAX_COUNT) {
      throw new BadRequestException(`Chat messages can include up to ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`);
    }

    const normalized: ChatAttachment[] = [];
    const fileAttachments: ChatAttachmentFileMongoDocument[] = [];
    for (const attachment of attachments) {
      if (attachment.type === 'link') {
        normalized.push(this.normalizeChatAttachment(attachment));
        continue;
      }

      if (attachment.dataUrl) {
        throw new BadRequestException('Upload file attachments before sending chat messages.');
      }
      const attachmentId = this.cleanAttachmentText(attachment.attachmentId ?? attachment.id, 120);
      if (!attachmentId) {
        throw new BadRequestException('Uploaded attachment id is required.');
      }
      const doc = await this.chatAttachments.findOne({
        attachmentId,
        sessionId: classSession.id,
        roomId: classSession.roomId,
        deletedAt: { $exists: false }
      });
      if (!doc) {
        throw new NotFoundException('Uploaded chat attachment not found.');
      }
      if (doc.scope !== 'pending' || doc.messageId) {
        throw new ConflictException('This attachment has already been sent.');
      }
      if (doc.uploadedByUserId !== this.participantChatIdentity(sender)) {
        throw new ForbiddenException('You can only send attachments you uploaded.');
      }
      if (doc.type !== attachment.type) {
        throw new BadRequestException('Attachment type does not match uploaded file.');
      }
      if (attachment.mimeType && attachment.mimeType.toLowerCase() !== doc.mimeType) {
        throw new BadRequestException('Attachment MIME type does not match uploaded file.');
      }
      normalized.push(this.toChatAttachmentFromFile(doc));
      fileAttachments.push(doc);
    }

    if (delivery.scope === 'broadcast' && !this.isTeacherChatParticipant(sender)) {
      throw new ForbiddenException('Students cannot send broadcast attachments.');
    }
    return { attachments: normalized, fileAttachments };
  }

  private async bindClassSessionChatAttachments(
    classSession: ClassSessionMongoDocument,
    message: ChatMessageMongoDocument,
    delivery: ClassSessionChatDelivery,
    attachments: readonly ChatAttachmentFileMongoDocument[]
  ): Promise<void> {
    for (const attachment of attachments) {
      const result = await this.chatAttachments.updateOne(
        {
          _id: attachment._id,
          sessionId: classSession.id,
          roomId: classSession.roomId,
          scope: 'pending',
          messageId: { $exists: false }
        },
        {
          $set: {
            scope: delivery.scope,
            messageId: message.id,
            ...(delivery.recipientId || delivery.recipient?.id ? { recipientId: delivery.recipientId ?? delivery.recipient?.id } : {}),
            ...(delivery.threadKey ? { threadKey: delivery.threadKey } : {})
          }
        }
      );
      if (result.modifiedCount !== 1) {
        throw new ConflictException('Attachment could not be attached to this message.');
      }
    }
  }

  private async releasePendingClassSessionChatAttachments(attachments: readonly ChatAttachmentFileMongoDocument[]): Promise<void> {
    const attachmentIds = attachments.map((attachment) => attachment._id).filter(Boolean);
    if (!attachmentIds.length) {
      return;
    }
    await this.chatAttachments
      .updateMany(
        {
          _id: { $in: attachmentIds },
          scope: 'pending',
          messageId: { $exists: false }
        },
        { $set: { deletedAt: new Date() } }
      )
      .catch(() => undefined);
  }

  private normalizeChatAttachment(attachment: SendChatAttachment): ChatAttachment {
    if (!attachment || (attachment.type !== 'image' && attachment.type !== 'pdf' && attachment.type !== 'link')) {
      throw new BadRequestException('Unsupported chat attachment type.');
    }

    const title = this.cleanAttachmentText(attachment.title, 180);
    const fileName = this.cleanAttachmentText(attachment.fileName, 180);
    const mimeType = this.cleanAttachmentText(attachment.mimeType, 120)?.toLowerCase();
    const createdAt = new Date().toISOString();

    if (attachment.type === 'link') {
      const url = this.normalizeAttachmentUrl(attachment.url);
      return {
        id: randomUUID(),
        type: 'link',
        title: title || url,
        url,
        createdAt
      };
    }

    const expectedMimeType = attachment.type === 'pdf' ? 'application/pdf' : mimeType;
    if (!expectedMimeType || !CHAT_ATTACHMENT_FILE_MIME_TYPES.has(expectedMimeType)) {
      throw new BadRequestException('Only PDF and common image attachments are allowed.');
    }
    if (attachment.type === 'image' && !CHAT_ATTACHMENT_IMAGE_MIME_TYPES.has(expectedMimeType)) {
      throw new BadRequestException('Only JPEG, PNG, GIF, and WebP image attachments are allowed.');
    }
    if (attachment.type === 'pdf' && expectedMimeType !== 'application/pdf') {
      throw new BadRequestException('PDF attachments must use application/pdf.');
    }

    const dataUrl = attachment.dataUrl ? this.normalizeAttachmentDataUrl(attachment.dataUrl, expectedMimeType) : undefined;
    const url = attachment.url ? this.normalizeAttachmentUrl(attachment.url) : undefined;
    if (!dataUrl && !url) {
      throw new BadRequestException('File attachments require a data URL or safe URL.');
    }

    const size = dataUrl ? this.byteLengthFromDataUrl(dataUrl) : Math.max(0, Math.trunc(attachment.size ?? 0));
    if (size > CHAT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw new BadRequestException('Chat attachments cannot exceed 2 MB.');
    }

    return {
      id: randomUUID(),
      type: attachment.type,
      ...(fileName ? { fileName } : {}),
      ...(title ? { title } : {}),
      mimeType: expectedMimeType,
      size,
      ...(url ? { url } : {}),
      ...(dataUrl ? { dataUrl } : {}),
      createdAt
    };
  }

  private cleanAttachmentText(value: string | undefined, maxLength: number): string {
    return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  }

  private normalizeAttachmentUrl(value: string | undefined): string {
    const raw = value?.trim();
    if (!raw) {
      throw new BadRequestException('Attachment URL is required.');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('Attachment URL is invalid.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('Attachment URLs must use http or https.');
    }
    return url.toString();
  }

  private normalizeAttachmentDataUrl(value: string, expectedMimeType: string): string {
    const trimmed = value.trim();
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(trimmed);
    if (!match) {
      throw new BadRequestException('Attachment data URL is invalid.');
    }
    const mimeType = match[1]?.toLowerCase();
    if (mimeType !== expectedMimeType) {
      throw new BadRequestException('Attachment data URL type does not match attachment metadata.');
    }
    if (this.byteLengthFromDataUrl(trimmed) > CHAT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw new BadRequestException('Chat attachments cannot exceed 2 MB.');
    }
    return trimmed;
  }

  private byteLengthFromDataUrl(value: string): number {
    const base64 = value.split(',', 2)[1] ?? '';
    return Buffer.byteLength(base64, 'base64');
  }

  private normalizeUploadedChatAttachmentMimeType(value: string | undefined): string {
    const mimeType = value?.trim().toLowerCase();
    if (!mimeType || !CHAT_ATTACHMENT_FILE_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException('Only PDF, JPEG, PNG, GIF, and WebP attachments are allowed.');
    }
    return mimeType;
  }

  private chatAttachmentTypeForMimeType(mimeType: string): 'image' | 'pdf' {
    return mimeType === 'application/pdf' ? 'pdf' : 'image';
  }

  private chatAttachmentMaxFileSizeBytes(): number {
    return this.config.get<number>('chatAttachments.maxFileSizeBytes', CHAT_ATTACHMENT_MAX_SIZE_BYTES);
  }

  private chatAttachmentStorageRoot(): string {
    return this.config.get<string>('chatAttachments.localPath', './chat-attachments');
  }

  private safeStorageSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'chat';
  }

  private safeAttachmentFileName(value: string | undefined, type: 'image' | 'pdf'): string {
    const fallback = type === 'pdf' ? 'attachment.pdf' : 'attachment';
    const cleaned = this.cleanAttachmentText(value ?? fallback, 180)
      .replace(/[\\/]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+/, '')
      .trim();
    return cleaned || fallback;
  }

  private toChatAttachmentFromFile(doc: ChatAttachmentFileMongoDocument): ChatAttachment {
    return {
      id: doc.attachmentId,
      attachmentId: doc.attachmentId,
      type: doc.type,
      fileName: doc.fileName,
      title: doc.title || doc.fileName,
      mimeType: doc.mimeType,
      size: doc.size,
      storageProvider: doc.storageProvider,
      downloadUrl: this.classSessionChatAttachmentDownloadUrl(doc.sessionId, doc.attachmentId),
      createdAt: this.dateToIso(doc.createdAt)
    };
  }

  private classSessionChatAttachmentDownloadUrl(sessionId: string, attachmentId: string): string {
    return `/api/v1/class-sessions/${encodeURIComponent(sessionId)}/chat/attachments/${encodeURIComponent(attachmentId)}`;
  }

  private canReadClassSessionChatAttachment(
    doc: ChatAttachmentFileMongoDocument,
    request: {
      sessionId: string;
      teacherId: string;
      requesterUserId: string;
      requesterRole: 'teacher' | 'student' | 'admin';
    }
  ): boolean {
    if (request.requesterRole === 'teacher' || request.requesterRole === 'admin') {
      return true;
    }
    if (doc.uploadedByUserId === request.requesterUserId) {
      return true;
    }
    if (doc.scope === 'broadcast') {
      return true;
    }
    if (doc.scope !== 'private' || !doc.threadKey) {
      return false;
    }
    return doc.threadKey === this.privateClassSessionThreadKeyForStudentId(request.sessionId, request.teacherId, request.requesterUserId);
  }

  private async resolveClassSessionChatDelivery(
    classSession: ClassSessionMongoDocument,
    sender: ParticipantMongoDocument,
    request: { roomId: string; recipientId?: string; scope?: ChatMessageScope }
  ): Promise<ClassSessionChatDelivery> {
    if (request.scope && request.scope !== 'private' && request.scope !== 'broadcast') {
      throw new BadRequestException('Unsupported chat message scope.');
    }

    if (!this.isTeacherChatParticipant(sender)) {
      const teacher = await this.findClassSessionTeacherParticipant(classSession);
      return {
        scope: 'private',
        recipient: teacher,
        recipientId: teacher.id,
        threadKey: this.privateClassSessionThreadKey(classSession.id, classSession.teacherId, sender),
        targets: await this.participantSocketTargets(classSession.roomId, [sender, teacher])
      };
    }

    const scope = request.scope ?? (request.recipientId ? 'private' : undefined);
    if (!scope) {
      throw new BadRequestException('Teacher chat messages must choose private or broadcast scope.');
    }

    if (scope === 'broadcast') {
      if (request.recipientId) {
        throw new BadRequestException('Broadcast chat messages cannot include a recipient.');
      }
      return {
        scope: 'broadcast',
        broadcastRoomId: request.roomId
      };
    }

    if (!request.recipientId) {
      throw new BadRequestException('A student recipient is required for private teacher chat.');
    }
    const target = await this.resolveClassSessionStudentThreadTarget({
      roomId: classSession.roomId,
      batchId: classSession.batchId,
      sessionId: classSession.id,
      teacherId: classSession.teacherId,
      participantId: request.recipientId
    });
    const recipients = target.participant ? [sender, target.participant] : [sender];

    return {
      scope: 'private',
      ...(target.participant ? { recipient: target.participant } : {}),
      recipientId: target.participant?.id ?? target.studentId,
      threadKey: target.threadKey,
      targets: await this.participantSocketTargets(classSession.roomId, recipients)
    };
  }

  private chatDeliveryState(delivery: ClassSessionChatDelivery): ChatDeliveryState {
    if (delivery.broadcastRoomId) {
      return 'delivered';
    }
    if (!delivery.recipient) {
      return 'sent';
    }
    const recipientIds = new Set([delivery.recipient.id, delivery.recipient.userId].filter((value): value is string => Boolean(value)));
    const reachedRecipient = delivery.targets?.some((target) => recipientIds.has(target.participantId) || Boolean(target.userId && recipientIds.has(target.userId))) ?? false;
    return reachedRecipient ? 'delivered' : 'sent';
  }

  private async findClassSessionTeacherParticipant(classSession: Pick<ClassSessionMongoDocument, 'roomId' | 'teacherId'>): Promise<ParticipantMongoDocument> {
    const baseFilter = {
      roomId: classSession.roomId,
      admitted: true,
      leftAt: { $exists: false },
      role: { $in: [Role.HOST, Role.CO_HOST] }
    };
    const scheduledTeacher = classSession.teacherId
      ? await this.participants.findOne({
          ...baseFilter,
          userId: classSession.teacherId
        })
      : null;
    if (scheduledTeacher) {
      return scheduledTeacher;
    }

    const activeTeacher = await this.participants.findOne(baseFilter);
    if (!activeTeacher) {
      throw new ConflictException('The teacher is not connected to chat yet.');
    }
    return activeTeacher;
  }

  private async findActiveParticipantByUserId(roomId: string, userId: string): Promise<ParticipantMongoDocument | null> {
    return this.participants.findOne({
      roomId,
      userId,
      admitted: true,
      leftAt: { $exists: false }
    });
  }

  private async resolveClassSessionStudentThreadTarget(request: {
    roomId: string;
    batchId: string;
    sessionId: string;
    teacherId: string;
    participantId: string;
  }): Promise<{ studentId: string; threadKey: string; participant?: ParticipantMongoDocument; rosterItem?: StudentEnrollmentRosterItem }> {
    const participant = await this.participants.findOne({
      roomId: request.roomId,
      admitted: true,
      leftAt: { $exists: false },
      role: Role.PARTICIPANT,
      $or: [{ _id: request.participantId }, { userId: request.participantId }]
    });
    if (participant) {
      const studentId = this.participantChatIdentity(participant);
      if (!(await this.studentEnrollments.isStudentEnrolledInBatch(studentId, request.batchId))) {
        throw new BadRequestException('Target student is not enrolled in this class session.');
      }
      return {
        studentId,
        participant,
        threadKey: this.privateClassSessionThreadKeyForStudentId(request.sessionId, request.teacherId, studentId)
      };
    }

    const roster = await this.studentEnrollments.listBatchRoster(request.batchId);
    const rosterItem = roster.find((student) => student.userId === request.participantId || student.id === request.participantId || student.enrollmentId === request.participantId);
    if (!rosterItem) {
      throw new BadRequestException('Target student is not enrolled in this class session.');
    }
    const activeParticipant = await this.findActiveParticipantByUserId(request.roomId, rosterItem.userId);
    if (activeParticipant?.role === Role.PARTICIPANT) {
      return {
        studentId: rosterItem.userId,
        participant: activeParticipant,
        rosterItem,
        threadKey: this.privateClassSessionThreadKeyForStudentId(request.sessionId, request.teacherId, rosterItem.userId)
      };
    }
    return {
      studentId: rosterItem.userId,
      rosterItem,
      threadKey: this.privateClassSessionThreadKeyForStudentId(request.sessionId, request.teacherId, rosterItem.userId)
    };
  }

  private async chatReadReceiptTargets(
    classSession: ClassSessionMongoDocument,
    reader: ParticipantMongoDocument,
    target: ClassSessionReadTarget
  ): Promise<SocketDeliveryTarget[]> {
    const participants: ParticipantMongoDocument[] = [reader];
    if (target.scope === 'private') {
      if (this.isTeacherChatParticipant(reader)) {
        if (target.student) {
          participants.push(target.student);
        }
      } else {
        const teacher = await this.findClassSessionTeacherParticipantForReceipt(classSession);
        if (teacher) {
          participants.push(teacher);
        }
      }
    } else if (!this.isTeacherChatParticipant(reader)) {
      const teacher = await this.findClassSessionTeacherParticipantForReceipt(classSession);
      if (teacher) {
        participants.push(teacher);
      }
    }
    return this.participantSocketTargets(classSession.roomId, participants);
  }

  private async findClassSessionTeacherParticipantForReceipt(classSession: ClassSessionMongoDocument): Promise<ParticipantMongoDocument | null> {
    try {
      return await this.findClassSessionTeacherParticipant(classSession);
    } catch (error) {
      if (error instanceof ConflictException) {
        return null;
      }
      throw error;
    }
  }

  private privateClassSessionThreadKey(sessionId: string, teacherId: string | undefined, student: ParticipantMongoDocument): string {
    return this.privateClassSessionThreadKeyForStudentId(sessionId, teacherId, this.participantChatIdentity(student));
  }

  private privateClassSessionThreadKeyForStudentId(sessionId: string, teacherId: string | undefined, studentId: string): string {
    const teacherKey = teacherId?.trim() || 'teacher';
    const studentKey = studentId.trim();
    return `${sessionId}:teacher:${teacherKey}:student:${studentKey}`;
  }

  private participantChatIdentity(participant: ParticipantMongoDocument): string {
    return participant.userId?.trim() || participant.id;
  }

  private classSessionAttendanceRow(
    studentId: string,
    displayName: string,
    email: string,
    participants: readonly ParticipantMongoDocument[],
    fallbackLeaveAt: Date,
    metadata: {
      enrolledAt?: Date;
      rosterSource?: 'roster' | 'participant';
      presentThresholdMinutes?: number;
      presentThresholdPercentage?: number;
      sessionDurationMinutes?: number;
      countReconnects?: boolean;
    } = {}
  ): ClassSessionAttendanceRow {
    const sorted = [...participants].sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime());
    const firstJoinAt = sorted[0]?.joinedAt;
    const lastLeaveAt = [...sorted].reverse().find((participant) => participant.leftAt)?.leftAt;
    const totalMs = sorted.reduce((total, participant) => {
      const leaveAt = participant.leftAt ?? fallbackLeaveAt;
        return total + Math.max(0, leaveAt.getTime() - participant.joinedAt.getTime());
      }, 0);
    return {
      studentId,
      displayName: displayName || 'Student',
      email,
      ...(metadata.enrolledAt ? { enrolledAt: metadata.enrolledAt } : {}),
      rosterSource: metadata.rosterSource ?? 'roster',
      ...(firstJoinAt ? { firstJoinAt } : {}),
      ...(lastLeaveAt ? { lastLeaveAt } : {}),
      totalDurationSeconds: Math.round(totalMs / 1000),
      reconnectCount: metadata.countReconnects === false ? 0 : Math.max(0, sorted.length - 1),
      status: this.attendancePresent(totalMs, metadata) ? 'present' : 'absent'
    };
  }

  private attendancePresent(
    totalMs: number,
    metadata: { presentThresholdMinutes?: number; presentThresholdPercentage?: number; sessionDurationMinutes?: number }
  ): boolean {
    if (totalMs <= 0) {
      return false;
    }
    const minuteThresholdMs = Math.max(0, metadata.presentThresholdMinutes ?? 0) * 60_000;
    const percent = Math.max(0, Math.min(100, metadata.presentThresholdPercentage ?? 0));
    const durationThresholdMs = Math.max(0, metadata.sessionDurationMinutes ?? 0) * 60_000 * (percent / 100);
    const requiredMs = Math.max(minuteThresholdMs, durationThresholdMs);
    return requiredMs <= 0 ? totalMs > 0 : totalMs >= requiredMs;
  }

  private formatAttendanceDuration(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  private csvEscape(value: string): string {
    if (!/[",\n\r]/.test(value)) {
      return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
  }

  private async participantSocketTargets(roomId: string, participants: readonly ParticipantMongoDocument[]): Promise<SocketDeliveryTarget[]> {
    const participantIds = participants.map((participant) => participant.id);
    const presence = await this.redis.participantsPresence(roomId, participantIds);
    const targets = new Map<string, SocketDeliveryTarget>();
    for (const entry of presence) {
      targets.set(entry.socketId, this.presenceToSocketTarget(entry));
    }
    for (const participant of participants) {
      if (participant.socketId && !targets.has(participant.socketId)) {
        targets.set(participant.socketId, {
          roomId,
          participantId: participant.id,
          socketId: participant.socketId,
          ...(participant.userId ? { userId: participant.userId } : {}),
          ...(participant.nodeId ? { nodeId: participant.nodeId } : {})
        });
      }
    }
    return [...targets.values()];
  }

  private presenceToSocketTarget(entry: RoomSocketPresence): SocketDeliveryTarget {
    return {
      roomId: entry.roomId,
      participantId: entry.participantId,
      socketId: entry.socketId,
      ...(entry.userId ? { userId: entry.userId } : {}),
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {})
    };
  }

  private async whiteboardControlTargets(roomId: string, student?: ParticipantMongoDocument): Promise<SocketDeliveryTarget[]> {
    const participants = new Map<string, ParticipantMongoDocument>();
    for (const moderator of await this.whiteboardActiveModerators(roomId)) {
      participants.set(moderator.id, moderator);
    }
    if (student) {
      participants.set(student.id, student);
    }
    return this.participantSocketTargets(roomId, [...participants.values()]);
  }

  private async whiteboardRevokeDelivery(
    roomId: string,
    state: WhiteboardControlState,
    classSession?: Pick<ClassSessionMongoDocument, 'id' | 'batchId'>,
    revokedByParticipantId?: string,
    reason = 'Whiteboard control revoked.'
  ): Promise<{ event: WhiteboardControlEvent; targets: SocketDeliveryTarget[] }> {
    const participant = await this.activeParticipantForWhiteboardState(roomId, state);
    const event: WhiteboardControlEvent = {
      ...(classSession ? { sessionId: classSession.id, batchId: classSession.batchId } : {}),
      roomId,
      participantId: participant?.id ?? state.participantId,
      displayName: participant?.displayName ?? state.displayName,
      granted: false,
      permissionLevel: 'view_only',
      ...(state.pageId ? { pageId: state.pageId } : {}),
      ...(revokedByParticipantId ? { revokedByParticipantId } : {}),
      reason,
      message: reason
    };
    return {
      event,
      targets: await this.whiteboardControlTargets(roomId, participant ?? undefined)
    };
  }

  private whiteboardLockEvent(
    classSession: Pick<ClassSessionMongoDocument, 'id' | 'batchId'>,
    state: WhiteboardLockState
  ): WhiteboardLockEvent {
    return {
      sessionId: classSession.id,
      batchId: classSession.batchId,
      roomId: state.roomId,
      locked: state.locked,
      changedAt: state.changedAt.toISOString(),
      ...(state.locked
        ? {
            lockedByParticipantId: state.changedByParticipantId,
            message: 'Teacher locked the whiteboard.'
          }
        : {
            unlockedByParticipantId: state.changedByParticipantId,
            message: 'Teacher unlocked the whiteboard.'
          })
    };
  }

  private normalizeWhiteboardPermissionLevel(permissionLevel?: WhiteboardPermissionLevel): WhiteboardPermissionLevel {
    if (!permissionLevel) {
      return DEFAULT_WHITEBOARD_PERMISSION_LEVEL;
    }
    if (!WHITEBOARD_PERMISSION_LEVELS.includes(permissionLevel)) {
      throw new BadRequestException('Whiteboard permission level is invalid.');
    }
    return permissionLevel;
  }

  private normalizeWhiteboardPageId(pageId: unknown): string | undefined {
    if (pageId === undefined || pageId === null || pageId === '') {
      return undefined;
    }
    if (typeof pageId !== 'string') {
      throw new BadRequestException('Whiteboard page is invalid.');
    }
    const normalized = pageId.trim();
    if (!normalized || normalized.length > 128) {
      throw new BadRequestException('Whiteboard page is invalid.');
    }
    return normalized;
  }

  private assertStudentWhiteboardCommandAllowed(state: WhiteboardControlState, command?: WhiteboardCommand): void {
    if (state.permissionLevel === 'view_only') {
      throw new ForbiddenException('Teacher has not allowed editing on the whiteboard.');
    }
    if (this.whiteboardLockByRoomId.get(state.roomId)?.locked) {
      throw new ForbiddenException('Teacher locked the whiteboard.');
    }
    if (!command) {
      return;
    }

    let commandSize = 0;
    try {
      commandSize = Buffer.byteLength(JSON.stringify(command), 'utf8');
    } catch {
      throw new BadRequestException('Whiteboard command is invalid.');
    }
    if (commandSize > MAX_STUDENT_WHITEBOARD_COMMAND_BYTES) {
      throw new BadRequestException('Whiteboard command is too large.');
    }

    const commandPageId = this.normalizeWhiteboardPageId(command.pageId);
    if (state.pageId && commandPageId !== state.pageId) {
      throw new ForbiddenException('Whiteboard control is limited to the current page.');
    }

    if (command.type === 'clear') {
      throw new ForbiddenException('Students cannot clear the class whiteboard.');
    }
    if (command.type === 'delete') {
      if (state.permissionLevel !== 'current_page_edit') {
        throw new ForbiddenException('Teacher has not allowed deleting whiteboard objects.');
      }
      return;
    }
    if (command.type !== 'upsert') {
      throw new BadRequestException('Whiteboard command type is invalid.');
    }

    const elementType = typeof command.element?.type === 'string' ? command.element.type : '';
    if (!elementType || elementType === 'file' || elementType === 'asset' || elementType === 'document') {
      throw new ForbiddenException('Students cannot import or attach whiteboard assets.');
    }
    if (state.permissionLevel === 'draw' && !DRAW_ONLY_WHITEBOARD_ELEMENT_TYPES.has(elementType)) {
      throw new ForbiddenException('Teacher only allowed drawing strokes.');
    }
    if (state.permissionLevel !== 'draw' && !ANNOTATION_WHITEBOARD_ELEMENT_TYPES.has(elementType)) {
      throw new ForbiddenException('Whiteboard object type is not allowed for student control.');
    }
  }

  private async assertWhiteboardCommandParticipant(roomId: string, actorParticipantId: string, command?: WhiteboardCommand): Promise<ParticipantMongoDocument> {
    const actor = await this.assertParticipant(roomId, actorParticipantId);
    if (actor.role === Role.HOST || actor.role === Role.CO_HOST) {
      return actor;
    }
    if (actor.role !== Role.PARTICIPANT) {
      throw new ForbiddenException('Whiteboard control is not available for this participant.');
    }
    const state = this.whiteboardControlByRoomId.get(roomId);
    if (!state || (state.participantId !== actor.id && state.userId !== actor.userId)) {
      throw new ForbiddenException('Teacher has not allowed you to control the whiteboard.');
    }
    if (state.participantId !== actor.id) {
      this.whiteboardControlByRoomId.set(roomId, { ...state, participantId: actor.id, displayName: actor.displayName });
    }
    this.assertStudentWhiteboardCommandAllowed(state, command);
    return actor;
  }

  private async whiteboardRealtimeTargets(roomId: string, actor: ParticipantMongoDocument): Promise<SocketDeliveryTarget[]> {
    const participants = new Map<string, ParticipantMongoDocument>();
    for (const moderator of await this.whiteboardActiveModerators(roomId)) {
      participants.set(moderator.id, moderator);
    }
    const state = this.whiteboardControlByRoomId.get(roomId);
    if (state) {
      const student = await this.activeParticipantForWhiteboardState(roomId, state);
      if (student) {
        participants.set(student.id, student);
      }
    }
    participants.set(actor.id, actor);
    return this.participantSocketTargets(roomId, [...participants.values()]);
  }

  private async whiteboardActiveModerators(roomId: string): Promise<ParticipantMongoDocument[]> {
    return this.participants.find({
      roomId,
      role: { $in: [Role.HOST, Role.CO_HOST] },
      admitted: true,
      leftAt: { $exists: false }
    }).exec();
  }

  private activeParticipantForWhiteboardState(
    roomId: string,
    state: WhiteboardControlState
  ): Promise<ParticipantMongoDocument | null> {
    return this.participants.findOne({
      roomId,
      userId: state.userId,
      role: Role.PARTICIPANT,
      admitted: true,
      leftAt: { $exists: false }
    }).exec();
  }

  private async activeWhiteboardControllerParticipant(roomId: string): Promise<ParticipantMongoDocument | undefined> {
    const state = this.whiteboardControlByRoomId.get(roomId);
    if (!state) {
      return undefined;
    }
    return (await this.activeParticipantForWhiteboardState(roomId, state)) ?? undefined;
  }

  private normalizeWhiteboardCommand(command: WhiteboardCommand): WhiteboardCommand {
    if (!command || typeof command !== 'object') {
      throw new BadRequestException('Whiteboard command is invalid.');
    }
    const pageId = this.normalizeWhiteboardPageId(command.pageId);
    if (command.type === 'clear') {
      return { type: 'clear', ...(pageId ? { pageId } : {}) };
    }
    if (command.type === 'delete') {
      if (!command.elementId || typeof command.elementId !== 'string') {
        throw new BadRequestException('Whiteboard delete command is invalid.');
      }
      return { type: 'delete', elementId: command.elementId, ...(pageId ? { pageId } : {}) };
    }
    if (command.type === 'upsert') {
      if (!command.element || typeof command.element !== 'object' || typeof command.element.id !== 'string') {
        throw new BadRequestException('Whiteboard upsert command is invalid.');
      }
      return { type: 'upsert', element: command.element, ...(pageId ? { pageId } : {}) };
    }
    throw new BadRequestException('Whiteboard command type is invalid.');
  }

  private isTeacherChatParticipant(participant: ParticipantMongoDocument): boolean {
    return participant.role === Role.HOST || participant.role === Role.CO_HOST;
  }

  async raiseHand(roomId: string, participantId: string, raised: boolean): Promise<ParticipantPatch> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.classSessions.findOne({ roomId });
    if (!classSession) {
      throw new NotFoundException('Class session room not found');
    }
    this.assertClassSessionRoomIsLive(classSession);
    if (!this.classSessionLiveSettings(classSession).speaking.handRaiseEnabled) {
      throw new ForbiddenException('Hand raise is disabled for this class.');
    }
    const participant = await this.assertParticipant(roomId, participantId);
    if (participant.role !== Role.PARTICIPANT) {
      throw new ForbiddenException('Only students can raise their hand.');
    }
    if (raised) {
      const handRaisedAt = new Date();
      await this.participants.updateOne(
        { _id: participantId, roomId },
        { $set: { handRaised: true, handRaisedAt } }
      );
      return { handRaised: true, handRaisedAt: handRaisedAt.toISOString() };
    }
    await this.participants.updateOne(
      { _id: participantId, roomId },
      { $set: { handRaised: false }, $unset: { handRaisedAt: '' } }
    );
    return { handRaised: false, handRaisedAt: null };
  }

  async lowerStudentHand(roomId: string, actorParticipantId: string, targetParticipantId: string): Promise<ParticipantPatch> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.classSessions.findOne({ roomId });
    if (!classSession) {
      throw new NotFoundException('Class session room not found');
    }
    this.assertClassSessionRoomIsLive(classSession);
    await this.assertModerator(roomId, actorParticipantId, false);
    const target = await this.assertParticipant(roomId, targetParticipantId);
    if (target.role !== Role.PARTICIPANT) {
      throw new ForbiddenException('Only student hand state can be moderated.');
    }
    await this.participants.updateOne(
      { _id: targetParticipantId, roomId },
      { $set: { handRaised: false }, $unset: { handRaisedAt: '' } }
    );
    return { handRaised: false, handRaisedAt: null };
  }

  async grantWhiteboardControl(
    roomId: string,
    actorParticipantId: string,
    targetParticipantId: string,
    permissionLevel?: WhiteboardPermissionLevel,
    pageId?: string
  ): Promise<WhiteboardControlDelivery> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.requireLiveClassSessionForRoom(roomId);
    if (!this.classSessionLiveSettings(classSession).whiteboard.studentWhiteboardControlEnabled) {
      throw new ForbiddenException('Student whiteboard control is disabled for this class.');
    }
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const target = await this.assertParticipant(roomId, targetParticipantId);
    if (target.role !== Role.PARTICIPANT) {
      throw new ForbiddenException('Only students can control the class whiteboard.');
    }
    if (!target.userId) {
      throw new ForbiddenException('Student identity is required for whiteboard control.');
    }

    const normalizedPermissionLevel = this.normalizeWhiteboardPermissionLevel(permissionLevel);
    const normalizedPageId = this.normalizeWhiteboardPageId(pageId);
    const previous = this.whiteboardControlByRoomId.get(roomId);
    const nextState: WhiteboardControlState = {
      roomId,
      participantId: target.id,
      userId: target.userId,
      displayName: target.displayName,
      permissionLevel: normalizedPermissionLevel,
      ...(normalizedPageId ? { pageId: normalizedPageId } : {}),
      grantedByParticipantId: actor.id,
      grantedAt: new Date()
    };
    this.whiteboardControlByRoomId.set(roomId, nextState);

    const event: WhiteboardControlEvent = {
      sessionId: classSession.id,
      batchId: classSession.batchId,
      roomId,
      participantId: target.id,
      displayName: target.displayName,
      granted: true,
      permissionLevel: normalizedPermissionLevel,
      ...(normalizedPageId ? { pageId: normalizedPageId } : {}),
      grantedAt: nextState.grantedAt.toISOString(),
      grantedByParticipantId: actor.id,
      message: 'Teacher allowed you to use the whiteboard.'
    };
    const targets = await this.whiteboardControlTargets(roomId, target);
    const revoked =
      previous && previous.participantId !== target.id
        ? await this.whiteboardRevokeDelivery(roomId, previous, classSession, actor.id, 'Teacher moved whiteboard control to another student.')
        : undefined;
    if (revoked && previous) {
      await this.recordClassSessionWhiteboardAudit(classSession, actor, 'revoke', {
        participantId: previous.participantId,
        userId: previous.userId,
        displayName: previous.displayName
      });
    }
    await this.recordClassSessionWhiteboardAudit(classSession, actor, 'grant', target);
    return {
      event,
      targets,
      ...(revoked ? { revoked } : {})
    };
  }

  async revokeWhiteboardControl(roomId: string, actorParticipantId: string, targetParticipantId?: string): Promise<WhiteboardControlDelivery> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.requireLiveClassSessionForRoom(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const state = this.whiteboardControlByRoomId.get(roomId);
    const participantId = targetParticipantId ?? state?.participantId;
    if (!state || !participantId || (state.participantId !== participantId && state.userId !== (await this.participants.findById(participantId))?.userId)) {
      throw new ConflictException('No matching student has whiteboard control.');
    }
    this.whiteboardControlByRoomId.delete(roomId);
    const delivery = await this.whiteboardRevokeDelivery(roomId, state, classSession, actor.id, 'Teacher revoked whiteboard control.');
    await this.recordClassSessionWhiteboardAudit(classSession, actor, 'revoke', {
      participantId: state.participantId,
      userId: state.userId,
      displayName: state.displayName
    });
    return {
      event: delivery.event,
      targets: delivery.targets
    };
  }

  async setWhiteboardLock(roomId: string, actorParticipantId: string, locked: boolean): Promise<WhiteboardRealtimeDelivery<WhiteboardLockEvent>> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    const classSession = await this.requireLiveClassSessionForRoom(roomId);
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const changedAt = new Date();
    const state: WhiteboardLockState = {
      roomId,
      locked,
      changedAt,
      changedByParticipantId: actor.id
    };
    if (locked) {
      this.whiteboardLockByRoomId.set(roomId, state);
    } else {
      this.whiteboardLockByRoomId.delete(roomId);
    }
    await this.recordClassSessionWhiteboardAudit(classSession, actor, locked ? 'lock' : 'unlock', {
      participantId: actor.id,
      userId: actor.userId,
      displayName: actor.displayName
    });
    return {
      event: this.whiteboardLockEvent(classSession, state),
      targets: await this.whiteboardControlTargets(roomId, await this.activeWhiteboardControllerParticipant(roomId))
    };
  }

  async sendWhiteboardCommand(roomId: string, actorParticipantId: string, command: WhiteboardCommand): Promise<WhiteboardRealtimeDelivery<WhiteboardCommandEvent>> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.requireLiveClassSessionForRoom(roomId);
    const normalizedCommand = this.normalizeWhiteboardCommand(command);
    const actor = await this.assertWhiteboardCommandParticipant(roomId, actorParticipantId, normalizedCommand);
    const event: WhiteboardCommandEvent = {
      roomId,
      participantId: actor.id,
      displayName: actor.displayName,
      command: normalizedCommand
    };
    return {
      event,
      targets: await this.whiteboardRealtimeTargets(roomId, actor)
    };
  }

  async sendWhiteboardCursor(
    roomId: string,
    actorParticipantId: string,
    cursor: Pick<WhiteboardCursor, 'position'> & Partial<Pick<WhiteboardCursor, 'color'>>
  ): Promise<WhiteboardRealtimeDelivery<WhiteboardCursorEvent>> {
    await this.nodeRegistry.assertLocalRoomOwner(roomId);
    await this.requireLiveClassSessionForRoom(roomId);
    const actor = await this.assertWhiteboardCommandParticipant(roomId, actorParticipantId);
    const position = cursor.position;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new BadRequestException('Whiteboard cursor position is invalid.');
    }
    const color = typeof cursor.color === 'string' && cursor.color.trim().length <= 64 ? cursor.color.trim() : '#F26076';
    const event: WhiteboardCursorEvent = {
      roomId,
      cursor: {
        participantId: actor.id,
        displayName: actor.displayName,
        color,
        position: { x: position.x, y: position.y }
      }
    };
    return {
      event,
      targets: await this.whiteboardRealtimeTargets(roomId, actor)
    };
  }

  async whiteboardControlForParticipant(roomId: string, participantId: string): Promise<WhiteboardControlDelivery | undefined> {
    const state = this.whiteboardControlByRoomId.get(roomId);
    if (!state) {
      return undefined;
    }
    const participant = await this.participants.findOne({ _id: participantId, roomId, admitted: true, leftAt: { $exists: false } });
    if (!participant || participant.role !== Role.PARTICIPANT || participant.userId !== state.userId) {
      return undefined;
    }
    let classSession: ClassSessionMongoDocument;
    try {
      classSession = await this.requireLiveClassSessionForRoom(roomId);
    } catch {
      this.whiteboardControlByRoomId.delete(roomId);
      return undefined;
    }
    if (state.participantId !== participant.id) {
      this.whiteboardControlByRoomId.set(roomId, { ...state, participantId: participant.id, displayName: participant.displayName });
    }
    return {
      event: {
        sessionId: classSession.id,
        batchId: classSession.batchId,
        roomId,
        participantId: participant.id,
        displayName: participant.displayName,
        granted: true,
        permissionLevel: state.permissionLevel,
        ...(state.pageId ? { pageId: state.pageId } : {}),
        grantedAt: state.grantedAt.toISOString(),
        grantedByParticipantId: state.grantedByParticipantId,
        message: 'Whiteboard control restored.'
      },
      targets: await this.participantSocketTargets(roomId, [participant])
    };
  }

  async whiteboardLockForParticipant(roomId: string, participantId: string): Promise<WhiteboardRealtimeDelivery<WhiteboardLockEvent> | undefined> {
    const state = this.whiteboardLockByRoomId.get(roomId);
    if (!state?.locked) {
      return undefined;
    }
    const participant = await this.participants.findOne({ _id: participantId, roomId, admitted: true, leftAt: { $exists: false } });
    if (!participant) {
      return undefined;
    }
    try {
      const classSession = await this.requireLiveClassSessionForRoom(roomId);
      return {
        event: this.whiteboardLockEvent(classSession, state),
        targets: await this.participantSocketTargets(roomId, [participant])
      };
    } catch {
      this.whiteboardLockByRoomId.delete(roomId);
      return undefined;
    }
  }

  async setStudentSpeakingPermission(
    roomId: string,
    actorParticipantId: string,
    targetParticipantId: string,
    allowedToSpeak: boolean
  ): Promise<ClassStudentSpeakResult> {
    const moderation = await this.moderateStudentMedia(
      roomId,
      actorParticipantId,
      targetParticipantId,
      allowedToSpeak ? 'unmute-mic' : 'mute-mic'
    );
    const now = new Date();
    const participantPatch: ParticipantPatch = allowedToSpeak
      ? {
          handRaised: false,
          handRaisedAt: null,
          allowedToSpeak: true,
          allowedToSpeakAt: now.toISOString(),
          allowedToSpeakBy: moderation.event.moderatedByParticipantId
        }
      : {
          allowedToSpeak: false,
          allowedToSpeakAt: null,
          allowedToSpeakBy: null
        };
    const update = allowedToSpeak
      ? {
          $set: {
            handRaised: false,
            allowedToSpeak: true,
            allowedToSpeakAt: now,
            allowedToSpeakBy: moderation.event.moderatedByParticipantId
          },
          $unset: { handRaisedAt: '' }
        }
      : {
          $set: { allowedToSpeak: false },
          $unset: { allowedToSpeakAt: '', allowedToSpeakBy: '' }
        };
    await this.participants.updateOne({ _id: targetParticipantId, roomId }, update);
    return {
      event: {
        roomId,
        participantId: targetParticipantId,
        allowedToSpeak,
        ...(allowedToSpeak ? { allowedToSpeakAt: now.toISOString(), allowedToSpeakBy: moderation.event.moderatedByParticipantId } : {}),
        moderatedByParticipantId: moderation.event.moderatedByParticipantId,
        permissions: moderation.permissions,
        message: allowedToSpeak
          ? 'Teacher allowed you to speak. Turn on your microphone when you are ready.'
          : 'Teacher revoked your speaking permission and muted your microphone.'
      },
      participantPatch,
      moderation
    };
  }

  async lookupRoomOwner(roomId: string): Promise<RoomOwnerLookupResponse> {
    const room = await this.rooms.findById(roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException('Room not found');
    }
    return this.nodeRegistry.lookupRoomOwner(roomId);
  }

  async getRoomForUser(roomId: string, userId: string): Promise<Room> {
    const participant = await this.participants.exists({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoom(roomId);
  }

  async getConsumerLayerStateForUser(consumerId: string, userId: string): Promise<ConsumerLayerState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    const participant = await this.participants.findOne({ roomId: consumer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getConsumerLayerState(consumerId, participant.id);
  }

  async getProducerLayerStateForUser(producerId: string, userId: string): Promise<ProducerLayerState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const participant = await this.participants.findOne({ roomId: producer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getProducerLayerState(producerId, participant.id);
  }

  async getConsumerQualityStateForUser(consumerId: string, userId: string): Promise<ConsumerQualityState> {
    const consumer = await this.consumers.findById(consumerId);
    if (!consumer) {
      throw new NotFoundException('Consumer not found');
    }
    const participant = await this.participants.findOne({ roomId: consumer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getConsumerQualityState(consumerId, participant.id);
  }

  async getProducerQualityStateForUser(producerId: string, userId: string): Promise<ProducerQualityState> {
    const producer = await this.producers.findById(producerId);
    if (!producer) {
      throw new NotFoundException('Producer not found');
    }
    const participant = await this.participants.findOne({ roomId: producer.roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getProducerQualityState(producerId, participant.id);
  }

  async getRoomQualityStateForUser(roomId: string, userId: string): Promise<RoomQualityState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoomQualityState(roomId, participant.id);
  }

  async getRoomQualitySummaryStateForUser(roomId: string, userId: string): Promise<RoomQualitySummaryState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    return this.getRoomQualitySummaryState(roomId, participant.id);
  }

  async getRoomDiagnosticsForUser(roomId: string, userId: string): Promise<RoomDiagnosticsState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    const [room, resolved] = await Promise.all([this.getRoom(roomId), this.resolveRoomQualityState(roomId)]);
    const [summary, recentTimeline, snapshotHistory] = await Promise.all([
      this.computeRoomQualitySummary(roomId, room),
      this.listRoomIncidentTimeline(roomId, 12).then((timeline) => timeline.events),
      this.listRoomSnapshotHistory(roomId, 8).then((history) => history.bundles)
    ]);
    const incidentState = await this.buildRoomIncidentState(roomId, summary, room);
    return {
      room,
      owner: resolved.owner,
      quality: resolved.quality,
      incidentState,
      recentTimeline,
      snapshotHistory,
      qualitySource: resolved.qualitySource,
      ownerAuthoritativeQuality: resolved.ownerAuthoritativeQuality,
      qualityAgeMs: ageFromIso(resolved.quality.updatedAt),
      distributedSignalAgeMs: resolved.distributedSignalAgeMs,
      crossNode: Boolean(resolved.owner.owner && !resolved.owner.local),
      localNodeId: this.nodeRegistry.localNodeId(),
      observedAt: new Date().toISOString(),
      warnings: resolved.warnings
    };
  }

  async getRoomAdaptiveDiagnosticsForUser(roomId: string, userId: string): Promise<RoomAdaptiveDiagnosticsState> {
    const participant = await this.participants.findOne({ roomId, userId, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not a room participant');
    }
    const [room, resolved] = await Promise.all([this.getRoom(roomId), this.resolveRoomQualityState(roomId)]);
    const consumerStates = resolved.quality.consumers;
    const transportStates = resolved.quality.transports;
    const producerStates = resolved.quality.producers;
    const degradedConsumers = consumerStates.filter((state) => isDegradedQualityState(state.score.reasons));
    const recoveringConsumers = consumerStates.filter((state) => state.score.reasons.includes('recovered'));
    const pendingLayerSwitches = consumerStates.filter((state) => hasPendingLayerSwitch(state)).length;
    const degradedTransports = transportStates.filter((state) => isDegradedQualityState(state.score.reasons));
    const degradedProducers = producerStates.filter((state) => isDegradedQualityState(state.score.reasons));
    const adaptiveDecisions = consumerStates
      .filter((state) => hasPendingLayerSwitch(state) || isDegradedQualityState(state.score.reasons))
      .sort((left, right) => left.score.score - right.score.score)
      .map((state) => ({
        consumerId: state.consumerId,
        participantId: state.participantId,
        producerId: state.producerId,
        score: state.score.score,
        reasons: state.score.reasons,
        currentLayers: state.currentLayers,
        targetLayers: state.targetLayers,
        currentSvcLayers: state.currentSvcLayers,
        targetSvcLayers: state.targetSvcLayers,
        availableBitrate: state.bitrate.availableBitrate,
        allocatedBitrate: state.bitrate.allocatedBitrate,
        pacingQueueDepth: state.pacingQueueDepth
      }));
    return {
      roomId,
      owner: resolved.owner,
      qualitySource: resolved.qualitySource,
      ownerAuthoritativeQuality: resolved.ownerAuthoritativeQuality,
      observedAt: new Date().toISOString(),
      congestionState: resolved.quality.congestionState,
      score: resolved.quality.score.score,
      participantCount: room.participants.length,
      bitrate: {
        target: resolved.quality.targetBitrate,
        allocated: resolved.quality.allocatedBitrate,
        actual: resolved.quality.actualBitrate,
        maxAvailable: maxNumber(consumerStates.map((state) => state.bitrate.availableBitrate)),
        avgAvailable: averageNumber(consumerStates.map((state) => state.bitrate.availableBitrate)),
        maxRecommended: maxNumber(consumerStates.map((state) => state.bitrate.recommendedBitrate)),
        avgRecommended: averageNumber(consumerStates.map((state) => state.bitrate.recommendedBitrate))
      },
      consumers: {
        total: consumerStates.length,
        degraded: degradedConsumers.length,
        recovering: recoveringConsumers.length,
        withPendingLayerSwitch: pendingLayerSwitches
      },
      transports: {
        total: transportStates.length,
        degraded: degradedTransports.length,
        maxPacketLoss: maxNumber(transportStates.flatMap((state) => state.consumers.map((consumer) => consumer.network.packetLoss))),
        maxRtt: maxNumber(transportStates.flatMap((state) => state.consumers.map((consumer) => consumer.network.rtt))),
        maxJitter: maxNumber(transportStates.flatMap((state) => state.consumers.map((consumer) => consumer.network.jitter))),
        maxPacingQueueDepth: maxNumber(transportStates.map((state) => state.pacingQueueDepth))
      },
      producers: {
        total: producerStates.length,
        degraded: degradedProducers.length,
        dynacastEnabled: producerStates.filter((state) => state.dynacastEnabled).length,
        activeLayerCount: producerStates.reduce((total, state) => total + state.activeLayers.length, 0),
        suspendedLayerCount: producerStates.reduce((total, state) => total + state.suspendedLayers.length, 0)
      },
      adaptiveDecisions,
      warnings: resolved.warnings
    };
  }

  async exportRoomIncidentSnapshot(roomId: string): Promise<RoomIncidentSnapshot> {
    const snapshot = await this.buildRoomIncidentSnapshot(roomId);
    this.metrics.incidentSnapshotsGenerated.labels('room').inc();
    return snapshot;
  }

  async exportTransportIncidentSnapshot(transportId: string): Promise<TransportIncidentSnapshot> {
    const transportState = this.media.transportQualityState(transportId) ?? this.readFreshDistributedState(this.distributedTransportQualityStates, transportId);
    if (!transportState) {
      throw new NotFoundException('Transport quality state not available');
    }
    const policyContext = await this.getRoomPolicyContext(transportState.roomId);
    const room = policyContext.room;
    const relatedProducers = room.producers.filter((producer) => producer.transportId === transportId);
    const relatedConsumers = room.consumers.filter((consumer) => consumer.transportId === transportId);
    this.metrics.incidentSnapshotsGenerated.labels('transport').inc();
    return {
      scope: 'transport',
      generatedAt: new Date().toISOString(),
      transport: this.transportIncidentSummary(transportId, room),
      roomId: room.id,
      roomProfile: room.mediaProfile,
      ownerNodeId: room.owner?.nodeId,
      ownerPublicUrl: room.owner?.publicUrl,
      ownerAvailable: Boolean(room.owner),
      workerId: room.mediaState?.workerId ?? this.resolveRoomWorkerId(room.id),
      roomQualitySummary: policyContext.summary,
      relatedProducers: relatedProducers.map((producer) => this.producerIncidentSummary(producer)),
      relatedConsumers: relatedConsumers.map((consumer) => this.consumerIncidentSummary(consumer)),
      degradedEntities: policyContext.summary.degradedEntityIds
    };
  }

  async getRoomSnapshotBundle(bundleId: string): Promise<RoomIncidentSnapshotBundle> {
    const bundle = await this.roomSnapshotBundles.findById(bundleId);
    if (!bundle) {
      throw new NotFoundException('Room snapshot bundle not found');
    }
    return this.toRoomSnapshotBundle(bundle);
  }

  async generateRoomSnapshotBundleForOperations(roomId: string, reason?: string): Promise<RoomIncidentSnapshotBundle> {
    return this.generateRoomSnapshotBundle(roomId, 'manual_operator', {
      automatic: false,
      actor: {
        type: 'operator',
        label: 'operations-token'
      },
      reason
    });
  }

  async injectRoomFailureForOperations(
    roomId: string,
    input?: {
      reason?: RoomFailureEvent['reason'];
      message?: string;
      recoverable?: boolean;
      workerId?: string;
    }
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    const workerId = input?.workerId ?? room.mediaState?.workerId ?? this.resolveRoomWorkerId(roomId) ?? 'operations-worker';
    const affectedTransports = [...new Set([...room.producers.map((producer) => producer.transportId), ...room.consumers.map((consumer) => consumer.transportId)])];
    await this.handleMediaRoomFailure({
      roomId,
      workerId,
      reason: input?.reason ?? 'worker_drained_forced',
      message: input?.message ?? `Media worker ${workerId} force-closed room ${roomId} during diagnostics validation`,
      failedAt: new Date().toISOString(),
      affectedTransports,
      affectedProducers: room.producers.map((producer) => producer.id),
      affectedConsumers: room.consumers.map((consumer) => consumer.id),
      recoverable: input?.recoverable ?? true
    });
  }

  async getRoomIncidentStateForOperations(roomId: string): Promise<RoomIncidentState> {
    const summary = await this.computeRoomQualitySummary(roomId);
    return this.buildRoomIncidentState(roomId, summary);
  }

  async getRoomIncidentTimelineForOperations(roomId: string, limit?: number): Promise<RoomIncidentTimelineState> {
    return this.listRoomIncidentTimeline(roomId, limit);
  }

  async getRoomSnapshotHistoryForOperations(roomId: string, limit?: number): Promise<RoomSnapshotHistoryState> {
    return this.listRoomSnapshotHistory(roomId, limit);
  }

  private async buildRoomIncidentSnapshot(roomId: string): Promise<RoomIncidentSnapshot> {
    const policyContext = await this.getRoomPolicyContext(roomId);
    const room = policyContext.room;
    const relatedTransportIds = new Set([
      ...room.producers.map((producer) => producer.transportId),
      ...room.consumers.map((consumer) => consumer.transportId)
    ]);
    const transportSummaries = [...relatedTransportIds].map((transportId) => this.transportIncidentSummary(transportId, room));
    return {
      scope: 'room',
      generatedAt: new Date().toISOString(),
      room,
      ownerNodeId: room.owner?.nodeId,
      ownerPublicUrl: room.owner?.publicUrl,
      ownerAvailable: Boolean(room.owner),
      workerId: room.mediaState?.workerId ?? this.resolveRoomWorkerId(room.id),
      roomProfile: room.mediaProfile,
      roomQualitySummary: policyContext.summary,
      participantSummary: {
        total: room.participants.length,
        admitted: room.participants.filter((participant) => participant.admitted).length,
        pending: room.participants.filter((participant) => !participant.admitted).length,
        viewers: room.participants.filter((participant) => participant.role === Role.VIEWER).length,
        hosts: room.participants.filter((participant) => participant.role === Role.HOST).length,
        coHosts: room.participants.filter((participant) => participant.role === Role.CO_HOST).length,
        screenSharing: room.participants.filter((participant) => participant.screenSharing).length,
        handRaised: room.participants.filter((participant) => participant.handRaised).length
      },
      producers: room.producers.map((producer) => this.producerIncidentSummary(producer)),
      consumers: room.consumers.map((consumer) => this.consumerIncidentSummary(consumer)),
      transports: transportSummaries,
      degradedEntities: policyContext.summary.degradedEntityIds,
      congestionIndicators: {
        congestionState: policyContext.summary.congestionState,
        score: policyContext.summary.score.score,
        reasons: policyContext.summary.score.reasons,
        targetBitrate: policyContext.summary.bitrate.target,
        allocatedBitrate: policyContext.summary.bitrate.allocated,
        actualBitrate: policyContext.summary.bitrate.actual
      },
      pipeContext: {
        crossNode: Boolean(room.owner && room.owner.nodeId !== this.nodeRegistry.localNodeId()),
        localNodeId: this.nodeRegistry.localNodeId()
      }
    };
  }

  private async buildRoomIncidentState(roomId: string, summary: RoomQualitySummaryState, roomOverride?: Room): Promise<RoomIncidentState> {
    const [roomDoc, room, ownerLookup] = await Promise.all([
      this.rooms.findById(roomId),
      roomOverride ? Promise.resolve(roomOverride) : this.getRoom(roomId),
      this.nodeRegistry.lookupRoomOwner(roomId)
    ]);
    const persisted = toRoomIncidentState(roomId, roomDoc?.incidentState);
    const nextAlerts = await this.evaluateRoomAlerts(room, summary, persisted, ownerLookup);
    return enrichRoomIncidentState(room, summary, ownerLookup, {
      ...persisted,
      activeAlerts: nextAlerts
    });
  }

  private async listRoomIncidentTimeline(roomId: string, limit = 24): Promise<RoomIncidentTimelineState> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const events = await this.roomIncidentEvents.find({ roomId }).sort({ createdAt: -1 }).limit(safeLimit);
    return {
      roomId,
      events: events.map((event) => this.toRoomIncidentTimelineEvent(event)),
      updatedAt: new Date().toISOString()
    };
  }

  private async listRoomSnapshotHistory(roomId: string, limit = 12): Promise<RoomSnapshotHistoryState> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const bundles = await this.roomSnapshotBundles.find({ roomId }).sort({ createdAt: -1 }).limit(safeLimit);
    return {
      roomId,
      bundles: bundles.map((bundle) => this.toRoomSnapshotBundleSummary(bundle)),
      updatedAt: new Date().toISOString()
    };
  }

  private applyRoomIncidentOverrides(room: Room, summary: RoomQualitySummaryState): RoomQualitySummaryState {
    const incident = room.incidentState;
    if (!incident) {
      return summary;
    }
    const warnings = new Set(summary.warnings);
    let join = summary.protections.join;
    let publish = summary.protections.publish;
    let screenShare = summary.protections.screenShare;

    if (room.mediaState?.status === 'failed') {
      join = overrideAutopilotDecision(join, 'reject', 'room_failed', 'Room media is unavailable while operators recover the room.');
      publish = overrideAutopilotDecision(publish, 'reject', 'room_failed', 'Room media is unavailable while operators recover the room.');
      screenShare = overrideAutopilotDecision(screenShare, 'reject', 'room_failed', 'Room media is unavailable while operators recover the room.');
      warnings.add('room_media_failed');
    }

    if (incident.protected && incident.admissionsState !== 'reopened') {
      join = overrideAutopilotDecision(
        join,
        'reject',
        'operator_protected',
        'New admissions are blocked while the room is under operator protection.'
      );
      warnings.add('room_operator_protected');
    }

    if (incident.protected) {
      publish = overrideAutopilotDecision(
        publish,
        'reject',
        'operator_protected',
        'New publishing is blocked while the room is under operator protection.'
      );
      screenShare = overrideAutopilotDecision(
        screenShare,
        'reject',
        'operator_protected',
        'New screen sharing is blocked while the room is under operator protection.'
      );
    }

    if (incident.publishingState === 'paused') {
      publish = overrideAutopilotDecision(
        publish,
        'reject',
        'operator_publish_paused',
        'Operators have paused new publishing until the room stabilizes.'
      );
      screenShare = overrideAutopilotDecision(
        screenShare,
        'reject',
        'operator_publish_paused',
        'Operators have paused new screen sharing until the room stabilizes.'
      );
      warnings.add('room_publishing_paused');
    }

    if (incident.admissionsState === 'reopened') {
      warnings.add('room_admissions_reopened');
    }
    if (incident.underRecovery) {
      warnings.add('room_under_operator_recovery');
    }

    return {
      ...summary,
      protections: {
        join,
        publish,
        screenShare
      },
      warnings: [...warnings],
      updatedAt: new Date().toISOString()
    };
  }

  private async refreshRoomIncidentState(
    roomId: string,
    summary: RoomQualitySummaryState,
    previousSummary?: RoomQualitySummaryState,
    roomOverride?: Room
  ): Promise<RoomIncidentState> {
    const roomDoc = await this.rooms.findById(roomId);
    if (!roomDoc) {
      return defaultIncidentState(roomId);
    }
    const room = roomOverride ?? await this.getRoom(roomId);
    const previousState = toRoomIncidentState(roomId, roomDoc.incidentState);
    const nextState = await this.buildRoomIncidentState(roomId, summary, room);
    const persistedState = toIncidentStateDocument(nextState, roomDoc.incidentState);
    const stateChanged = JSON.stringify(previousState) !== JSON.stringify(toRoomIncidentState(roomId, persistedState));
    if (stateChanged) {
      roomDoc.incidentState = persistedState as RoomMongoDocument['incidentState'];
      await roomDoc.save();
    }

    if (previousSummary) {
      await this.recordSummaryTransitionEvents(room, previousSummary, summary, previousState, nextState);
    }
    await this.syncAlertTimeline(room, previousState.activeAlerts, nextState.activeAlerts);

    for (const listener of this.roomIncidentStateEventListeners) {
      listener(nextState);
    }

    if (previousSummary && previousSummary.health !== 'critical' && summary.health === 'critical') {
      await this.generateRoomSnapshotBundle(roomId, 'critical_quality', {
        automatic: true,
        actor: { type: 'automation', label: 'room-policy' }
      }).catch(() => undefined);
    }

    return nextState;
  }

  private async generateRoomSnapshotBundle(
    roomId: string,
    triggerReason: RoomSnapshotTriggerReason,
    options: {
      automatic: boolean;
      actor?: RoomIncidentActor;
      reason?: string;
    }
  ): Promise<RoomIncidentSnapshotBundle> {
    const snapshot = await this.buildRoomIncidentSnapshot(roomId);
    const incidentState = await this.buildRoomIncidentState(roomId, snapshot.roomQualitySummary, snapshot.room);
    const recentTimeline = (await this.listRoomIncidentTimeline(roomId, 12)).events;
    const ownerLookup = await this.nodeRegistry.lookupRoomOwner(roomId);
    const createdAt = new Date();
    const payload: RoomIncidentSnapshotBundle = {
      ...snapshot,
      bundleId: '',
      triggerReason,
      automatic: options.automatic,
      actor: options.actor,
      incidentState,
      recentTimeline,
      distributedContext: {
        ownerLocal: ownerLookup.local,
        ownerNodeId: ownerLookup.owner?.nodeId,
        ownerPublicUrl: ownerLookup.owner?.publicUrl,
        qualitySource: snapshot.roomQualitySummary.qualitySource,
        ownerAuthoritativeQuality: snapshot.roomQualitySummary.ownerAuthoritativeQuality,
        localNodeId: this.nodeRegistry.localNodeId()
      }
    };
    const doc = await this.roomSnapshotBundles.create({
      roomId,
      triggerReason,
      automatic: options.automatic,
      actorType: options.actor?.type,
      actorParticipantId: options.actor?.participantId,
      actorUserId: options.actor?.userId,
      actorLabel: options.actor?.label,
      actorNodeId: options.actor?.nodeId,
      actorWorkerId: options.actor?.workerId,
      health: snapshot.roomQualitySummary.health,
      status: incidentState.status,
      protected: incidentState.protected,
      underRecovery: incidentState.underRecovery,
      degradedEntityCount:
        snapshot.roomQualitySummary.degradedEntityIds.consumers.length
        + snapshot.roomQualitySummary.degradedEntityIds.producers.length
        + snapshot.roomQualitySummary.degradedEntityIds.transports.length,
      warningCount: snapshot.roomQualitySummary.warnings.length,
      bundle: payload,
      createdAt
    });
    payload.bundleId = doc.id;
    doc.bundle = payload as unknown as Record<string, unknown>;
    await doc.save();
    this.metrics.incidentSnapshotsGenerated.labels('room').inc();
    this.metrics.snapshotBundlesGenerated.labels(triggerReason, options.automatic ? 'automatic' : 'manual').inc();
    const roomDoc = await this.rooms.findById(roomId);
    if (roomDoc) {
      const state = roomDoc.incidentState ?? defaultIncidentStateDocument(roomId, createdAt);
      state.snapshotCount = (state.snapshotCount ?? 0) + 1;
      state.latestSnapshotId = doc.id;
      state.updatedAt = createdAt;
      roomDoc.incidentState = state as RoomMongoDocument['incidentState'];
      await roomDoc.save();
    }
    await this.recordRoomIncidentEvent({
      roomId,
      type: 'snapshot_generated',
      severity: 'warn',
      summary: snapshotTriggerSummary(triggerReason),
      detail: options.reason,
      actor: options.actor,
      snapshotId: doc.id
    });
    await this.platformEvents.appendEvent({
      type: 'incident.snapshot.generated',
      roomId,
      actor: this.platformActorFromIncidentActor(options.actor),
      payload: {
        room: {
          roomId,
          ...(snapshot.room.name ? { name: snapshot.room.name } : {}),
          mediaProfileId: snapshot.room.mediaProfile.id
        },
        bundleId: doc.id,
        triggerReason,
        automatic: options.automatic,
        health: snapshot.roomQualitySummary.health,
        status: incidentState.status,
        degradedEntityCount:
          snapshot.roomQualitySummary.degradedEntityIds.consumers.length
          + snapshot.roomQualitySummary.degradedEntityIds.producers.length
          + snapshot.roomQualitySummary.degradedEntityIds.transports.length,
        warningCount: snapshot.roomQualitySummary.warnings.length
      }
    });
    const summary = this.toRoomSnapshotBundleSummary(doc);
    for (const listener of this.roomSnapshotGeneratedEventListeners) {
      listener(summary);
    }
    return this.toRoomSnapshotBundle(doc);
  }

  private toRoomIncidentTimelineEvent(event: RoomIncidentEventMongoDocument): RoomIncidentTimelineEvent {
    return {
      id: event.id,
      roomId: event.roomId,
      type: event.type,
      severity: event.severity,
      summary: event.summary,
      detail: event.detail,
      ...(event.actorType
        ? {
            actor: {
              type: event.actorType,
              participantId: event.actorParticipantId,
              userId: event.actorUserId,
              label: event.actorLabel,
              nodeId: event.actorNodeId,
              workerId: event.actorWorkerId
            }
          }
        : {}),
      relatedParticipantId: event.relatedParticipantId,
      relatedProducerId: event.relatedProducerId,
      relatedConsumerId: event.relatedConsumerId,
      relatedTransportId: event.relatedTransportId,
      snapshotId: event.snapshotId,
      alertCode: event.alertCode,
      ownerNodeId: event.ownerNodeId,
      workerId: event.workerId,
      createdAt: event.createdAt.toISOString()
    };
  }

  private toRoomSnapshotBundleSummary(bundle: RoomSnapshotBundleMongoDocument): RoomSnapshotBundleSummary {
    return {
      bundleId: bundle.id,
      roomId: bundle.roomId,
      generatedAt: bundle.createdAt.toISOString(),
      triggerReason: bundle.triggerReason,
      automatic: bundle.automatic,
      ...(bundle.actorType
        ? {
            actor: {
              type: bundle.actorType,
              participantId: bundle.actorParticipantId,
              userId: bundle.actorUserId,
              label: bundle.actorLabel,
              nodeId: bundle.actorNodeId,
              workerId: bundle.actorWorkerId
            }
          }
        : {}),
      health: bundle.health,
      status: bundle.status,
      protected: bundle.protected,
      underRecovery: bundle.underRecovery,
      degradedEntityCount: bundle.degradedEntityCount,
      warningCount: bundle.warningCount
    };
  }

  private toRoomSnapshotBundle(bundle: RoomSnapshotBundleMongoDocument): RoomIncidentSnapshotBundle {
    return {
      ...(bundle.bundle as unknown as Omit<RoomIncidentSnapshotBundle, 'bundleId'>),
      bundleId: bundle.id
    };
  }

  private async evaluateRoomAlerts(
    room: Room,
    summary: RoomQualitySummaryState,
    currentState: RoomIncidentState,
    ownerLookup: RoomOwnerLookupResponse
  ): Promise<RoomOperatorAlert[]> {
    const now = Date.now();
    const previous = new Map((currentState.activeAlerts ?? []).map((alert) => [alert.code, alert]));
    const alerts: RoomOperatorAlert[] = [];
    const recentThrottleCount = await this.roomIncidentEvents.countDocuments({
      roomId: room.id,
      type: { $in: ['join_throttled', 'join_rejected', 'publish_throttled', 'publish_rejected', 'screen_share_throttled', 'screen_share_rejected'] },
      createdAt: { $gte: new Date(now - 10 * 60_000) }
    });
    const recentSnapshotCount = await this.roomSnapshotBundles.countDocuments({
      roomId: room.id,
      createdAt: { $gte: new Date(now - 15 * 60_000) }
    });

    if (summary.health === 'critical') {
      alerts.push(nextAlert(previous.get('room_critical'), {
        code: 'room_critical',
        severity: 'critical',
        title: 'Room entered a critical state',
        detail: `The room quality summary is critical and protections are actively restricting joins or publishing.`
      }));
    }
    if (recentThrottleCount >= 3) {
      alerts.push(nextAlert(previous.get('repeated_throttles'), {
        code: 'repeated_throttles',
        severity: 'warn',
        title: 'Repeated throttles or rejections detected',
        detail: `The room has recorded ${recentThrottleCount} admission or publish throttles/rejections in the last 10 minutes.`
      }));
    }
    if (room.mediaState?.status === 'failed') {
      alerts.push(nextAlert(previous.get('room_failed'), {
        code: 'room_failed',
        severity: 'critical',
        title: 'Room media failed',
        detail: room.mediaState.failureMessage ?? 'The room media plane failed and needs operator intervention.'
      }));
    }
    if (!ownerLookup.local && summary.warnings.some((warning) => warning.startsWith('room_owner_') || warning.startsWith('owner_quality_signal_'))) {
      alerts.push(nextAlert(previous.get('distributed_owner_risk'), {
        code: 'distributed_owner_risk',
        severity: 'warn',
        title: 'Distributed owner continuity risk',
        detail: 'The room depends on a remote owner node and quality visibility is degraded or stale.'
      }));
    }
    if (recentSnapshotCount >= 3) {
      alerts.push(nextAlert(previous.get('repeated_snapshots'), {
        code: 'repeated_snapshots',
        severity: 'warn',
        title: 'Repeated incident snapshots generated',
        detail: `The room has generated ${recentSnapshotCount} incident snapshots in the last 15 minutes.`
      }));
    }
    if (currentState.protected && currentState.protectedAt && now - Date.parse(currentState.protectedAt) >= 5 * 60_000) {
      alerts.push(nextAlert(previous.get('protection_prolonged'), {
        code: 'protection_prolonged',
        severity: 'warn',
        title: 'Room protection has been active for an extended period',
        detail: 'The room remains protected more than five minutes after the incident began.'
      }));
    }
    if (summary.health !== 'stable' && currentState.healthChangedAt && now - Date.parse(currentState.healthChangedAt) >= 3 * 60_000) {
      alerts.push(nextAlert(previous.get('critical_state_prolonged'), {
        code: 'critical_state_prolonged',
        severity: summary.health === 'critical' ? 'critical' : 'warn',
        title: 'Room has not recovered',
        detail: `The room has remained ${summary.health} for longer than the expected recovery window.`
      }));
    }

    return alerts;
  }

  private async syncAlertTimeline(room: Room, previousAlerts: RoomOperatorAlert[], nextAlerts: RoomOperatorAlert[]): Promise<void> {
    const previous = new Map(previousAlerts.map((alert) => [alert.code, alert]));
    const next = new Map(nextAlerts.map((alert) => [alert.code, alert]));
    for (const alert of nextAlerts) {
      if (!previous.has(alert.code)) {
        this.metrics.roomAlertEvents.labels(alert.code, 'emitted').inc();
        await this.recordRoomIncidentEvent({
          roomId: room.id,
          type: 'alert_raised',
          severity: alert.severity,
          summary: alert.title,
          detail: alert.detail,
          actor: { type: 'automation', label: 'room-alerts' },
          alertCode: alert.code
        });
      } else {
        this.metrics.roomAlertEvents.labels(alert.code, 'suppressed').inc();
      }
    }
    for (const alert of previousAlerts) {
      if (!next.has(alert.code)) {
        this.metrics.roomAlertEvents.labels(alert.code, 'resolved').inc();
      }
    }
  }

  private async recordSummaryTransitionEvents(
    room: Room,
    previousSummary: RoomQualitySummaryState,
    nextSummary: RoomQualitySummaryState,
    previousState: RoomIncidentState,
    nextState: RoomIncidentState
  ): Promise<void> {
    if (previousSummary.health !== nextSummary.health) {
      await this.platformEvents.appendEvent({
        type: nextSummary.health === 'stable' ? 'room.recovered' : 'room.degraded',
        roomId: room.id,
        actor: {
          type: 'automation',
          label: 'room-policy'
        },
        payload: {
          room: {
            roomId: room.id,
            ...(room.name ? { name: room.name } : {}),
            mediaProfileId: room.mediaProfile.id
          },
          previousHealth: previousSummary.health,
          health: nextSummary.health,
          status: nextState.status,
          warnings: nextSummary.warnings
        }
      });
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: nextSummary.health === 'stable' ? 'room_recovered' : 'health_changed',
        severity: nextSummary.health === 'critical' ? 'critical' : nextSummary.health === 'degraded' ? 'warn' : 'info',
        summary: nextSummary.health === 'stable'
          ? 'Room health recovered to stable.'
          : `Room health changed from ${previousSummary.health} to ${nextSummary.health}.`,
        actor: { type: 'automation', label: 'room-policy' }
      });
    }
    if (!sameProtectionState(previousSummary.protections, nextSummary.protections)) {
      await this.platformEvents.appendEvent({
        type: 'room.protection.changed',
        roomId: room.id,
        actor: {
          type: 'automation',
          label: 'room-policy'
        },
        payload: {
          room: {
            roomId: room.id,
            ...(room.name ? { name: room.name } : {})
          },
          protected: nextState.protected,
          admissionsState: nextState.admissionsState,
          publishingState: nextState.publishingState,
          source: 'automation',
          reason: nextSummary.warnings.join(', ') || undefined
        }
      });
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: 'protection_changed',
        severity: protectionSeverity(nextSummary.protections),
        summary: `Room protections changed to join=${nextSummary.protections.join.action}, publish=${nextSummary.protections.publish.action}, screen=${nextSummary.protections.screenShare.action}.`,
        actor: { type: 'automation', label: 'room-policy' }
      });
    }
    if (!sameRecommendationCodes(previousSummary.recommendations, nextSummary.recommendations)) {
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: 'recommendation_changed',
        severity: recommendationSeverity(nextSummary.recommendations),
        summary: `Automation recommendations changed for the room.`,
        detail: nextSummary.recommendations.map((recommendation) => recommendation.title).join('; '),
        actor: { type: 'automation', label: 'room-policy' }
      });
    }
    const newWarnings = nextSummary.warnings.filter((warning) => !previousSummary.warnings.includes(warning));
    if (newWarnings.length > 0) {
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: 'infrastructure_impact',
        severity: 'warn',
        summary: 'Room warnings changed due to node, worker, or distributed-owner pressure.',
        detail: newWarnings.join(', '),
        actor: { type: 'automation', label: 'room-diagnostics' }
      });
    }
    if (previousState.status !== nextState.status && nextState.status === 'recovering') {
      await this.recordRoomIncidentEvent({
        roomId: room.id,
        type: 'manual_action',
        severity: 'warn',
        summary: 'Room entered operator recovery mode.',
        actor: { type: 'automation', label: 'room-recovery' }
      });
    }
  }

  private async recordRoomIncidentEvent(input: {
    roomId: string;
    type: RoomIncidentTimelineEvent['type'];
    severity: RoomIncidentTimelineEvent['severity'];
    summary: string;
    detail?: string;
    actor?: RoomIncidentActor;
    relatedParticipantId?: string;
    relatedProducerId?: string;
    relatedConsumerId?: string;
    relatedTransportId?: string;
    snapshotId?: string;
    alertCode?: RoomOperatorAlert['code'];
    ownerNodeId?: string;
    workerId?: string;
  }): Promise<RoomIncidentTimelineEvent> {
    const doc = await this.roomIncidentEvents.create({
      roomId: input.roomId,
      type: input.type,
      severity: input.severity,
      summary: input.summary,
      detail: input.detail,
      actorType: input.actor?.type,
      actorParticipantId: input.actor?.participantId,
      actorUserId: input.actor?.userId,
      actorLabel: input.actor?.label,
      actorNodeId: input.actor?.nodeId,
      actorWorkerId: input.actor?.workerId,
      relatedParticipantId: input.relatedParticipantId,
      relatedProducerId: input.relatedProducerId,
      relatedConsumerId: input.relatedConsumerId,
      relatedTransportId: input.relatedTransportId,
      snapshotId: input.snapshotId,
      alertCode: input.alertCode,
      ownerNodeId: input.ownerNodeId,
      workerId: input.workerId,
      createdAt: new Date()
    });
    this.metrics.roomIncidentTimelineEvents.labels(input.type, input.severity).inc();
    const event = this.toRoomIncidentTimelineEvent(doc);
    for (const listener of this.roomIncidentTimelineEventListeners) {
      listener(event);
    }
    return event;
  }

  private async getRoomPolicyContext(roomId: string, _roomDoc?: RoomMongoDocument): Promise<RoomPolicyContext> {
    const [room, summary] = await Promise.all([this.getRoom(roomId), this.computeRoomQualitySummary(roomId)]);
    return { room, summary };
  }

  private async computeRoomQualitySummary(roomId: string, roomOverride?: Room): Promise<RoomQualitySummaryState> {
    const room = roomOverride ?? await this.getRoom(roomId);
    const ownerLookup = await this.requireRoomOwnerLookup(roomId);
    const distributedSummary = ownerLookup.local ? undefined : this.readFreshRoomQualitySummaryState(roomId);
    if (distributedSummary) {
      const previousDistributed = this.roomQualitySummaryStates.get(roomId);
      this.roomQualitySummaryStates.set(roomId, distributedSummary);
      this.metrics.updateRoomAutopilotSummary(distributedSummary, previousDistributed);
      return distributedSummary;
    }
    const resolved = await this.resolveRoomQualityStateWithFallback(roomId);
    const clusterSnapshot = await this.nodeRegistry.snapshot();
    const ownerNode = resolved.owner.owner
      ? clusterSnapshot.nodes.find((node) => node.nodeId === resolved.owner.owner?.nodeId)
      : undefined;
    const node = resolved.owner.local ? clusterSnapshot.localNode : ownerNode ?? clusterSnapshot.localNode;
    const summary = buildRoomQualitySummary({
      room,
      quality: resolved.quality,
      qualitySource: resolved.qualitySource,
      ownerAuthoritativeQuality: resolved.ownerAuthoritativeQuality,
      warnings: resolved.warnings,
      node,
      workers: this.media.workerPoolSnapshot()
    });
    const nextSummary = this.applyRoomIncidentOverrides(room, summary);
    const previous = this.roomQualitySummaryStates.get(roomId);
    this.roomQualitySummaryStates.set(roomId, nextSummary);
    this.metrics.updateRoomAutopilotSummary(nextSummary, previous);
    return nextSummary;
  }

  private async emitRoomQualitySummaryUpdate(roomId: string, roomOverride?: Room): Promise<RoomQualitySummaryState> {
    const previousSummary = this.roomQualitySummaryStates.get(roomId);
    const summary = await this.computeRoomQualitySummary(roomId, roomOverride);
    const ownerLookup = await this.nodeRegistry.lookupRoomOwner(roomId);
    if (ownerLookup.local || !ownerLookup.owner) {
      await this.refreshRoomIncidentState(roomId, summary, previousSummary, roomOverride).catch(() => undefined);
    }
    for (const listener of this.roomQualitySummaryEventListeners) {
      listener(summary);
    }
    return summary;
  }

  private async resolveRoomQualityStateWithFallback(roomId: string): Promise<ResolvedRoomQualityState> {
    try {
      return await this.resolveRoomQualityState(roomId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        throw error;
      }
      const owner = await this.requireRoomOwnerLookup(roomId);
      return {
        owner,
        quality: createFallbackRoomQualityState(roomId),
        qualitySource: owner.local ? 'local-owner' : 'local-fallback',
        ownerAuthoritativeQuality: owner.local,
        warnings: ['room_quality_state_unavailable']
      };
    }
  }

  private async applyRoomMediaProfile(roomId: string, profileId: RoomMediaProfileId): Promise<void> {
    const ownerLookup = await this.requireRoomOwnerLookup(roomId);
    const room = await this.getRoom(roomId);
    const profile = room.mediaProfile.id === profileId
      ? room.mediaProfile
      : resolveRoomMediaProfile(profileId, {
          updatedAt: room.mediaProfile.updatedAt,
          updatedByParticipantId: room.mediaProfile.updatedByParticipantId
        });
    const producerDocs = await this.producers.find({ roomId, status: { $ne: 'closed' } });
    const consumerDocs = await this.consumers.find({ roomId, status: { $ne: 'closed' } });
    const participantMap = new Map(room.participants.map((participant) => [participant.id, participant]));
    const producerMap = new Map(producerDocs.map((producer) => [producer.id, producer]));
    const touchedProducerIds = new Set<string>();

    for (const producerDoc of producerDocs) {
      if (!await this.isProducerHostedLocally(producerDoc, ownerLookup)) {
        continue;
      }
      const nextPriority = normalizeConsumerPriority(defaultProducerPriority(profile, producerDoc.kind));
      if (normalizeConsumerPriority(producerDoc.priority) !== nextPriority) {
        producerDoc.priority = nextPriority;
        await producerDoc.save();
        this.media.setProducerPriority(producerDoc.id, nextPriority);
      }
      touchedProducerIds.add(producerDoc.id);
    }

    for (const consumerDoc of consumerDocs) {
      if (!this.isConsumerHostedLocally(consumerDoc)) {
        continue;
      }
      const producerDoc = producerMap.get(consumerDoc.producerId);
      if (!producerDoc) {
        continue;
      }
      const participant = participantMap.get(consumerDoc.participantId);
      const nextPriority = normalizeConsumerPriority(defaultConsumerPriority(profile, producerDoc.kind));
      const nextLayers = normalizeLayerSelection(
        defaultConsumerLayers(profile, producerDoc.kind, { viewer: participant?.role === Role.VIEWER })
      );
      consumerDoc.priority = nextPriority;
      if (nextLayers) {
        consumerDoc.preferredLayers = nextLayers as Record<string, unknown>;
        consumerDoc.preferredLayer = selectionToPreferredLayerName(nextLayers);
      }
      await consumerDoc.save();
      this.media.setConsumerPriority(consumerDoc.id, nextPriority);
      if (nextLayers) {
        await this.media.setConsumerPreferredLayers(consumerDoc.id, nextLayers);
      }
      touchedProducerIds.add(consumerDoc.producerId);
    }

    if (this.pipeCoordinator.isEnabled()) {
      for (const producerId of touchedProducerIds) {
        await this.syncDistributedConsumerDemandByProducer(roomId, producerId, { ownerLookup }).catch(() => undefined);
      }
    }
    this.appliedRoomProfileSignatures.set(roomId, roomProfileSignature(profile));
  }

  private producerIncidentSummary(producer: Producer): IncidentProducerSummary {
    return {
      producerId: producer.id,
      participantId: producer.participantId,
      transportId: producer.transportId,
      kind: producer.kind,
      priority: producer.priority,
      status: producer.status,
      score: producer.quality?.score.score,
      level: producer.quality?.score.level,
      currentLayers: producer.currentLayers,
      activeLayers: producer.dynacast?.activeLayers,
      targetLayers: producer.dynacast?.desiredLayers[0] ?? producer.currentLayers
    };
  }

  private consumerIncidentSummary(consumer: Consumer): IncidentConsumerSummary {
    return {
      consumerId: consumer.id,
      participantId: consumer.participantId,
      producerId: consumer.producerId,
      transportId: consumer.transportId,
      priority: consumer.priority,
      status: consumer.status,
      score: consumer.quality?.score.score,
      level: consumer.quality?.score.level,
      currentLayers: consumer.currentLayers,
      preferredLayers: consumer.preferredLayers,
      targetLayers: consumer.targetLayers,
      currentSvcLayers: consumer.currentSvcLayers,
      preferredSvcLayers: consumer.preferredSvcLayers,
      targetSvcLayers: consumer.targetSvcLayers
    };
  }

  private transportIncidentSummary(transportId: string, room: Room): IncidentTransportSummary {
    const state = this.media.transportQualityState(transportId) ?? this.readFreshDistributedState(this.distributedTransportQualityStates, transportId);
    const producers = room.producers.filter((producer) => producer.transportId === transportId);
    const consumers = room.consumers.filter((consumer) => consumer.transportId === transportId);
    return {
      transportId,
      participantId: consumers[0]?.participantId ?? producers[0]?.participantId ?? 'unknown',
      consumerCount: consumers.length,
      producerCount: producers.length,
      score: state?.score.score,
      level: state?.score.level,
      targetBitrate: state?.targetBitrate,
      allocatedBitrate: state?.allocatedBitrate,
      actualBitrate: state?.actualBitrate,
      pacingQueueDepth: state?.pacingQueueDepth
    };
  }

  private recordProtectionDecision(profileId: RoomMediaProfileId, decision: RoomAutopilotDecision): void {
    if (decision.action !== 'allow') {
      this.metrics.roomProtectionDecisions.labels(profileId, decision.scope, decision.action, decision.code).inc();
    }
  }

  private cleanupRoomAutopilotState(roomId: string): void {
    const previous = this.roomQualitySummaryStates.get(roomId);
    if (previous) {
      this.metrics.clearRoomAutopilotSummary(previous);
      this.roomQualitySummaryStates.delete(roomId);
    }
  }

  private resolveRoomWorkerId(roomId: string): string | undefined {
    const mediaWithRoomWorker = this.media as MediaService & { roomWorkerId?: (roomId: string) => string | undefined };
    return mediaWithRoomWorker.roomWorkerId?.(roomId);
  }

  private async getRoom(roomId: string): Promise<Room> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    const [participants, permissionDocs, producerDocs, consumerDocs, owner] = await Promise.all([
      this.participants.find({ roomId, leftAt: { $exists: false } }),
      this.permissions.find({ roomId }),
      this.producers.find({ roomId, status: { $ne: 'closed' } }),
      this.consumers.find({ roomId, status: { $ne: 'closed' } }),
      this.nodeRegistry.getRoomOwner(roomId)
    ]);
    const permissionMap = new Map(permissionDocs.map((permission) => [permission.participantId, this.toPermissions(permission)]));
    const consumerLayerMap = new Map<string, ConsumerLayerState[]>();
    for (const consumer of consumerDocs) {
      const state = this.consumerLayerState(consumer);
      const list = consumerLayerMap.get(consumer.participantId) ?? [];
      list.push(state);
      consumerLayerMap.set(consumer.participantId, list);
    }
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      settings: {
        locked: room.settings.locked,
        waitingRoomEnabled: room.settings.waitingRoomEnabled,
        joinApprovalRequired: room.settings.joinApprovalRequired,
        visibility: room.settings.visibility,
        maxParticipants: room.settings.maxParticipants,
        recordingEnabled: room.settings.recordingEnabled,
        chatEnabled: room.settings.chatEnabled
      },
      mediaProfile: resolveRoomMediaProfile(room.mediaProfile?.id, {
        updatedAt: room.mediaProfile?.updatedAt?.toISOString(),
        updatedByParticipantId: room.mediaProfile?.updatedByParticipantId
      }),
      mediaState: {
        status: room.mediaState?.status ?? 'active',
        failedAt: room.mediaState?.failedAt?.toISOString(),
        failureReason: room.mediaState?.failureReason,
        failureMessage: room.mediaState?.failureMessage,
        workerId: room.mediaState?.workerId
      },
      incidentState: toRoomIncidentState(room.id, room.incidentState),
      owner,
      participants: participants.map((participant) =>
        this.toParticipant(participant, permissionMap.get(participant.id) ?? DEFAULT_PARTICIPANT_PERMISSIONS, consumerLayerMap.get(participant.id))
      ),
      producers: producerDocs.map((producer) => this.toProducer(producer)),
      consumers: consumerDocs.map((consumer) => this.toConsumer(consumer)),
      createdAt: room.createdAt.toISOString(),
      closedAt: room.closedAt?.toISOString()
    };
  }

  private async findRoomDocumentById(roomId: string): Promise<RoomMongoDocument | null> {
    try {
      return await this.rooms.findById(roomId);
    } catch (error) {
      if (isMongooseCastError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async createParticipant(
    roomId: string,
    user: SocketUser,
    socketId: string,
    role: Role,
    permissions: Permissions,
    admitted: boolean,
    displayName = user.email,
    participantId?: string
  ): Promise<ParticipantMongoDocument> {
    const participant = await this.participants.create({
      ...(participantId ? { _id: new Types.ObjectId(participantId) } : {}),
      roomId,
      userId: user.id,
      displayName,
      socketId,
      nodeId: this.nodeRegistry.localNodeId(),
      role,
      audioEnabled: permissions.canPublishAudio,
      videoEnabled: permissions.canPublishVideo,
      screenSharing: false,
      handRaised: false,
      allowedToSpeak: false,
      admitted,
      joinedAt: new Date(),
      lastActiveAt: new Date(),
      lastSeenAt: new Date(),
      leftAt: undefined
    });
    await this.permissions.create({ roomId, participantId: participant.id, ...permissions });
    this.metrics.activeParticipants.labels(roomId).inc();
    return participant;
  }

  private async deferClassSessionTeacherDisconnect(
    session: ClassSessionMongoDocument,
    participant: ParticipantMongoDocument
  ): Promise<LeaveRoomForSocketResult> {
    const now = new Date();
    const teacherReconnectDeadlineAt = new Date(now.getTime() + CLASS_SESSION_TEACHER_RECONNECT_GRACE_MS);
    const activeProducers = await this.producers.find({
      roomId: session.roomId,
      participantId: participant.id,
      status: { $ne: 'closed' }
    });
    const activeProducerIds = activeProducers.map((producer) => producer.id);
    await this.participants.updateOne(
      { _id: participant.id, roomId: session.roomId },
      {
        $set: {
          socketId: '',
          lastSeenAt: now,
          screenSharing: false
        }
      }
    );
    await this.producers.updateMany(
      { roomId: session.roomId, participantId: participant.id, status: { $ne: 'closed' } },
      { status: 'closed', closedAt: now }
    );
    await this.consumers.updateMany(
      {
        roomId: session.roomId,
        status: { $ne: 'closed' },
        $or: [
          { participantId: participant.id },
          ...(activeProducerIds.length ? [{ producerId: { $in: activeProducerIds } }] : [])
        ]
      },
      { status: 'closed', closedAt: now }
    );
    await this.redis.removePresence(session.roomId, participant.id);
    await this.media.closeParticipantTransports(participant.id);
    await this.classSessions.updateOne(
      { _id: session.id, status: 'live' },
      {
        $set: {
          teacherDisconnectedAt: now,
          teacherReconnectDeadlineAt
        }
      }
    );
    this.scheduleClassSessionTeacherReconnectGrace(session.id, teacherReconnectDeadlineAt);
    this.metrics.classSessionReconnectGraceEvents.labels('started').inc();
    await this.recordClassSessionTeacherConnectionAudit('disconnected', session, participant);
    await this.recordClassSessionReconnectGraceAudit('started', session, participant, {
      teacherReconnectDeadlineAt: teacherReconnectDeadlineAt.toISOString()
    });
    return {
      closed: false,
      left: true,
      reconnecting: true,
      participantPatch: {
        connected: false,
        screenSharing: false
      },
      room: await this.getRoom(session.roomId)
    };
  }

  private scheduleClassSessionTeacherReconnectGrace(sessionId: string, deadlineAt: Date): void {
    this.cancelClassSessionTeacherReconnectGrace(sessionId);
    const timer = setTimeout(() => {
      void this.completeClassSessionAfterTeacherReconnectGrace(sessionId);
    }, Math.max(0, deadlineAt.getTime() - Date.now()));
    this.unrefTimer(timer);
    this.classSessionTeacherReconnectTimers.set(sessionId, timer);
    this.metrics.activeClassSessionReconnectGraceTimers.set(this.classSessionTeacherReconnectTimers.size);
  }

  private async completeClassSessionAfterTeacherReconnectGrace(sessionId: string): Promise<void> {
    this.classSessionTeacherReconnectTimers.delete(sessionId);
    this.metrics.activeClassSessionReconnectGraceTimers.set(this.classSessionTeacherReconnectTimers.size);
    const session = await this.classSessions.findById(sessionId);
    if (!session || session.status !== 'live') {
      return;
    }
    const deadlineAt = session.teacherReconnectDeadlineAt;
    if (!deadlineAt) {
      return;
    }
    if (deadlineAt.getTime() > Date.now()) {
      this.scheduleClassSessionTeacherReconnectGrace(session.id, deadlineAt);
      return;
    }
    if (await this.isClassSessionTeacherConnected(session)) {
      await this.clearClassSessionTeacherReconnectGrace(session.id);
      return;
    }
    const completedAt = new Date();
    const updated = await this.classSessions.findOneAndUpdate(
      { _id: sessionId, status: 'live', teacherReconnectDeadlineAt: { $lte: completedAt } },
      {
        $set: {
          status: 'completed',
          completedAt
        },
        $unset: {
          teacherDisconnectedAt: '',
          teacherReconnectDeadlineAt: ''
        }
      },
      { new: true }
    );
    if (!updated) {
      return;
    }
    try {
      await this.closeClassSessionRoom({
        roomId: updated.roomId,
        actorUserId: updated.teacherId,
        actorLabel: 'Teacher reconnect timeout'
      });
    } catch {
      // The class session is durably completed; lifecycle sync still tells clients to leave.
    }
    this.emitClassSessionLifecycleEvent('session:ended', this.classSessionLifecyclePayload(updated));
    this.metrics.classSessionReconnectGraceEvents.labels('expired').inc();
    this.metrics.classSessionLifecycleTransitions.labels('reconnect_timeout', 'completed').inc();
    await this.recordClassSessionReconnectGraceAudit('expired', updated);
  }

  private async restoreClassSessionTeacherReconnectGrace(): Promise<void> {
    const sessions = await this.classSessions.find({
      status: 'live',
      teacherReconnectDeadlineAt: { $exists: true }
    });
    for (const session of sessions) {
      const deadlineAt = session.teacherReconnectDeadlineAt;
      if (!deadlineAt) {
        continue;
      }
      if (deadlineAt.getTime() <= Date.now()) {
        await this.completeClassSessionAfterTeacherReconnectGrace(session.id);
        continue;
      }
      this.scheduleClassSessionTeacherReconnectGrace(session.id, deadlineAt);
    }
  }

  private async processExpiredClassSessionTeacherReconnectGrace(): Promise<void> {
    const sessions = await this.classSessions.find({
      status: 'live',
      teacherReconnectDeadlineAt: { $lte: new Date() }
    });
    for (const session of sessions) {
      await this.completeClassSessionAfterTeacherReconnectGrace(session.id);
    }
  }

  private async clearClassSessionTeacherReconnectGrace(sessionId: string): Promise<void> {
    const hadTimer = this.classSessionTeacherReconnectTimers.has(sessionId);
    this.cancelClassSessionTeacherReconnectGrace(sessionId);
    const session = await this.classSessions.findById(sessionId);
    await this.classSessions.updateOne(
      { _id: sessionId },
      {
        $unset: {
          teacherDisconnectedAt: '',
          teacherReconnectDeadlineAt: ''
        }
      }
    );
    if (hadTimer || session?.teacherReconnectDeadlineAt) {
      this.metrics.classSessionReconnectGraceEvents.labels('cancelled').inc();
      if (session) {
        await this.recordClassSessionReconnectGraceAudit('cancelled', session);
      }
    }
  }

  private async isClassSessionTeacherConnected(session: ClassSessionMongoDocument): Promise<boolean> {
    const teacher = await this.participants.findOne({
      roomId: session.roomId,
      userId: session.teacherId,
      leftAt: { $exists: false }
    });
    if (!teacher?.socketId) {
      return false;
    }
    const presence = await this.redis.participantPresence(session.roomId, teacher.id);
    return presence.length > 0;
  }

  private async recordClassSessionMediaFailure(
    session: ClassSessionMongoDocument | null,
    operation: 'publish' | 'consume',
    kind: Producer['kind'] | 'unknown',
    reason: string,
    participant?: ParticipantMongoDocument
  ): Promise<void> {
    if (!session) {
      return;
    }
    const safeReason = this.safeMetricLabel(reason);
    const safeKind = this.safeMetricLabel(kind);
    this.metrics.classSessionMediaFailures.labels(operation, safeKind, safeReason).inc();
    await this.auditLogs?.record({
      actorId: participant?.userId ?? participant?.id,
      actorName: participant?.displayName,
      actorRoles: participant ? [participant.role] : [],
      action: `class_sessions.media.${operation}.failure`,
      status: 'failure',
      resourceType: 'class_session',
      resourceId: session.id,
      targetType: participant ? 'participant' : undefined,
      targetId: participant?.id,
      metadata: {
        summary: `Class-session media ${operation} failed`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        participantId: participant?.id,
        participantRole: participant?.role,
        kind: safeKind,
        reason: safeReason
      }
    });
  }

  private async recordClassSessionRoomJoinAudit(
    session: ClassSessionMongoDocument | null,
    user: SocketUser,
    participant: ParticipantMongoDocument | undefined,
    result: 'admitted' | 'denied',
    reason: string
  ): Promise<void> {
    if (!session) {
      return;
    }
    const safeReason = this.safeMetricLabel(reason);
    const role = this.classSessionMetricRole(user, session, participant);
    this.metrics.classSessionJoinAttempts.labels(result, safeReason, role).inc();
    await this.auditLogs?.record({
      actorId: user.id,
      actorEmail: user.email,
      actorRoles: user.roles,
      action: `class_sessions.room_join.${result}`,
      status: result === 'admitted' ? 'success' : 'failure',
      resourceType: 'class_session',
      resourceId: session.id,
      targetType: participant ? 'participant' : undefined,
      targetId: participant?.id,
      metadata: {
        summary:
          result === 'admitted'
            ? `Admitted ${role} socket to class session`
            : `Denied ${role} socket join to class session`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        participantId: participant?.id,
        actorRole: role,
        result,
        reason: safeReason
      }
    });
  }

  private async recordClassSessionChatFailure(
    roomId: string,
    operation: 'send' | 'read',
    scope: ChatMessageScope | undefined,
    error: unknown
  ): Promise<void> {
    const session = await this.classSessions.findOne({ roomId });
    if (!session) {
      return;
    }
    const safeScope = this.safeMetricLabel(scope ?? 'unspecified');
    const safeReason = this.auditErrorReason(error);
    this.metrics.classSessionChatFailures.labels(operation, safeScope, safeReason).inc();
    await this.auditLogs?.record({
      action: `class_sessions.chat.${operation}.failure`,
      status: 'failure',
      resourceType: 'class_session',
      resourceId: session.id,
      metadata: {
        summary: `Class-session chat ${operation} failed`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId,
        scope: safeScope,
        reason: safeReason
      }
    });
  }

  private async recordClassSessionModerationAudit(
    session: ClassSessionMongoDocument,
    actor: ParticipantMongoDocument,
    target: ParticipantMongoDocument,
    action: StudentMediaModerationAction,
    result: 'success' | 'failure'
  ): Promise<void> {
    this.metrics.classSessionModerationActions.labels(action, result).inc();
    await this.auditLogs?.record({
      actorId: actor.userId ?? actor.id,
      actorName: actor.displayName,
      actorRoles: [actor.role],
      action: `class_sessions.moderation.${action}`,
      status: result,
      resourceType: 'class_session',
      resourceId: session.id,
      targetUserId: target.userId,
      targetType: 'participant',
      targetId: target.id,
      metadata: {
        summary: `Class-session moderation ${action}`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        actorParticipantId: actor.id,
        targetParticipantId: target.id,
        targetRole: target.role,
        result
      }
    });
  }

  private async recordClassSessionWhiteboardAudit(
    session: ClassSessionMongoDocument,
    actor: ParticipantMongoDocument,
    action: 'grant' | 'revoke' | 'lock' | 'unlock',
    target: Pick<ParticipantMongoDocument, 'id' | 'userId' | 'displayName'> | { participantId: string; userId?: string; displayName?: string }
  ): Promise<void> {
    const targetParticipantId = 'participantId' in target ? target.participantId : target.id;
    this.metrics.classSessionWhiteboardControlActions.labels(action, 'success').inc();
    await this.auditLogs?.record({
      actorId: actor.userId ?? actor.id,
      actorName: actor.displayName,
      actorRoles: [actor.role],
      action: `class_sessions.whiteboard_control.${action}`,
      resourceType: 'class_session',
      resourceId: session.id,
      targetUserId: target.userId,
      targetType: 'participant',
      targetId: targetParticipantId,
      metadata: {
        summary: `${action} class-session whiteboard control`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        actorParticipantId: actor.id,
        targetParticipantId
      }
    });
  }

  private async recordClassSessionReconnectGraceAudit(
    event: 'started' | 'cancelled' | 'expired',
    session: ClassSessionMongoDocument,
    participant?: ParticipantMongoDocument,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLogs?.record({
      actorId: participant?.userId ?? session.teacherId,
      actorName: participant?.displayName,
      actorRoles: participant ? [participant.role] : ['system'],
      action: `class_sessions.teacher_reconnect_grace.${event}`,
      resourceType: 'class_session',
      resourceId: session.id,
      metadata: {
        summary: `Teacher reconnect grace ${event}`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        teacherId: session.teacherId,
        event,
        ...extra
      }
    });
  }

  private async recordClassSessionTeacherConnectionAudit(
    event: 'disconnected' | 'reconnected',
    session: ClassSessionMongoDocument,
    participant: ParticipantMongoDocument
  ): Promise<void> {
    await this.auditLogs?.record({
      actorId: participant.userId ?? session.teacherId,
      actorName: participant.displayName,
      actorRoles: [participant.role],
      action: `class_sessions.teacher.${event}`,
      resourceType: 'class_session',
      resourceId: session.id,
      targetUserId: participant.userId,
      targetType: 'participant',
      targetId: participant.id,
      metadata: {
        summary: `Class-session teacher ${event}`,
        sessionId: session.id,
        batchId: session.batchId,
        roomId: session.roomId,
        teacherId: session.teacherId,
        participantId: participant.id,
        event
      }
    });
  }

  private auditErrorReason(error: unknown): string {
    const status = typeof (error as { getStatus?: () => number })?.getStatus === 'function'
      ? (error as { getStatus: () => number }).getStatus()
      : undefined;
    if (status === 400) {
      return 'bad_request';
    }
    if (status === 403) {
      return 'forbidden';
    }
    if (status === 404) {
      return 'not_found';
    }
    if (status === 409) {
      return 'conflict';
    }
    if (status === 503) {
      return 'service_unavailable';
    }
    if (error instanceof Error && error.name) {
      return this.safeMetricLabel(error.name);
    }
    return 'unknown';
  }

  private classSessionMetricRole(
    user: SocketUser,
    session: Pick<ClassSessionMongoDocument, 'teacherId'>,
    participant?: Pick<ParticipantMongoDocument, 'role'>
  ): string {
    if (participant?.role === Role.HOST) {
      return 'teacher';
    }
    if (participant?.role === Role.CO_HOST) {
      return 'admin';
    }
    if (participant?.role === Role.PARTICIPANT) {
      return 'student';
    }
    if (this.isAdminSocketUser(user)) {
      return 'admin';
    }
    if (user.id === session.teacherId || user.roles.includes('TEACHER')) {
      return 'teacher';
    }
    if (user.roles.includes('STUDENT')) {
      return 'student';
    }
    return 'other';
  }

  private safeMetricLabel(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized.slice(0, 64) || 'unknown';
  }

  private unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
    (timer as { unref?: () => void }).unref?.();
  }

  private assertClassSessionRoomIsLive(session: ClassSessionMongoDocument): void {
    if (session.status === 'live') {
      return;
    }
    throw new ConflictException(this.classSessionJoinBlockedMessage(session.status));
  }

  private async requireLiveClassSessionForRoom(roomId: string): Promise<ClassSessionMongoDocument> {
    const session = await this.classSessions.findOne({ roomId });
    if (!session) {
      throw new NotFoundException('Class session not found.');
    }
    this.assertClassSessionRoomIsLive(session);
    return session;
  }

  private async resolveClassSessionAccessBySessionId(sessionId: string, batchId?: string): Promise<{ batchId: string; teacherId: string }> {
    const persisted = await this.classSessions.findById(sessionId);
    if (persisted) {
      return { batchId: persisted.batchId, teacherId: persisted.teacherId };
    }

    if (!batchId) {
      throw new NotFoundException('Class session not found.');
    }

    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } });
    if (!batch) {
      throw new NotFoundException('Class session not found.');
    }

    const resolvedBatchId = String(batch.id ?? batch._id ?? batchId);
    const schedules = await this.batchSchedules.find({ batchId: resolvedBatchId }).sort({ dayOfWeek: 1 });
    if (!planClassSessions(batch, schedules).some((session) => session.id === sessionId)) {
      throw new NotFoundException('Class session not found.');
    }

    return { batchId: resolvedBatchId, teacherId: batch.teacherId };
  }

  private async assertSocketCanAccessClassSessionBatch(batchId: string, teacherId: string, user: SocketUser): Promise<void> {
    if (this.isAdminSocketUser(user)) {
      return;
    }
    if (user.roles.includes('TEACHER') && teacherId === user.id) {
      return;
    }
    if (user.roles.includes('STUDENT') && (await this.studentEnrollments.isStudentEnrolledInBatch(user.id, batchId))) {
      return;
    }
    throw new ForbiddenException('You are not allowed to open this class session.');
  }

  private isClassSessionTeacherUser(session: ClassSessionMongoDocument, user: SocketUser): boolean {
    return user.roles.includes('TEACHER') && session.teacherId === user.id;
  }

  private isClassSessionTeacherParticipant(session: ClassSessionMongoDocument, participant: ParticipantMongoDocument): boolean {
    return participant.userId === session.teacherId || (participant.role === Role.HOST && participant.id === session.teacherId);
  }

  private classSessionLifecyclePayload(session: ClassSessionMongoDocument): ClassSessionLifecycleEvent {
    return {
      sessionId: session.id,
      batchId: session.batchId,
      roomId: session.roomId,
      status: 'completed',
      ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
      ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {})
    };
  }

  private classSessionEntitlements(
    session: ClassSessionMongoDocument,
    user: SocketUser
  ): { role: Role; permissions: Permissions } {
    if (session.teacherId === user.id) {
      return { role: Role.HOST, permissions: DEFAULT_PARTICIPANT_PERMISSIONS };
    }
    if (this.isAdminSocketUser(user)) {
      return { role: Role.CO_HOST, permissions: DEFAULT_PARTICIPANT_PERMISSIONS };
    }
    const liveSettings = this.classSessionLiveSettings(session);
    return {
      role: Role.PARTICIPANT,
      permissions: {
        ...CLASS_SESSION_STUDENT_PERMISSIONS,
        canPublishAudio: liveSettings.media.allowStudentsToUnmuteSelf,
        canPublishVideo: liveSettings.media.allowStudentsToStartCameraSelf,
        canShareScreen:
          liveSettings.studentScreenShare.studentScreenShareEnabled &&
          !liveSettings.studentScreenShare.studentScreenShareRequiresApproval,
        canChat: liveSettings.chat.privateTeacherStudentChatEnabled || liveSettings.chat.teacherBroadcastEnabled
      }
    };
  }

  private classSessionLiveSettings(session: Pick<ClassSessionMongoDocument, 'liveSettings'>): LiveClassSettings {
    const settings = session.liveSettings;
    return {
      media: { ...SYSTEM_LIVE_CLASS_SETTINGS.media, ...settings?.media },
      chat: { ...SYSTEM_LIVE_CLASS_SETTINGS.chat, ...settings?.chat },
      whiteboard: { ...SYSTEM_LIVE_CLASS_SETTINGS.whiteboard, ...settings?.whiteboard },
      speaking: { ...SYSTEM_LIVE_CLASS_SETTINGS.speaking, ...settings?.speaking },
      recording: { ...SYSTEM_LIVE_CLASS_SETTINGS.recording, ...settings?.recording },
      attendance: { ...SYSTEM_LIVE_CLASS_SETTINGS.attendance, ...settings?.attendance },
      access: { ...SYSTEM_LIVE_CLASS_SETTINGS.access, ...settings?.access },
      materials: { ...SYSTEM_LIVE_CLASS_SETTINGS.materials, ...settings?.materials },
      notifications: { ...SYSTEM_LIVE_CLASS_SETTINGS.notifications, ...settings?.notifications },
      questionQueue: { ...SYSTEM_LIVE_CLASS_SETTINGS.questionQueue, ...settings?.questionQueue },
      recordingRetention: { ...SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention, ...settings?.recordingRetention },
      studentScreenShare: { ...SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare, ...settings?.studentScreenShare },
      advancedAnalytics: { ...SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics, ...settings?.advancedAnalytics },
      inactiveDetection: { ...SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection, ...settings?.inactiveDetection },
      bandwidthPolicy: { ...SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy, ...settings?.bandwidthPolicy },
      exportControls: { ...SYSTEM_LIVE_CLASS_SETTINGS.exportControls, ...settings?.exportControls }
    };
  }

  private async assertClassSessionStudentScreenShareAllowed(
    session: ClassSessionMongoDocument,
    participant: ParticipantMongoDocument,
    permission: Permissions,
    source: string | undefined
  ): Promise<void> {
    if (participant.role !== Role.PARTICIPANT) {
      return;
    }
    const settings = this.classSessionLiveSettings(session).studentScreenShare;
    if (source === 'whiteboard') {
      throw new ForbiddenException('Only the teacher can share the class whiteboard.');
    }
    if (!settings.studentScreenShareEnabled) {
      throw new ForbiddenException('Student screen sharing is disabled for this class.');
    }
    if (settings.studentScreenShareRequiresApproval && !permission.canShareScreen) {
      throw new ForbiddenException('Screen sharing requires teacher approval.');
    }
    const activeStudentShares = await this.activeStudentScreenShareCount(session.roomId ?? participant.roomId, participant.id);
    if (activeStudentShares >= settings.maxActiveStudentShares) {
      throw new ConflictException('The active student screen share limit has been reached.');
    }
  }

  private async activeStudentScreenShareCount(roomId: string, excludingParticipantId: string): Promise<number> {
    const producers = await this.producers
      .find({
        roomId,
        participantId: { $ne: excludingParticipantId },
        kind: 'screen',
        status: 'live',
        source: { $ne: 'whiteboard' }
      })
      .select('participantId')
      .lean()
      .exec();
    const participantIds = Array.from(new Set(producers.map((producer) => String(producer.participantId)).filter(Boolean)));
    if (!participantIds.length) {
      return 0;
    }
    return this.participants.countDocuments({
      _id: { $in: participantIds },
      roomId,
      role: Role.PARTICIPANT
    });
  }

  private async applyClassSessionEntitlements(
    room: RoomMongoDocument,
    participant: ParticipantMongoDocument,
    entitlements: { role: Role; permissions: Permissions }
  ): Promise<void> {
    const participantUpdate: Partial<ParticipantDocument> = {};
    if (participant.role !== entitlements.role) {
      participantUpdate.role = entitlements.role;
    }
    if (participant.audioEnabled !== entitlements.permissions.canPublishAudio) {
      participantUpdate.audioEnabled = entitlements.permissions.canPublishAudio;
    }
    if (participant.videoEnabled !== entitlements.permissions.canPublishVideo) {
      participantUpdate.videoEnabled = entitlements.permissions.canPublishVideo;
    }
    if (Object.keys(participantUpdate).length) {
      await this.participants.updateOne({ _id: participant.id, roomId: room.id }, { $set: participantUpdate });
    }
    await this.permissions.updateOne(
      { roomId: room.id, participantId: participant.id },
      { $set: entitlements.permissions },
      { upsert: true }
    );
    if (entitlements.role === Role.HOST && room.hostId !== participant.id) {
      await this.rooms.updateOne({ _id: room.id }, { $set: { hostId: participant.id } });
      room.hostId = participant.id;
    }
  }

  private isAdminSocketUser(user: SocketUser): boolean {
    return user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN');
  }

  private classSessionJoinBlockedMessage(status: ClassSessionMongoDocument['status']): string {
    if (status === 'completed') {
      return 'This class session has ended.';
    }
    if (status === 'cancelled') {
      return 'This class session was cancelled.';
    }
    return 'The teacher has not started this class session yet.';
  }

  private async requireRoomOwnerLookup(roomId: string): Promise<RoomOwnerLookupResponse> {
    const lookup = await this.nodeRegistry.lookupRoomOwner(roomId);
    if (!lookup.owner || !lookup.available) {
      throw new ServiceUnavailableException(`Room owner is unavailable: ${lookup.reason ?? 'missing'}`);
    }
    return lookup;
  }

  private async getPermissions(roomId: string, participantId: string): Promise<Permissions> {
    const doc = await this.permissions.findOne({ roomId, participantId });
    return doc ? this.toPermissions(doc) : DEFAULT_PARTICIPANT_PERMISSIONS;
  }

  private toChatMessage(doc: ChatMessageMongoDocument): ChatMessage {
    return {
      id: doc.id,
      ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
      ...(doc.batchId ? { batchId: doc.batchId } : {}),
      roomId: doc.roomId,
      ...(doc.channelId ? { channelId: doc.channelId } : {}),
      ...(doc.chatChannelId ? { chatChannelId: doc.chatChannelId } : {}),
      senderId: doc.senderId,
      senderName: doc.senderName,
      senderRole: doc.senderRole,
      ...(doc.recipientId ? { recipientId: doc.recipientId } : {}),
      scope: doc.scope ?? (doc.recipientId ? 'private' : 'broadcast'),
      ...(doc.threadKey ? { threadKey: doc.threadKey } : {}),
      message: doc.message,
      ...(doc.attachments?.length
        ? {
            attachments: doc.attachments.map((attachment) => ({
              id: attachment.id,
              ...(attachment.attachmentId ? { attachmentId: attachment.attachmentId } : {}),
              type: attachment.type,
              ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
              ...(attachment.title ? { title: attachment.title } : {}),
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
              ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
              ...(attachment.storageProvider ? { storageProvider: attachment.storageProvider } : {}),
              ...(attachment.downloadUrl ? { downloadUrl: attachment.downloadUrl } : {}),
              ...(attachment.url ? { url: attachment.url } : {}),
              ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
              ...(attachment.createdAt ? { createdAt: this.dateToIso(attachment.createdAt) } : {})
            }))
          }
        : {}),
      shadowMuted: doc.shadowMuted,
      createdAt: this.dateToIso(doc.createdAt),
      ...(doc.deletedAt ? { deletedAt: this.dateToIso(doc.deletedAt) } : {})
    };
  }

  private toChatReadState(doc: ChatReadStateMongoDocument): ChatReadState {
    return {
      id: doc.id,
      sessionId: doc.sessionId,
      ...(doc.batchId ? { batchId: doc.batchId } : {}),
      roomId: doc.roomId,
      ...(doc.channelId ? { channelId: doc.channelId } : {}),
      ...(doc.chatChannelId ? { chatChannelId: doc.chatChannelId } : {}),
      userId: doc.userId,
      ...(doc.participantId ? { participantId: doc.participantId } : {}),
      scope: doc.scope,
      ...(doc.threadKey ? { threadKey: doc.threadKey } : {}),
      lastReadAt: this.dateToIso(doc.lastReadAt),
      updatedAt: this.dateToIso(doc.updatedAt ?? doc.lastReadAt)
    };
  }

  private toChatReadReceiptEvent(state: ChatReadState): ChatReadReceiptEvent {
    return {
      sessionId: state.sessionId,
      ...(state.batchId ? { batchId: state.batchId } : {}),
      roomId: state.roomId,
      ...(state.channelId ? { channelId: state.channelId } : {}),
      ...(state.chatChannelId ? { chatChannelId: state.chatChannelId } : {}),
      scope: state.scope,
      ...(state.threadKey ? { threadKey: state.threadKey } : {}),
      ...(state.participantId ? { participantId: state.participantId } : {}),
      userId: state.userId,
      lastReadAt: state.lastReadAt
    };
  }

  private chatReadStateKey(sessionId: string, userId: string, scope: ChatMessageScope, threadKey?: string): string {
    return `${sessionId}:${userId}:${scope}:${threadKey ?? 'broadcast'}`;
  }

  private chatSenderRole(role: Role): string {
    if (role === Role.HOST || role === Role.CO_HOST) {
      return 'teacher';
    }
    return 'student';
  }

  private chatRequesterRole(participant: ParticipantMongoDocument, user: SocketUser): 'teacher' | 'student' | 'admin' {
    if (user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN')) {
      return 'admin';
    }
    if (participant.role === Role.HOST || participant.role === Role.CO_HOST) {
      return 'teacher';
    }
    return 'student';
  }

  private dateToIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private async assertParticipant(roomId: string, participantId: string): Promise<ParticipantMongoDocument> {
    const participant = await this.participants.findOne({ _id: participantId, roomId, admitted: true, leftAt: { $exists: false } });
    if (!participant) {
      throw new ForbiddenException('Not an active room participant');
    }
    return participant;
  }

  private async assertModerator(roomId: string, actorParticipantId: string, hostOnly: boolean): Promise<ParticipantMongoDocument> {
    const actor = await this.assertParticipant(roomId, actorParticipantId);
    const allowed = hostOnly ? actor.role === Role.HOST : actor.role === Role.HOST || actor.role === Role.CO_HOST;
    if (!allowed) {
      throw new ForbiddenException('Moderator role required');
    }
    return actor;
  }

  private async assertCanControlProducer(producer: ProducerMongoDocument, participantId: string): Promise<ParticipantMongoDocument> {
    if (producer.participantId === participantId) {
      return this.assertParticipant(producer.roomId, participantId);
    }
    return this.assertModerator(producer.roomId, participantId, false);
  }

  private async assertNotBanned(roomId: string, userId: string): Promise<void> {
    const ban = await this.moderation.exists({ roomId, userId, action: 'ban', active: true });
    if (ban) {
      throw new ForbiddenException('Participant is banned');
    }
  }

  private async addModeration(
    roomId: string,
    actorParticipantId: string,
    participantId: string,
    action: 'kick' | 'ban' | 'shadow-mute' | 'force-mute' | 'disable-camera' | 'stop-screen',
    reason?: string
  ): Promise<{ actor: ParticipantMongoDocument; participant: ParticipantMongoDocument }> {
    const actor = await this.assertModerator(roomId, actorParticipantId, false);
    const participant = await this.participants.findById(participantId);
    if (!participant || participant.roomId !== roomId) {
      throw new NotFoundException('Participant not found');
    }
    await this.moderation.create({
      roomId,
      participantId,
      userId: participant?.userId,
      actorId: actorParticipantId,
      action,
      reason,
      active: true
    });
    return { actor, participant };
  }

  private async assertNoActiveStudentMediaModeration(roomId: string, participantId: string, kind: 'audio' | 'video'): Promise<void> {
    const action = kind === 'audio' ? 'force-mute' : 'disable-camera';
    const moderation = await this.moderation.exists({ roomId, participantId, action, active: true });
    if (moderation) {
      throw new ForbiddenException(kind === 'audio' ? 'Microphone disabled by moderator' : 'Camera disabled by moderator');
    }
  }

  private studentMediaModerationMessage(action: StudentMediaModerationAction): string {
    switch (action) {
      case 'mute-mic':
        return 'Teacher muted your microphone.';
      case 'unmute-mic':
        return 'Teacher allowed your microphone. You can turn it on when ready.';
      case 'stop-camera':
        return 'Teacher stopped your camera.';
      case 'restore-camera':
        return 'Teacher allowed your camera. You can turn it on when ready.';
    }
  }

  private async handleConsumerLayerEvent(event: ConsumerLayerEvent): Promise<void> {
    if (isPersistedMongoId(event.consumerId)) {
      await this.consumers.updateOne(
        { _id: event.consumerId },
        {
          $set: {
            currentLayers: event.currentLayers,
            targetLayers: event.targetLayers,
            preferredLayers: event.preferredLayers,
            currentSvcLayers: event.currentSvcLayers,
            targetSvcLayers: event.targetSvcLayers,
            preferredSvcLayers: event.preferredSvcLayers,
            layerSwitchReason: event.reason,
            layerSwitchedAt: new Date(event.timestamp)
          }
        }
      );
    }
    switch (event.type) {
      case 'changed':
        this.metrics.successfulLayerSwitches.labels(event.reason).inc();
        if (event.currentSvcLayers) {
          this.metrics.svcLayerSwitches.labels(event.reason).inc();
        }
        if (event.switchDurationMs !== undefined) {
          this.metrics.layerSwitchDuration.labels(event.reason).observe(event.switchDurationMs);
        }
        break;
      case 'switch-failed':
        this.metrics.failedLayerSwitches.labels(event.reason).inc();
        if (event.targetSvcLayers) {
          this.metrics.svcLayerSwitchFailures.labels(event.reason).inc();
        }
        break;
      case 'unavailable':
        this.metrics.unavailableLayerCount.labels(event.reason).inc();
        if (event.targetSvcLayers) {
          this.metrics.svcUnavailableLayerCount.labels(event.reason).inc();
        }
        break;
      case 'switching':
        break;
    }
    for (const listener of this.layerEventListeners) {
      listener(event);
    }
  }

  private async handleProducerDynacastEvent(event: ProducerDynacastEvent): Promise<void> {
    await this.producers.updateOne(
      { _id: event.producerId },
      {
        $set: {
          dynacastState: event.state
        }
      }
    );
    const producer = await this.producers.findById(event.producerId);
    if (event.type === 'layers-needed' && event.neededLayers.length > 0) {
      this.metrics.dynacastLayerResumes.labels(event.reason).inc(event.neededLayers.length);
    }
    if (event.type === 'layers-unneeded' && event.unneededLayers.length > 0) {
      this.metrics.dynacastLayerSuspends.labels(event.reason).inc(event.unneededLayers.length);
    }
    if (event.type === 'updated' && (event.neededLayers.length > 0 || event.unneededLayers.length > 0)) {
      this.metrics.dynacastLayerDemandChanges.labels(event.reason).inc();
    }
    if (producer) {
      this.metrics.dynacastEstimatedBandwidthSaved.labels(producer.kind).set(event.estimatedBandwidthSavedBps);
    }
    for (const listener of this.producerDynacastEventListeners) {
      listener(event);
    }
  }

  private handleConsumerQualityState(state: ConsumerQualityState): void {
    this.metrics.consumerQualityScore.labels(state.roomId, state.participantId, state.consumerId).set(state.score.score);
    this.metrics.recommendedBitrate.labels(state.roomId, state.participantId, 'consumer').set(state.bitrate.recommendedBitrate);
    this.metrics.availableBitrate.labels(state.roomId, state.participantId, 'consumer').set(state.bitrate.availableBitrate);
    this.metrics.allocatedBitrate.labels(state.roomId, state.participantId, 'consumer').set(state.bitrate.allocatedBitrate);
    this.metrics.pacingQueueBytes.labels(state.roomId, state.participantId, 'consumer').set(state.pacingQueueDepth);
    this.metrics.packetLoss.labels(state.roomId, state.participantId).set(state.network.packetLoss);
    this.metrics.rtt.labels(state.roomId, state.participantId).set(state.network.rtt);
    this.metrics.jitter.labels(state.roomId, state.participantId).set(state.network.jitter);
    for (const reason of state.score.reasons.filter((reason) => reason !== 'stable')) {
      this.metrics.qualityDegradations.labels('consumer', reason).inc();
    }
    if (state.score.reasons.includes('stable') || state.score.reasons.includes('recovered')) {
      this.metrics.qualityRecoveries.labels('consumer').inc();
    }
    for (const listener of this.consumerQualityEventListeners) {
      listener(state);
    }
  }

  private handleProducerQualityState(state: ProducerQualityState): void {
    this.metrics.producerQualityScore.labels(state.roomId, state.participantId, state.producerId, state.kind).set(state.score.score);
    this.metrics.recommendedBitrate.labels(state.roomId, state.participantId, 'producer').set(state.bitrate.recommendedBitrate);
    this.metrics.availableBitrate.labels(state.roomId, state.participantId, 'producer').set(state.bitrate.availableBitrate);
    this.metrics.allocatedBitrate.labels(state.roomId, state.participantId, 'producer').set(state.bitrate.allocatedBitrate);
    for (const layer of state.layerScores.concat(state.svcLayerScores)) {
      this.metrics.layerQualityScore
        .labels(state.roomId, state.producerId, String(layer.layer?.spatialLayer ?? layer.svcLayer?.spatialLayerId ?? 'x'), String(layer.layer?.temporalLayer ?? layer.svcLayer?.temporalLayerId ?? 'x'))
        .set(layer.score.score);
    }
    for (const reason of state.score.reasons.filter((reason) => reason !== 'stable')) {
      this.metrics.qualityDegradations.labels('producer', reason).inc();
    }
    if (state.score.reasons.includes('stable') || state.score.reasons.includes('recovered')) {
      this.metrics.qualityRecoveries.labels('producer').inc();
    }
    for (const listener of this.producerQualityEventListeners) {
      listener(state);
    }
  }

  private handleTransportQualityState(state: TransportQualityState): void {
    this.metrics.transportQualityScore.labels(state.roomId, state.participantId, state.transportId).set(state.score.score);
    this.metrics.pacingQueueBytes.labels(state.roomId, state.participantId, 'transport').set(state.pacingQueueDepth);
    this.metrics.transportTargetBitrate.labels(state.roomId, state.participantId, state.transportId).set(state.targetBitrate);
    this.metrics.transportAllocatedBitrate.labels(state.roomId, state.participantId, state.transportId).set(state.allocatedBitrate);
    this.metrics.transportActualBitrate.labels(state.roomId, state.participantId, state.transportId).set(state.actualBitrate);
    for (const listener of this.transportQualityEventListeners) {
      listener(state);
    }
  }

  private handleRoomQualityState(state: RoomQualityState): void {
    this.setDistributedRoomQualityState(state);
    this.metrics.roomQualityScore.labels(state.roomId).set(state.score.score);
    this.metrics.roomTargetBitrate.labels(state.roomId).set(state.targetBitrate);
    this.metrics.roomAllocatedBitrate.labels(state.roomId).set(state.allocatedBitrate);
    this.metrics.roomActualBitrate.labels(state.roomId).set(state.actualBitrate);
    this.metrics.roomCongestionState.labels(state.roomId, 'underuse').set(state.congestionState === 'underuse' ? 1 : 0);
    this.metrics.roomCongestionState.labels(state.roomId, 'normal').set(state.congestionState === 'normal' ? 1 : 0);
    this.metrics.roomCongestionState.labels(state.roomId, 'overuse').set(state.congestionState === 'overuse' ? 1 : 0);
    void this.emitRoomQualitySummaryUpdate(state.roomId).catch(() => undefined);
    for (const listener of this.roomQualityEventListeners) {
      listener(state);
    }
  }

  private handleDistributedRoomSignal(signal: RoomSignalEnvelope): void {
    const [payload] = signal.payload;
    if (signal.event === 'room:quality-summary-updated') {
      if (
        isRoomQualitySummaryStatePayload(payload)
        && !this.shouldIgnoreDistributedStateUpdate({ roomId: payload.roomId, updatedAt: payload.updatedAt })
      ) {
        this.setDistributedRoomQualitySummaryState(payload);
      }
      return;
    }
    if (signal.event === 'room:updated') {
      if (isRoomPayloadWithProfile(payload)) {
        void this.handleDistributedRoomProfileUpdate(payload).catch(() => undefined);
      }
      return;
    }
    if (signal.event === 'room:quality-updated') {
      if (isRoomQualityState(payload) && !this.shouldIgnoreDistributedStateUpdate({ roomId: payload.roomId, updatedAt: payload.updatedAt })) {
        this.setDistributedRoomQualityState(payload);
      }
      return;
    }
    if (signal.event === 'consumer:score-updated') {
      if (
        isConsumerQualityState(payload)
        && !this.shouldIgnoreDistributedStateUpdate({
          roomId: payload.roomId,
          participantId: payload.participantId,
          entityId: payload.consumerId,
          entityTombstones: this.distributedConsumerTombstones,
          updatedAt: payload.updatedAt
        })
      ) {
        this.setDistributedQualityState(this.distributedConsumerQualityStates, payload.consumerId, payload);
      }
      return;
    }
    if (signal.event === 'producer:score-updated') {
      if (
        isProducerQualityState(payload)
        && !this.shouldIgnoreDistributedStateUpdate({
          roomId: payload.roomId,
          participantId: payload.participantId,
          entityId: payload.producerId,
          entityTombstones: this.distributedProducerTombstones,
          updatedAt: payload.updatedAt
        })
      ) {
        this.setDistributedQualityState(this.distributedProducerQualityStates, payload.producerId, payload);
      }
      return;
    }
    if (signal.event === 'transport:quality-updated') {
      if (
        isTransportQualityState(payload)
        && !this.shouldIgnoreDistributedStateUpdate({
          roomId: payload.roomId,
          participantId: payload.participantId,
          updatedAt: payload.updatedAt
        })
      ) {
        this.setDistributedQualityState(this.distributedTransportQualityStates, payload.transportId, payload);
      }
      return;
    }
    if (signal.event === 'producer:closed' && typeof payload === 'string') {
      this.markObservabilityTombstone(this.distributedProducerTombstones, payload);
      this.distributedProducerQualityStates.delete(payload);
      return;
    }
    if (signal.event === 'consumer:closed' && typeof payload === 'string') {
      this.markObservabilityTombstone(this.distributedConsumerTombstones, payload);
      this.distributedConsumerQualityStates.delete(payload);
      return;
    }
    if (signal.event === 'participant:left' && typeof payload === 'string') {
      this.markObservabilityTombstone(this.distributedParticipantTombstones, participantTombstoneKey(signal.roomId, payload));
      this.deleteDistributedStatesForParticipant(this.distributedConsumerQualityStates, signal.roomId, payload);
      this.deleteDistributedStatesForParticipant(this.distributedProducerQualityStates, signal.roomId, payload);
      this.deleteDistributedStatesForParticipant(this.distributedTransportQualityStates, signal.roomId, payload);
      return;
    }
    if (signal.event === 'room:closed' || signal.event === 'room:failed') {
      this.clearDistributedRoomObservability(signal.roomId);
      void this.cleanupDistributedClosedRoom(signal.roomId);
    }
  }

  private async resolveRoomQualityState(roomId: string): Promise<ResolvedRoomQualityState> {
    const owner = await this.requireRoomOwnerLookup(roomId);
    if (!owner.local && !this.pipeCoordinator.isEnabled()) {
      await this.nodeRegistry.assertLocalRoomOwner(roomId);
    }
    const distributedStateObservedAt = this.distributedRoomQualityObservedAt.get(roomId);
    const distributedStateWasStale = distributedStateObservedAt !== undefined && Date.now() - distributedStateObservedAt > ROOM_QUALITY_SIGNAL_STALE_MS;
    const localState = this.media.roomQualityState(roomId);
    const freshDistributedState = owner.local ? undefined : this.readFreshRoomQualityState(roomId);
    const quality = owner.local ? localState : freshDistributedState ?? localState;
    if (!quality) {
      throw new NotFoundException('Room quality state not available');
    }
    const qualityObservedAt = this.distributedRoomQualityObservedAt.get(roomId);
    const warnings: string[] = [];
    if (!owner.available) {
      warnings.push(`room_owner_${owner.reason ?? 'unavailable'}`);
    }
    if (!owner.local && !freshDistributedState) {
      warnings.push('owner_quality_signal_unavailable');
    }
    const distributedSignalAgeMs = qualityObservedAt === undefined ? undefined : Math.max(0, Date.now() - qualityObservedAt);
    if (distributedStateWasStale) {
      warnings.push('owner_quality_signal_stale');
    }
    return {
      owner,
      quality,
      qualitySource: owner.local ? 'local-owner' : freshDistributedState ? 'remote-signal-cache' : 'local-fallback',
      ownerAuthoritativeQuality: owner.local || Boolean(freshDistributedState),
      distributedSignalAgeMs,
      warnings
    };
  }

  private clearDistributedRoomObservability(roomId: string): void {
    this.markObservabilityTombstone(this.distributedRoomTombstones, roomId);
    this.distributedRoomQualityStates.delete(roomId);
    this.distributedRoomQualityObservedAt.delete(roomId);
    this.distributedRoomQualitySummaryStates.delete(roomId);
    this.distributedRoomQualitySummaryObservedAt.delete(roomId);
    this.deleteDistributedStatesForRoom(this.distributedConsumerQualityStates, roomId);
    this.deleteDistributedStatesForRoom(this.distributedProducerQualityStates, roomId);
    this.deleteDistributedStatesForRoom(this.distributedTransportQualityStates, roomId);
    this.appliedRoomProfileSignatures.delete(roomId);
  }

  private shouldIgnoreDistributedStateUpdate(options: {
    roomId: string;
    participantId?: string;
    entityId?: string;
    entityTombstones?: Map<string, number>;
    updatedAt: string;
  }): boolean {
    const updatedAtMs = isoToEpoch(options.updatedAt) ?? Date.now();
    const roomTombstone = this.readRecentObservabilityTombstone(this.distributedRoomTombstones, options.roomId);
    if (roomTombstone !== undefined && updatedAtMs <= roomTombstone) {
      return true;
    }
    if (options.participantId) {
      const participantTombstone = this.readRecentObservabilityTombstone(
        this.distributedParticipantTombstones,
        participantTombstoneKey(options.roomId, options.participantId)
      );
      if (participantTombstone !== undefined && updatedAtMs <= participantTombstone) {
        return true;
      }
    }
    if (options.entityId && options.entityTombstones) {
      const entityTombstone = this.readRecentObservabilityTombstone(options.entityTombstones, options.entityId);
      if (entityTombstone !== undefined && updatedAtMs <= entityTombstone) {
        return true;
      }
    }
    return false;
  }

  private markObservabilityTombstone(map: Map<string, number>, key: string, observedAt = Date.now()): void {
    this.pruneObservabilityTombstones(map, observedAt);
    map.set(key, observedAt);
  }

  private async cleanupDistributedClosedRoom(roomId: string): Promise<void> {
    if (this.pipeCoordinator.isEnabled()) {
      try {
        await this.pipeCoordinator.closeRoomBindings(roomId);
      } catch {
        this.metrics.pipeCleanupFailures.labels('distributed_room_closed_bindings').inc();
      }
    }
    const cleanup = normalizeMediaRoomCleanupSummary(await this.media.closeRoom(roomId));
    this.applyLocalRoomCleanupMetrics(roomId, cleanup);
  }

  private applyLocalRoomCleanupMetrics(roomId: string, cleanup: LocalRoomCleanupMetrics, options: { includeParticipants?: boolean } = {}): void {
    if (options.includeParticipants ?? true) {
      for (const _participantId of cleanup.participantIds) {
        this.metrics.activeParticipants.labels(roomId).dec();
      }
    }
    for (const [kind, count] of Object.entries(cleanup.producerCounts)) {
      for (let index = 0; index < count; index += 1) {
        this.metrics.activeProducers.labels(kind).dec();
      }
    }
    for (let index = 0; index < cleanup.consumerCount; index += 1) {
      this.metrics.activeConsumers.dec();
    }
    for (let index = 0; index < cleanup.transportCount; index += 1) {
      this.metrics.activeTransports.dec();
    }
  }

  private readRecentObservabilityTombstone(map: Map<string, number>, key: string, now = Date.now()): number | undefined {
    this.pruneObservabilityTombstones(map, now);
    return map.get(key);
  }

  private pruneObservabilityTombstones(map: Map<string, number>, now = Date.now()): void {
    for (const [key, observedAt] of map) {
      if (now - observedAt > OBSERVABILITY_TOMBSTONE_TTL_MS) {
        map.delete(key);
      }
    }
  }

  private deleteDistributedStatesForRoom<T extends { roomId: string; updatedAt: string }>(
    cache: Map<string, DistributedStateEntry<T>>,
    roomId: string
  ): void {
    for (const [key, entry] of cache) {
      if (entry.state.roomId === roomId) {
        cache.delete(key);
      }
    }
  }

  private deleteDistributedStatesForParticipant<T extends { roomId: string; participantId: string; updatedAt: string }>(
    cache: Map<string, DistributedStateEntry<T>>,
    roomId: string,
    participantId: string
  ): void {
    for (const [key, entry] of cache) {
      if (entry.state.roomId === roomId && entry.state.participantId === participantId) {
        cache.delete(key);
      }
    }
  }

  private setDistributedRoomQualityState(state: RoomQualityState): void {
    const current = this.distributedRoomQualityStates.get(state.roomId);
    if (current && compareIsoTimestamps(state.updatedAt, current.updatedAt) < 0) {
      return;
    }
    this.distributedRoomQualityStates.set(state.roomId, state);
    this.distributedRoomQualityObservedAt.set(state.roomId, Date.now());
  }

  private setDistributedRoomQualitySummaryState(state: RoomQualitySummaryState): void {
    const current = this.distributedRoomQualitySummaryStates.get(state.roomId);
    if (current && compareIsoTimestamps(state.updatedAt, current.updatedAt) < 0) {
      return;
    }
    this.distributedRoomQualitySummaryStates.set(state.roomId, state);
    this.distributedRoomQualitySummaryObservedAt.set(state.roomId, Date.now());
  }

  private setDistributedQualityState<T extends { roomId: string; updatedAt: string }>(
    cache: Map<string, DistributedStateEntry<T>>,
    key: string,
    state: T
  ): void {
    const current = cache.get(key);
    if (current && compareIsoTimestamps(state.updatedAt, current.state.updatedAt) < 0) {
      return;
    }
    cache.set(key, {
      state,
      observedAt: Date.now()
    });
  }

  private readFreshRoomQualityState(roomId: string): RoomQualityState | undefined {
    const state = this.distributedRoomQualityStates.get(roomId);
    const observedAt = this.distributedRoomQualityObservedAt.get(roomId);
    if (!state || observedAt === undefined) {
      return undefined;
    }
    if (Date.now() - observedAt > ROOM_QUALITY_SIGNAL_STALE_MS) {
      this.distributedRoomQualityStates.delete(roomId);
      this.distributedRoomQualityObservedAt.delete(roomId);
      return undefined;
    }
    return state;
  }

  private readFreshRoomQualitySummaryState(roomId: string): RoomQualitySummaryState | undefined {
    const state = this.distributedRoomQualitySummaryStates.get(roomId);
    const observedAt = this.distributedRoomQualitySummaryObservedAt.get(roomId);
    if (!state || observedAt === undefined) {
      return undefined;
    }
    if (Date.now() - observedAt > ROOM_QUALITY_SIGNAL_STALE_MS) {
      this.distributedRoomQualitySummaryStates.delete(roomId);
      this.distributedRoomQualitySummaryObservedAt.delete(roomId);
      return undefined;
    }
    return state;
  }

  private readFreshDistributedState<T extends { roomId: string; updatedAt: string }>(
    cache: Map<string, DistributedStateEntry<T>>,
    key: string
  ): T | undefined {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.observedAt > DISTRIBUTED_QUALITY_STALE_MS) {
      cache.delete(key);
      return undefined;
    }
    return entry.state;
  }

  private async handleDistributedRoomProfileUpdate(room: Pick<Room, 'id' | 'mediaProfile'>): Promise<void> {
    const signature = roomProfileSignature(room.mediaProfile);
    if (this.appliedRoomProfileSignatures.get(room.id) === signature) {
      return;
    }
    await this.applyRoomMediaProfile(room.id, room.mediaProfile.id);
  }

  private async syncDistributedConsumerDemandByProducer(
    roomId: string,
    producerId: string,
    options: { ownerLookup?: RoomOwnerLookupResponse; consumerId?: string } = {}
  ): Promise<void> {
    if (!this.pipeCoordinator.isEnabled()) {
      return;
    }
    const ownerLookup = options.ownerLookup ?? await this.requireRoomOwnerLookup(roomId);
    const producer = await this.producers.findById(producerId);
    if (!producer || producer.status === 'closed') {
      return;
    }
    const producerHostedLocally = await this.isProducerHostedLocally(producer, ownerLookup);
    if (producerHostedLocally) {
      return;
    }
    const demand = await this.computeLocalConsumerDemand(roomId, producerId);
    if (ownerLookup.local) {
      await this.pipeCoordinator.syncOriginConsumerState({
        roomId,
        producerId,
        ...demand
      });
      return;
    }
    await this.pipeCoordinator.syncRemoteConsumerState({
      roomId,
      producerId,
      consumerId: options.consumerId,
      ...demand
    });
  }

  private async computeLocalConsumerDemand(roomId: string, producerId: string): Promise<{
    status: 'live' | 'paused';
    priority?: number;
    preferredLayers?: RtpLayerSelection;
    preferredSvcLayers?: SvcLayerSelection;
  }> {
    const consumers = await this.consumers.find({ roomId, producerId, status: { $ne: 'closed' } });
    const localConsumers = consumers.filter((consumer) => this.isConsumerHostedLocally(consumer));
    if (localConsumers.length === 0) {
      return { status: 'paused' };
    }
    const liveConsumers = localConsumers.filter((consumer) => consumer.status === 'live');
    const demandConsumers = liveConsumers.length > 0 ? liveConsumers : localConsumers;
    return {
      status: liveConsumers.length > 0 ? 'live' : 'paused',
      priority: highestConsumerPriority(demandConsumers),
      preferredLayers: mergeLayerSelections(
        demandConsumers.map((consumer) =>
          normalizeLayerSelection(consumer.preferredLayers as RtpLayerSelection | undefined)
          ?? preferredLayerNameToSelection(consumer.preferredLayer)
        )
      ),
      preferredSvcLayers: mergeSvcLayerSelections(
        demandConsumers.map((consumer) => normalizeSvcLayerSelection(consumer.preferredSvcLayers as SvcLayerSelection | undefined))
      )
    };
  }

  private isConsumerHostedLocally(consumer: Pick<ConsumerMongoDocument, 'participantId' | 'transportId'>): boolean {
    try {
      this.media.assertTransportOwner(consumer.transportId, consumer.participantId);
      return true;
    } catch {
      return false;
    }
  }

  private consumerLayerState(doc: ConsumerMongoDocument): ConsumerLayerState {
    return (
      this.readLocalConsumerLayerState(doc.id) ?? {
        roomId: doc.roomId,
        participantId: doc.participantId,
        consumerId: doc.id,
        producerId: doc.producerId,
        preferredLayers: normalizeLayerSelection(doc.preferredLayers as RtpLayerSelection | undefined),
        currentLayers: normalizeLayerSelection(doc.currentLayers as RtpLayerSelection | undefined),
        targetLayers: normalizeLayerSelection(doc.targetLayers as RtpLayerSelection | undefined),
        preferredSvcLayers: normalizeSvcLayerSelection(doc.preferredSvcLayers as SvcLayerSelection | undefined),
        currentSvcLayers: normalizeSvcLayerSelection(doc.currentSvcLayers as SvcLayerSelection | undefined),
        targetSvcLayers: normalizeSvcLayerSelection(doc.targetSvcLayers as SvcLayerSelection | undefined),
        switchedAt: doc.layerSwitchedAt?.toISOString(),
        switchReason: normalizeLayerSwitchReason(doc.layerSwitchReason)
      }
    );
  }

  private toParticipant(doc: ParticipantMongoDocument, permissions: Permissions, consumerLayers?: ConsumerLayerState[]): Participant {
    return {
      id: doc.id,
      userId: doc.userId,
      displayName: doc.displayName,
      socketId: doc.socketId,
      connected: Boolean(doc.socketId),
      role: doc.role,
      audioEnabled: doc.audioEnabled,
      videoEnabled: doc.videoEnabled,
      screenSharing: doc.screenSharing,
      handRaised: doc.handRaised,
      ...(doc.handRaisedAt ? { handRaisedAt: doc.handRaisedAt.toISOString() } : {}),
      allowedToSpeak: doc.allowedToSpeak,
      ...(doc.allowedToSpeakAt ? { allowedToSpeakAt: doc.allowedToSpeakAt.toISOString() } : {}),
      ...(doc.allowedToSpeakBy ? { allowedToSpeakBy: doc.allowedToSpeakBy } : {}),
      admitted: doc.admitted,
      permissions,
      consumerLayers,
      joinedAt: doc.joinedAt.toISOString(),
      lastSeenAt: doc.lastSeenAt.toISOString(),
      ...(doc.lastActiveAt ? { lastActiveAt: doc.lastActiveAt.toISOString() } : {}),
      ...(doc.inactiveSince ? { inactiveSince: doc.inactiveSince.toISOString(), inactive: true } : { inactive: false })
    };
  }

  private toPermissions(doc: PermissionMongoDocument): Permissions {
    return {
      canPublishAudio: doc.canPublishAudio,
      canPublishVideo: doc.canPublishVideo,
      canShareScreen: doc.canShareScreen,
      canChat: doc.canChat
    };
  }

  private toProducer(doc: ProducerMongoDocument): Producer {
    const producerLayerState = this.readLocalProducerLayerState(doc);
    const dynacast = producerLayerState?.dynacast ?? (doc.dynacastState as unknown as ProducerDynacastState | undefined);
    const svc = producerLayerState?.svc ?? (doc.svcState as unknown as ProducerSvcState | undefined);
    return {
      id: doc.id,
      roomId: doc.roomId,
      participantId: doc.participantId,
      kind: doc.kind,
      ...(doc.source ? { source: doc.source } : {}),
      transportId: doc.transportId,
      priority: normalizeConsumerPriority(doc.priority),
      rtpParameters: doc.rtpParameters as unknown as Producer['rtpParameters'],
      svc,
      dynacast,
      quality: this.readLocalProducerQualityState(doc) ?? this.readFreshDistributedState(this.distributedProducerQualityStates, doc.id),
      status: doc.status,
      createdAt: doc.createdAt.toISOString()
    };
  }

  private toConsumer(doc: ConsumerMongoDocument): Consumer {
    return {
      id: doc.id,
      roomId: doc.roomId,
      producerId: doc.producerId,
      participantId: doc.participantId,
      transportId: doc.transportId,
      priority: normalizeConsumerPriority(doc.priority),
      preferredLayer: doc.preferredLayer,
      preferredLayers: normalizeLayerSelection(doc.preferredLayers as RtpLayerSelection | undefined),
      currentLayers: normalizeLayerSelection(doc.currentLayers as RtpLayerSelection | undefined),
      targetLayers: normalizeLayerSelection(doc.targetLayers as RtpLayerSelection | undefined),
      preferredSvcLayers: normalizeSvcLayerSelection(doc.preferredSvcLayers as SvcLayerSelection | undefined),
      currentSvcLayers: normalizeSvcLayerSelection(doc.currentSvcLayers as SvcLayerSelection | undefined),
      targetSvcLayers: normalizeSvcLayerSelection(doc.targetSvcLayers as SvcLayerSelection | undefined),
      layerState: this.consumerLayerState(doc),
      quality: this.readLocalConsumerQualityState(doc.id) ?? this.readFreshDistributedState(this.distributedConsumerQualityStates, doc.id),
      rtpParameters: doc.rtpParameters as unknown as Consumer['rtpParameters'],
      status: doc.status,
      createdAt: doc.createdAt.toISOString()
    };
  }

  private platformRoomReference(
    room:
      | Pick<Room, 'id' | 'name' | 'settings' | 'mediaProfile' | 'hostId'>
      | Pick<RoomMongoDocument, 'id' | 'name' | 'settings' | 'mediaProfile' | 'hostId'>
  ) {
    return {
      roomId: room.id,
      ...(room.name ? { name: room.name } : {}),
      ...(room.settings?.visibility ? { visibility: room.settings.visibility } : {}),
      ...(room.settings?.maxParticipants !== undefined ? { maxParticipants: room.settings.maxParticipants } : {}),
      ...(room.settings?.waitingRoomEnabled !== undefined ? { waitingRoomEnabled: room.settings.waitingRoomEnabled } : {}),
      ...(room.settings?.joinApprovalRequired !== undefined ? { joinApprovalRequired: room.settings.joinApprovalRequired } : {}),
      ...(room.mediaProfile?.id ? { mediaProfileId: room.mediaProfile.id } : {}),
      ...(room.hostId ? { hostParticipantId: room.hostId } : {})
    };
  }

  private platformParticipantReference(participant: Pick<ParticipantMongoDocument, 'id' | 'userId' | 'displayName' | 'role' | 'admitted' | 'nodeId'>) {
    return {
      participantId: participant.id,
      ...(participant.userId ? { userId: participant.userId } : {}),
      ...(participant.displayName ? { displayName: participant.displayName } : {}),
      ...(participant.role ? { role: participant.role } : {}),
      admitted: participant.admitted,
      ...(participant.nodeId ? { nodeId: participant.nodeId } : {})
    };
  }

  private platformProducerReference(
    producer: Pick<ProducerMongoDocument, 'id' | 'participantId' | 'transportId' | 'kind' | 'status' | 'priority'>
  ) {
    return {
      producerId: producer.id,
      participantId: producer.participantId,
      transportId: producer.transportId,
      kind: producer.kind,
      status: producer.status,
      priority: normalizeConsumerPriority(producer.priority)
    };
  }

  private platformConsumerReference(
    consumer: Pick<
      ConsumerMongoDocument,
      'id' | 'participantId' | 'producerId' | 'transportId' | 'status' | 'priority' | 'preferredLayers' | 'preferredSvcLayers'
    >
  ) {
    return {
      consumerId: consumer.id,
      participantId: consumer.participantId,
      producerId: consumer.producerId,
      transportId: consumer.transportId,
      status: consumer.status,
      priority: normalizeConsumerPriority(consumer.priority),
      preferredLayers: normalizeLayerSelection(consumer.preferredLayers as RtpLayerSelection | undefined),
      preferredSvcLayers: normalizeSvcLayerSelection(consumer.preferredSvcLayers as SvcLayerSelection | undefined)
    };
  }

  private platformActorFromParticipant(
    participant: Pick<ParticipantMongoDocument, 'id' | 'userId' | 'displayName' | 'nodeId'>,
    type: PlatformEventActor['type'] = 'participant'
  ): PlatformEventActor {
    return {
      type,
      participantId: participant.id,
      ...(participant.userId ? { userId: participant.userId } : {}),
      ...(participant.displayName ? { label: participant.displayName } : {}),
      ...(participant.nodeId ? { nodeId: participant.nodeId } : {})
    };
  }

  private platformActorFromParticipantContext(
    participant: Pick<ParticipantMongoDocument, 'id' | 'userId' | 'displayName' | 'nodeId'> | undefined,
    participantId: string,
    type: PlatformEventActor['type'] = 'participant'
  ): PlatformEventActor {
    if (participant) {
      return this.platformActorFromParticipant(participant, type);
    }
    return {
      type,
      participantId
    };
  }

  private platformActorFromIncidentActor(actor?: RoomIncidentActor): PlatformEventActor | undefined {
    if (!actor) {
      return undefined;
    }
    return {
      type:
        actor.type === 'operator'
          ? 'operator'
          : actor.type === 'automation'
            ? 'automation'
            : actor.type === 'worker'
              ? 'worker'
              : actor.type === 'node'
                ? 'node'
                : 'participant',
      ...(actor.participantId ? { participantId: actor.participantId } : {}),
      ...(actor.userId ? { userId: actor.userId } : {}),
      ...(actor.label ? { label: actor.label } : {}),
      ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
      ...(actor.workerId ? { workerId: actor.workerId } : {})
    };
  }

  private async isProducerHostedLocally(
    producer: Pick<ProducerMongoDocument, 'id' | 'nodeId'>,
    ownerLookup?: RoomOwnerLookupResponse
  ): Promise<boolean> {
    const localNodeId = this.nodeRegistry.localNodeId();
    if (!isMissingNodeId(producer.nodeId)) {
      return producer.nodeId === localNodeId;
    }
    if (!this.pipeCoordinator.isEnabled()) {
      await this.backfillProducerNodeId(producer, localNodeId, 'local_no_pipe');
      return true;
    }
    if (this.media.getProducer(producer.id)) {
      await this.backfillProducerNodeId(producer, localNodeId, 'local_media_registry');
      return true;
    }
    this.metrics.producerNodeIdFallbacks.labels(ownerLookup?.local ? 'assumed_remote_owner' : 'assumed_remote_non_owner').inc();
    return false;
  }

  private readLocalProducerLayerState(doc: Pick<ProducerMongoDocument, 'id' | 'nodeId'>): ProducerLayerState | undefined {
    if (!this.shouldReadLocalProducerState(doc.nodeId)) {
      return undefined;
    }
    try {
      return this.media.producerLayerState(doc.id);
    } catch (error) {
      if (isMissingWorkerAssignmentError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private readLocalConsumerLayerState(consumerId: string): ConsumerLayerState | undefined {
    try {
      return this.media.consumerLayerState(consumerId);
    } catch (error) {
      if (isMissingWorkerAssignmentError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private readLocalConsumerQualityState(consumerId: string): ConsumerQualityState | undefined {
    try {
      return this.media.consumerQualityState(consumerId);
    } catch (error) {
      if (isMissingWorkerAssignmentError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private readLocalProducerQualityState(doc: Pick<ProducerMongoDocument, 'id' | 'nodeId'>): ProducerQualityState | undefined {
    if (!this.shouldReadLocalProducerState(doc.nodeId)) {
      return undefined;
    }
    try {
      return this.media.producerQualityState(doc.id);
    } catch (error) {
      if (isMissingWorkerAssignmentError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private shouldReadLocalProducerState(nodeId: string | undefined | null): boolean {
    return isMissingNodeId(nodeId) || nodeId === this.nodeRegistry.localNodeId();
  }

  private async backfillProducerNodeId(
    producer: Pick<ProducerMongoDocument, 'id' | 'nodeId'>,
    nodeId: string,
    resolution: 'local_no_pipe' | 'local_media_registry'
  ): Promise<void> {
    this.metrics.producerNodeIdFallbacks.labels(resolution).inc();
    producer.nodeId = nodeId;
    try {
      const result = await this.producers.updateOne(
        {
          _id: producer.id,
          $or: [{ nodeId: { $exists: false } }, { nodeId: null }, { nodeId: '' }]
        },
        { $set: { nodeId } }
      );
      if (typeof result?.modifiedCount === 'number' && result.modifiedCount > 0) {
        this.metrics.producerNodeIdBackfills.labels(resolution).inc();
      }
    } catch {
      this.metrics.producerNodeIdFallbacks.labels(`${resolution}_write_failed`).inc();
    }
  }

  private async releaseRemoteConsumerFeedSafely(
    consumerId: string,
    reason: 'consumer_closed' | 'participant_left' | 'error' = 'consumer_closed',
    stage: string
  ): Promise<void> {
    try {
      await this.pipeCoordinator.releaseRemoteConsumerFeed(consumerId, reason);
    } catch {
      this.metrics.pipeCleanupFailures.labels(stage).inc();
    }
  }

  private async releaseRemoteProducerPublicationSafely(
    producerId: string,
    reason: 'producer_closed' | 'participant_left' | 'error' = 'producer_closed',
    stage: string
  ): Promise<void> {
    try {
      await this.pipeCoordinator.releaseRemoteProducerPublication(producerId, reason);
    } catch {
      this.metrics.pipeCleanupFailures.labels(stage).inc();
    }
  }
}

function consumerRtpParametersForProducer(producerRtp: RtpParameters): RtpParameters {
  const primaryCodec = producerRtp.codecs.find((codec) => !/\/rtx$/i.test(codec.mimeType));
  const rtxCodec = producerRtp.codecs.find((codec) => /\/rtx$/i.test(codec.mimeType) && Number(codec.parameters?.apt) === primaryCodec?.payloadType);
  const ssrc = randomSsrc();
  const rtxSsrc = rtxCodec ? randomSsrc() : undefined;
  return {
    ...producerRtp,
    encodings: [
      {
        ssrc,
        scalabilityMode: producerRtp.encodings[0]?.scalabilityMode,
        rtx: rtxSsrc !== undefined ? { ssrc: rtxSsrc, payloadType: rtxCodec?.payloadType } : undefined
      }
    ],
    simulcast: undefined,
    rtcp: {
      ...producerRtp.rtcp,
      cname: `sfu-${ssrc.toString(16)}`
    }
  };
}

function preferredLayerNameToSelection(layer: 'low' | 'medium' | 'high' | undefined): RtpLayerSelection | undefined {
  switch (layer) {
    case 'low':
      return { spatialLayer: 0 };
    case 'medium':
      return { spatialLayer: 1 };
    case 'high':
      return { spatialLayer: 2 };
    default:
      return undefined;
  }
}

function selectionToPreferredLayerName(selection: RtpLayerSelection | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!selection) {
    return undefined;
  }
  const spatialLayer = selection.spatialLayer ?? 2;
  if (spatialLayer <= 0) {
    return 'low';
  }
  if (spatialLayer === 1) {
    return 'medium';
  }
  return 'high';
}

function createFallbackRoomQualityState(roomId: string): RoomQualityState {
  const updatedAt = new Date().toISOString();
  return {
    roomId,
    score: {
      score: 100,
      level: 'excellent',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 100,
        rttScore: 100,
        jitterScore: 100,
        congestionScore: 100,
        retransmissionScore: 100,
        allocationScore: 100
      },
      updatedAt
    },
    consumers: [],
    producers: [],
    transports: [],
    targetBitrate: 0,
    allocatedBitrate: 0,
    actualBitrate: 0,
    congestionState: 'normal',
    updatedAt
  };
}

function isMissingNodeId(nodeId: string | undefined | null): boolean {
  return !nodeId || nodeId.trim().length === 0;
}

function normalizeMediaRoomCleanupSummary(summary: Partial<LocalRoomCleanupMetrics> | undefined): LocalRoomCleanupMetrics {
  return {
    participantIds: summary?.participantIds ?? [],
    transportCount: summary?.transportCount ?? 0,
    consumerCount: summary?.consumerCount ?? 0,
    producerCounts: summary?.producerCounts ?? {},
    pipeTransportCount: summary?.pipeTransportCount ?? 0
  };
}

function isMissingWorkerAssignmentError(error: unknown): boolean {
  return error instanceof Error && /is not assigned to a worker/i.test(error.message);
}

type IncidentDateLike = Date | string | undefined;

interface PersistedIncidentAlertLike {
  code: RoomOperatorAlert['code'];
  severity: RoomOperatorAlert['severity'];
  title: string;
  detail: string;
  firstTriggeredAt?: IncidentDateLike;
  lastTriggeredAt?: IncidentDateLike;
  occurrenceCount?: number;
}

interface PersistedIncidentStateLike {
  roomId?: string;
  status?: RoomIncidentState['status'];
  health?: RoomIncidentState['health'];
  healthChangedAt?: IncidentDateLike;
  protected?: boolean;
  protectedAt?: IncidentDateLike;
  protectedByParticipantId?: string;
  protectedReason?: string;
  admissionsState?: RoomIncidentState['admissionsState'];
  publishingState?: RoomIncidentState['publishingState'];
  underRecovery?: boolean;
  recoveryStartedAt?: IncidentDateLike;
  recoveryStartedByParticipantId?: string;
  recoveryClearedAt?: IncidentDateLike;
  recoveryClearedByParticipantId?: string;
  recoveryReason?: string;
  lastFailureAt?: IncidentDateLike;
  lastFailureReason?: RoomIncidentState['lastFailureReason'];
  lastFailureMessage?: string;
  lastRecoveryAction?: RoomIncidentState['lastRecoveryAction'];
  lastRecoveryActionAt?: IncidentDateLike;
  activeAlerts?: PersistedIncidentAlertLike[] | RoomOperatorAlertDocument[];
  snapshotCount?: number;
  latestSnapshotId?: string;
  updatedAt?: IncidentDateLike;
}

function defaultIncidentStateDocument(roomId: string, now = new Date()): PersistedIncidentStateLike {
  return {
    roomId,
    status: 'stable',
    health: 'stable',
    healthChangedAt: now,
    protected: false,
    admissionsState: 'default',
    publishingState: 'default',
    underRecovery: false,
    activeAlerts: [],
    snapshotCount: 0,
    updatedAt: now
  };
}

function defaultIncidentState(roomId: string): RoomIncidentState {
  return toRoomIncidentState(roomId, defaultIncidentStateDocument(roomId));
}

function toRoomIncidentState(
  roomId: string,
  value: PersistedIncidentStateLike | RoomIncidentStateDocument | undefined
): RoomIncidentState {
  const base = value ?? defaultIncidentStateDocument(roomId);
  return {
    roomId,
    status: base.status ?? 'stable',
    health: base.health ?? 'stable',
    healthChangedAt: toIso(base.healthChangedAt),
    protected: base.protected ?? false,
    protectedAt: toIso(base.protectedAt),
    protectedByParticipantId: base.protectedByParticipantId,
    protectedReason: base.protectedReason,
    admissionsState: base.admissionsState ?? 'default',
    publishingState: base.publishingState ?? 'default',
    underRecovery: base.underRecovery ?? false,
    recoveryStartedAt: toIso(base.recoveryStartedAt),
    recoveryStartedByParticipantId: base.recoveryStartedByParticipantId,
    recoveryClearedAt: toIso(base.recoveryClearedAt),
    recoveryClearedByParticipantId: base.recoveryClearedByParticipantId,
    recoveryReason: base.recoveryReason,
    lastFailureAt: toIso(base.lastFailureAt),
    lastFailureReason: base.lastFailureReason,
    lastFailureMessage: base.lastFailureMessage,
    lastRecoveryAction: base.lastRecoveryAction,
    lastRecoveryActionAt: toIso(base.lastRecoveryActionAt),
    activeAlerts: (base.activeAlerts ?? []).map((alert: PersistedIncidentAlertLike | RoomOperatorAlertDocument) => ({
      code: alert.code,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      firstTriggeredAt: toIso(alert.firstTriggeredAt) ?? new Date().toISOString(),
      lastTriggeredAt: toIso(alert.lastTriggeredAt) ?? new Date().toISOString(),
      occurrenceCount: alert.occurrenceCount ?? 1
    })),
    snapshotCount: base.snapshotCount ?? 0,
    latestSnapshotId: base.latestSnapshotId,
    updatedAt: toIso(base.updatedAt) ?? new Date().toISOString()
  };
}

function toIncidentStateDocument(
  state: RoomIncidentState,
  existing?: PersistedIncidentStateLike | RoomIncidentStateDocument
): PersistedIncidentStateLike {
  return {
    ...(existing ?? {}),
    roomId: state.roomId,
    status: state.status,
    health: state.health,
    healthChangedAt: state.healthChangedAt ? new Date(state.healthChangedAt) : undefined,
    protected: state.protected,
    protectedAt: state.protectedAt ? new Date(state.protectedAt) : undefined,
    protectedByParticipantId: state.protectedByParticipantId,
    protectedReason: state.protectedReason,
    admissionsState: state.admissionsState,
    publishingState: state.publishingState,
    underRecovery: state.underRecovery,
    recoveryStartedAt: state.recoveryStartedAt ? new Date(state.recoveryStartedAt) : undefined,
    recoveryStartedByParticipantId: state.recoveryStartedByParticipantId,
    recoveryClearedAt: state.recoveryClearedAt ? new Date(state.recoveryClearedAt) : undefined,
    recoveryClearedByParticipantId: state.recoveryClearedByParticipantId,
    recoveryReason: state.recoveryReason,
    lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt) : undefined,
    lastFailureReason: state.lastFailureReason,
    lastFailureMessage: state.lastFailureMessage,
    lastRecoveryAction: state.lastRecoveryAction,
    lastRecoveryActionAt: state.lastRecoveryActionAt ? new Date(state.lastRecoveryActionAt) : undefined,
    activeAlerts: state.activeAlerts.map((alert: RoomOperatorAlert) => ({
      code: alert.code,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      firstTriggeredAt: new Date(alert.firstTriggeredAt),
      lastTriggeredAt: new Date(alert.lastTriggeredAt),
      occurrenceCount: alert.occurrenceCount
    })),
    snapshotCount: state.snapshotCount,
    latestSnapshotId: state.latestSnapshotId,
    updatedAt: new Date(state.updatedAt)
  };
}

function enrichRoomIncidentState(
  room: Pick<Room, 'id' | 'settings' | 'mediaState' | 'owner'>,
  summary: Pick<RoomQualitySummaryState, 'roomId' | 'health' | 'protections'>,
  ownerLookup: Pick<RoomOwnerLookupResponse, 'local' | 'owner' | 'available' | 'reason'>,
  persisted: RoomIncidentState
): RoomIncidentState {
  return enrichIncidentStateWithDerivedFields(
    {
      ...persisted,
      roomId: room.id,
      health: summary.health,
      status: deriveIncidentStatus(room.mediaState, persisted, summary.health),
      healthChangedAt:
        persisted.health === summary.health && persisted.healthChangedAt
          ? persisted.healthChangedAt
          : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    room,
    summary,
    ownerLookup
  );
}

function enrichIncidentStateWithDerivedFields(
  state: RoomIncidentState,
  room: Pick<Room, 'id' | 'settings' | 'mediaState' | 'owner'>,
  summary: Pick<RoomQualitySummaryState, 'roomId' | 'health' | 'protections'>,
  ownerLookup: Pick<RoomOwnerLookupResponse, 'local' | 'owner' | 'available' | 'reason'>
): RoomIncidentState {
  return {
    ...state,
    blockedReasons: buildBlockedReasons(room, summary, state),
    workflows: buildRecoveryWorkflows(room, summary, state, ownerLookup)
  };
}

function buildBlockedReasons(
  room: Pick<Room, 'settings' | 'mediaState'>,
  summary: Pick<RoomQualitySummaryState, 'protections'>,
  state: RoomIncidentState
): string[] {
  const reasons = new Set<string>();
  if (room.settings.locked) {
    reasons.add('Room admissions are locked by the host.');
  }
  if (room.mediaState?.status === 'failed') {
    reasons.add('Room media is failed and needs recovery before new sessions can proceed.');
  }
  if (state.protected && state.admissionsState !== 'reopened') {
    reasons.add(summary.protections.join.message);
  }
  if (state.protected || state.publishingState === 'paused') {
    reasons.add(summary.protections.publish.message);
  }
  return [...reasons];
}

function buildRecoveryWorkflows(
  room: Pick<Room, 'settings' | 'mediaState'>,
  summary: Pick<RoomQualitySummaryState, 'health'> & Partial<Pick<RoomQualitySummaryState, 'warnings'>>,
  state: RoomIncidentState,
  ownerLookup: Pick<RoomOwnerLookupResponse, 'local' | 'available' | 'reason'>
): RoomRecoveryWorkflow[] {
  const warnings = summary.warnings ?? [];
  return [
    {
      id: 'protect_room',
      title: 'Protect room',
      status: state.protected ? 'active' : summary.health === 'stable' ? 'available' : 'recommended',
      detail: state.protected
        ? 'Operator protections are limiting joins or publishing while the room stabilizes.'
        : 'Protecting the room pauses growth while current participants recover.',
      suggestedActions: state.protected ? ['unprotect_room'] : ['protect_room']
    },
    {
      id: 'drain_prepare',
      title: 'Prepare for drain',
      status: warnings.some((warning) => /node|worker|owner_quality_signal/i.test(warning)) ? 'recommended' : 'available',
      detail: ownerLookup.local
        ? 'Use room protections and snapshots before draining the current owner node or worker.'
        : `This room is owned remotely${ownerLookup.reason ? ` (${ownerLookup.reason.replaceAll('_', ' ')})` : ''}. Coordinate recovery with the owner node.`,
      suggestedActions: ['protect_room', 'pause_new_publishing', 'force_incident_snapshot']
    },
    {
      id: 'reopen_room',
      title: 'Reopen room',
      status: state.protected
        ? summary.health === 'stable' && room.mediaState?.status !== 'failed' && !room.settings.locked
          ? 'recommended'
          : 'blocked'
        : 'available',
      detail: 'Reopen admissions or remove protection once the room is stable and the infrastructure is healthy.',
      blockedReason:
        state.protected && (summary.health !== 'stable' || room.mediaState?.status === 'failed' || room.settings.locked)
          ? 'The room is not ready to reopen yet.'
          : undefined,
      suggestedActions: ['reopen_admissions', 'resume_new_publishing', 'unprotect_room']
    },
    {
      id: 'acknowledge_failure',
      title: 'Acknowledge failure',
      status: room.mediaState?.status === 'failed'
        ? state.underRecovery
          ? 'active'
          : 'recommended'
        : state.underRecovery
          ? 'active'
          : 'available',
      detail: 'Mark the room under recovery so operators can coordinate drain, snapshot, and reopen steps.',
      suggestedActions: state.underRecovery ? ['clear_recovery'] : ['mark_operator_recovery']
    }
  ];
}

function deriveIncidentStatus(
  mediaState: Room['mediaState'] | undefined,
  state: Pick<RoomIncidentState, 'underRecovery'>,
  health: RoomHealthState
): RoomIncidentState['status'] {
  if (mediaState?.status === 'failed') {
    return 'failed';
  }
  if (state.underRecovery) {
    return 'recovering';
  }
  return health;
}

function overrideAutopilotDecision(
  decision: RoomAutopilotDecision,
  action: RoomAutopilotDecision['action'],
  code: RoomAutopilotDecision['code'],
  message: string
): RoomAutopilotDecision {
  return {
    ...decision,
    action,
    code,
    message,
    triggeredBy: ['operator'],
    updatedAt: new Date().toISOString()
  };
}

function incidentActorFromParticipant(
  participant: Pick<ParticipantMongoDocument, 'id' | 'userId' | 'displayName'>,
  type: RoomIncidentActor['type']
): RoomIncidentActor {
  return {
    type,
    participantId: participant.id,
    userId: participant.userId,
    label: participant.displayName
  };
}

function nextAlert(
  previous: RoomOperatorAlert | undefined,
  base: Pick<RoomOperatorAlert, 'code' | 'severity' | 'title' | 'detail'>
): RoomOperatorAlert {
  const now = new Date().toISOString();
  return {
    ...base,
    firstTriggeredAt: previous?.firstTriggeredAt ?? now,
    lastTriggeredAt: now,
    occurrenceCount: (previous?.occurrenceCount ?? 0) + 1
  };
}

function recoveryActionSummary(action: RoomRecoveryActionType): string {
  switch (action) {
    case 'protect_room':
      return 'Operator protected the room.';
    case 'unprotect_room':
      return 'Operator removed room protection.';
    case 'reopen_admissions':
      return 'Operator reopened room admissions.';
    case 'pause_new_publishing':
      return 'Operator paused new publishing.';
    case 'resume_new_publishing':
      return 'Operator resumed new publishing.';
    case 'force_incident_snapshot':
      return 'Operator generated a fresh incident snapshot.';
    case 'mark_operator_recovery':
      return 'Operator marked the room under recovery.';
    case 'clear_recovery':
      return 'Operator cleared the room recovery state.';
  }
}

function snapshotTriggerSummary(reason: RoomSnapshotTriggerReason): string {
  switch (reason) {
    case 'manual_operator':
      return 'An operator generated a fresh incident snapshot bundle.';
    case 'critical_quality':
      return 'A snapshot bundle was generated automatically when the room entered a critical state.';
    case 'room_failure':
      return 'A snapshot bundle was generated automatically for a room media failure.';
    case 'repeated_throttles':
      return 'A snapshot bundle was generated automatically after repeated throttles or rejections.';
    case 'repeated_snapshots':
      return 'A snapshot bundle was generated automatically after repeated incident activity.';
  }
}

function sanitizeOperatorReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  const value = reason.trim();
  return value.length === 0 ? undefined : value.slice(0, 500);
}

function sameProtectionState(
  left: RoomQualitySummaryState['protections'],
  right: RoomQualitySummaryState['protections']
): boolean {
  return left.join.action === right.join.action
    && left.join.code === right.join.code
    && left.publish.action === right.publish.action
    && left.publish.code === right.publish.code
    && left.screenShare.action === right.screenShare.action
    && left.screenShare.code === right.screenShare.code;
}

function protectionSeverity(protections: RoomQualitySummaryState['protections']): RoomIncidentTimelineEvent['severity'] {
  const actions = [protections.join.action, protections.publish.action, protections.screenShare.action];
  if (actions.includes('reject')) {
    return 'critical';
  }
  if (actions.includes('soft-throttle') || actions.includes('warn')) {
    return 'warn';
  }
  return 'info';
}

function sameRecommendationCodes(
  left: RoomQualitySummaryState['recommendations'],
  right: RoomQualitySummaryState['recommendations']
): boolean {
  return JSON.stringify(left.map((recommendation) => recommendation.code).sort())
    === JSON.stringify(right.map((recommendation) => recommendation.code).sort());
}

function recommendationSeverity(recommendations: RoomQualitySummaryState['recommendations']): RoomIncidentTimelineEvent['severity'] {
  if (recommendations.some((recommendation) => recommendation.severity === 'critical')) {
    return 'critical';
  }
  if (recommendations.some((recommendation) => recommendation.severity === 'warn')) {
    return 'warn';
  }
  return 'info';
}

function toIso(value: Date | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function defaultDecision(scope: RoomAutopilotDecision['scope']): RoomAutopilotDecision {
  return {
    scope,
    health: 'critical',
    action: 'reject',
    code: 'room_failed',
    message: 'Room media is unavailable while operators recover the room.',
    triggeredBy: ['operator'],
    updatedAt: new Date().toISOString()
  };
}

function normalizeLayerSelection(selection: RtpLayerSelection | undefined): RtpLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    spatialLayer: normalizeLayerNumber(selection.spatialLayer),
    temporalLayer: normalizeLayerNumber(selection.temporalLayer)
  };
}

function normalizeSvcLayerSelection(selection: SvcLayerSelection | undefined): SvcLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    spatialLayerId: normalizeLayerNumber(selection.spatialLayerId),
    temporalLayerId: normalizeLayerNumber(selection.temporalLayerId),
    qualityLayerId: normalizeLayerNumber(selection.qualityLayerId ?? selection.spatialLayerId)
  };
}

function mergeLayerSelections(selections: Array<RtpLayerSelection | undefined>): RtpLayerSelection | undefined {
  const merged = selections.reduce<RtpLayerSelection | undefined>((accumulator, current) => {
    if (!current) {
      return accumulator;
    }
    return {
      spatialLayer: maxDefined(accumulator?.spatialLayer, current.spatialLayer),
      temporalLayer: maxDefined(accumulator?.temporalLayer, current.temporalLayer)
    };
  }, undefined);
  return merged && (merged.spatialLayer !== undefined || merged.temporalLayer !== undefined) ? merged : undefined;
}

function mergeSvcLayerSelections(selections: Array<SvcLayerSelection | undefined>): SvcLayerSelection | undefined {
  const merged = selections.reduce<SvcLayerSelection | undefined>((accumulator, current) => {
    if (!current) {
      return accumulator;
    }
    return {
      spatialLayerId: maxDefined(accumulator?.spatialLayerId, current.spatialLayerId),
      temporalLayerId: maxDefined(accumulator?.temporalLayerId, current.temporalLayerId),
      qualityLayerId: maxDefined(accumulator?.qualityLayerId, current.qualityLayerId)
    };
  }, undefined);
  return merged && (merged.spatialLayerId !== undefined || merged.temporalLayerId !== undefined || merged.qualityLayerId !== undefined)
    ? merged
    : undefined;
}

function highestConsumerPriority(
  consumers: Array<Pick<ConsumerMongoDocument, 'priority'>>
): number | undefined {
  return consumers.reduce<number | undefined>((highest, consumer) => {
    const priority = normalizeConsumerPriority(consumer.priority);
    return highest === undefined ? priority : Math.max(highest, priority);
  }, undefined);
}

function isConsumerQualityState(value: unknown): value is ConsumerQualityState {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ConsumerQualityState).consumerId === 'string'
    && typeof (value as ConsumerQualityState).roomId === 'string'
    && typeof (value as ConsumerQualityState).updatedAt === 'string';
}

function isProducerQualityState(value: unknown): value is ProducerQualityState {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ProducerQualityState).producerId === 'string'
    && typeof (value as ProducerQualityState).roomId === 'string'
    && typeof (value as ProducerQualityState).updatedAt === 'string';
}

function isTransportQualityState(value: unknown): value is TransportQualityState {
  return typeof value === 'object'
    && value !== null
    && typeof (value as TransportQualityState).transportId === 'string'
    && typeof (value as TransportQualityState).roomId === 'string'
    && typeof (value as TransportQualityState).updatedAt === 'string';
}

function isRoomQualityState(value: unknown): value is RoomQualityState {
  return typeof value === 'object'
    && value !== null
    && typeof (value as RoomQualityState).roomId === 'string'
    && typeof (value as RoomQualityState).updatedAt === 'string'
    && typeof (value as RoomQualityState).congestionState === 'string';
}

function isRoomQualitySummaryStatePayload(value: unknown): value is RoomQualitySummaryState {
  return typeof value === 'object'
    && value !== null
    && typeof (value as RoomQualitySummaryState).roomId === 'string'
    && typeof (value as RoomQualitySummaryState).updatedAt === 'string'
    && typeof (value as RoomQualitySummaryState).health === 'string'
    && typeof (value as RoomQualitySummaryState).profile?.id === 'string';
}

function isRoomPayloadWithProfile(value: unknown): value is Pick<Room, 'id' | 'mediaProfile'> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Room).id === 'string'
    && typeof (value as Room).mediaProfile?.id === 'string';
}

function roomProfileSignature(profile: Pick<RoomMediaProfile, 'id' | 'updatedAt'>): string {
  return `${profile.id}:${profile.updatedAt ?? 'none'}`;
}

function compareIsoTimestamps(left: string, right: string): number {
  const leftValue = Date.parse(left);
  const rightValue = Date.parse(right);
  if (Number.isNaN(leftValue) && Number.isNaN(rightValue)) {
    return 0;
  }
  if (Number.isNaN(leftValue)) {
    return -1;
  }
  if (Number.isNaN(rightValue)) {
    return 1;
  }
  return leftValue - rightValue;
}

function isDegradedQualityState(reasons: ReadonlyArray<string>): boolean {
  return reasons.some((reason) => reason !== 'stable' && reason !== 'recovered');
}

function hasPendingLayerSwitch(state: Pick<ConsumerQualityState, 'currentLayers' | 'targetLayers' | 'currentSvcLayers' | 'targetSvcLayers'>): boolean {
  return JSON.stringify(state.currentLayers ?? null) !== JSON.stringify(state.targetLayers ?? null)
    || JSON.stringify(state.currentSvcLayers ?? null) !== JSON.stringify(state.targetSvcLayers ?? null);
}

function isPersistedMongoId(value: string): boolean {
  return Types.ObjectId.isValid(value);
}

function isMongooseCastError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'CastError';
}

function averageNumber(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueConsumerDocs<T extends { id?: string; _id?: unknown }>(consumers: T[]): T[] {
  const seen = new Set<string>();
  return consumers.filter((consumer) => {
    const key = consumer.id ?? String(consumer._id ?? '');
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function maxNumber(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values);
}

function participantTombstoneKey(roomId: string, participantId: string): string {
  return `${roomId}:${participantId}`;
}

function isoToEpoch(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function normalizeLayerNumber(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeLayerSwitchReason(value: string | undefined): ConsumerLayerSwitchReason | undefined {
  return value === 'initial' || value === 'preferred' || value === 'bandwidth' || value === 'keyframe' || value === 'unavailable' || value === 'manual' || value === 'unknown'
    ? value
    : undefined;
}

function normalizeConsumerPriority(priority: number | undefined): number {
  if (priority === undefined || !Number.isFinite(priority)) {
    return 1;
  }
  return Math.max(0.1, Math.min(10, priority));
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function producerDynacastMetricEventName(event: ProducerDynacastEvent): string {
  return event.type;
}

function sanitizeMetricLabel(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 80) || 'unknown';
}

function ageFromIso(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.max(0, Date.now() - parsed);
}

function randomSsrc(): number {
  const value = randomBytes(4).readUInt32BE(0);
  return value === 0 ? 1 : value;
}
