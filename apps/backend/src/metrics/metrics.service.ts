import { Injectable, OnModuleInit } from '@nestjs/common';
import client, { Counter, Gauge, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();
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
  readonly roomAdmissionRejections = new Counter({
    name: 'sfu_room_admission_rejections_total',
    help: 'Room admission or media allocation rejections',
    labelNames: ['reason']
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
      this.roomAdmissionRejections,
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
      this.controlPlaneMessagesPublished,
      this.controlPlanePublishFailures,
      this.controlPlaneMessagesDelivered,
      this.controlPlaneConsumeFailures,
      this.controlPlaneReplayMessages,
      this.controlPlaneDuplicateSuppressions,
      this.crossNodeSubscribers
    ].forEach((metric) => this.registry.registerMetric(metric as never));
  }

  async text(): Promise<string> {
    return this.registry.metrics();
  }
}
