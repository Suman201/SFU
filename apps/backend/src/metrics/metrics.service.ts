import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ClusterNodeInfo, RoomQualitySummaryState } from '@native-sfu/contracts';
import type { MediaWorkerPoolSnapshot } from '@native-sfu/nest-sfu';
import client, { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { PipeCoordinatorHealthSnapshot, PipeCoordinatorSnapshot } from '../cluster/pipe-coordinator.service';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();
  private readonly trackedMediaWorkerIds = new Set<string>();
  private readonly trackedMediaWorkerDropReasons = new Set<string>();
  private readonly trackedPipeTransportIds = new Set<string>();
  readonly activeRooms = new Gauge({ name: 'sfu_active_rooms', help: 'Current active rooms' });
  readonly activeParticipants = new Gauge({ name: 'sfu_active_participants', help: 'Current active participants', labelNames: ['roomId'] });
  readonly activeTransports = new Gauge({ name: 'sfu_active_transports', help: 'Current active media transports' });
  readonly activeProducers = new Gauge({ name: 'sfu_active_producers', help: 'Current active producers', labelNames: ['kind'] });
  readonly activeConsumers = new Gauge({ name: 'sfu_active_consumers', help: 'Current active consumers' });
  readonly forwardedRtpPackets = new Counter({ name: 'sfu_forwarded_rtp_packets_total', help: 'Forwarded RTP packets', labelNames: ['kind'] });
  readonly droppedRtpPackets = new Counter({ name: 'sfu_dropped_rtp_packets_total', help: 'Dropped RTP packets', labelNames: ['reason'] });
  readonly roomJoinDuration = new Histogram({
    name: 'sfu_room_join_duration_ms',
    help: 'Room join duration in milliseconds',
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  });
  readonly packetLoss = new Gauge({ name: 'sfu_packet_loss_ratio', help: 'Packet loss ratio by room and participant', labelNames: ['roomId', 'participantId'] });
  readonly rtt = new Gauge({ name: 'sfu_rtt_ms', help: 'RTT in milliseconds by room and participant', labelNames: ['roomId', 'participantId'] });
  readonly jitter = new Gauge({ name: 'sfu_jitter_ms', help: 'Jitter in milliseconds by room and participant', labelNames: ['roomId', 'participantId'] });
  readonly bandwidth = new Gauge({ name: 'sfu_bandwidth_bps', help: 'Estimated bandwidth in bits per second', labelNames: ['roomId', 'participantId', 'direction'] });
  readonly successfulLayerSwitches = new Counter({
    name: 'sfu_consumer_layer_switches_total',
    help: 'Successful consumer layer switches',
    labelNames: ['reason']
  });
  readonly failedLayerSwitches = new Counter({
    name: 'sfu_consumer_layer_switch_failures_total',
    help: 'Failed consumer layer switches',
    labelNames: ['reason']
  });
  readonly layerSwitchDuration = new Histogram({
    name: 'sfu_consumer_layer_switch_duration_ms',
    help: 'Consumer layer switch duration in milliseconds',
    labelNames: ['reason'],
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  });
  readonly unavailableLayerCount = new Counter({
    name: 'sfu_consumer_layer_unavailable_total',
    help: 'Unavailable requested consumer layers',
    labelNames: ['reason']
  });
  readonly dynacastLayerDemandChanges = new Counter({
    name: 'sfu_dynacast_layer_demand_changes_total',
    help: 'Producer dynacast layer demand changes',
    labelNames: ['reason']
  });
  readonly dynacastLayerResumes = new Counter({
    name: 'sfu_dynacast_layer_resumes_total',
    help: 'Producer dynacast layer resume requests',
    labelNames: ['reason']
  });
  readonly dynacastLayerSuspends = new Counter({
    name: 'sfu_dynacast_layer_suspends_total',
    help: 'Producer dynacast layer suspend requests',
    labelNames: ['reason']
  });
  readonly dynacastPublisherTargetedEvents = new Counter({
    name: 'sfu_dynacast_publisher_targeted_events_total',
    help: 'Publisher-only dynacast control events delivered to the producer socket',
    labelNames: ['event']
  });
  readonly dynacastSubscriberSuppressedEvents = new Counter({
    name: 'sfu_dynacast_subscriber_suppressed_events_total',
    help: 'Dynacast producer-control events intentionally withheld from subscriber sockets',
    labelNames: ['event']
  });
  readonly dynacastPublisherTargetFailures = new Counter({
    name: 'sfu_dynacast_publisher_target_failures_total',
    help: 'Dynacast producer-control events that could not be delivered to the publisher socket',
    labelNames: ['event', 'reason']
  });
  readonly dynacastControlFailures = new Counter({
    name: 'sfu_dynacast_control_failures_total',
    help: 'Dynacast control failures by reason',
    labelNames: ['reason']
  });
  readonly dynacastSenderControlApplyFailures = new Counter({
    name: 'sfu_dynacast_sender_control_apply_failures_total',
    help: 'Publisher browser RTCRtpSender dynacast setParameters failures',
    labelNames: ['reason']
  });
  readonly dynacastEstimatedBandwidthSaved = new Gauge({
    name: 'sfu_dynacast_estimated_bandwidth_saved_bps',
    help: 'Estimated producer upstream bitrate saved by dynacast',
    labelNames: ['kind']
  });
  readonly svcLayerSwitches = new Counter({
    name: 'sfu_svc_layer_switches_total',
    help: 'Successful SVC layer switches',
    labelNames: ['reason']
  });
  readonly svcLayerSwitchFailures = new Counter({
    name: 'sfu_svc_layer_switch_failures_total',
    help: 'Failed SVC layer switches',
    labelNames: ['reason']
  });
  readonly svcUnavailableLayerCount = new Counter({
    name: 'sfu_svc_layer_unavailable_total',
    help: 'Unavailable requested SVC layers',
    labelNames: ['reason']
  });
  readonly svcActiveLayers = new Gauge({
    name: 'sfu_svc_active_layers',
    help: 'Active SVC layers reported by producer kind and layer',
    labelNames: ['kind', 'spatialLayer', 'temporalLayer', 'scalabilityMode']
  });
  readonly consumerQualityScore = new Gauge({
    name: 'sfu_consumer_quality_score',
    help: 'Consumer adaptive quality score from 0 to 100',
    labelNames: ['roomId', 'participantId', 'consumerId']
  });
  readonly producerQualityScore = new Gauge({
    name: 'sfu_producer_quality_score',
    help: 'Producer adaptive quality score from 0 to 100',
    labelNames: ['roomId', 'participantId', 'producerId', 'kind']
  });
  readonly transportQualityScore = new Gauge({
    name: 'sfu_transport_quality_score',
    help: 'Transport aggregate adaptive quality score from 0 to 100',
    labelNames: ['roomId', 'participantId', 'transportId']
  });
  readonly roomQualityScore = new Gauge({
    name: 'sfu_room_quality_score',
    help: 'Room aggregate adaptive quality score from 0 to 100',
    labelNames: ['roomId']
  });
  readonly layerQualityScore = new Gauge({
    name: 'sfu_layer_quality_score',
    help: 'Per-layer adaptive quality score from 0 to 100',
    labelNames: ['roomId', 'producerId', 'spatialLayer', 'temporalLayer']
  });
  readonly qualityDegradations = new Counter({
    name: 'sfu_quality_degradations_total',
    help: 'Quality degradation events by scope and reason',
    labelNames: ['scope', 'reason']
  });
  readonly qualityRecoveries = new Counter({
    name: 'sfu_quality_recoveries_total',
    help: 'Quality recovery events by scope',
    labelNames: ['scope']
  });
  readonly consumerPriorityUpdates = new Counter({
    name: 'sfu_consumer_priority_updates_total',
    help: 'Consumer priority updates'
  });
  readonly producerPriorityUpdates = new Counter({
    name: 'sfu_producer_priority_updates_total',
    help: 'Producer priority updates',
    labelNames: ['kind']
  });
  readonly pacingQueueBytes = new Gauge({
    name: 'sfu_pacing_queue_bytes',
    help: 'Pacing queue depth in bytes',
    labelNames: ['roomId', 'participantId', 'scope']
  });
  readonly recommendedBitrate = new Gauge({
    name: 'sfu_recommended_bitrate_bps',
    help: 'Recommended bitrate in bits per second',
    labelNames: ['roomId', 'participantId', 'scope']
  });
  readonly availableBitrate = new Gauge({
    name: 'sfu_available_bitrate_bps',
    help: 'Available bitrate in bits per second',
    labelNames: ['roomId', 'participantId', 'scope']
  });
  readonly allocatedBitrate = new Gauge({
    name: 'sfu_allocated_bitrate_bps',
    help: 'Allocated bitrate in bits per second',
    labelNames: ['roomId', 'participantId', 'scope']
  });
  readonly transportTargetBitrate = new Gauge({
    name: 'sfu_transport_target_bitrate_bps',
    help: 'Transport target bitrate in bits per second',
    labelNames: ['roomId', 'participantId', 'transportId']
  });
  readonly transportAllocatedBitrate = new Gauge({
    name: 'sfu_transport_allocated_bitrate_bps',
    help: 'Transport allocated bitrate in bits per second',
    labelNames: ['roomId', 'participantId', 'transportId']
  });
  readonly transportActualBitrate = new Gauge({
    name: 'sfu_transport_actual_bitrate_bps',
    help: 'Transport actual bitrate in bits per second',
    labelNames: ['roomId', 'participantId', 'transportId']
  });
  readonly roomTargetBitrate = new Gauge({
    name: 'sfu_room_target_bitrate_bps',
    help: 'Room target bitrate in bits per second',
    labelNames: ['roomId']
  });
  readonly roomAllocatedBitrate = new Gauge({
    name: 'sfu_room_allocated_bitrate_bps',
    help: 'Room allocated bitrate in bits per second',
    labelNames: ['roomId']
  });
  readonly roomActualBitrate = new Gauge({
    name: 'sfu_room_actual_bitrate_bps',
    help: 'Room actual bitrate in bits per second',
    labelNames: ['roomId']
  });
  readonly roomCongestionState = new Gauge({
    name: 'sfu_room_congestion_state',
    help: 'Room congestion state as a one-hot gauge',
    labelNames: ['roomId', 'state']
  });
  readonly mediaWorkerModeInfo = new Gauge({
    name: 'sfu_media_worker_mode_info',
    help: 'Media worker mode. Value is 1 for the active mode.',
    labelNames: ['mode']
  });
  readonly mediaWorkersConfigured = new Gauge({
    name: 'sfu_media_workers_configured',
    help: 'Configured media worker process count'
  });
  readonly mediaWorkersReady = new Gauge({
    name: 'sfu_media_workers_ready',
    help: 'Ready media worker process count'
  });
  readonly mediaWorkerUp = new Gauge({
    name: 'sfu_media_worker_up',
    help: 'Media worker health status by worker id',
    labelNames: ['workerId']
  });
  readonly mediaWorkerRooms = new Gauge({
    name: 'sfu_media_worker_rooms',
    help: 'Active rooms assigned to a media worker',
    labelNames: ['workerId']
  });
  readonly mediaWorkerTransports = new Gauge({
    name: 'sfu_media_worker_transports',
    help: 'Active transports owned by a media worker',
    labelNames: ['workerId']
  });
  readonly mediaWorkerProducers = new Gauge({
    name: 'sfu_media_worker_producers',
    help: 'Active producers owned by a media worker',
    labelNames: ['workerId']
  });
  readonly mediaWorkerConsumers = new Gauge({
    name: 'sfu_media_worker_consumers',
    help: 'Active consumers owned by a media worker',
    labelNames: ['workerId']
  });
  readonly mediaWorkerRtpPackets = new Gauge({
    name: 'sfu_media_worker_rtp_packets',
    help: 'RTP packets forwarded by media worker',
    labelNames: ['workerId']
  });
  readonly mediaWorkerRtcpPackets = new Gauge({
    name: 'sfu_media_worker_rtcp_packets',
    help: 'RTCP packets handled by media worker',
    labelNames: ['workerId']
  });
  readonly mediaWorkerIpcRequests = new Counter({
    name: 'sfu_media_worker_ipc_requests_total',
    help: 'Media worker IPC requests by operation and status',
    labelNames: ['operation', 'status']
  });
  readonly mediaWorkerIpcLatency = new Histogram({
    name: 'sfu_media_worker_ipc_request_duration_ms',
    help: 'Media worker IPC request duration in milliseconds',
    labelNames: ['operation'],
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  });
  readonly mediaWorkerIpcInflight = new Gauge({
    name: 'sfu_media_worker_ipc_inflight',
    help: 'Media worker IPC inflight requests',
    labelNames: ['workerId']
  });
  readonly mediaWorkerIpcQueueDepth = new Gauge({
    name: 'sfu_media_worker_ipc_queue_depth',
    help: 'Media worker IPC queue depth',
    labelNames: ['workerId']
  });
  readonly mediaWorkerIpcTimeouts = new Gauge({
    name: 'sfu_media_worker_ipc_timeouts',
    help: 'Media worker IPC timeout count',
    labelNames: ['workerId']
  });
  readonly mediaWorkerCrashes = new Counter({
    name: 'sfu_media_worker_crashes_total',
    help: 'Media worker crashes by worker and reason',
    labelNames: ['workerId', 'reason']
  });
  readonly mediaWorkerRestarts = new Counter({
    name: 'sfu_media_worker_restarts_total',
    help: 'Media worker restarts by worker and reason',
    labelNames: ['workerId', 'reason']
  });
  readonly mediaWorkerDrains = new Counter({
    name: 'sfu_media_worker_drains_total',
    help: 'Media worker drain transitions by worker and state',
    labelNames: ['workerId', 'state']
  });
  readonly mediaWorkerRoomFailures = new Counter({
    name: 'sfu_media_worker_room_failures_total',
    help: 'Rooms failed by media worker fault reason',
    labelNames: ['reason']
  });
  readonly mediaWorkerFailedRooms = new Gauge({
    name: 'sfu_media_worker_failed_rooms',
    help: 'Failed rooms currently quarantined by media worker pool'
  });
  readonly mediaWorkerDraining = new Gauge({
    name: 'sfu_media_worker_draining',
    help: 'Media worker draining state by worker id',
    labelNames: ['workerId']
  });
  readonly mediaWorkerOverloaded = new Gauge({
    name: 'sfu_media_worker_overloaded',
    help: 'Media worker overload state by worker id',
    labelNames: ['workerId']
  });
  readonly mediaWorkerCapacityScore = new Gauge({
    name: 'sfu_media_worker_capacity_score',
    help: 'Media worker normalized capacity pressure score',
    labelNames: ['workerId']
  });
  readonly mediaWorkerPid = new Gauge({
    name: 'sfu_media_worker_pid',
    help: 'Media worker process id',
    labelNames: ['workerId']
  });
  readonly mediaWorkerUptimeMs = new Gauge({
    name: 'sfu_media_worker_uptime_ms',
    help: 'Media worker process uptime in milliseconds',
    labelNames: ['workerId']
  });
  readonly mediaWorkerRssBytes = new Gauge({
    name: 'sfu_media_worker_rss_bytes',
    help: 'Media worker RSS memory in bytes',
    labelNames: ['workerId']
  });
  readonly mediaWorkerHeapUsedBytes = new Gauge({
    name: 'sfu_media_worker_heap_used_bytes',
    help: 'Media worker heap used in bytes',
    labelNames: ['workerId']
  });
  readonly mediaWorkerCpuUserMicros = new Gauge({
    name: 'sfu_media_worker_cpu_user_micros',
    help: 'Media worker cumulative user CPU time in microseconds',
    labelNames: ['workerId']
  });
  readonly mediaWorkerCpuSystemMicros = new Gauge({
    name: 'sfu_media_worker_cpu_system_micros',
    help: 'Media worker cumulative system CPU time in microseconds',
    labelNames: ['workerId']
  });
  readonly mediaWorkerRtpPacketRate = new Gauge({
    name: 'sfu_media_worker_rtp_packet_rate',
    help: 'Media worker RTP packets per second',
    labelNames: ['workerId']
  });
  readonly mediaWorkerRtcpPacketRate = new Gauge({
    name: 'sfu_media_worker_rtcp_packet_rate',
    help: 'Media worker RTCP packets per second',
    labelNames: ['workerId']
  });
  readonly mediaWorkerDroppedRtpPackets = new Gauge({
    name: 'sfu_media_worker_dropped_rtp_packets',
    help: 'Media worker RTP packets dropped before forwarding',
    labelNames: ['workerId']
  });
  readonly mediaWorkerDroppedRtpReasons = new Gauge({
    name: 'sfu_media_worker_dropped_rtp_reasons',
    help: 'Media worker RTP packet drops by reason',
    labelNames: ['workerId', 'reason']
  });
  readonly mediaWorkerHeartbeatAgeMs = new Gauge({
    name: 'sfu_media_worker_heartbeat_age_ms',
    help: 'Milliseconds since the last media worker heartbeat',
    labelNames: ['workerId']
  });
  readonly roomAdmissionRejections = new Counter({
    name: 'sfu_room_admission_rejections_total',
    help: 'Room admission or media allocation rejections',
    labelNames: ['reason']
  });
  readonly roomProfileDistribution = new Gauge({
    name: 'sfu_room_profile_distribution',
    help: 'Active rooms by media profile',
    labelNames: ['profile']
  });
  readonly roomProfileChanges = new Counter({
    name: 'sfu_room_profile_changes_total',
    help: 'Room media profile changes',
    labelNames: ['from', 'to']
  });
  readonly roomProtectionDecisions = new Counter({
    name: 'sfu_room_protection_decisions_total',
    help: 'Non-allow room protection decisions by profile, scope, action, and reason',
    labelNames: ['profile', 'scope', 'action', 'reason']
  });
  readonly degradedRoomCount = new Gauge({
    name: 'sfu_degraded_room_count',
    help: 'Rooms currently in degraded or critical state by profile and health',
    labelNames: ['profile', 'health']
  });
  readonly currentRoomProtectionState = new Gauge({
    name: 'sfu_room_protection_state',
    help: 'Current room protection state by profile, scope, and action',
    labelNames: ['profile', 'scope', 'action']
  });
  readonly policyRecommendationCounts = new Gauge({
    name: 'sfu_room_policy_recommendation_count',
    help: 'Current policy recommendation counts by profile, recommendation code, and severity',
    labelNames: ['profile', 'code', 'severity']
  });
  readonly incidentSnapshotsGenerated = new Counter({
    name: 'sfu_incident_snapshots_generated_total',
    help: 'Incident snapshots generated by scope',
    labelNames: ['scope']
  });
  readonly snapshotBundlesGenerated = new Counter({
    name: 'sfu_snapshot_bundles_generated_total',
    help: 'Room incident snapshot bundles generated by trigger and mode',
    labelNames: ['trigger', 'mode']
  });
  readonly roomRecoveryActions = new Counter({
    name: 'sfu_room_recovery_actions_total',
    help: 'Operator room recovery actions by action and outcome',
    labelNames: ['action', 'outcome']
  });
  readonly reopenedRooms = new Counter({
    name: 'sfu_reopened_rooms_total',
    help: 'Rooms reopened by explicit operator recovery action'
  });
  readonly roomsUnderRecovery = new Gauge({
    name: 'sfu_rooms_under_recovery',
    help: 'Rooms currently marked under active operator recovery'
  });
  readonly roomRecoveryDuration = new Histogram({
    name: 'sfu_room_recovery_duration_ms',
    help: 'Room recovery duration in milliseconds',
    buckets: [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000]
  });
  readonly roomAlertEvents = new Counter({
    name: 'sfu_room_alert_events_total',
    help: 'Room operator alert lifecycle events',
    labelNames: ['code', 'status']
  });
  readonly roomIncidentTimelineEvents = new Counter({
    name: 'sfu_room_incident_timeline_events_total',
    help: 'Room incident timeline events by type and severity',
    labelNames: ['type', 'severity']
  });
  readonly platformEventsEmitted = new Counter({
    name: 'sfu_platform_events_emitted_total',
    help: 'Platform events emitted by event type',
    labelNames: ['type']
  });
  readonly platformEventQueries = new Counter({
    name: 'sfu_platform_event_queries_total',
    help: 'Platform event-log queries by scope',
    labelNames: ['scope']
  });
  readonly webhookDeliveryAttempts = new Counter({
    name: 'sfu_webhook_delivery_attempts_total',
    help: 'Webhook delivery attempts by platform event type',
    labelNames: ['type']
  });
  readonly webhookDeliveriesSucceeded = new Counter({
    name: 'sfu_webhook_deliveries_succeeded_total',
    help: 'Successful webhook deliveries by platform event type',
    labelNames: ['type']
  });
  readonly webhookDeliveriesFailed = new Counter({
    name: 'sfu_webhook_deliveries_failed_total',
    help: 'Failed webhook deliveries scheduled for retry by platform event type',
    labelNames: ['type']
  });
  readonly webhookDeliveriesExhausted = new Counter({
    name: 'sfu_webhook_deliveries_exhausted_total',
    help: 'Webhook deliveries that exhausted retries by platform event type',
    labelNames: ['type']
  });
  readonly webhookDeliveriesCancelled = new Counter({
    name: 'sfu_webhook_deliveries_cancelled_total',
    help: 'Webhook deliveries cancelled before dispatch by reason',
    labelNames: ['reason']
  });
  readonly webhookRetriesScheduled = new Counter({
    name: 'sfu_webhook_retries_scheduled_total',
    help: 'Webhook retries scheduled by platform event type',
    labelNames: ['type']
  });
  readonly webhookReplays = new Counter({
    name: 'sfu_webhook_replays_total',
    help: 'Manual webhook replay requests by scope',
    labelNames: ['scope']
  });
  readonly webhookEndpointCounts = new Gauge({
    name: 'sfu_webhook_endpoint_count',
    help: 'Webhook endpoint counts by state',
    labelNames: ['state']
  });
  readonly webhookDeliveryQueue = new Gauge({
    name: 'sfu_webhook_delivery_queue',
    help: 'Webhook delivery counts by queue state',
    labelNames: ['state']
  });
  readonly webhookDeliveryLatency = new Histogram({
    name: 'sfu_webhook_delivery_duration_ms',
    help: 'Webhook delivery latency in milliseconds',
    labelNames: ['result'],
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
  });
  readonly producerNodeIdFallbacks = new Counter({
    name: 'sfu_producer_node_id_fallbacks_total',
    help: 'Legacy producer node-id compatibility fallbacks by resolution path',
    labelNames: ['resolution']
  });
  readonly producerNodeIdBackfills = new Counter({
    name: 'sfu_producer_node_id_backfills_total',
    help: 'Legacy producer node-id backfills persisted by resolution path',
    labelNames: ['resolution']
  });
  readonly clusterNodeInfo = new Gauge({
    name: 'sfu_cluster_node_info',
    help: 'Static identity for the local backend node. Value is always 1.',
    labelNames: ['nodeId', 'region', 'zone']
  });
  readonly clusterRegisteredNodes = new Gauge({
    name: 'sfu_cluster_registered_nodes',
    help: 'Backend nodes currently registered in Redis'
  });
  readonly clusterHealthyNodes = new Gauge({
    name: 'sfu_cluster_healthy_nodes',
    help: 'Healthy backend nodes currently registered in Redis'
  });
  readonly clusterDrainingNodes = new Gauge({
    name: 'sfu_cluster_draining_nodes',
    help: 'Backend nodes currently marked draining'
  });
  readonly clusterOwnedRooms = new Gauge({
    name: 'sfu_cluster_owned_rooms',
    help: 'Rooms owned by this backend node'
  });
  readonly clusterNodeCapacityScore = new Gauge({
    name: 'sfu_cluster_node_capacity_score',
    help: 'Local backend node capacity pressure score',
    labelNames: ['nodeId']
  });
  readonly remoteRoomJoinAttempts = new Counter({
    name: 'sfu_remote_room_join_attempts_total',
    help: 'Room joins or commands received by a node that does not own the room',
    labelNames: ['reason']
  });
  readonly roomOwnerRedirects = new Counter({
    name: 'sfu_room_owner_redirects_total',
    help: 'Room ownership redirects returned to clients',
    labelNames: ['reason']
  });
  readonly roomOwnershipClaims = new Counter({
    name: 'sfu_room_ownership_claims_total',
    help: 'Room ownership claim attempts by result',
    labelNames: ['result']
  });
  readonly roomOwnerLookupLatency = new Histogram({
    name: 'sfu_room_owner_lookup_duration_ms',
    help: 'Redis room owner lookup latency in milliseconds',
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]
  });
  readonly clusterNodeHeartbeatLatency = new Histogram({
    name: 'sfu_cluster_node_heartbeat_duration_ms',
    help: 'Redis node heartbeat latency in milliseconds',
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]
  });
  readonly staleRoomOwners = new Counter({
    name: 'sfu_stale_room_owners_total',
    help: 'Room owner lookups that found missing or expired owner/node leases'
  });
  readonly roomOwnershipConflicts = new Counter({
    name: 'sfu_room_ownership_conflicts_total',
    help: 'Room ownership claim or renewal conflicts'
  });
  readonly pipeTransportsCreated = new Counter({
    name: 'sfu_pipe_transports_created_total',
    help: 'Cross-node pipe transports created',
    labelNames: ['protocol']
  });
  readonly pipeCreateRequests = new Counter({
    name: 'sfu_pipe_create_requests_total',
    help: 'Pipe transport create requests initiated by protocol',
    labelNames: ['protocol']
  });
  readonly activePipeTransports = new Gauge({
    name: 'sfu_pipe_transports_active',
    help: 'Active cross-node pipe transports'
  });
  readonly pipeProducers = new Gauge({
    name: 'sfu_pipe_producers',
    help: 'Active pipe producers'
  });
  readonly pipeConsumers = new Gauge({
    name: 'sfu_pipe_consumers',
    help: 'Active pipe consumers'
  });
  readonly pipeRtpPackets = new Counter({
    name: 'sfu_pipe_rtp_packets_total',
    help: 'RTP packets sent or received over pipe transports',
    labelNames: ['direction']
  });
  readonly pipeRtpBytes = new Counter({
    name: 'sfu_pipe_rtp_bytes_total',
    help: 'RTP bytes sent or received over pipe transports',
    labelNames: ['direction']
  });
  readonly pipeRtcpPackets = new Counter({
    name: 'sfu_pipe_rtcp_packets_total',
    help: 'RTCP packets sent or received over pipe transports',
    labelNames: ['direction']
  });
  readonly pipeRtcpBytes = new Counter({
    name: 'sfu_pipe_rtcp_bytes_total',
    help: 'RTCP bytes sent or received over pipe transports',
    labelNames: ['direction']
  });
  readonly pipePacketLoss = new Gauge({
    name: 'sfu_pipe_packet_loss_ratio',
    help: 'Pipe transport packet loss estimate',
    labelNames: ['pipeTransportId']
  });
  readonly pipeJitter = new Gauge({
    name: 'sfu_pipe_jitter_ms',
    help: 'Pipe transport jitter in milliseconds',
    labelNames: ['pipeTransportId']
  });
  readonly pipeRtt = new Gauge({
    name: 'sfu_pipe_rtt_ms',
    help: 'Pipe transport RTT in milliseconds',
    labelNames: ['pipeTransportId']
  });
  readonly pipeSetupLatency = new Histogram({
    name: 'sfu_pipe_setup_duration_ms',
    help: 'Pipe setup latency in milliseconds',
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  });
  readonly pipeTeardowns = new Counter({
    name: 'sfu_pipe_teardowns_total',
    help: 'Pipe transport teardown count',
    labelNames: ['reason']
  });
  readonly pipeErrors = new Counter({
    name: 'sfu_pipe_errors_total',
    help: 'Pipe transport or coordination errors',
    labelNames: ['code']
  });
  readonly pipeCleanupFailures = new Counter({
    name: 'sfu_pipe_cleanup_failures_total',
    help: 'Pipe cleanup or release failures by operation stage',
    labelNames: ['stage']
  });
  readonly pipeBackpressureEvents = new Counter({
    name: 'sfu_pipe_backpressure_events_total',
    help: 'Pipe transport backpressure events',
    labelNames: ['pipeTransportId']
  });
  readonly pipeCoordinationRetries = new Counter({
    name: 'sfu_pipe_coordination_retries_total',
    help: 'Pipe coordination retry attempts',
    labelNames: ['type']
  });
  readonly pipeCoordinationTimeouts = new Counter({
    name: 'sfu_pipe_coordination_timeouts_total',
    help: 'Pipe coordination requests that timed out',
    labelNames: ['type']
  });
  readonly pipeUdpSetupSuccess = new Counter({
    name: 'sfu_pipe_udp_setup_success_total',
    help: 'UDP pipe setup handshakes completed successfully'
  });
  readonly pipeUdpSetupFailures = new Counter({
    name: 'sfu_pipe_udp_setup_failures_total',
    help: 'UDP pipe setup handshakes failed',
    labelNames: ['reason']
  });
  readonly pipeRemoteAttachFailures = new Counter({
    name: 'sfu_pipe_remote_attach_failures_total',
    help: 'Remote subscriber attachment failures by stage',
    labelNames: ['stage']
  });
  readonly pipeRemotePublishFailures = new Counter({
    name: 'sfu_pipe_remote_publish_failures_total',
    help: 'Remote publisher attachment or synchronization failures by stage',
    labelNames: ['stage']
  });
  readonly pipeWorkerModeRejected = new Counter({
    name: 'sfu_pipe_worker_mode_rejections_total',
    help: 'Pipe operations rejected because worker-mode pipe IPC is unavailable',
    labelNames: ['operation']
  });
  readonly pipePeerAdmissionFailures = new Counter({
    name: 'sfu_pipe_peer_admission_failures_total',
    help: 'Pipe peer admission failures by reason',
    labelNames: ['reason']
  });
  readonly pipeSignalingReroutes = new Counter({
    name: 'sfu_pipe_signaling_reroutes_total',
    help: 'Non-owner subscriber joins or commands rerouted through pipe-aware signaling',
    labelNames: ['reason']
  });
  readonly pipeRtcpForwarded = new Counter({
    name: 'sfu_pipe_rtcp_forwarded_total',
    help: 'RTCP packets forwarded into media routing from pipe coordination',
    labelNames: ['direction']
  });
  readonly pipeRejectedRequests = new Gauge({
    name: 'sfu_pipe_rejected_requests',
    help: 'Pipe coordination requests currently tracked as rejected by the local node'
  });
  readonly pipeRuntimeInfo = new Gauge({
    name: 'sfu_pipe_runtime_info',
    help: 'Current local pipe runtime configuration and support state. Value is always 1.',
    labelNames: ['enabled', 'durable', 'supported', 'mediaWorkerMode', 'defaultProtocol', 'advertiseIpConfigured', 'reason']
  });
  readonly controlPlaneMessagesPublished = new Counter({
    name: 'sfu_control_plane_messages_published_total',
    help: 'Durable control-plane messages published by stream',
    labelNames: ['stream']
  });
  readonly controlPlanePublishFailures = new Counter({
    name: 'sfu_control_plane_publish_failures_total',
    help: 'Durable control-plane publish failures by stream',
    labelNames: ['stream']
  });
  readonly controlPlaneMessagesDelivered = new Counter({
    name: 'sfu_control_plane_messages_delivered_total',
    help: 'Durable control-plane messages delivered to handlers by stream',
    labelNames: ['stream']
  });
  readonly controlPlaneConsumeFailures = new Counter({
    name: 'sfu_control_plane_consume_failures_total',
    help: 'Durable control-plane read or handler failures by stream and phase',
    labelNames: ['stream', 'phase']
  });
  readonly controlPlaneReplayMessages = new Counter({
    name: 'sfu_control_plane_replay_messages_total',
    help: 'Durable control-plane messages replayed from persisted offsets',
    labelNames: ['stream']
  });
  readonly controlPlaneDuplicateSuppressions = new Counter({
    name: 'sfu_control_plane_duplicate_suppressions_total',
    help: 'Duplicate control-plane messages suppressed by stream and reason',
    labelNames: ['stream', 'reason']
  });
  readonly crossNodeSubscribers = new Gauge({
    name: 'sfu_cross_node_subscribers',
    help: 'Active subscribers served through cross-node pipe forwarding'
  });
  readonly metricsRefreshFailures = new Counter({
    name: 'sfu_metrics_refresh_failures_total',
    help: 'Runtime metric refresh failures before a Prometheus scrape',
    labelNames: ['component']
  });
  readonly metricsRefreshStatus = new Gauge({
    name: 'sfu_metrics_refresh_status',
    help: 'Last runtime metric refresh status before a Prometheus scrape',
    labelNames: ['component']
  });

  onModuleInit(): void {
    this.registry.setDefaultLabels({ service: 'native-webrtc-sfu' });
    client.collectDefaultMetrics({ register: this.registry });
    [
      this.activeRooms,
      this.activeParticipants,
      this.activeTransports,
      this.activeProducers,
      this.activeConsumers,
      this.forwardedRtpPackets,
      this.droppedRtpPackets,
      this.roomJoinDuration,
      this.packetLoss,
      this.rtt,
      this.jitter,
      this.bandwidth,
      this.successfulLayerSwitches,
      this.failedLayerSwitches,
      this.layerSwitchDuration,
      this.unavailableLayerCount,
      this.dynacastLayerDemandChanges,
      this.dynacastLayerResumes,
      this.dynacastLayerSuspends,
      this.dynacastPublisherTargetedEvents,
      this.dynacastSubscriberSuppressedEvents,
      this.dynacastPublisherTargetFailures,
      this.dynacastControlFailures,
      this.dynacastSenderControlApplyFailures,
      this.dynacastEstimatedBandwidthSaved,
      this.svcLayerSwitches,
      this.svcLayerSwitchFailures,
      this.svcUnavailableLayerCount,
      this.svcActiveLayers,
      this.consumerQualityScore,
      this.producerQualityScore,
      this.transportQualityScore,
      this.roomQualityScore,
      this.layerQualityScore,
      this.qualityDegradations,
      this.qualityRecoveries,
      this.consumerPriorityUpdates,
      this.producerPriorityUpdates,
      this.pacingQueueBytes,
      this.recommendedBitrate,
      this.availableBitrate,
      this.allocatedBitrate,
      this.transportTargetBitrate,
      this.transportAllocatedBitrate,
      this.transportActualBitrate,
      this.roomTargetBitrate,
      this.roomAllocatedBitrate,
      this.roomActualBitrate,
      this.roomCongestionState,
      this.mediaWorkerModeInfo,
      this.mediaWorkersConfigured,
      this.mediaWorkersReady,
      this.mediaWorkerUp,
      this.mediaWorkerRooms,
      this.mediaWorkerTransports,
      this.mediaWorkerProducers,
      this.mediaWorkerConsumers,
      this.mediaWorkerRtpPackets,
      this.mediaWorkerRtcpPackets,
      this.mediaWorkerIpcRequests,
      this.mediaWorkerIpcLatency,
      this.mediaWorkerIpcInflight,
      this.mediaWorkerIpcQueueDepth,
      this.mediaWorkerIpcTimeouts,
      this.mediaWorkerCrashes,
      this.mediaWorkerRestarts,
      this.mediaWorkerDrains,
      this.mediaWorkerRoomFailures,
      this.mediaWorkerFailedRooms,
      this.mediaWorkerDraining,
      this.mediaWorkerOverloaded,
      this.mediaWorkerCapacityScore,
      this.mediaWorkerPid,
      this.mediaWorkerUptimeMs,
      this.mediaWorkerRssBytes,
      this.mediaWorkerHeapUsedBytes,
      this.mediaWorkerCpuUserMicros,
      this.mediaWorkerCpuSystemMicros,
      this.mediaWorkerRtpPacketRate,
      this.mediaWorkerRtcpPacketRate,
      this.mediaWorkerDroppedRtpPackets,
      this.mediaWorkerDroppedRtpReasons,
      this.mediaWorkerHeartbeatAgeMs,
      this.roomAdmissionRejections,
      this.roomProfileDistribution,
      this.roomProfileChanges,
      this.roomProtectionDecisions,
      this.degradedRoomCount,
      this.currentRoomProtectionState,
      this.policyRecommendationCounts,
      this.incidentSnapshotsGenerated,
      this.snapshotBundlesGenerated,
      this.roomRecoveryActions,
      this.reopenedRooms,
      this.roomsUnderRecovery,
      this.roomRecoveryDuration,
      this.roomAlertEvents,
      this.roomIncidentTimelineEvents,
      this.platformEventsEmitted,
      this.platformEventQueries,
      this.webhookDeliveryAttempts,
      this.webhookDeliveriesSucceeded,
      this.webhookDeliveriesFailed,
      this.webhookDeliveriesExhausted,
      this.webhookDeliveriesCancelled,
      this.webhookRetriesScheduled,
      this.webhookReplays,
      this.webhookEndpointCounts,
      this.webhookDeliveryQueue,
      this.webhookDeliveryLatency,
      this.producerNodeIdFallbacks,
      this.producerNodeIdBackfills,
      this.clusterNodeInfo,
      this.clusterRegisteredNodes,
      this.clusterHealthyNodes,
      this.clusterDrainingNodes,
      this.clusterOwnedRooms,
      this.clusterNodeCapacityScore,
      this.remoteRoomJoinAttempts,
      this.roomOwnerRedirects,
      this.roomOwnershipClaims,
      this.roomOwnerLookupLatency,
      this.clusterNodeHeartbeatLatency,
      this.staleRoomOwners,
      this.roomOwnershipConflicts,
      this.pipeTransportsCreated,
      this.pipeCreateRequests,
      this.activePipeTransports,
      this.pipeProducers,
      this.pipeConsumers,
      this.pipeRtpPackets,
      this.pipeRtpBytes,
      this.pipeRtcpPackets,
      this.pipeRtcpBytes,
      this.pipePacketLoss,
      this.pipeJitter,
      this.pipeRtt,
      this.pipeSetupLatency,
      this.pipeTeardowns,
      this.pipeErrors,
      this.pipeCleanupFailures,
      this.pipeBackpressureEvents,
      this.pipeCoordinationRetries,
      this.pipeCoordinationTimeouts,
      this.pipeUdpSetupSuccess,
      this.pipeUdpSetupFailures,
      this.pipeRemoteAttachFailures,
      this.pipeRemotePublishFailures,
      this.pipeWorkerModeRejected,
      this.pipePeerAdmissionFailures,
      this.pipeSignalingReroutes,
      this.pipeRtcpForwarded,
      this.pipeRejectedRequests,
      this.pipeRuntimeInfo,
      this.controlPlaneMessagesPublished,
      this.controlPlanePublishFailures,
      this.controlPlaneMessagesDelivered,
      this.controlPlaneConsumeFailures,
      this.controlPlaneReplayMessages,
      this.controlPlaneDuplicateSuppressions,
      this.crossNodeSubscribers,
      this.metricsRefreshFailures,
      this.metricsRefreshStatus
    ].forEach((metric) => this.registry.registerMetric(metric as never));
  }

  refreshMediaWorkerSnapshot(snapshot: MediaWorkerPoolSnapshot): void {
    const currentWorkerIds = new Set<string>();
    const currentDropReasons = new Set<string>();
    this.mediaWorkerModeInfo.labels('in-process').set(snapshot.mode === 'in-process' ? 1 : 0);
    this.mediaWorkerModeInfo.labels('worker').set(snapshot.mode === 'worker' ? 1 : 0);
    this.mediaWorkersConfigured.set(snapshot.workerCount);
    this.mediaWorkersReady.set(snapshot.readyWorkers);
    this.mediaWorkerFailedRooms.set(snapshot.failedRooms.length);
    for (const workerId of this.trackedMediaWorkerIds) {
      if (!snapshot.workers.some((worker) => worker.workerId === workerId)) {
        this.clearMediaWorkerMetrics(workerId);
      }
    }
    for (const worker of snapshot.workers) {
      currentWorkerIds.add(worker.workerId);
      this.mediaWorkerUp.labels(worker.workerId).set(worker.healthy ? 1 : 0);
      this.mediaWorkerDraining.labels(worker.workerId).set(worker.draining ? 1 : 0);
      this.mediaWorkerOverloaded.labels(worker.workerId).set(worker.overloaded ? 1 : 0);
      this.mediaWorkerCapacityScore.labels(worker.workerId).set(worker.capacityScore ?? 0);
      if (worker.pid) {
        this.mediaWorkerPid.labels(worker.workerId).set(worker.pid);
      } else {
        this.mediaWorkerPid.remove(worker.workerId);
      }
      this.mediaWorkerUptimeMs.labels(worker.workerId).set(worker.uptimeMs ?? 0);
      this.mediaWorkerRooms.labels(worker.workerId).set(worker.activeRooms);
      this.mediaWorkerTransports.labels(worker.workerId).set(worker.activeTransports);
      this.mediaWorkerProducers.labels(worker.workerId).set(worker.activeProducers);
      this.mediaWorkerConsumers.labels(worker.workerId).set(worker.activeConsumers);
      this.mediaWorkerRtpPackets.labels(worker.workerId).set(worker.rtpPackets);
      this.mediaWorkerRtcpPackets.labels(worker.workerId).set(worker.rtcpPackets);
      this.mediaWorkerRtpPacketRate.labels(worker.workerId).set(worker.rtpPacketRate ?? 0);
      this.mediaWorkerRtcpPacketRate.labels(worker.workerId).set(worker.rtcpPacketRate ?? 0);
      this.mediaWorkerDroppedRtpPackets.labels(worker.workerId).set(worker.droppedRtpPackets ?? 0);
      this.mediaWorkerIpcInflight.labels(worker.workerId).set(worker.inflightRequests);
      this.mediaWorkerIpcQueueDepth.labels(worker.workerId).set(worker.queueDepth);
      this.mediaWorkerIpcTimeouts.labels(worker.workerId).set(worker.ipcTimeouts);
      this.mediaWorkerRssBytes.labels(worker.workerId).set(worker.memory?.rss ?? 0);
      this.mediaWorkerHeapUsedBytes.labels(worker.workerId).set(worker.memory?.heapUsed ?? 0);
      this.mediaWorkerCpuUserMicros.labels(worker.workerId).set(worker.cpu?.user ?? 0);
      this.mediaWorkerCpuSystemMicros.labels(worker.workerId).set(worker.cpu?.system ?? 0);
      this.mediaWorkerHeartbeatAgeMs.labels(worker.workerId).set(heartbeatAgeMs(worker.lastHeartbeatAt));
      for (const [reason, count] of Object.entries(worker.droppedRtpReasons ?? {})) {
        currentDropReasons.add(`${worker.workerId}:${reason}`);
        this.mediaWorkerDroppedRtpReasons.labels(worker.workerId, reason).set(count ?? 0);
      }
    }
    for (const key of this.trackedMediaWorkerDropReasons) {
      if (!currentDropReasons.has(key)) {
        const [workerId, reason] = splitTrackedMetricKey(key);
        this.mediaWorkerDroppedRtpReasons.remove(workerId, reason);
      }
    }
    this.trackedMediaWorkerIds.clear();
    for (const workerId of currentWorkerIds) {
      this.trackedMediaWorkerIds.add(workerId);
    }
    this.trackedMediaWorkerDropReasons.clear();
    for (const key of currentDropReasons) {
      this.trackedMediaWorkerDropReasons.add(key);
    }
  }

  refreshClusterSnapshot(snapshot: {
    localNode: ClusterNodeInfo;
    nodes: ClusterNodeInfo[];
    ownedRoomCount: number;
  }): void {
    this.clusterNodeInfo.labels(snapshot.localNode.nodeId, snapshot.localNode.region ?? 'unknown', snapshot.localNode.zone ?? 'unknown').set(1);
    this.clusterRegisteredNodes.set(snapshot.nodes.length);
    this.clusterHealthyNodes.set(snapshot.nodes.filter((node) => node.health === 'healthy').length);
    this.clusterDrainingNodes.set(snapshot.nodes.filter((node) => node.draining).length);
    this.clusterOwnedRooms.set(snapshot.ownedRoomCount);
    this.clusterNodeCapacityScore.labels(snapshot.localNode.nodeId).set(snapshot.localNode.capacity.capacityScore);
  }

  refreshPipeSnapshot(summary: PipeCoordinatorSnapshot, health: PipeCoordinatorHealthSnapshot): void {
    this.activePipeTransports.set(summary.activePipeTransports);
    this.pipeProducers.set(summary.pipeProducers);
    this.pipeConsumers.set(summary.pipeConsumers);
    this.pipeRejectedRequests.set(summary.rejectedRequests);
    this.pipeRuntimeInfo.reset();
    this.pipeRuntimeInfo
      .labels(
        String(health.enabled),
        String(health.durable),
        String(health.supported),
        health.mediaWorkerMode,
        health.defaultProtocol,
        String(health.advertiseIpConfigured),
        health.reason ?? 'none'
      )
      .set(1);
  }

  refreshPipeTransportMetrics(snapshots: Array<{ id: string; rtpPackets: number; droppedPackets: number }>): void {
    const currentTransportIds = new Set<string>();
    for (const snapshot of snapshots) {
      currentTransportIds.add(snapshot.id);
      this.trackedPipeTransportIds.add(snapshot.id);
      this.pipePacketLoss.labels(snapshot.id).set(snapshot.rtpPackets > 0 ? snapshot.droppedPackets / snapshot.rtpPackets : 0);
    }
    for (const pipeTransportId of [...this.trackedPipeTransportIds]) {
      if (!currentTransportIds.has(pipeTransportId)) {
        this.clearPipeTransportMetrics(pipeTransportId);
      }
    }
  }

  updatePipeTransportMetrics(pipeTransportId: string, stats: { packetLoss?: number; jitterMs?: number; rttMs?: number }): void {
    this.trackedPipeTransportIds.add(pipeTransportId);
    this.pipePacketLoss.labels(pipeTransportId).set(stats.packetLoss ?? 0);
    this.pipeJitter.labels(pipeTransportId).set(stats.jitterMs ?? 0);
    this.pipeRtt.labels(pipeTransportId).set(stats.rttMs ?? 0);
  }

  clearPipeTransportMetrics(pipeTransportId: string): void {
    this.pipePacketLoss.remove(pipeTransportId);
    this.pipeJitter.remove(pipeTransportId);
    this.pipeRtt.remove(pipeTransportId);
    this.trackedPipeTransportIds.delete(pipeTransportId);
  }

  markRefreshStatus(component: 'cluster' | 'pipe' | 'media_workers', ok: boolean): void {
    this.metricsRefreshStatus.labels(component).set(ok ? 1 : 0);
    if (!ok) {
      this.metricsRefreshFailures.labels(component).inc();
    }
  }

  updateRoomAutopilotSummary(next: RoomQualitySummaryState, previous?: RoomQualitySummaryState): void {
    if (previous) {
      this.clearRoomAutopilotSummary(previous);
    }
    if (next.health !== 'stable') {
      this.degradedRoomCount.labels(next.profile.id, next.health).inc();
    }
    for (const [scope, decision] of Object.entries(next.protections)) {
      this.currentRoomProtectionState.labels(next.profile.id, scope, decision.action).inc();
    }
    for (const recommendation of next.recommendations) {
      this.policyRecommendationCounts
        .labels(next.profile.id, recommendation.code, recommendation.severity)
        .inc();
    }
  }

  clearRoomAutopilotSummary(summary: RoomQualitySummaryState | undefined): void {
    if (!summary) {
      return;
    }
    if (summary.health !== 'stable') {
      this.degradedRoomCount.labels(summary.profile.id, summary.health).dec();
    }
    for (const [scope, decision] of Object.entries(summary.protections)) {
      this.currentRoomProtectionState.labels(summary.profile.id, scope, decision.action).dec();
    }
    for (const recommendation of summary.recommendations) {
      this.policyRecommendationCounts
        .labels(summary.profile.id, recommendation.code, recommendation.severity)
        .dec();
    }
  }

  async text(): Promise<string> {
    return this.registry.metrics();
  }

  private clearMediaWorkerMetrics(workerId: string): void {
    this.mediaWorkerUp.remove(workerId);
    this.mediaWorkerDraining.remove(workerId);
    this.mediaWorkerOverloaded.remove(workerId);
    this.mediaWorkerCapacityScore.remove(workerId);
    this.mediaWorkerPid.remove(workerId);
    this.mediaWorkerUptimeMs.remove(workerId);
    this.mediaWorkerRooms.remove(workerId);
    this.mediaWorkerTransports.remove(workerId);
    this.mediaWorkerProducers.remove(workerId);
    this.mediaWorkerConsumers.remove(workerId);
    this.mediaWorkerRtpPackets.remove(workerId);
    this.mediaWorkerRtcpPackets.remove(workerId);
    this.mediaWorkerRtpPacketRate.remove(workerId);
    this.mediaWorkerRtcpPacketRate.remove(workerId);
    this.mediaWorkerDroppedRtpPackets.remove(workerId);
    this.mediaWorkerIpcInflight.remove(workerId);
    this.mediaWorkerIpcQueueDepth.remove(workerId);
    this.mediaWorkerIpcTimeouts.remove(workerId);
    this.mediaWorkerRssBytes.remove(workerId);
    this.mediaWorkerHeapUsedBytes.remove(workerId);
    this.mediaWorkerCpuUserMicros.remove(workerId);
    this.mediaWorkerCpuSystemMicros.remove(workerId);
    this.mediaWorkerHeartbeatAgeMs.remove(workerId);
    this.trackedMediaWorkerIds.delete(workerId);
    for (const key of [...this.trackedMediaWorkerDropReasons]) {
      const [trackedWorkerId, reason] = splitTrackedMetricKey(key);
      if (trackedWorkerId !== workerId) {
        continue;
      }
      this.mediaWorkerDroppedRtpReasons.remove(trackedWorkerId, reason);
      this.trackedMediaWorkerDropReasons.delete(key);
    }
  }
}

function heartbeatAgeMs(lastHeartbeatAt?: string): number {
  if (!lastHeartbeatAt) {
    return 0;
  }
  const heartbeatAt = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(heartbeatAt)) {
    return 0;
  }
  return Math.max(0, Date.now() - heartbeatAt);
}

function splitTrackedMetricKey(key: string): [string, string] {
  const separator = key.indexOf(':');
  if (separator === -1) {
    return [key, 'unknown'];
  }
  return [key.slice(0, separator), key.slice(separator + 1)];
}
