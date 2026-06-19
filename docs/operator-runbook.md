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

## Eventing and Webhook Triage

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
   - inspect the attempt history
6. If the delivery is `exhausted`, fix the receiver and replay either:
   - `POST /api/v1/events/deliveries/<deliveryId>/replay`
   - `POST /api/v1/events/log/<eventId>/endpoints/<endpointId>/replay`

Useful metrics in this workflow:

- `sfu_platform_events_emitted_total`
- `sfu_platform_event_queries_total`
- `sfu_webhook_delivery_attempts_total`
- `sfu_webhook_deliveries_succeeded_total`
- `sfu_webhook_deliveries_failed_total`
- `sfu_webhook_deliveries_exhausted_total`
- `sfu_webhook_deliveries_cancelled_total`
- `sfu_webhook_retries_scheduled_total`
- `sfu_webhook_replays_total`
- `sfu_webhook_endpoint_count`
- `sfu_webhook_delivery_queue`
- `sfu_webhook_delivery_duration_ms`

Delivery behavior notes:

- signature header: `X-Native-Sfu-Signature`
- timestamp header: `X-Native-Sfu-Timestamp`
- event id header: `X-Native-Sfu-Event-Id`
- delivery id header: `X-Native-Sfu-Delivery-Id`
- event type header: `X-Native-Sfu-Event-Type`
- non-2xx responses are failures
- exhausted deliveries remain queryable until normal data-retention cleanup
- replay creates a fresh delivery record; it does not mutate the original failed attempt history

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
