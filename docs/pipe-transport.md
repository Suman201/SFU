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
- `ENABLE_PIPE_TRANSPORT=true` is rejected at boot when `MEDIA_WORKER_MODE=worker` because Phase 11 still lacks worker pipe IPC.
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
- Cross-node room event fanout for room-scoped participant, producer, room-close, room-failure, permission, and chat updates.
- Prometheus metrics for pipe transport state, durable control-plane delivery, replay, duplicate suppression, and worker rejection.

Not production-ready yet:

- Remote publishing on non-owner nodes.
- Multi-node RTP forwarding as a default path.
- Worker-mode pipe IPC. Pipe transport is now rejected at boot when worker mode is enabled.
