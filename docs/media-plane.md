# Media Plane

The repository implements the control-plane and packet-router shape of a native SFU without depending on an existing SFU. The implemented native pieces are:

- RTP packet parsing and serialization.
- SSRC-to-producer route tracking.
- Producer-to-consumer routing.
- Pause/resume and close behavior.
- Simulcast layer filtering by RID/SSRC.
- RTCP Sender Report and Receiver Report parsing/creation.
- RTCP PLI, FIR, NACK, and REMB parsing/creation.
- RTCP feedback routing between consumers and producers.
- Per-producer RTP retransmission cache with sequence tracking and FIFO eviction.
- NACK recovery from cached RTP packets with upstream NACK fallback for cache misses.
- PLI/FIR keyframe request aggregation, coalescing, and rate limiting.
- RTP stream state tracking for SSRC lifecycle, sequence/timestamp continuity, and producer restart detection.
- RTP packet validation for version, SSRC, payload type, duplicate, late, and reordered packets.
- Consumer-specific RTP rewriting for SSRC, payload type, sequence number, timestamp, and negotiated RTX SSRC/payload mappings.
- Arrival-driven reorder buffering with duplicate and late-packet suppression.
- RTP header extension negotiation, parsing, serialization, and per-consumer rewrite for MID, RID, RRID, audio level, Absolute Send Time, and TWCC.
- Transport-wide sequence insertion, arrival tracking, and RTCP TWCC feedback generation/parsing.
- TWCC, delay, and loss informed bandwidth estimation with incoming/outgoing bitrate snapshots and per-consumer recommendations.
- Per-consumer and per-transport egress pacing queues with rate-controlled sending, burst suppression, and queue-depth metrics.
- VP8, H264, and VP9 keyframe detection.
- Keyframe-gated consumer join recovery for active video streams.
- Packet-loss, jitter, and bandwidth metric hooks.
- ICE parameter generation, UDP host candidate gathering, optional server-reflexive/TURN relay candidate gathering, STUN binding checks, nomination, ICE restart, and consent freshness.
- DTLS 1.2 certificate generation, fingerprint generation/validation, state machine, ICE datagram integration, and SRTP key export.
- SRTP/SRTCP encryption, decryption, authentication, replay protection, rollover tracking, and SSRC validation.
- ICE-selected datagram demultiplexing for STUN, DTLS, RTP, RTCP, SRTP, and SRTCP.
- Live inbound RTP/SRTP and RTCP/SRTCP routing into the media router.
- Live outbound RTP/SRTP and RTCP/SRTCP egress through the selected ICE pair.
- SDP parsing and Unified Plan answer generation hardened against Chrome, Firefox, and Safari offer shapes.
- Browser publisher-to-subscriber media bridge coverage for audio, video, and screen tracks.
- Dynacast producer layer demand tracking with consumer demand aggregation, producer layer control events, suspended-layer metrics, and browser sender-control hooks.
- Coturn REST credential generation.

These pieces are now split into reusable modules:

- `packages/sfu-core` has no NestJS dependency and can be used from any TypeScript runtime.
- `packages/nest-sfu` exposes `NestSfuModule`, `MediaService`, `IceService`, `DtlsService`, and `SrtpService` for NestJS applications.

## ICE Boundary

`packages/nest-sfu` now owns a real TypeScript ICE agent for the SFU-side transport lifecycle:

- UDP host sockets are gathered from configured network interfaces.
- STUN servers can be configured to gather server-reflexive candidates.
- TURN servers can be configured to gather UDP relay candidates through Allocate/CreatePermission and Send/Data indications.
- Candidates use RFC 8445 priority and candidate-pair priority formulas.
- STUN Binding requests/responses include USERNAME, MESSAGE-INTEGRITY, FINGERPRINT, PRIORITY, role, and USE-CANDIDATE handling.
- Peer-reflexive candidates are learned from authenticated inbound checks.
- ICE restart rotates local credentials and clears remote checklist state.
- Consent freshness periodically probes the selected pair and disconnects after configured failures.

The transport module supports UDP ICE with host candidates and can gather server-reflexive or TURN relay candidates when `stunServers` / `turnServers` are explicitly configured. The backend release-candidate deployment baseline wires browser TURN credential generation and UDP host candidates by default. TCP/TLS TURN and advanced candidate pooling are deferred to later hardening work.

## DTLS/SRTP Boundary

Browser WebRTC media is not plain RTP. It is ICE-selected UDP/TCP carrying DTLS for keying and SRTP/SRTCP for encrypted media. Node.js core does not expose a production DTLS-SRTP stack. This repo therefore includes:

- `DtlsService`, which owns a local self-signed certificate, advertises fingerprints, validates remote fingerprints, and runs a DTLS 1.2 server over the selected ICE candidate pair.
- `DtlsTransport`, which exposes DTLS state and SRTP keying material after secure establishment.
- `SrtpService`, which derives SRTP/SRTCP sessions from DTLS keying material and enforces authentication, replay protection, and SSRC allowlists.
- `MediaPacketBridge`, which classifies selected ICE datagrams, serializes inbound media handling with queue counters, decrypts inbound SRTP/SRTCP, and protects outbound RTP/RTCP.
- `RtcpProcessor`, which aggregates SR/RR/PLI/FIR/NACK/REMB feedback for metrics and control decisions.
- `RtpRouter`, which validates and orders producer RTP, caches producer RTP for NACK recovery, rewrites RTP per consumer, maps rewritten RTCP feedback back to producer space, and rate-limits keyframe requests before forwarding PLI/FIR upstream.
- `MediaService`, which owns transport lifecycle and registers producers/consumers with the RTP/RTCP router.
- `sdp` helpers, which parse browser offers and generate Unified Plan-compliant answers for active audio/video m-lines.

The implemented packet bridge demuxes selected ICE datagrams into DTLS, SRTP, and SRTCP paths, feeds decrypted RTP/RTCP into the router, and protects routed packets for egress.

## Phase 1 Status

Phase 1 media transport is complete for the native TypeScript SFU scope:

- ICE, DTLS, SRTP/SRTCP, RTCP, and live packet bridging are implemented end to end.
- Browser interoperability tests validate publisher-to-SFU-to-subscriber flow for audio, video, and screen tracks.
- Unit and integration tests cover RTP retransmission cache, NACK recovery, PLI/FIR coalescing, STUN/TURN candidate gathering, SDP parsing/answering, and the media packet bridge.
- Congestion control, TWCC adaptation, simulcast/SVC production policy, and worker-process architecture remain out of Phase 1 by design.

The routing engine should remain codec-agnostic and must never decode, mix, or transcode media.

## Phase 2 Forwarding Correctness

Implemented:

- Per-SSRC producer stream state with sequence, timestamp, lifecycle, restart, duplicate, and late-packet tracking.
- RTP payload type and SSRC validation against producer RTP parameters.
- Reorder buffering that releases contiguous packets and suppresses duplicate/late arrivals.
- Per-consumer RTP SSRC, payload type, sequence number, and timestamp rewriting.
- Reverse mapping of rewritten consumer feedback for NACK repair and keyframe/bandwidth feedback routing.
- RTX SSRC/payload type mapping when producer and consumer RTP parameters advertise RTX.
- Dynamic subscribe/unsubscribe behavior across multiple producers and consumers.

Remaining Phase 2 hardening:

- Time-based reorder buffer drain for isolated gaps when no later packet arrives.
- Downstream RTCP Sender Report timestamp/SSRC rewriting to fully match rewritten RTP streams.
- RTX packet generation for NACK repair when the subscriber negotiated RTX-only retransmission.
- Live Firefox and WebKit forwarding validation beyond SDP fixture coverage.

## Phase 3 Adaptive Transport Foundation

Implemented:

- RTP header extension registry and SDP-driven extension negotiation.
- One-byte and two-byte RTP header extension parsing/serialization.
- Per-consumer extension ID rewrite and outbound TWCC/Absolute-Send-Time insertion.
- TWCC RTCP feedback packet creation and parsing, including loss status and receive deltas.
- Packet arrival timeline, packet loss, and delay variation snapshots.
- TWCC-aware bandwidth estimator that exposes incoming bitrate, outgoing bitrate, available bitrate, and recommended consumer bitrate.
- Per-consumer and per-transport pacing queues with configurable target bitrate, queue budget, burst smoothing through scheduled sends, and queue-depth metrics.
- Codec-aware keyframe detection for VP8, H264, and VP9.
- Join recovery that can request a keyframe and hold active video forwarding until the first keyframe.
- Browser media interoperability still validates Chrome publisher-to-SFU-to-subscriber flow with negotiated transport-wide extension support.

Remaining adaptive transport blockers:

- GCC-grade trendline estimator with overuse/underuse state machine.
- RTT extraction from RTCP/TWCC feedback and transport-level RTT smoothing.
- Probe clusters and probing controller for bitrate ramp-up.
- Full transport-cc feedback scheduling policy with feedback-window compaction.
- Producer/consumer scoring and priority-based bandwidth allocation.
- SVC layer switching, dependency-descriptor handling, producer/consumer scoring, and multi-node routing.

## Phase 5 Dynacast Foundation

Implemented:

- Per-producer Dynacast state in `sfu-core`, separate from observed RTP activity.
- Per-consumer layer demand tracking across join, leave, pause, resume, preferred layer changes, and bandwidth-selected targets.
- Room-wide desired layer aggregation with highest required spatial and temporal layer snapshots.
- Producer control events: `producer:layers-needed`, `producer:layers-unneeded`, and `producer:dynacast-updated`.
- Suspended layer state, resume/suspend counters, demand-change counters, and estimated upstream bitrate savings.
- Router integration that keeps the current layer demanded until a keyframe-gated spatial switch completes, preserving RTP continuity.
- Nest/backend propagation through `MediaService`, `RoomsService`, Socket.IO contracts, room state, and Prometheus metrics.
- Client-side RTCRtpSender encoding activation hook for browsers that expose simulcast sender encodings.

Deferred:

- SVC and AV1 dependency descriptors.
- Worker isolation and multi-node routing.
- Publisher-only socket targeting for producer control events.
- Full LiveKit-grade client publishing stack built around `addTransceiver(...sendEncodings)`.
