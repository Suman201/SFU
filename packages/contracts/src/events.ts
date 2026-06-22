import type { RecordingScope, RecordingStatus } from './recordings.js';
import type { Role } from './roles.js';
import type { RoomIncidentStatus, RoomMediaProfileId, RoomVisibility, RoomRecoveryActionType } from './rooms.js';
import type { ProducerKind, RtpLayerSelection, SvcLayerSelection } from './producers.js';

export const PLATFORM_EVENT_SCHEMA_VERSION = 1 as const;

export const PLATFORM_EVENT_ACTOR_TYPES = [
  'participant',
  'operator',
  'automation',
  'system',
  'worker',
  'node'
] as const;

export type PlatformEventActorType = (typeof PLATFORM_EVENT_ACTOR_TYPES)[number];

export const PLATFORM_EVENT_TYPES = [
  'room.created',
  'room.joined',
  'room.left',
  'room.closed',
  'room.locked',
  'room.unlocked',
  'participant.admitted',
  'participant.rejected',
  'participant.kicked',
  'participant.banned',
  'participant.unbanned',
  'participant.muted',
  'producer.created',
  'producer.paused',
  'producer.resumed',
  'producer.closed',
  'consumer.created',
  'consumer.paused',
  'consumer.resumed',
  'consumer.closed',
  'room.media_profile.changed',
  'room.protection.changed',
  'room.degraded',
  'room.recovered',
  'room.failed',
  'incident.snapshot.generated',
  'recovery.action.executed',
  'operator.action.executed',
  'room.owner.changed',
  'recording.started',
  'recording.stopped',
  'recording.failed'
] as const;

export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export interface PlatformEventActor {
  type: PlatformEventActorType;
  participantId?: string;
  userId?: string;
  label?: string;
  nodeId?: string;
  workerId?: string;
}

export interface PlatformRoomReference {
  roomId: string;
  name?: string;
  visibility?: RoomVisibility;
  maxParticipants?: number;
  waitingRoomEnabled?: boolean;
  joinApprovalRequired?: boolean;
  mediaProfileId?: RoomMediaProfileId;
  hostParticipantId?: string;
}

export interface PlatformParticipantReference {
  participantId: string;
  userId?: string;
  displayName?: string;
  role?: Role;
  admitted?: boolean;
  nodeId?: string;
}

export interface PlatformProducerReference {
  producerId: string;
  participantId: string;
  transportId: string;
  kind: ProducerKind;
  status?: 'live' | 'paused' | 'closed';
  priority?: number;
  layers?: RtpLayerSelection;
  svcLayers?: SvcLayerSelection;
}

export interface PlatformConsumerReference {
  consumerId: string;
  participantId: string;
  producerId: string;
  transportId: string;
  status?: 'live' | 'paused' | 'closed';
  priority?: number;
  preferredLayers?: RtpLayerSelection;
  preferredSvcLayers?: SvcLayerSelection;
}

export interface RoomCreatedEventPayload {
  room: PlatformRoomReference;
  host: PlatformParticipantReference;
}

export interface RoomJoinedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  participant: PlatformParticipantReference;
  admitted: boolean;
  asViewer: boolean;
}

export interface RoomLeftEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  participant: PlatformParticipantReference;
  closedRoom: boolean;
}

export interface RoomClosedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  participantCount?: number;
}

export interface RoomLockEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  locked: boolean;
}

export interface ParticipantModerationEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  participant: PlatformParticipantReference;
  reason?: string;
  forced?: boolean;
}

export interface ProducerLifecycleEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name' | 'mediaProfileId'>;
  producer: PlatformProducerReference;
  policyAction?: 'allow' | 'warn' | 'soft-throttle' | 'reject';
}

export interface ConsumerLifecycleEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name' | 'mediaProfileId'>;
  consumer: PlatformConsumerReference;
}

export interface RoomMediaProfileChangedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  previousProfileId: RoomMediaProfileId;
  nextProfileId: RoomMediaProfileId;
}

export interface RoomProtectionChangedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  protected: boolean;
  admissionsState: 'default' | 'reopened' | 'protected';
  publishingState: 'default' | 'paused' | 'protected';
  reason?: string;
  source: 'automation' | 'operator' | 'system';
}

export interface RoomHealthEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name' | 'mediaProfileId'>;
  previousHealth?: 'stable' | 'degraded' | 'critical';
  health: 'stable' | 'degraded' | 'critical';
  status: RoomIncidentStatus;
  warnings?: string[];
}

export interface RoomFailedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name' | 'mediaProfileId'>;
  reason: 'worker_crashed' | 'worker_drained_forced' | 'worker_unhealthy' | 'worker_overloaded';
  message: string;
  recoverable: boolean;
  workerId?: string;
  affectedParticipantIds?: string[];
  affectedProducerIds?: string[];
  affectedConsumerIds?: string[];
  affectedTransportIds?: string[];
}

export interface IncidentSnapshotGeneratedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name' | 'mediaProfileId'>;
  bundleId: string;
  triggerReason: 'manual_operator' | 'critical_quality' | 'room_failure' | 'repeated_throttles' | 'repeated_snapshots';
  automatic: boolean;
  health: 'stable' | 'degraded' | 'critical';
  status: RoomIncidentStatus;
  degradedEntityCount: number;
  warningCount: number;
}

export interface RecoveryActionExecutedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name' | 'mediaProfileId'>;
  action: RoomRecoveryActionType;
  executed: boolean;
  blockedReason?: string;
  generatedSnapshotId?: string;
  protected: boolean;
  underRecovery: boolean;
  status: RoomIncidentStatus;
}

export interface OperatorActionExecutedEventPayload {
  action:
    | 'incident_snapshot_generated'
    | 'room_failure_injected'
    | 'worker_drain_started'
    | 'node_drain_started'
    | 'node_drain_cleared'
    | 'webhook_replayed'
    | 'event_replayed_to_endpoint'
    | 'webhook_endpoint_created'
    | 'webhook_endpoint_updated'
    | 'webhook_endpoint_secret_rotated'
    | 'redis_stream_endpoint_created'
    | 'redis_stream_endpoint_updated';
  scope: 'room' | 'worker' | 'node' | 'webhook' | 'redis_stream' | 'delivery';
  roomId?: string;
  workerId?: string;
  endpointId?: string;
  deliveryId?: string;
  outcome: 'executed' | 'blocked' | 'failed';
  reason?: string;
}

export interface RoomOwnerChangedEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  ownerNodeId: string;
  ownerUrl: string;
  previousOwnerNodeId?: string;
}

export interface RecordingLifecycleEventPayload {
  room: Pick<PlatformRoomReference, 'roomId' | 'name'>;
  recordingId: string;
  participantId?: string;
  scope: RecordingScope;
  status: RecordingStatus;
  path?: string;
  downloadUrl?: string;
  reason?: string;
}

export interface PlatformEventPayloadByType {
  'room.created': RoomCreatedEventPayload;
  'room.joined': RoomJoinedEventPayload;
  'room.left': RoomLeftEventPayload;
  'room.closed': RoomClosedEventPayload;
  'room.locked': RoomLockEventPayload;
  'room.unlocked': RoomLockEventPayload;
  'participant.admitted': ParticipantModerationEventPayload;
  'participant.rejected': ParticipantModerationEventPayload;
  'participant.kicked': ParticipantModerationEventPayload;
  'participant.banned': ParticipantModerationEventPayload;
  'participant.unbanned': ParticipantModerationEventPayload;
  'participant.muted': ParticipantModerationEventPayload;
  'producer.created': ProducerLifecycleEventPayload;
  'producer.paused': ProducerLifecycleEventPayload;
  'producer.resumed': ProducerLifecycleEventPayload;
  'producer.closed': ProducerLifecycleEventPayload;
  'consumer.created': ConsumerLifecycleEventPayload;
  'consumer.paused': ConsumerLifecycleEventPayload;
  'consumer.resumed': ConsumerLifecycleEventPayload;
  'consumer.closed': ConsumerLifecycleEventPayload;
  'room.media_profile.changed': RoomMediaProfileChangedEventPayload;
  'room.protection.changed': RoomProtectionChangedEventPayload;
  'room.degraded': RoomHealthEventPayload;
  'room.recovered': RoomHealthEventPayload;
  'room.failed': RoomFailedEventPayload;
  'incident.snapshot.generated': IncidentSnapshotGeneratedEventPayload;
  'recovery.action.executed': RecoveryActionExecutedEventPayload;
  'operator.action.executed': OperatorActionExecutedEventPayload;
  'room.owner.changed': RoomOwnerChangedEventPayload;
  'recording.started': RecordingLifecycleEventPayload;
  'recording.stopped': RecordingLifecycleEventPayload;
  'recording.failed': RecordingLifecycleEventPayload;
}

export interface PlatformEventBase<TType extends PlatformEventType = PlatformEventType> {
  id: string;
  schemaVersion: typeof PLATFORM_EVENT_SCHEMA_VERSION;
  type: TType;
  roomId?: string;
  actor?: PlatformEventActor;
  sourceNodeId?: string;
  timestamp: string;
  payload: PlatformEventPayloadByType[TType];
}

export type PlatformEvent = {
  [TType in PlatformEventType]: PlatformEventBase<TType>;
}[PlatformEventType];

export interface PlatformEventListResponse {
  events: PlatformEvent[];
}

export interface PlatformEventQuery {
  roomId?: string;
  eventTypes?: PlatformEventType[];
  actorUserId?: string;
  actorParticipantId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export const EVENT_DELIVERY_ADAPTER_KINDS = ['webhook', 'redis-stream'] as const;
export type EventDeliveryAdapterKind = (typeof EVENT_DELIVERY_ADAPTER_KINDS)[number];

export const WEBHOOK_DELIVERY_STATUSES = ['queued', 'retrying', 'dispatching', 'delivered', 'exhausted', 'cancelled'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WEBHOOK_ENDPOINT_HEALTH_STATES = ['healthy', 'degraded', 'failing', 'disabled'] as const;
export type WebhookEndpointHealthState = (typeof WEBHOOK_ENDPOINT_HEALTH_STATES)[number];

export const EVENT_DELIVERY_FAILURE_CATEGORIES = [
  'http',
  'timeout',
  'network',
  'auth',
  'configuration',
  'storage',
  'throttled',
  'endpoint_disabled',
  'endpoint_missing',
  'event_missing'
] as const;
export type EventDeliveryFailureCategory = (typeof EVENT_DELIVERY_FAILURE_CATEGORIES)[number];
export type WebhookDeliveryFailureCategory = EventDeliveryFailureCategory;

export const DELIVERY_SNAPSHOT_SOURCES = [
  'queued_endpoint_state',
  'original_delivery_snapshot',
  'current_endpoint_state'
] as const;
export type DeliverySnapshotSource = (typeof DELIVERY_SNAPSHOT_SOURCES)[number];

export interface WebhookEndpointHealthSummary {
  status: WebhookEndpointHealthState;
  lastDeliveryStatus?: WebhookDeliveryStatus;
  lastDeliveryAt?: string;
  lastResponseStatusCode?: number;
  lastError?: string;
  lastFailureCategory?: EventDeliveryFailureCategory;
  lastDeliveryReference?: string;
  consecutiveFailures: number;
}

export interface WebhookEndpoint {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  subscribedEventTypes: PlatformEventType[];
  roomFilterIds?: string[];
  timeoutMs: number;
  maxAttempts: number;
  initialBackoffMs: number;
  signingAlgorithm: 'hmac-sha256';
  secretConfigured: boolean;
  secretFingerprint?: string;
  secretLastRotatedAt?: string;
  health: WebhookEndpointHealthSummary;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointSecretResponse {
  endpoint: WebhookEndpoint;
  signingSecret: string;
}

export interface CreateWebhookEndpointRequest {
  name: string;
  url: string;
  enabled?: boolean;
  subscribedEventTypes: PlatformEventType[];
  roomFilterIds?: string[];
  signingSecret?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
}

export interface UpdateWebhookEndpointRequest {
  name?: string;
  url?: string;
  enabled?: boolean;
  subscribedEventTypes?: PlatformEventType[];
  roomFilterIds?: string[];
  timeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
}

export interface RotateWebhookEndpointSecretRequest {
  signingSecret?: string;
}

export interface WebhookEndpointListResponse {
  endpoints: WebhookEndpoint[];
}

export interface RedisStreamEndpointHealthSummary {
  status: WebhookEndpointHealthState;
  lastDeliveryStatus?: WebhookDeliveryStatus;
  lastDeliveryAt?: string;
  lastError?: string;
  lastFailureCategory?: EventDeliveryFailureCategory;
  lastDeliveryReference?: string;
  consecutiveFailures: number;
}

export interface RedisStreamEndpoint {
  id: string;
  adapterKind: 'redis-stream';
  name: string;
  enabled: boolean;
  streamKey: string;
  maxLen?: number;
  subscribedEventTypes: PlatformEventType[];
  roomFilterIds?: string[];
  timeoutMs: number;
  maxAttempts: number;
  initialBackoffMs: number;
  health: RedisStreamEndpointHealthSummary;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRedisStreamEndpointRequest {
  name: string;
  enabled?: boolean;
  streamKey: string;
  maxLen?: number;
  subscribedEventTypes: PlatformEventType[];
  roomFilterIds?: string[];
  timeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
}

export interface UpdateRedisStreamEndpointRequest {
  name?: string;
  enabled?: boolean;
  streamKey?: string;
  maxLen?: number;
  subscribedEventTypes?: PlatformEventType[];
  roomFilterIds?: string[];
  timeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
}

export interface RedisStreamEndpointListResponse {
  endpoints: RedisStreamEndpoint[];
}

export interface WebhookDeliveryAttempt {
  attemptNumber: number;
  attemptedAt: string;
  completedAt: string;
  status: 'succeeded' | 'failed' | 'timeout';
  responseStatusCode?: number;
  durationMs: number;
  error?: string;
  failureCategory?: EventDeliveryFailureCategory;
  deliveryReference?: string;
  nextAttemptAt?: string;
}

export interface WebhookEndpointSnapshot {
  adapterKind: 'webhook';
  url: string;
  signingAlgorithm: 'hmac-sha256';
  secretFingerprint?: string;
  timeoutMs: number;
  maxAttempts: number;
  initialBackoffMs: number;
  subscribedEventTypes: PlatformEventType[];
  roomFilterIds?: string[];
  endpointUpdatedAt?: string;
  secretLastRotatedAt?: string;
}

export interface RedisStreamEndpointSnapshot {
  adapterKind: 'redis-stream';
  streamKey: string;
  maxLen?: number;
  timeoutMs: number;
  maxAttempts: number;
  initialBackoffMs: number;
  subscribedEventTypes: PlatformEventType[];
  roomFilterIds?: string[];
  endpointUpdatedAt?: string;
}

export type EventDeliverySnapshot = WebhookEndpointSnapshot | RedisStreamEndpointSnapshot;

export interface EventDelivery {
  id: string;
  adapterKind: EventDeliveryAdapterKind;
  endpointId: string;
  eventId: string;
  eventType: PlatformEventType;
  roomId?: string;
  status: WebhookDeliveryStatus;
  snapshotSource: DeliverySnapshotSource;
  endpointSnapshot: EventDeliverySnapshot;
  attemptCount: number;
  lastResponseStatusCode?: number;
  lastError?: string;
  lastFailureCategory?: EventDeliveryFailureCategory;
  lastDeliveryReference?: string;
  nextAttemptAt?: string;
  deliveredAt?: string;
  exhaustedAt?: string;
  cancelledAt?: string;
  replayOfDeliveryId?: string;
  replayedBy?: PlatformEventActor;
  attempts: WebhookDeliveryAttempt[];
  createdAt: string;
  updatedAt: string;
}

export type WebhookDelivery = EventDelivery;

export interface WebhookDeliveryQuery {
  endpointId?: string;
  eventId?: string;
  roomId?: string;
  status?: WebhookDeliveryStatus;
  eventTypes?: PlatformEventType[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface WebhookDeliveryListResponse {
  deliveries: WebhookDelivery[];
}

export interface ReplayWebhookDeliveryRequest {
  reason?: string;
}

export interface ReplayWebhookEventRequest {
  reason?: string;
}

export interface ReplayWebhookDeliveryResponse {
  delivery: WebhookDelivery;
}

export interface DeliveryDispatchDiagnosticsSummary {
  concurrency: number;
  maxBatchPerPump: number;
  maxConcurrentPerEndpoint: number;
  activeDispatches: number;
  nextClaimPrefers: 'queued' | 'retrying';
}

export interface DeliveryBacklogEndpointSummary {
  adapterKind: EventDeliveryAdapterKind;
  endpointId: string;
  total: number;
  queued: number;
  retrying: number;
  dispatching: number;
}

export interface DeliveryBacklogAgingSummary {
  queued: number;
  retrying: number;
  dispatching: number;
}

export interface DeliveryFairnessDiagnosticsSummary {
  activeLaneCount: number;
  queuedLaneCount: number;
  retryingLaneCount: number;
  dispatchingLaneCount: number;
  largestBacklogEndpointShare: number;
  largestBacklogEndpointShareByAdapter: Record<EventDeliveryAdapterKind, number>;
}

export interface EventingDiagnosticsSummary {
  observedAt: string;
  endpointCounts: {
    total: number;
    enabled: number;
    disabled: number;
    unhealthy: number;
  };
  endpointCountsByAdapter: Record<EventDeliveryAdapterKind, number>;
  deliveryCounts: {
    queued: number;
    retrying: number;
    dispatching: number;
    delivered: number;
    exhausted: number;
    cancelled: number;
  };
  deliveryCountsByAdapter: Record<
    EventDeliveryAdapterKind,
    {
      queued: number;
      retrying: number;
      dispatching: number;
      delivered: number;
      exhausted: number;
      cancelled: number;
    }
  >;
  failureCategoryCounts: Record<EventDeliveryFailureCategory, number>;
  snapshotSourceCounts: Record<DeliverySnapshotSource, number>;
  adapterCounts: Record<EventDeliveryAdapterKind, number>;
  dispatch: DeliveryDispatchDiagnosticsSummary;
  activeDispatchesByAdapter: Record<EventDeliveryAdapterKind, number>;
  leaseCounts: {
    active: number;
    expired: number;
  };
  backlogAging: DeliveryBacklogAgingSummary;
  backlogAgingByAdapter: Record<EventDeliveryAdapterKind, DeliveryBacklogAgingSummary>;
  fairness: DeliveryFairnessDiagnosticsSummary;
  topBacklogEndpoints: DeliveryBacklogEndpointSummary[];
  retention: {
    eventRetentionDays: number;
    deliveryRetentionDays: number;
    exhaustedDeliveryRetentionDays: number;
    cleanupIntervalMs: number;
    lastSweepAt?: string;
    lastSweepDeletedCounts?: {
      events: number;
      deliveries: number;
    };
  };
  recentEventCount: number;
  lastEventAt?: string;
}
