# @native-sfu/nest-sfu

Reusable NestJS wrapper around `@native-sfu/sfu-core`.

```ts
import { Module } from '@nestjs/common';
import { NestSfuModule } from '@native-sfu/nest-sfu';

@Module({
  imports: [
    NestSfuModule.forRoot({
      turnSecret: process.env.TURN_SECRET!,
      turnUris: ['turn:turn.example.com:3478?transport=udp'],
      stunServers: ['stun:stun.example.com:3478'],
      turnServers: [
        {
          url: 'turn:turn.example.com:3478?transport=udp',
          username: process.env.TURN_USERNAME!,
          credential: process.env.TURN_PASSWORD!
        }
      ],
      rtpRetransmissionCacheSize: 512,
      keyframeRequestIntervalMs: 1000,
      defaultPacingBitrateBps: 2_500_000,
      enableTwcc: true,
      enablePacing: true
    })
  ]
})
export class AppModule {}
```

Use `forRootAsync` to bridge existing config and metrics services. The module exports:

- `MediaService`
- `IceService`
- `DtlsService`
- `SrtpService`
- `RtpRouter`
- `RtcpProcessor`
- `SimulcastSelector`
- `ProducerSimulcastState`
- `BandwidthEstimator`
- `AudioLevelObserver`

DTLS 1.2 transport establishment, SRTP/SRTCP packet protection, RTCP SR/RR/PLI/FIR/NACK/REMB/TWCC processing, RTP stream validation, reorder handling, consumer-specific RTP rewriting, RTP header-extension rewrite, TWCC insertion, bandwidth estimation, egress pacing, keyframe-gated joins, RID/RRID simulcast negotiation, producer layer tracking, adaptive consumer layer selection, keyframe-aware layer switching, RTX mapping, RTP retransmission cache, NACK recovery, PLI/FIR coalescing, STUN server-reflexive candidates, TURN UDP relay candidates, hardened Unified Plan SDP helpers, and the live media packet bridge are implemented over the selected ICE candidate pair.
