# @native-sfu/sfu-core

Framework-free SFU primitives:

- RTP packet parsing and serialization.
- RTP producer/consumer routing by SSRC.
- RTCP receiver report, NACK, and PLI parsing.
- Simulcast layer selection.
- Bandwidth estimation.
- Audio-level and active-speaker observation.

This package does not open sockets, persist state, or implement DTLS/SRTP. It is safe to reuse in another Node/TypeScript app when you provide your own transport and metrics hooks.

```ts
import { RtpRouter } from '@native-sfu/sfu-core';

const router = new RtpRouter({
  onForwardedPacket: (kind) => metrics.forwarded(kind),
  onDroppedPacket: (reason) => metrics.dropped(reason)
});
```
