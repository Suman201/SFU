# Native WebRTC SFU Platform

This repository is a production-oriented monorepo for a WebRTC SFU platform using Node.js 22, TypeScript, NestJS, Socket.IO, Redis, MongoDB, Angular, Docker, Coturn, Prometheus, Grafana, and Kubernetes manifests.

The media-plane code is intentionally written behind native interfaces and contains RTP/RTCP routing primitives instead of depending on mediasoup, Janus, LiveKit, Jitsi, Kurento, ion-sfu, Pion-SFU, or another SFU.

## Important Media-Plane Boundary

The signaling, room state, authorization, metrics, schemas, documentation, and frontend workflow are implemented as normal application code. Real WebRTC interoperability still requires a hardened DTLS-SRTP transport implementation. Node.js does not expose a production DTLS-SRTP stack in core, so the repository defines explicit `DtlsTransport` and `SrtpSession` boundaries and fails closed where cryptographic media transport is unavailable.

That boundary is deliberate: pretending to implement DTLS/SRTP with a toy cipher would be less production-ready than refusing unsafe media transport.

## Structure

- `apps/backend`: NestJS backend, Socket.IO signaling, domain services, MongoDB schemas, Redis state, RTP/RTCP router, metrics.
- `apps/frontend`: Angular application with lobby, waiting room, room view, media controls, chat, participants, host controls, and WebRTC client service.
- `packages/contracts`: Shared TypeScript contracts for roles, rooms, participants, producers, consumers, chat, metrics, and signaling events.
- `packages/sfu-core`: Framework-free RTP/RTCP routing primitives, simulcast selection, bandwidth estimation, and audio-level observation.
- `packages/nest-sfu`: Reusable NestJS module wrapping `sfu-core` with ICE/TURN, DTLS/SRTP fail-closed boundaries, and media transport lifecycle services.
- `infra`: Docker Compose, Coturn, Prometheus, Grafana, and Kubernetes manifests.
- `docs`: Architecture, API, WebSocket, deployment, security, and media-plane notes.
- `tests/load`: k6 load test scaffold.

## Reuse In Another App

For a non-Nest app, import `@native-sfu/sfu-core` and wire your own transport, metrics, and persistence.

For a NestJS app, import `NestSfuModule` from `@native-sfu/nest-sfu`:

```ts
NestSfuModule.forRoot({
  turnSecret: process.env.TURN_SECRET!,
  turnUris: ['turn:turn.example.com:3478?transport=udp']
});
```

Use `forRootAsync` when you want to bridge an existing config service and metrics service.

## Development

```bash
npm install
cp .env.example .env
npm run docker:up
npm run dev:backend
npm run dev:frontend
```

Frontend: `http://localhost:4200`

Backend API: `http://localhost:3000/api/v1`

Metrics: `http://localhost:3000/metrics`

Grafana: `http://localhost:3001`

Prometheus: `http://localhost:9090`
