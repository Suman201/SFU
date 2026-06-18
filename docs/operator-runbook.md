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
