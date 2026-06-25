# Operator Runbook

## Planned Node Maintenance

1. Send `POST /api/v1/media/node/drain` with `X-Operations-Token`.
2. Confirm `GET /health/ready` is no longer returning `200`.
3. Confirm `GET /api/v1/media/diagnostics/node` reports:
   - `trafficReady=false`
   - `cluster.localNode.draining=true`
4. Wait for room and transport counts to settle according to your maintenance policy.
5. Confirm your ingress or load balancer has stopped sending new control-plane traffic to the node.
6. Send SIGTERM only after the node is drained.
7. After maintenance, call `POST /api/v1/media/node/undrain` and verify `/health/ready` returns `200` again.

Notes:

- Prefer a `preStop` hook or rollout controller action that triggers drain and waits for readiness withdrawal instead of a fixed sleep.
- Keep Kubernetes `terminationGracePeriodSeconds` longer than your worst-case drain window plus ingress deregistration delay.

## Staging Rollout Guardrails

Before a controlled production rollout, run the staging preflight and browser TURN proof from [docs/testing.md](/Volumes/Extarnal/RND/SFU/docs/testing.md). Treat them as necessary rollout checks, not as a substitute for a real staged browser publish/subscribe proof over the deployment ingress.

In practice that staged proof has two halves:

- direct-node preflight to confirm the deployed server-side config surface and diagnostics behavior
- shared-ingress Chromium relay gathering to confirm real TURN credential use through the public hostname

A green result means the environment is configured coherently enough for cautious rollout work. It does not mean full room join, publish, subscribe, reconnect, or ingress ownership behavior has been proven end to end.

Treat these conditions as rollout blockers:

- `turn_not_ready`, `turn_localhost_uris`, or `turn_unsupported_transport` in `/api/v1/media/diagnostics/node`
- `addressing.publicUrlIsLocalOrWildcard=true`, `addressing.nodePublicUrlIsLocalOrWildcard=true`, or `addressing.pipeAdvertiseIpIsLocalOrWildcard=true` in non-local staging
- `/metrics` still reachable without `X-Operations-Token` when `OPERATIONS_TOKEN` is supposed to be enabled
- Swagger docs reachable in production without `X-Operations-Token` when `SWAGGER_ENABLED=true`
- `/api/v1/media/turn-credentials` returning zero URIs or non-UDP TURN URIs during staged validation
- `sfu_metrics_refresh_status{component="cluster|pipe|media_workers"} != 1`
- `sfu_media_worker_failed_rooms > 0`
- `readyWorkers < workerCount` or sustained worker overload during a steady-state soak
- `sfu_pipe_coordination_timeouts_total`, `sfu_pipe_udp_setup_failures_total`, `sfu_pipe_remote_attach_failures_total`, or `sfu_pipe_remote_publish_failures_total` increasing during normal traffic
- post-soak room / transport / consumer / pipe counts failing to converge back to zero within the baseline timeout

Use these as practical investigation thresholds during soak, not as universal capacity promises:

- `nodejs_eventloop_lag_mean_seconds > 0.05` for several consecutive scrapes
- `nodejs_eventloop_lag_max_seconds > 0.25`
- rapidly increasing `process_resident_memory_bytes` or `sfu_media_worker_rss_bytes`
- `sfu_media_worker_ipc_queue_depth` or `sfu_media_worker_ipc_request_duration_ms` climbing together with publish/subscribe churn

## Worker Drain

To drain a specific worker:

```bash
curl -X POST \
  -H "X-Operations-Token: $OPERATIONS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"forceAfterMs":30000}' \
  http://backend.example.com/api/v1/media/workers/<workerId>/drain
```

Watch:

- `/api/v1/media/workers`
- `/api/v1/media/diagnostics/workers/<workerId>`
- `sfu_media_worker_draining`
- `sfu_media_worker_failed_rooms`

Use forced drain only when graceful room migration is no longer practical.

## Pipe Incident Triage

When cross-node media setup fails:

1. Check `/api/v1/media/diagnostics/pipe`.
2. Check `/api/v1/media/diagnostics/node` on both owner and non-owner nodes.
3. Confirm `PIPE_CLUSTER_SECRET`, `PIPE_ADVERTISE_IP`, and UDP range exposure match the deployment.
4. Confirm advertised/public node addresses still match the real peer-to-peer path after any node replacement or ingress change.
5. Inspect:
   - `sfu_pipe_transports_active`
   - `sfu_pipe_rejected_requests`
   - `sfu_pipe_errors_total`
   - `sfu_pipe_rtp_packets_total`
   - `sfu_pipe_rtcp_packets_total`

If diagnostics show repeated setup rejection or zero active transports, treat it as a control-plane or exposure problem before investigating browser behavior.

## Eventing, Webhook, and Redis Stream Triage

When an operator asks whether an event was emitted or whether a webhook actually fired:

1. Query `GET /api/v1/events/log` or `GET /api/v1/events/rooms/<roomId>/log`.
2. Confirm the expected event type, actor, and timestamp are present in the audit log.
3. If the event exists, query `GET /api/v1/events/deliveries?eventId=<eventId>`.
4. If no delivery exists:
   - verify the endpoint is enabled
   - verify the endpoint subscribes to that event type
   - verify any room filter includes the room
5. If delivery exists but failed:
   - inspect `lastResponseStatusCode`
   - inspect `lastError`
   - inspect `lastFailureCategory`
   - inspect `lastDeliveryReference` when the adapter reports one
   - inspect the attempt history
6. If the delivery is `exhausted`, fix the receiver and replay either:
   - `POST /api/v1/events/deliveries/<deliveryId>/replay`
   - `POST /api/v1/events/log/<eventId>/endpoints/<endpointId>/replay`

Lifecycle notes:

- Local environments may leave `OPERATIONS_TOKEN` empty for validation convenience. Production should not.
- `POST /api/v1/events/deliveries/<deliveryId>/replay` is intentionally limited to `cancelled` and `exhausted` records.
- `queued`, `retrying`, and `dispatching` rows are already in flight or scheduled and should not be manually replayed.
- Disabling an endpoint cancels queued/retrying rows immediately.
- Re-enabling an endpoint only affects future queue activity; it does not resurrect cancelled rows.
- Endpoint URL, subscription, room-filter, timeout, and retry-policy edits should be treated as forward-looking operational changes.
- A queued delivery keeps an immutable endpoint snapshot. That frozen snapshot is what later retries execute unless the row is cancelled.
- Delivery replay keeps the original frozen snapshot.
- Event-to-endpoint replay intentionally uses the endpoint's current state and is the right tool when an operator wants to resend with updated configuration.
- Redis stream endpoints do not expose a signing secret. Their execution truth is the persisted stream key plus the returned Redis stream entry id.
- Non-retryable adapter failures, such as webhook auth failures or Redis stream configuration/auth failures, move directly to `exhausted` rather than consuming the full retry budget.
- Backlog fairness is lane-based across `adapterKind + endpointId`, so a single noisy adapter should no longer starve other healthy endpoints in the same backlog.

Useful metrics in this workflow:

- `sfu_platform_events_emitted_total`
- `sfu_platform_event_queries_total`
- `sfu_event_delivery_attempts_total`
- `sfu_event_deliveries_succeeded_total`
- `sfu_event_deliveries_failed_total`
- `sfu_event_delivery_failures_by_category_total`
- `sfu_event_deliveries_exhausted_total`
- `sfu_event_deliveries_cancelled_total`
- `sfu_event_retries_scheduled_total`
- `sfu_event_delivery_replays_total`
- `sfu_event_delivery_endpoint_count`
- `sfu_event_delivery_queue`
- `sfu_event_delivery_duration_ms`
- `sfu_event_delivery_active_dispatches`
- `sfu_webhook_delivery_attempts_total`
- `sfu_webhook_deliveries_succeeded_total`
- `sfu_webhook_deliveries_failed_total`
- `sfu_webhook_delivery_failures_by_category_total`
- `sfu_webhook_deliveries_exhausted_total`
- `sfu_webhook_deliveries_cancelled_total`
- `sfu_webhook_retries_scheduled_total`
- `sfu_webhook_replays_total`
- `sfu_webhook_endpoint_count`
- `sfu_webhook_delivery_queue`
- `sfu_webhook_delivery_duration_ms`
- `sfu_event_delivery_adapter_executions_total`
- `sfu_event_delivery_snapshot_source_usage_total`
- `sfu_webhook_active_dispatches`
- `sfu_event_delivery_oldest_age_ms`
- `sfu_event_delivery_backlog_concentration_ratio`
- `sfu_event_delivery_lane_count`

Delivery behavior notes:

- signature header: `X-Native-Sfu-Signature`
- timestamp header: `X-Native-Sfu-Timestamp`
- event id header: `X-Native-Sfu-Event-Id`
- delivery id header: `X-Native-Sfu-Delivery-Id`
- event type header: `X-Native-Sfu-Event-Type`
- non-2xx responses are failures
- Redis stream publishes return a stream entry id that is stored as the delivery reference
- exhausted deliveries remain queryable until normal data-retention cleanup
- replay creates a fresh delivery record; it does not mutate the original failed attempt history
- production webhook endpoints should use `https` and must not point at localhost or wildcard hosts
- production should configure a dedicated `WEBHOOK_SECRET_ENCRYPTION_KEY`
- dispatch throughput/fairness tuning is controlled by:
  - `WEBHOOK_DELIVERY_CONCURRENCY`
  - `WEBHOOK_DELIVERY_MAX_BATCH_PER_PUMP`
  - `WEBHOOK_DELIVERY_MAX_CONCURRENT_PER_ENDPOINT`
- `/api/v1/events/diagnostics/summary` now includes:
  - per-adapter endpoint counts
  - per-adapter delivery-state counts
  - active dispatches by adapter
  - active vs expired delivery leases
  - backlog aging overall and per adapter
  - hottest-lane concentration / share
  - top backlog lanes with `adapterKind`
- default retention windows are:
  - `EVENT_LOG_RETENTION_DAYS=30`
  - `WEBHOOK_DELIVERY_RETENTION_DAYS=14`
  - `WEBHOOK_EXHAUSTED_DELIVERY_RETENTION_DAYS=30`

## Live Class Session Incidents

Use this section for teacher/student classroom incidents. Product behavior remains manual-start/manual-end, except the existing teacher reconnect grace timeout can complete a live session after the configured grace window.

Core signals:

- Audit actions: `class_sessions.start`, `class_sessions.end`, `class_sessions.join.admitted`, `class_sessions.join.denied`, `class_sessions.room_join.admitted`, `class_sessions.room_join.denied`, `class_sessions.teacher.disconnected`, `class_sessions.teacher.reconnected`, `class_sessions.teacher_reconnect_grace.started`, `class_sessions.teacher_reconnect_grace.cancelled`, `class_sessions.teacher_reconnect_grace.expired`, `class_sessions.media.publish.failure`, `class_sessions.media.consume.failure`, `class_sessions.chat.send.failure`, `class_sessions.chat.read.failure`, `class_sessions.moderation.*`, `class_sessions.whiteboard_control.*`, `class_sessions.material.*`, `class_sessions.recording.*`
- Platform events: `room.created`, `room.joined`, `room.left`, `room.closed`, `producer.created`, `producer.paused`, `producer.resumed`, `producer.closed`, `consumer.created`, `consumer.paused`, `consumer.resumed`, `consumer.closed`, `recording.started`, `recording.stopped`, `recording.failed`
- Metrics: `sfu_class_session_lifecycle_transitions_total`, `sfu_class_session_join_attempts_total`, `sfu_class_session_reconnect_grace_events_total`, `sfu_class_session_reconnect_grace_timers_active`, `sfu_class_session_media_failures_total`, `sfu_class_session_chat_failures_total`, `sfu_class_session_moderation_actions_total`, `sfu_class_session_whiteboard_control_actions_total`, `sfu_class_session_material_actions_total`

### Stuck Live Session

Teacher/student sees: class still appears live after teacher believes it ended, or students cannot re-enter because another session for the batch is live.

Checks:

1. Query the class-session record by `sessionId` and confirm `status`, `roomId`, `startedAt`, `completedAt`, `teacherDisconnectedAt`, and `teacherReconnectDeadlineAt`.
2. Query audit logs for `class_sessions.start`, `class_sessions.end`, and `class_sessions.teacher_reconnect_grace.*` on the same `sessionId`.
3. Query room event history for `room.closed` and active participants/producers.
4. Check `sfu_class_session_reconnect_grace_timers_active` and `sfu_class_session_lifecycle_transitions_total`.

Safe mitigation:

- If the teacher is present, ask them to use End for everyone.
- If the teacher is gone and the reconnect deadline has passed, manually end through the existing class-session end path or operator close flow; do not edit Mongo by hand unless engineering approves.
- Capture room incident snapshot before force-closing if media evidence matters.

Escalate when DB status and room state disagree after manual end, or reconnect grace expiry emits no `session:ended` / `room.closed`.

### Teacher Cannot Publish Media

Teacher sees: camera, microphone, screen, or whiteboard share fails to start; students see no host media.

Checks:

1. Confirm browser permission/device state and that another tab/app is not holding the camera or mic.
2. Confirm teacher has joined the class room as host and session status is `live`.
3. Check audit actions `class_sessions.media.publish.failure` and metrics `sfu_class_session_media_failures_total{operation="publish"}` by `kind` and `reason`.
4. Check producer platform events. Absence of `producer.created` after a publish attempt means the failure happened before publication.
5. Check room protection decisions and worker readiness if the reason starts with `policy_`, `media_worker`, or `service_unavailable`.
6. For screen/whiteboard, confirm the live settings allow screen/whiteboard sharing and only one screen-like producer is active.

Safe mitigation:

- Have the teacher refresh, rejoin, and republish while keeping the session live.
- If only screen/whiteboard fails, stop the active screen-like producer and retry.
- If worker pressure is high, apply room recovery/profile actions before asking all students to reconnect.

Escalate when publish failures increase across rooms, or TURN/ICE checks fail for multiple teachers.

### Students Cannot Consume Media

Student sees: teacher video/screen tile is blank, stuck loading, or audio is silent.

Checks:

1. Verify a live teacher producer exists for the expected kind: `video`, `audio`, or `screen`.
2. Check `consumer.created` platform events for the student participant and `sfu_class_session_media_failures_total{operation="consume"}`.
3. Check browser autoplay restrictions for audio. A user gesture may be required before audio starts.
4. Check distributed room ownership and pipe metrics if producer and consumer are on different nodes.
5. Compare one affected student with one healthy student to isolate client/browser vs SFU routing.

Safe mitigation:

- Ask the affected student to refresh/rejoin; history and private chat recover from server state.
- If many students fail together, snapshot the room, inspect worker/pipe health, and avoid closing the class unless the room is unrecoverable.

Escalate when consumers fail for multiple rooms or all failures correlate with one node.

### TURN Relay Failure

Teacher/student sees: local preview works but remote media never connects, often worse across different networks.

Checks:

1. Query `/api/v1/media/diagnostics/node` and `/api/v1/media/turn-credentials`.
2. Confirm no `localhost`, wildcard, or private-only TURN URIs are advertised in non-local environments.
3. Confirm Coturn is reachable on the advertised UDP/TCP ports and firewall/security groups expose the relay range.
4. Use browser WebRTC internals to prove relay candidates are gathered.
5. Watch `sfu_class_session_media_failures_total`, pipe setup metrics, and worker transport counts.

Safe mitigation:

- Fix TURN config/secret/URI exposure and redeploy only the affected config path.
- Keep existing live sessions running if direct/srflx media still works; do not mass-end sessions for a TURN-only issue.

Escalate when relay candidates cannot be gathered from a clean browser on a public network.

### Recording Failed

Teacher sees: recording indicator fails, stops unexpectedly, or playback is unavailable.

Checks:

1. Query recording records for `sessionId`, status, `failureReason`, manifest path, size, retention, and tracks.
2. Check `recording.started`, `recording.stopped`, and `recording.failed` platform events.
3. Check audit actions `class_sessions.recording.start`, `class_sessions.recording.stop`, and class-session end audit.
4. Confirm local/S3 storage path, permissions, disk space, and retention policy.
5. Confirm screen/whiteboard producers are present if the expected recording content is missing.

Safe mitigation:

- If the session is still live and policy allows, stop and start recording through the existing recording controls.
- If recording failed during session end, do not reopen or mutate the completed session just to recover recording metadata.

Escalate when storage/manifest errors affect more than one session or recording state blocks session end.

### Chat Delivery Issue

Teacher/student sees: private messages not arriving, broadcast not arriving, read states stale, or history missing after refresh.

Checks:

1. Confirm session status is `live` for sending.
2. Query audit actions `class_sessions.chat.send.failure` and `class_sessions.chat.read.failure`. These records intentionally do not contain raw message bodies.
3. Confirm private messages have `scope=private`, the expected `recipientId`, and the teacher/student `threadKey`; confirm broadcast has `scope=broadcast`.
4. Check active socket targets for the sender and recipient. Multi-tab users should receive targeted private events on all active sockets.
5. Reload history for the relevant thread; missed realtime events should recover from persisted history.

Safe mitigation:

- Have the affected user refresh/rejoin to rebuild socket targets.
- For teacher broadcast issues, verify the composer was in broadcast mode and not a selected private thread.

Escalate immediately if any student can see another student's private thread.

### Unauthorized Access Report

Teacher/student/admin reports: a user saw a class, room, chat, material, or lifecycle event they should not access.

Checks:

1. Verify enrollment status from the dedicated enrollment source of truth for the batch.
2. Query audit actions for `class_sessions.join.denied`, `class_sessions.room_join.denied`, material download/share actions, and chat failures around the report time.
3. Confirm `session:watch`, HTTP metadata, `room:join`, chat history/send, material download, recording download, and whiteboard control all use the same batch/session authorization path.
4. Check whether the user was admin/super-admin, batch teacher, or actively enrolled at the time.
5. Assess exposure from persisted records; do not rely only on UI state.

Safe mitigation:

- Remove or suspend incorrect enrollment first.
- End or lock the live class only if active unauthorized access is still possible.
- Preserve audit logs and room event history before cleanup.

Escalate if private chat, recordings, materials, or lifecycle watcher rooms leaked to non-enrolled students.

### Mongo/Redis Degraded

Teacher/student sees: join hangs, reconnect state is wrong, chat/history fails, attendance/recording metadata is stale, or lifecycle events are delayed.

Checks:

1. Check `/health/ready` and database/Redis readiness.
2. Inspect Mongo latency/errors for class sessions, participants, producers, consumers, chat, materials, recordings, audit logs, and attendance snapshots.
3. Inspect Redis presence and Socket.IO room targeting, especially for multi-tab private chat and reconnect grace.
4. Watch default Node/process metrics plus `sfu_class_session_*` counters for spikes in denied joins, chat failures, media failures, and reconnect grace expiries.

Safe mitigation:

- Keep live sessions alive when possible; do not manually end sessions just because Redis presence is degraded.
- After recovery, verify active live sessions, reconnect grace fields, room participants, recording status, and attendance snapshots.
- Rebuild derived views from persisted Mongo state when Redis missed transient presence.

Escalate when Mongo writes fail for session end, chat persistence, recording status, or attendance snapshots.

## Room Autopilot Triage

When a host reports degraded room behavior or unexpected admission throttling:

1. Check `GET /api/v1/rooms/<roomId>/quality-summary` with a host participant token.
2. Check `GET /api/v1/media/diagnostics/rooms/<roomId>/incident-snapshot` with `X-Operations-Token`.
3. Confirm the active room media profile matches intent:
   - `meeting`: balanced collaboration default
   - `webinar`: stronger protection for new publishers and higher screen-share weight
   - `classroom`: screen-share friendly without fully suppressing discussion
   - `support`: most aggressive room protection under congestion
4. Inspect the protection decisions for:
   - joins
   - new publishing
   - screen share
   - whether publishing is being soft-throttled into a paused state instead of hard rejected
5. Use the recommendation list to decide whether to:
   - move to a more protective room profile
   - pause or reduce non-essential screen sharing
   - hold new publishers
   - hold or manually admit new joins

If host controls stop responding on a distributed room, check whether the browser is attached to a non-owner node. Owner-authoritative room-profile changes return `ROOM_REDIRECT` with `ownerUrl`; the frontend should reconnect to that owner before retrying the action.

The most useful new metrics in this workflow are:

- `sfu_room_profile_distribution`
- `sfu_room_profile_changes_total`
- `sfu_room_protection_decisions_total`
- `sfu_degraded_room_count`
- `sfu_room_protection_state`
- `sfu_room_policy_recommendation_count`
- `sfu_incident_snapshots_generated_total`

If a room is repeatedly entering `critical` health while node or worker pressure is also elevated, treat it as an infrastructure-admission problem first and only tune room profiles second.

## Room Incident Workflow

When a host or operator reports an active room incident:

1. Check `GET /api/v1/rooms/<roomId>/incident-state` with a host or co-host token.
2. Check `GET /api/v1/rooms/<roomId>/incident-timeline` to confirm whether the issue is:
   - repeated throttling
   - new protection changes
   - worker/media failure
   - distributed owner visibility loss
3. If you need an attachment-quality bundle, call `POST /api/v1/media/diagnostics/rooms/<roomId>/incident-snapshot` with `X-Operations-Token`.
4. If the room is still taking damage from growth, run one or more recovery actions:
   - `protect_room`
   - `pause_new_publishing`
   - `mark_operator_recovery`
5. Once health returns to `stable`, reopen in this order:
   - `reopen_admissions`
   - `resume_new_publishing`
   - `unprotect_room`
   - `clear_recovery`

Watch these metrics while doing it:

- `sfu_room_recovery_actions_total`
- `sfu_rooms_under_recovery`
- `sfu_room_recovery_duration_ms`
- `sfu_room_alert_events_total`
- `sfu_room_incident_timeline_events_total`
- `sfu_snapshot_bundles_generated_total`

Operator notes:

- `room:incident-updated`, `room:incident-event`, and `room:snapshot-generated` are live room signals, not just polled diagnostics.
- room audit/event history is intentionally REST-backed rather than a new Socket.IO stream; use the room incident signals for live operator UX and the audit log for durable history and replay source-of-truth.
- A failed room should usually be snapshotted before cleanup evidence ages out.
- If a room is remotely owned and warning strings mention owner-quality visibility or remote-owner risk, investigate owner-node continuity before reopening traffic.
