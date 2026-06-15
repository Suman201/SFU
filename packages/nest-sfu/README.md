# @native-sfu/nest-sfu

Reusable NestJS wrapper around `@native-sfu/sfu-core`.

```ts
import { Module } from '@nestjs/common';
import { NestSfuModule } from '@native-sfu/nest-sfu';

@Module({
  imports: [
    NestSfuModule.forRoot({
      turnSecret: process.env.TURN_SECRET!,
      turnUris: ['turn:turn.example.com:3478?transport=udp']
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
- `BandwidthEstimator`
- `AudioLevelObserver`

DTLS/SRTP remains fail-closed until you provide a hardened native transport adapter.
