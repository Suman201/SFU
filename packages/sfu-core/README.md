# @native-sfu/sfu-core

Framework-free SFU primitives:

- RTP packet parsing and serialization.
- RTP producer/consumer routing by SSRC.
- RTP stream state, sequence/timestamp tracking, restart detection, validation, and reorder handling.
- Consumer-specific RTP SSRC, payload type, sequence number, timestamp, and RTX mapping.
- RTP header extension registry, negotiation, parsing, serialization, and rewrite support.
- TWCC sequence insertion, feedback parsing/generation, and packet-arrival timelines.
- RTCP Sender Report, Receiver Report, NACK, PLI, FIR, and REMB parsing/creation.
- RTCP feedback routing between consumers and producers.
- Per-producer RTP retransmission cache and NACK recovery.
- PLI/FIR keyframe request coalescing and rate limiting.
- Simulcast layer selection.
- TWCC, delay, and loss based bandwidth estimation.
- Egress pacing queues.
- VP8/H264/VP9 keyframe detection and keyframe-gated join recovery.
- Audio-level and active-speaker observation.

This package does not open sockets, persist state, or implement ICE/DTLS/SRTP. It is safe to reuse in another Node/TypeScript app when you provide your own transport and metrics hooks.

```ts
import { RtpRouter } from '@native-sfu/sfu-core';

const router = new RtpRouter({
  retransmissionCacheSize: 512,
  keyframeRequestIntervalMs: 1000,
  maxReorderPackets: 64,
  onForwardedPacket: (kind) => metrics.forwarded(kind),
  onDroppedPacket: (reason) => metrics.dropped(reason),
  onRetransmittedPacket: (kind) => metrics.retransmitted(kind),
  onBandwidthEstimate: (id, estimate) => metrics.bitrate(id, estimate.recommendedBitrate),
  onPacingQueueDepth: (snapshot) => metrics.pacing(snapshot.id, snapshot.queuedBytes)
});
```
