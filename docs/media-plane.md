# Media Plane

The repository implements the control-plane and packet-router shape of a native SFU without depending on an existing SFU. The implemented native pieces are:

- RTP packet parsing and serialization.
- SSRC-to-producer route tracking.
- Producer-to-consumer routing.
- Pause/resume and close behavior.
- Simulcast layer filtering by RID/SSRC.
- RTCP receiver report parsing.
- RTCP NACK and PLI parsing.
- Packet-loss, jitter, and bandwidth metric hooks.
- ICE parameter generation, UDP host candidate gathering, STUN binding checks, nomination, ICE restart, and consent freshness.
- Coturn REST credential generation.

These pieces are now split into reusable modules:

- `packages/sfu-core` has no NestJS dependency and can be used from any TypeScript runtime.
- `packages/nest-sfu` exposes `NestSfuModule`, `MediaService`, `IceService`, `DtlsService`, and `SrtpService` for NestJS applications.

## ICE Boundary

`packages/nest-sfu` now owns a real TypeScript ICE agent for the SFU-side transport lifecycle:

- UDP host sockets are gathered from configured network interfaces.
- Candidates use RFC 8445 priority and candidate-pair priority formulas.
- STUN Binding requests/responses include USERNAME, MESSAGE-INTEGRITY, FINGERPRINT, PRIORITY, role, and USE-CANDIDATE handling.
- Peer-reflexive candidates are learned from authenticated inbound checks.
- ICE restart rotates local credentials and clears remote checklist state.
- Consent freshness periodically probes the selected pair and disconnects after configured failures.

The first production-ready scope is host/UDP ICE. Server-reflexive and relayed candidate allocation still require STUN/TURN client allocation work against coturn.

## DTLS/SRTP Boundary

Browser WebRTC media is not plain RTP. It is ICE-selected UDP/TCP carrying DTLS for keying and SRTP/SRTCP for encrypted media. Node.js core does not expose a production DTLS-SRTP stack. This repo therefore includes:

- `DtlsService`, which creates fingerprints and fails closed for handshake.
- `SrtpService`, which fails closed until a hardened SRTP engine is provided.
- `MediaService`, which owns transport lifecycle and registers producers/consumers with the RTP router.

This is safer than a mock cipher because insecure media transport would create a false sense of production readiness.

## Production Path

To make the media plane browser-interoperable while keeping the "no existing SFU" constraint:

1. Implement a native Node addon or sidecar for DTLS 1.2 and SRTP/SRTCP using audited cryptographic libraries.
2. Expose only packet protect/unprotect, key export, replay-window, and transport lifecycle APIs to TypeScript.
3. Feed decrypted RTP into `RtpRouter.route()`.
4. Protect routed RTP per consumer before egress.
5. Add packet retransmission cache for NACK and keyframe request forwarding for PLI/FIR.

The routing engine should remain codec-agnostic and must never decode, mix, or transcode media.
