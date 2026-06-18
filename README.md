# Native WebRTC SFU Platform

This repository is a production-oriented monorepo for a WebRTC SFU platform using Node.js 22, TypeScript, NestJS, Socket.IO, Redis, MongoDB, Angular, Docker, Coturn, Prometheus, Grafana, and Kubernetes manifests.

The media-plane code is intentionally written behind native interfaces and contains RTP/RTCP routing primitives instead of depending on mediasoup, Janus, LiveKit, Jitsi, Kurento, ion-sfu, Pion-SFU, or another SFU.

## Current Release-Candidate Scope

The repository now includes the end-to-end transport, forwarding, adaptive media, distributed pipe, observability, and shutdown foundations needed for a production release candidate on a controlled single-node or two-node deployment.

The remaining work is operational, not architectural: production TURN deployment, explicit UDP exposure strategy, environment-specific capacity validation, and final release gating in the target runtime.

If the goal is to make this platform more useful than a raw mediasoup deployment, the recommended strategy is to compete on operator experience, policy, diagnostics, and workflow depth rather than only on low-level SFU mechanics. See [docs/beyond-mediasoup-roadmap.md](/Volumes/Extarnal/RND/SFU/docs/beyond-mediasoup-roadmap.md).

Production operators should publish only UDP TURN URIs in the current release candidate and must ensure `PUBLIC_URL`, `NODE_PUBLIC_URL`, `PIPE_ADVERTISE_IP`, `ICE_STUN_SERVERS`, `ICE_TURN_SERVERS`, `ICE_ANNOUNCED_ADDRESS`, and TURN public addresses resolve to the real paths used by browsers and peer nodes.

Outside local development, the frontend now defaults to same-origin `/api/v1` and `/sfu` so staged ingress can exercise real backend and TURN behavior. Split-host deployments can override those runtime endpoints through `/env.js`.

The server now also validates and exposes the deployment-facing config surface more explicitly: production requires a non-empty `OPERATIONS_TOKEN`, `TURN_URIS` must be explicit UDP `turn:` URIs, `PUBLIC_URL` and `NODE_PUBLIC_URL` must not point at localhost, `ICE_STUN_SERVERS` and `ICE_TURN_SERVERS` must stay on supported UDP transports, `ICE_ANNOUNCED_ADDRESS` must not collapse back to localhost, and `PIPE_ADVERTISE_IP` must be a real inter-node address whenever pipe transport is enabled. Operators can confirm the effective runtime values and rollout alerts through `GET /api/v1/media/diagnostics/node`.

## Structure

- `apps/backend`: NestJS backend, Socket.IO signaling, domain services, MongoDB schemas, Redis state, RTP/RTCP router, metrics.
- `apps/frontend`: Angular application with lobby, waiting room, room view, media controls, chat, participants, host controls, and WebRTC client service.
- `packages/contracts`: Shared TypeScript contracts for roles, rooms, participants, producers, consumers, chat, metrics, and signaling events.
- `packages/sfu-core`: Framework-free RTP/RTCP routing primitives, simulcast selection, bandwidth estimation, and audio-level observation.
- `packages/nest-sfu`: Reusable NestJS module wrapping `sfu-core` with ICE/TURN, DTLS/SRTP, media transport lifecycle services, worker mode, and distributed pipe hooks.
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

The checked-in local `.env` values use `127.0.0.1` for MongoDB and Redis because `npm run dev:backend` runs on the host, not inside the Docker network. The Compose backend service overrides those addresses back to `mongo` / `redis` internally.

Frontend: `http://localhost:4200`

Backend API: `http://localhost:3000/api/v1`

Metrics: `http://localhost:3000/metrics`

Grafana: `http://localhost:3001`

Prometheus: `http://localhost:9090`
