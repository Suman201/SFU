# Pipe Transport Foundation

Phase 11 adds a feature-flagged cross-node RTP/RTCP pipe foundation. It is disabled by default and is intended for controlled simulation and integration testing before production cross-node RTP forwarding.

## Boundaries

- Room ownership remains authoritative in `NodeRegistryService`.
- Pipe coordination lives in the backend cluster layer.
- Pipe RTP/RTCP primitives live in `sfu-core`.
- Browser ICE, DTLS, SRTP, and `MediaPacketBridge` paths remain unchanged.
- No AV1 dependency descriptors, global region routing, or production-default pipe routing are included.

## Runtime Controls

- `ENABLE_PIPE_TRANSPORT=false` keeps pipe coordination dormant.
- `PIPE_CLUSTER_SECRET` is required when pipe transport is enabled.
- `PIPE_PORT_RANGE` and `PIPE_ADVERTISE_IP` control UDP pipe transport endpoint binding and advertisement.
- `PIPE_ALLOWED_NODE_IDS` optionally restricts which backend nodes may participate in pipe setup.
- `PIPE_COORDINATION_TIMEOUT_MS` limits stale Redis coordination messages.
- `PIPE_COORDINATION_MAX_ATTEMPTS` controls acknowledgement retry attempts.
- `PIPE_MAX_SETUP_REQUESTS_PER_MINUTE` rate-limits setup commands per process.
- `ENABLE_PIPE_TRANSPORT=true` is rejected at boot outside `NODE_ENV=test` unless `PIPE_ADVERTISE_IP` is configured, so production/staging cannot silently fall back to internal-only simulation.

## Current Scope

Implemented:

- Type-safe `pipe:*` coordination contracts.
- Durable Redis Stream-backed coordination for `pipe:*` commands and room fanout, with replayable per-node offsets.
- Signed Redis coordination envelopes with correlation IDs, idempotency keys, acknowledgements, retries, timeout propagation, and persisted duplicate suppression.
- Owner fencing against the current Redis room owner, including claim-timestamp validation.
- Internal pipe transport simulation for RTP, RTCP, SSRC rewriting, replay/drop protection, backpressure, counters, and idempotent cleanup.
- UDP pipe transport for controlled node-to-node RTP/RTCP validation with framed datagrams, peer auth, advertised endpoints, and socket cleanup.
- MediaService pipe ingress/egress hooks for controlled owner-to-remote RTP and remote-to-owner RTCP validation.
- Owner-orchestrated remote feed setup so a non-owner subscriber node can request a producer feed, establish a pipe, and register a remote proxy producer while keeping WebRTC transport local to the subscriber node.
- Remote publisher setup so a non-owner publisher node can publish locally while the owner node receives a proxy producer through coordinated pipe bindings.
- Cross-node room event fanout for room-scoped participant, producer, room-close, room-failure, permission, and chat updates.
- Prometheus metrics for pipe transport state, durable control-plane delivery, replay, duplicate suppression, and worker rejection.
- Worker-mode distributed pipe transport for controlled cross-node publish/subscribe validation.

Not production-ready yet:

- Multi-node RTP forwarding as the default production path.
- Active-room migration or automatic owner handoff during node drain/owner expiry.
- Public-network proof for real `PIPE_PORT_RANGE` UDP exposure in the target staging/production deployment.

## Local Two-Node Validation

Use the checked-in local proof stack for controlled backend/socket validation:

```bash
npm run docker:start:multi-node
npm run seed:dummy-users:multi-node
npm run test:live-soak:local
npm run docker:down:multi-node
```

That stack starts two backend nodes with pipe enabled, distinct media and pipe UDP ranges, shared MongoDB/Redis, and worker-mode media. The soak harness writes a report under `reports/live-soak/` and fails when the expected distributed/pipe health checks do not pass.

This local validation is intentionally not a browser or public-network proof. Production readiness still requires staging evidence for public TURN, public ICE candidate reachability, ingress behavior, and real inter-node UDP exposure.

## Troubleshooting

If distributed pipe setup is enabled, start with:

1. `/api/v1/media/diagnostics/pipe`
2. `/api/v1/media/diagnostics/node`
3. `/metrics`

The first metrics worth checking are:

- `sfu_pipe_transports_active`
- `sfu_pipe_rejected_requests`
- `sfu_pipe_errors_total`
- `sfu_pipe_rtp_packets_total`
- `sfu_pipe_rtcp_packets_total`

Common misconfigurations:

- `PIPE_ADVERTISE_IP` missing or wrong for the deployed node
- UDP range exposed only partially
- `PIPE_CLUSTER_SECRET` mismatch across nodes
- `ENABLE_PIPE_TRANSPORT=true` without sticky owner-aware signaling
